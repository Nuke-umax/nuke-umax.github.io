// 字形アトラス照合による名前認識（ブラウザ版）。Python版(poc_atlas等)の移植。
// 汎用OCRを使わず、固定フォントの字形を最近傍照合する。完全オフライン・高速。

const GLYPH_SIZE = 32;
const DARK_MAX = 110;          // これ未満の輝度を文字インクとみなす
const MATCH_REJECT = 320;      // 最近傍字形の距離がこれを超えたら不明(?)

// atlas_v1.json（char -> base64(128byte, 1024bit little-endian)）を展開する。
function unpackAtlas(json) {
  const atlas = {};
  for (const ch in json) {
    const bin = atob(json[ch]);
    const words = new Uint32Array(GLYPH_SIZE);   // 1024bit = 32 x uint32
    for (let i = 0; i < GLYPH_SIZE; i++) {
      words[i] = (bin.charCodeAt(i * 4) | (bin.charCodeAt(i * 4 + 1) << 8)
        | (bin.charCodeAt(i * 4 + 2) << 16) | (bin.charCodeAt(i * 4 + 3) << 24)) >>> 0;
    }
    atlas[ch] = words;
  }
  return atlas;
}

// 名前矩形をグレースケール2値インク配列（{data:Uint8, w, h}）に落とす。
function binarizeRect(imageData, width, rect) {
  const w = rect.w, h = rect.h;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((rect.y + y) * width + (rect.x + x)) * 4;
      const g = imageData[i] * 0.3 + imageData[i + 1] * 0.59 + imageData[i + 2] * 0.11;
      ink[y * w + x] = g < DARK_MAX ? 1 : 0;
    }
  }
  return { data: ink, w, h };
}

// 縦射影の連続インク列を断片[x0,x1)に。
function inkFragments(ink) {
  const { data, w, h } = ink;
  const col = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) c += data[y * w + x];
    col[x] = c;
  }
  // 「完全ゼロ」でしか切らないと、JPEG圧縮由来の1px残留インクが文字間の
  // 隙間を橋渡しし、複数文字が1断片に融合することがある（実測: 6文字の
  // 名前が丸ごと1断片になった事例）。真の文字境界は最小値0〜2（幅3〜9px）、
  // 単独の複雑な字の内部の窪み（例: 「凋」の冫と周の間）は最小値4以上で
  // 明確に分離できるため、閾値を2に緩める。
  // 3にすると別の実害が出た: "r" の腕の先端（薄く細い部分）はインク値が
  // ちょうど3で、真の境界（最大2）と単独文字内部（最小4）の間に挟まり、
  // 背景と誤判定されて腕が切り落とされた（"r"が縦棒だけに見える不具合）。
  const FRAGMENT_BG_TOLERANCE = 2;
  const frags = [];
  let x = 0;
  while (x < w) {
    if (col[x] > FRAGMENT_BG_TOLERANCE) {
      const x0 = x;
      while (x < w && col[x] > FRAGMENT_BG_TOLERANCE) x++;
      frags.push([x0, x]);
    } else x++;
  }
  return { frags, col };
}

function textHeight(ink) {
  const { data, w, h } = ink;
  let top = -1, bottom = -1;
  for (let y = 0; y < h; y++) {
    let any = 0;
    for (let x = 0; x < w; x++) if (data[y * w + x]) { any = 1; break; }
    if (any) { if (top < 0) top = y; bottom = y; }
  }
  return top < 0 ? h : bottom - top + 1;
}

// ピッチ（文字インク高≒全角幅）基準で断片をグルーピングし文字セルにする。
function segmentByPitch(ink) {
  const { frags } = inkFragments(ink);
  if (frags.length === 0) return [];
  const pitch = textHeight(ink);
  const mergeGap = pitch * 0.22;
  const maxWidth = pitch * 1.15;
  const cells = [];
  let cur = frags[0].slice();
  for (let k = 1; k < frags.length; k++) {
    const f = frags[k];
    const gap = f[0] - cur[1];
    const wouldWidth = f[1] - cur[0];
    if (gap < mergeGap && wouldWidth <= maxWidth) cur[1] = f[1];
    else { cells.push(cur); cur = f.slice(); }
  }
  cells.push(cur);
  return cells;
}

// マスタ期待文字数に合わせ、過結合セルを内部の真の文字境界で再分割する。
// 「幅が広い＝複数文字」という前提は、全角(CJK)と半角(Latin)の幅差で成立
// しない（結合した半角2文字が単独の全角1文字より狭いことがある）。信頼
// できる手がかりは「セル内部に完全な空白列（インク濃度ほぼゼロ）がある
// か」で、これは複数文字の継ぎ目でのみ生じる（実測: 単独の複雑な字の
// 内部の窪みは最小4以上、真の字間は0〜2）。
const ZERO_GAP_THRESHOLD = 2;

function refineToCount(ink, cells, expected) {
  const { col } = inkFragments(ink);
  cells = cells.map(c => c.slice());
  let guard = 0;
  while (cells.length < expected && guard < expected * 2) {
    guard++;
    const candidates = [];
    for (let i = 0; i < cells.length; i++) {
      const [x0, x1] = cells[i];
      if (x1 - x0 < 8) continue;
      let innerMin = Infinity;
      for (let x = x0 + 3; x < x1 - 3; x++) if (col[x] < innerMin) innerMin = col[x];
      if (innerMin <= ZERO_GAP_THRESHOLD) candidates.push(i);
    }
    if (candidates.length === 0) break;   // 真の境界を持つセルが無い＝これ以上安全に分割できない
    let widest = candidates[0];
    for (const i of candidates) if (cells[i][1] - cells[i][0] > cells[widest][1] - cells[widest][0]) widest = i;
    const [x0, x1] = cells[widest];
    let cut = x0 + 3, best = Infinity;
    for (let x = x0 + 3; x < x1 - 3; x++) if (col[x] < best) { best = col[x]; cut = x; }
    cells.splice(widest, 1, [x0, cut], [cut, x1]);
  }

  // セルが多すぎる場合は結合する。segmentByPitch は「隣との間隔が広い」という理由だけで
  // 1文字を割ってしまうことがある（実測: リ・ト のように2画が離れたカナ。
  // 「ストリーミング♡ラッシュ」は12字なのに13セルに割れて対応付け不能だった）。
  // 文字数が分かっているときに限り、「結合しても1文字幅を超えない」隣接ペアのうち
  // 最も狭いものから結合する。1文字が割れた断片どうしは結合しても1文字幅に収まるが、
  // 別々の文字どうしを結合すると2文字幅になり上限に引っかかるため、取り違えにくい。
  const pitch = textHeight(ink);
  const maxMergedWidth = pitch * 1.15;          // segmentByPitch の maxWidth と同じ基準
  while (cells.length > expected) {
    let narrowest = -1, narrowestWidth = Infinity;
    for (let i = 0; i + 1 < cells.length; i++) {
      const merged = cells[i + 1][1] - cells[i][0];
      if (merged > maxMergedWidth) continue;
      if (merged < narrowestWidth) { narrowestWidth = merged; narrowest = i; }
    }
    if (narrowest < 0) break;                   // どれも1文字幅に収まらない＝安全に結合できない
    cells.splice(narrowest, 2, [cells[narrowest][0], cells[narrowest + 1][1]]);
  }
  return cells;
}

// 1文字ぶんを、アスペクト比を保って32x32中央に配置し、1024bitに詰める。
function normalizeGlyph(ink, cell) {
  const { data, w, h } = ink;
  const [cx0, cx1] = cell;
  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = cx0; x < cx1; x++) {
      if (data[y * w + x]) {
        if (top < 0) top = y; bottom = y;
        if (left < 0 || x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  const words = new Uint32Array(GLYPH_SIZE);
  if (top < 0) return words;
  const gh = bottom - top + 1, gw = right - left + 1;
  const scale = (GLYPH_SIZE - 2) / Math.max(gh, gw);
  const nh = Math.max(1, Math.round(gh * scale)), nw = Math.max(1, Math.round(gw * scale));
  const oy = (GLYPH_SIZE - nh) >> 1, ox = (GLYPH_SIZE - nw) >> 1;
  // ピクセル中心でサンプリングする（Python側のPIL NEARESTリサイズと合わせる。
  // 単純な比率(ty*gh/nh)だと半ピクセル分ズレ、言語間でアトラスの互換性が
  // 崩れる＝同じ文字でも距離が大きくなる原因になっていた）。
  for (let ty = 0; ty < nh; ty++) {
    const sy = top + Math.floor((ty + 0.5) * gh / nh);
    for (let tx = 0; tx < nw; tx++) {
      const sx = left + Math.floor((tx + 0.5) * gw / nw);
      if (data[sy * w + sx]) {
        const k = (oy + ty) * GLYPH_SIZE + (ox + tx);   // k = Y*32+X
        words[k >> 5] |= (1 << (k & 31));
      }
    }
  }
  return words;
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < GLYPH_SIZE; i++) {
    let x = (a[i] ^ b[i]) >>> 0;
    while (x) { x &= x - 1; d++; }
  }
  return d;
}

// アトラスのキーは原則1文字だが、同じ文字を複数テンプレート持たせたい場合は
// 「文字#連番」形式のキーを使う（例: "L#0","L#1"）。同一フォントでも描画サイズが
// 大きく違うと32×32正規化後のビットマップがズレて誤一致するため（実測: 帯高16pxの
// カードから採った"I"が帯高44pxの"I"に一致せず"『"に化けた）、実サンプルを複数
// 持たせて最近傍を安定させる。ここでキーの"#"以降を落として文字に還元するので、
// 呼び出し側は単一テンプレートと同じように扱える。
// キーは「文字」または「文字#連番」。文字自体が "#" のときキーは "##0" になるため、
// 先頭から探すと空文字に潰れて字が消える（実測: スキル名「#カレンに染まってみる？」の
// 採取で発生）。連番側に "#" は現れないので、最後の "#" を区切りとみなせば
// "##0"→"#"、"A#0"→"A" の両方が正しく還元できる。
function glyphKeyToChar(key) {
  const i = key.lastIndexOf("#");
  return i <= 0 ? key : key.slice(0, i);
}

// 字形の中央を横切る走査線に現れるインクの塊の数。
// ○ は左右の輪郭で2つ、◎ は内側の輪が加わって4つになる。
function middleRowRunCount(glyph) {
  const row = glyph[GLYPH_SIZE >> 1];
  let runs = 0, wasInk = false;
  for (let x = 0; x < GLYPH_SIZE; x++) {
    const isInk = ((row >>> x) & 1) === 1;
    if (isInk && !wasInk) runs++;
    wasInk = isInk;
  }
  return runs;
}

// ○ と ◎ は外周がまったく同じで、違いは内側の輪の有無だけ。32×32へ正規化すると
// その差はごく少数のビットに縮み、ハミング距離では安定して分けられない
// （実測: 同一の「◎」に対し ○=134 / ◎=144 と逆転し、画面の「根幹距離◎」が
//  「根幹距離○」として距離0で確定した。○◎は評価点も必要SPも違う別スキルなので
//  結果が変わる）。塊の数は内側の輪の有無を直接見るので、太さや滲みに左右されない。
const RING_MARK_MIN_RUNS = 3;   // 3以上なら内側の輪があるとみなす（○=2, ◎=4）

function matchGlyph(glyph, atlas) {
  let bestCh = '?', bestD = Infinity;
  for (const ch in atlas) {
    const d = hamming(glyph, atlas[ch]);
    if (d < bestD) { bestD = d; bestCh = ch; }
  }
  if (bestD > MATCH_REJECT) return '?';
  const ch = glyphKeyToChar(bestCh);
  if (ch === '○' || ch === '◎') {
    return middleRowRunCount(glyph) >= RING_MARK_MIN_RUNS ? '◎' : '○';
  }
  return ch;
}

// 名前矩形を分割し、各文字の正規化字形（Uint32Array）配列を返す。
// アトラス構築（収穫）と認識の両方で使う共通処理。
function nameGlyphs(imageData, width, nameRect, expected = null) {
  const ink = binarizeRect(imageData, width, nameRect);
  let cells = segmentByPitch(ink);
  if (expected) cells = refineToCount(ink, cells, expected);
  return cells.map(c => normalizeGlyph(ink, c));
}

// 名前矩形を認識して文字列を返す。expected指定時は補正分割。
function recognizeName(imageData, width, nameRect, atlas, expected = null) {
  return nameGlyphs(imageData, width, nameRect, expected).map(g => matchGlyph(g, atlas)).join('');
}

// 2パス認識。生分割で確信一致しない場合のみ分割数を変えて試し、
// マスタ照合距離が最小になる分割を採る。
//
// 増やす方向は半角Latinの過結合を救済する。減らす方向は、濁点・半濁点が本体から
// 離れて別の字として数えられる過分割を救済する（実測: 「パイオニア」の「パ」が
// 「!」と「（」の2セルに割れて6字になり、6字の別スキル「閃光のマギア」に
// 距離5で一致して本来の候補を上回った。結合して5字にすれば距離0で一致する）。
//
// 試す順は 0 → 減 → 増。距離が同じなら先に試した方を残すので、素の分割を尊重し、
// 明確に良くなるときだけ分割数を変える。
// matchFn: (recogStr) => { name, distance }（マスタ最近傍）
function recognizeNameBest(imageData, width, nameRect, atlas, matchFn, maxExtra = 8, maxMerge = 2) {
  const ink = binarizeRect(imageData, width, nameRect);
  const base = segmentByPitch(ink);
  const deltas = [0];
  for (let d = 1; d <= maxMerge; d++) deltas.push(-d);
  for (let d = 1; d <= maxExtra; d++) deltas.push(d);

  let best = null, bestGlyphs = null;
  for (const delta of deltas) {
    const target = base.length + delta;
    if (target < 1) continue;
    const cells = delta === 0 ? base : refineToCount(ink, base, target);
    if (delta !== 0 && cells.length !== target) continue;   // その数には分割・結合できない
    const glyphs = cells.map(c => normalizeGlyph(ink, c));
    const recog = glyphs.map(g => matchGlyph(g, atlas)).join('');
    const res = matchFn(recog);
    if (best === null || res.distance < best.distance) {
      best = { recog, name: res.name, distance: res.distance, gap: res.gap, secondName: res.secondName };
      bestGlyphs = glyphs;
    }
    if (best.distance === 0) break;   // 完全一致で打ち切り（純CJKは即確定）
  }
  if (best !== null) best.distinguishMargin = distinguishingCharMargin(best, bestGlyphs, atlas);
  return best;
}

// best と secondName が「同じ長さ」の兄弟スキルのとき、相違する各位置の字形が
// 勝者側と敗者側のどちらへ近いかを合算して返す。
// 戻り値 = Σ(hamming(敗者字) - hamming(勝者字))（正で大きいほど勝者確信、
// 負で大きいほど「第1候補が誤読で、実は次点が正しい」）。
//
// 文字単位の1回照合で文字列にしてから名前照合すると、途中の1誤読（固→適など、
// どちらの候補とも無関係な字への事故）が編集距離gap=1に化けて曖昧化する。
// そこで曖昧ペアが出たあとに、勝者名と次点名をビットマップへ戻して相違位置だけ
// 直接対決させる。判定に必要なのは「勝者字 vs 敗者字のどちらに近いか」だけで、
// 無関係な誤読字（適など）は関与しない（実測: 地固め/大詰めは 固:174 で 詰は圏外）。
//
// 敗者側の字がアトラス未収録なら「その字と読める可能性は無かった」ため
// MATCH_REJECT 相当の遠距離とみなし勝者へ倒す。勝者側の字が未収録なら評価不能で
// null（＝この救済の対象外。従来のgap判定へ委ねる）。
function distinguishingCharMargin(best, glyphs, atlas) {
  const winnerName = best.name, rivalName = best.secondName;
  if (winnerName === null || rivalName === null) return null;
  if (winnerName.length !== rivalName.length) return null;
  if (glyphs === null || glyphs.length !== winnerName.length) return null;
  let marginSum = 0, diffCount = 0;
  for (let i = 0; i < winnerName.length; i++) {
    if (winnerName[i] === rivalName[i]) continue;
    const winnerGlyph = atlas[winnerName[i]];
    if (winnerGlyph === undefined) return null;   // 勝者字が無ければ確信不能
    const rivalGlyph = atlas[rivalName[i]];
    const winnerDist = hamming(glyphs[i], winnerGlyph);
    const rivalDist = rivalGlyph === undefined ? MATCH_REJECT : hamming(glyphs[i], rivalGlyph);
    marginSum += rivalDist - winnerDist;
    diffCount++;
  }
  return diffCount === 0 ? null : marginSum;
}
