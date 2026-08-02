// 画像をまたぐ重複行の除去。連続スクショの境界に現れる「写り込みの重複」を、
// OCR結果に依存せず、名前crop画像の知覚ハッシュ＋境界連続性で判定する。
//
// 設計意図: OCR名でキー付けすると、OCR誤読で別スキルが同一視され実データを失う。
//   重複はスクロール境界の「連続ブロック」なので、視覚一致で連続長を測るのが安全。

// 名前crop領域を粗いグレースケール格子に落とし、平均以上を1とするaHash（256bit）。
// 同じ行のスクショはほぼ同一画像なのでハッシュが一致する。
const AHASH_COLS = 32;
const AHASH_ROWS = 8;

function computeNameHash(data, width, rect) {
  const cols = AHASH_COLS, rows = AHASH_ROWS;
  const cellW = rect.w / cols, cellH = rect.h / rows;
  const cells = new Float32Array(cols * rows);
  let sum = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor(rect.x + cx * cellW), x1 = Math.floor(rect.x + (cx + 1) * cellW);
      const y0 = Math.floor(rect.y + cy * cellH), y1 = Math.floor(rect.y + (cy + 1) * cellH);
      let acc = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          acc += data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
          n++;
        }
      }
      const v = n ? acc / n : 0;
      cells[cy * cols + cx] = v;
      sum += v;
    }
  }
  const mean = sum / cells.length;
  // 256bit を Uint32×8 に格納
  const bits = new Uint32Array(cols * rows / 32);
  for (let k = 0; k < cells.length; k++) {
    if (cells[k] > mean) bits[k >> 5] |= (1 << (k & 31));
  }
  return bits;
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) { x &= x - 1; d++; }
  }
  return d;
}

// 2つの行を同一行とみなすか。名前crop画像の近さ（aHash）に加え、
// 必要SPと進化フラグの一致も要求する。名前ボックスは余白が多くaHash単独では
// 別スキルを誤って近いと判定しうるため、SP・進化で裏取りする（数字OCRは信頼できる）。
const SAME_ROW_HAMMING_MAX = 24;   // 256bit中

function isSameRow(a, b) {
  if (a.sp !== b.sp) return false;
  if (a.evo !== b.evo) return false;
  return hammingDistance(a.hash, b.hash) <= SAME_ROW_HAMMING_MAX;
}

// 連続する2画像の境界重複長を求める。
// imgN の末尾 k 行が imgN+1 の先頭 k 行と一致する最大の k を返す。
function boundaryOverlap(prevRows, currRows, same = isSameRow) {
  const maxK = Math.min(prevRows.length, currRows.length);
  for (let k = maxK; k >= 1; k--) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!same(prevRows[prevRows.length - k + j], currRows[j])) { ok = false; break; }
    }
    if (ok) return k;
  }
  return 0;
}

// 画像の並び順を、画像の中身から復元する。
//
// なぜ必要か: 認識結果は「上から下へ順に撮った」前提に立っているが、入力の並び順は
// 当てにならない。ファイル選択はタップ順、更新日時はクラウド保存で書き換わり、
// ファイル名もリネームやダウンロードで崩れる。並びが狂うと確認・修正の表示順が
// 取得画面と食い違い、隣接画像の重なりも見つからないため重複行がそのまま残る。
//
// 使う手がかりは2つ。
//  (1) 先頭画像: スキル取得画面の1行目は必ずそのウマ娘の固有スキル（獲得済・ID 90万以上）。
//      実測4キャラ全てで、1行目が固有スキルの画像はちょうど1枚だけだった。
//  (2) 以降の並び: 隣り合う画像は重ねて撮られている（②の案内文でそう指示している）ので、
//      「iの末尾とjの先頭が一致する」ペアを繋げば鎖になる。
//
// 重ねずに撮られた画像は繋がらない。その場合は繋がった塊どうしを入力順（ファイル名順）で
// 並べる＝従来どおりの挙動になり、悪化はしない。
const UNIQUE_SKILL_MIN_ID = 900000;

// 順序復元用の厳格な同一判定。
// 連結時の isSameRow（字形ハッシュ＋SP＋進化）は隣り合う画像だけを比べる前提では
// 十分だが、全ペアを突き合わせる順序復元では緩すぎる（実測: Vodkaの画像18の末尾2行が
// 画像20の先頭2行と誤って一致し、真の隣接1行より強い偽の連結になって順序が壊れた）。
// スキル名と獲得済みフラグの一致も要求すると、実測4キャラ・79枚で偽の連結は0件になった。
function isSameRowStrict(a, b) {
  return a.name === b.name && a.acquired === b.acquired && isSameRow(a, b);
}

function isTopImage(rows) {
  const first = rows[0];
  return first !== undefined && first.acquired === true && first.skillId >= UNIQUE_SKILL_MIN_ID;
}

function orderImagesByContent(perImageRows, scrollProfiles) {
  const n = perImageRows.length;
  const inputOrder = perImageRows.map((_, i) => i);
  if (n < 2) return inputOrder;

  // スクロールバーが読めればそれが最も確実。読めない端末では以下の重なり方式へ。
  const byScrollbar = scrollProfiles ? orderImagesByScrollbar(scrollProfiles) : null;
  if (byScrollbar !== null) return byScrollbar;

  const links = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const k = boundaryOverlap(perImageRows[i], perImageRows[j], isSameRowStrict);
      if (k > 0) links.push({ i, j, k });
    }
  }
  // 重なりが大きい順。同数なら入力順を優先し、結果を入力に対して安定させる。
  links.sort((a, b) => (b.k - a.k) || (a.i - b.i) || (a.j - b.j));

  const next = new Array(n).fill(-1);
  const prev = new Array(n).fill(-1);
  const chainId = inputOrder.slice();
  for (const { i, j } of links) {
    if (next[i] !== -1 || prev[j] !== -1) continue;   // 前後は1枚ずつ
    if (chainId[i] === chainId[j]) continue;          // 輪を作らない
    next[i] = j;
    prev[j] = i;
    const absorbed = chainId[j];
    for (let h = 0; h < n; h++) if (chainId[h] === absorbed) chainId[h] = chainId[i];
  }

  const chains = inputOrder.filter(i => prev[i] === -1).map(head => {
    const members = [];
    for (let i = head; i !== -1; i = next[i]) members.push(i);
    return members;
  });
  // 固有スキルを含む塊を先頭に。残りは入力順（＝ファイル名順）で続ける。
  const topImages = inputOrder.filter(i => isTopImage(perImageRows[i]));
  const topImage = topImages.length === 1 ? topImages[0] : -1;
  const rank = (chain) => (chain.includes(topImage) ? -1 : Math.min(...chain));
  chains.sort((a, b) => rank(a) - rank(b));

  const result = chains.flat();
  return result.length === n ? result : inputOrder;   // 想定外なら入力順のまま
}

// 画像ごとの行配列を、境界重複を除いて連結する。
// perImageRows: [[{hash, sp, evo, ...}], ...]（各画像は上→下のスクロール順）
// 戻り値: { merged:[行...], overlaps:[各境界の重複長] }
function mergeAcrossImages(perImageRows) {
  const merged = [];
  const overlaps = [];
  for (let i = 0; i < perImageRows.length; i++) {
    const rows = perImageRows[i];
    if (i === 0) { merged.push(...rows); continue; }
    const k = boundaryOverlap(perImageRows[i - 1], rows);
    overlaps.push(k);
    merged.push(...rows.slice(k));   // 重複ぶんの先頭を捨てて連結
  }
  return { merged, overlaps };
}

// スクロールバーのつまみ位置から撮影順を復元する。
//
// 重なりを繋ぐ方式は「隣り合う画像に丸ごと共通する行がある」ことが前提で、
// 送り幅が大きい撮り方（共通行が下端で見切れる）だと働かない。
// 一方スクロールバーのつまみはリスト内の絶対位置そのものなので、
// 内容にも重なりにも依存せず並べられる。
//
// つまみの太さ・色・位置は端末ごとに違うため、閾値で決め打ちせず
// 「全画像で同じ位置に出る暗部＝静的なUI」を差し引いて、動く暗部だけを残す。
// 検出できない端末では null を返し、呼び出し側が従来方式へ落ちる（警告は出さない）。
const SCROLLBAR_BAND = { xStart: 0.94, yStart: 0.28, yEnd: 0.82 };
const SCROLLBAR_DARK_MAX = 190;
const SCROLLBAR_RUN_MIN_RATIO = 0.010;   // つまみの最小の長さ（画面高比）
const SCROLLBAR_RUN_MAX_RATIO = 0.150;   // 同・最大。スキルが少ないキャラほど長い
const SCROLLBAR_STATIC_TOLERANCE_RATIO = 0.002;  // 同位置とみなすズレ
const SCROLLBAR_MIN_SPREAD_RATIO = 0.050;        // これ未満しか動かなければ不採用

// 右端の各列について、暗部の連続（＝つまみ候補）の中心yを集める。
function scrollbarRunCenters(data, width, height) {
  const xStart = Math.floor(width * SCROLLBAR_BAND.xStart);
  const yStart = Math.floor(height * SCROLLBAR_BAND.yStart);
  const yEnd = Math.floor(height * SCROLLBAR_BAND.yEnd);
  const minLen = Math.round(height * SCROLLBAR_RUN_MIN_RATIO);
  const maxLen = Math.round(height * SCROLLBAR_RUN_MAX_RATIO);
  const columns = [];
  for (let x = xStart; x < width; x++) {
    const centers = [];
    let runStart = -1;
    for (let y = yStart; y <= yEnd; y++) {
      const i = (y * width + x) * 4;
      const dark = y < yEnd && (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11) < SCROLLBAR_DARK_MAX;
      if (dark) { if (runStart < 0) runStart = y; }
      else if (runStart >= 0) {
        const len = y - runStart;
        // 長さも持つ。つまみの長さ＝1画面分の移動量なので、撮り漏れの判定に使う。
        if (len >= minLen && len <= maxLen) centers.push({ center: (runStart + y) / 2, length: len });
        runStart = -1;
      }
    }
    columns.push(centers);
  }
  return { width, height, columns };
}

// つまみの位置を全画像ぶん取り出す。戻り値 { centers, lengths } は入力順。
// 取り出せなければ null（呼び出し側は従来どおり静かに諦める）。
function scrollbarThumbs(profiles) {
  const n = profiles.length;
  if (n < 2) return null;
  const head = profiles[0];
  if (!head) return null;
  // 端末が同じであることを前提にする。解像度が混ざったら諦める。
  if (profiles.some(p => !p || p.width !== head.width || p.height !== head.height)) return null;

  const tolerance = Math.max(2, head.height * SCROLLBAR_STATIC_TOLERANCE_RATIO);
  const minSpread = head.height * SCROLLBAR_MIN_SPREAD_RATIO;
  let best = null;
  for (let c = 0; c < head.columns.length; c++) {
    // 全画像に同じ位置で現れる暗部は動かないUI。取り除くとつまみだけが残る。
    const moving = profiles.map(p => p.columns[c].filter(run =>
      !profiles.every(other => other.columns[c].some(o => Math.abs(o.center - run.center) <= tolerance))));
    if (moving.some(m => m.length !== 1)) continue;
    const centers = moving.map(m => m[0].center);
    const lengths = moving.map(m => m[0].length);
    const spread = Math.max(...centers) - Math.min(...centers);
    if (spread < minSpread) continue;
    if (best === null || spread > best.spread) best = { spread, centers, lengths };
  }
  return best === null ? null : { centers: best.centers, lengths: best.lengths };
}

function orderImagesByScrollbar(profiles) {
  const thumbs = scrollbarThumbs(profiles);
  if (thumbs === null) return null;
  return profiles.map((_, i) => i).sort((a, b) => thumbs.centers[a] - thumbs.centers[b]);
}

// 撮り漏れ（スクロール中に1画面ぶん飛ばした箇所）を検出する。
//
// 原理: スクロールバーのつまみは、リスト全体に対する表示範囲を表す。1画面ぶん
// スクロールすると、つまみはちょうど自分の長さだけ動く。したがって隣り合う2枚の
// つまみ移動量が、つまみの長さを超えていれば、その間に写っていない範囲がある。
//   移動量 < 長さ … 重なって撮れている（案内どおり）
//   移動量 ≒ 長さ … 重なりは無いが連続している
//   移動量 > 長さ … 間が抜けている ← これを警告する
//
// order は orderImagesByContent が返す撮影順。つまみの値は入力順の配列なので、
// order を通して並べ替えてから隣同士を比べる。
const SCROLL_GAP_TOLERANCE = 1.25;   // 長さのこの倍を超えたら抜けとみなす

function detectMissingRanges(profiles, order) {
  const thumbs = scrollbarThumbs(profiles);
  if (thumbs === null) return null;          // 判定できない端末では黙る（誤警告を出さない）
  const gaps = [];
  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1], curr = order[i];
    const moved = thumbs.centers[curr] - thumbs.centers[prev];
    const screen = (thumbs.lengths[prev] + thumbs.lengths[curr]) / 2;
    if (screen > 0 && moved > screen * SCROLL_GAP_TOLERANCE) {
      gaps.push({ afterOrderIndex: i - 1, missingScreens: moved / screen - 1 });
    }
  }
  return gaps;
}
