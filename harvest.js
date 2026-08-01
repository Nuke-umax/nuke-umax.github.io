// 字形アトラスの自動収穫（ランタイム自己修復）。マスタ名を正解ラベルとして
// 使うため人手ラベリング・追加撮影は不要。ユーザーが読み取りに使った
// スクリーンショットから、そのユーザーのローカルアトラスが育つ設計。
// スクショや収穫結果は一切外部送信しない（端末内のみで完結）。
//
// Python試作(poc_harvest.py/poc_harvest_jikei.py)で実証・修正した2つの不具合
// を踏まえた実装:
//   ①「距離0の完全一致」は近縁名（右回り○/左回り○等）があっても無条件で確信とする
//   ②「未知(?)ぶんの距離は許容」しつつ、生分割で確信しなければ2パスで分割数を探索する

const GAP_MARGIN = 2;     // 次点との距離差がこれ以上なら一意とみなす（誤収穫防止）

// 収穫専用の未知判定閾値。recognizer.js の MATCH_REJECT(320)は認識時の
// 取りこぼし防止で緩めに取っているが、収穫では緩すぎると未知の字が
// 似た既存字に強制マッチし、confidentMatch が真の「未知(?)」信号を
// 得られず確信判定に届かない（実測: 320のままだと収穫が1字で頭打ちになる）。
const HARVEST_MATCH_REJECT = 150;

function harvestMatchGlyph(glyph, atlas) {
  let bestCh = '?', bestD = Infinity;
  for (const ch in atlas) {
    const d = hamming(glyph, atlas[ch]);
    if (d < bestD) { bestD = d; bestCh = ch; }
  }
  return bestD <= HARVEST_MATCH_REJECT ? bestCh : '?';
}

// マスタ最近傍を返す。未知(?)ぶんの距離は許容し、一意性で誤りを防ぐ。
// 未知文字なしの完全一致(距離0)は、近縁名の有無によらず無条件で確信とする
// （リテラル完全一致に曖昧さはないため）。
function confidentMatch(recog, index) {
  if (recog.length < 2) return { ok: false, name: null, distance: 999 };
  let best = null, bestDist = Infinity, second = Infinity;
  for (const entry of index) {
    const d = editDistance(recog, entry.key);
    if (d < bestDist) { second = bestDist; bestDist = d; best = entry; }
    else if (d < second) { second = d; }
  }
  const unknowns = (recog.match(/\?/g) || []).length;
  if (bestDist === 0 && unknowns === 0) return { ok: true, name: best.name, distance: 0 };
  const ok = bestDist <= unknowns + 1 && (second - bestDist) >= GAP_MARGIN;
  return { ok, name: best ? best.name : null, distance: bestDist };
}

// 2パス探索: 生分割で確信しなければ分割数を段階的に増やし、マスタ距離最小を採る。
// 戻り値: { ok, name, cells, distance } | null
function bestMatch2Pass(ink, baseCells, atlas, index, maxExtra = 8) {
  let best = null;
  for (let extra = 0; extra <= maxExtra; extra++) {
    const cells = extra === 0 ? baseCells : refineToCount(ink, baseCells, baseCells.length + extra);
    if (extra > 0 && cells.length !== baseCells.length + extra) break;
    const recog = cells.map(c => harvestMatchGlyph(normalizeGlyph(ink, c), atlas)).join('');
    const { ok, name, distance } = confidentMatch(recog, index);
    if (best === null || distance < best.distance) best = { ok, name, cells, distance };
    if (ok) return best;   // 完全一致なら打ち切り
  }
  return best;
}

// 1行ぶんのink({data,w,h})から、確信できれば新規文字を収穫してatlasに追加する。
// 戻り値: 新規収穫した文字数
function harvestRow(ink, atlas, index) {
  const base = segmentByPitch(ink);
  if (base.length === 0) return 0;
  const best = bestMatch2Pass(ink, base, atlas, index);
  if (best === null || !best.ok || best.name === null) return 0;

  const targetChars = [...normalizeName(best.name)];
  const cells = best.cells.length === targetChars.length
    ? best.cells
    : refineToCount(ink, best.cells, targetChars.length);
  if (cells.length !== targetChars.length) return 0;

  let added = 0;
  targetChars.forEach((ch, i) => {
    if (!(ch in atlas)) {
      atlas[ch] = normalizeGlyph(ink, cells[i]);
      added++;
    }
  });
  return added;
}

// 複数行(inks配列)から収穫が収束するまで反復する。
// 戻り値: { addedTotal, passes }
function harvestAll(inks, atlas, index, maxPasses = 8) {
  let addedTotal = 0, passes = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    let addedThisPass = 0;
    for (const ink of inks) addedThisPass += harvestRow(ink, atlas, index);
    addedTotal += addedThisPass;
    passes = pass + 1;
    if (addedThisPass === 0) break;
  }
  return { addedTotal, passes };
}
