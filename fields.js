// 必要SP・保有スキルPt・適性ランク・獲得済み行の抽出。
// 分割・正規化・アトラス照合は recognizer.js の関数（segmentByPitch等）を
// 数字・ランク文字にもそのまま流用する（名前専用ではない汎用処理のため）。

// 暖色（茶色/橙色）文字のインク抽出。数字は下地の緑ラベルや灰色ボタン縁と
// 明確に色が違うため、色条件で下地ノイズを分離できる。
function warmInk(data, width, rect, opts) {
  const { rMin = null, brightMax = null, rMinusB = 0 } = opts;
  const w = rect.w, h = rect.h;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((rect.y + y) * width + (rect.x + x)) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const bright = r * 0.3 + g * 0.59 + b * 0.11;
      let ok = (r - b) > rMinusB;
      if (rMin !== null) ok = ok && r > rMin;
      if (brightMax !== null) ok = ok && bright < brightMax;
      ink[y * w + x] = ok ? 1 : 0;
    }
  }
  return { data: ink, w, h };
}

// 必要SP（各行・茶色文字）。灰色「−」ボタンの縁を rMinusB で除外する。
// brightMax は 110。金色ハイライトバッジ（高SPスキル）では数字の周囲に
// 中間輝度(130-150)の暖色ハロ（金地とのアンチエイリアス）が生じ、150だと
// これを拾って隣接数字を橋渡し・結合させてしまう。数字本体の茶は輝度〜90
// なので、110にすればハロを除外しつつ本体は保てる（白地の通常バッジでも
// ハロは灰色=rMinusBで既に除外されるため影響しない）。
function spDigitInk(data, width, rect) {
  return warmInk(data, width, rect, { brightMax: 110, rMinusB: 20 });
}

// 保有スキルPt（画面上部ヘッダ・橙文字）。緑ラベルは rMin/rMinusB で除外する。
function skillPointDigitInk(data, width, rect) {
  return warmInk(data, width, rect, { rMin: 150, rMinusB: 60 });
}

// 保有スキルPtのおおまかな探索矩形（ヘッダ内、解像度比のみに依存）。
// 実際の桁位置はこの中のインク投影から求めるので、多少広くても構わない。
//
// 既知の限界（§10.14と同種）: ヘッダー内要素の縦位置は画面全体に対する
// 単純な比率ではスケールしない（実測: 1080×2412=比0.298〜0.327、
// 1206×2622=比0.332〜0.347。アスペクト比が0.4478→0.4599と変わっただけで
// 約0.02のズレが生じた）。安全マージンを持たせて両解像度を包含する範囲に
// 広げてある。将来的にはヘッダーの色/構造アンカー検出に置き換えるとよい。
const SKILL_POINT_SEARCH_RATIO = { xLeft: 0.73, xRight: 0.97, yTop: 0.29, yBottom: 0.355 };

function skillPointSearchRect(width, height) {
  const r = SKILL_POINT_SEARCH_RATIO;
  return {
    x: Math.round(width * r.xLeft), y: Math.round(height * r.yTop),
    w: Math.round(width * (r.xRight - r.xLeft)), h: Math.round(height * (r.yBottom - r.yTop)),
  };
}

// ink({data,w,h}) を分割・正規化・アトラス照合して文字列にする（数字・ランク共通）。
function recognizeInk(ink, atlas) {
  const cells = segmentByPitch(ink);
  return cells.map(c => matchGlyph(normalizeGlyph(ink, c), atlas)).join('');
}

// 数字専用の認識。「New」等で強調された金色バッジは左端に丸い縁取り装飾を
// 持ち、これが幅数pxの偽の「文字」としてセル化され桁がずれることがある
// （実測: 好転一息の金色バッジで"238"の前に幅4pxの断片が混入し桁崩壊）。
// 数字は幅がほぼ均一なので、極端に細いセルは文字ではなく装飾のノイズと
// みなして除外する。
const DIGIT_MIN_WIDTH_RATIO = 0.15;   // 最小セル幅 ÷ 行の高さ

// 注意: 「他セルより明確に広い＝2桁結合」という判定は導入しない。
// 数字の"1"は他の数字より自然に幅が狭いため、"1"を基準にすると通常の
// 単独数字まで誤って分割してしまう（実測で確認済みの実害）。

// segmentByPitch は名前用に「小さな隙間は同一文字内の構造とみなして
// 再結合する」ロジック（隙間 < ピッチの22%なら結合）を持つ。この閾値は
// 複雑な漢字の内部構造（例: 「凋」の冫と周の間）向けに調整したものだが、
// 数字列では隣接する2桁の本来の字間（実測5px程度）の方がこの閾値
// （実測10px程度）より狭いことがあり、正しく分離できたはずの2桁を
// 誤って再結合してしまう（実測: "238"の"2"と"3"が結合し桁崩壊）。
// 数字は構造的な内部の隙間を持たないため、再結合ロジックを経由しない
// 素の断片化（inkFragments）だけで十分かつより安全。
//
// 探索矩形を広めに取っている都合上（skillPointSearchRect参照）、数字本体の
// 上に無関係な暖色ノイズ（「変更」「詳細」ボタンラベルの縁など）が写り込む
// ことがある。このノイズは数字と列（x）範囲が重なるため単純な列分割では
// 除去できず、縦方向の外接矩形が本体まで含めて間延びし、正規化後の字形が
// 潰れて誤認識する（実測: メジロラモーヌの"8060"が"1160"に化けた）。
// 数字本体は密な連続インクの帯として現れ、ノイズは疎らなので、行方向の
// インク密度が最大の連続帯だけを数字本体とみなして切り出す。
function isolateDigitRowBand(ink) {
  const { data, w, h } = ink;
  const rowInkCounts = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < w; x++) count += data[y * w + x];
    rowInkCounts[y] = count;
  }
  const bands = [];
  let y = 0;
  while (y < h) {
    if (rowInkCounts[y] === 0) { y++; continue; }
    const yTop = y;
    let maxDensity = 0;
    while (y < h && rowInkCounts[y] > 0) { maxDensity = Math.max(maxDensity, rowInkCounts[y]); y++; }
    bands.push({ yTop, yBottom: y, maxDensity });
  }
  // バンドが1つしかなくても、探索矩形自体が数字本体より上下に大きな余白を
  // 持つことがある（ヘッダーの保有Pt探索矩形は複数解像度を包含するため
  // 広めに取ってある）。その場合も本体の高さちょうどまで詰めないと、
  // 後段の密度フィルタ（DIGIT_MIN_DENSITY_RATIO）の分母が実際の文字高さ
  // より大きくなり、本物の数字まで誤って足切りされる。
  if (bands.length === 0) return ink;
  const densestBand = bands.reduce((a, b) => (b.maxDensity > a.maxDensity ? b : a));
  // 帯内でも、選択中行のゴールドハイライトのにじみが数字と縦連結して疎らな行
  // （インク1〜2px）として上下に間延びさせることがある（実測: 圧倒のSP帯が
  // 数字本体28px＋上下ノイズで51pxに膨張。密度閾値 h×0.4 が20.4に上がり、細い
  // 「2」(密度20)が足切りされ 240→40 になった）。帯内の最大行インクに対して
  // 十分疎らな上下端の行を刈り込み、数字本体の高さちょうどに詰める。数字の
  // 端行は箱幅いっぱいに広がり最大行インクの2割は優に超えるため巻き込まない。
  const trimFloor = densestBand.maxDensity * 0.2;
  let top = densestBand.yTop, bottom = densestBand.yBottom;
  while (top < bottom && rowInkCounts[top] < trimFloor) top++;
  while (bottom > top && rowInkCounts[bottom - 1] < trimFloor) bottom--;
  const bandHeight = bottom - top;
  const bandData = new Uint8Array(w * bandHeight);
  for (let by = 0; by < bandHeight; by++) {
    for (let x = 0; x < w; x++) bandData[by * w + x] = data[(top + by) * w + x];
  }
  return { data: bandData, w, h: bandHeight };
}

// 数字本体と同じ行帯（y範囲）に、SPステッパーUIの「−」「＋」ボタンの縁が
// 列（x）方向で重なって入り込むことがある（実測: メジロラモーヌの選択中
// 行が「−180＋」形式で表示され、探索矩形が「−」ボタンの縁を巻き込んで
// "180"の前に偽の文字が混入した）。ボタンの縁は幅は数字と紛らわしい太さに
// なり得るが、実際に色条件を満たす画素は縁のごく薄い線に限られるため、
// 断片内の最大列密度（＝インクで埋まっている行数）は本物の数字本体より
// 明確に低い（実測: 数字は行高の47〜88%を埋めるが、ボタン縁は12〜33%に
// とどまる）。幅に加えて密度でも足切りする。
const DIGIT_MIN_DENSITY_RATIO = 0.4;   // 断片内最大列密度 ÷ 行の高さ

function recognizeDigits(rawInk, atlas) {
  const ink = isolateDigitRowBand(rawInk);
  const { frags, col } = inkFragments(ink);
  const cells = frags.filter(c => {
    const width = c[1] - c[0];
    if (width < ink.h * DIGIT_MIN_WIDTH_RATIO) return false;
    let maxDensity = 0;
    for (let x = c[0]; x < c[1]; x++) maxDensity = Math.max(maxDensity, col[x]);
    return maxDensity >= ink.h * DIGIT_MIN_DENSITY_RATIO;
  });
  return cells.map(c => matchGlyph(normalizeGlyph(ink, c), atlas)).join('');
}

// ---- 適性ランク（詳細画面モーダル） ----
// 距離適性・脚質適性の行帯（解像度比。詳細画面は固定モーダルレイアウト）。
// 既知の限界: 現状は比率のみに依存しており、アスペクト比が大きく異なる端末で
// ずれる可能性がある。将来的には緑ヘッダー等のアンカー検出に置き換えるとよい。
const APTITUDE_ROW_RATIO = {
  dist: { yTop: 903 / 2412, yBottom: 963 / 2412 },
  leg: { yTop: 963 / 2412, yBottom: 1023 / 2412 },
};
const RANK_MIN_W_RATIO = 18 / 1080, RANK_MAX_W_RATIO = 42 / 1080, CELL_GAP_RATIO = 45 / 1080;
// ラベル語末の1文字（例:「距離適性」の「性」）は直後に大きな隙間を持つため、
// 後方の隙間だけで判定すると誤ってランク文字扱いされる。ラベル内の字間
// （数px）とラベル→バッジ間の間隔（20px超）は明確に差があるため、
// 前方の隙間もあわせて要求する。
const CELL_PRE_GAP_RATIO = 15 / 1080;

// ランク文字（色付き・灰色G/F含む）のインク抽出。暗い or 高彩度を文字とみなす。
function rankInk(data, width, rect) {
  const w = rect.w, h = rect.h;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((rect.y + y) * width + (rect.x + x)) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const bright = r * 0.3 + g * 0.59 + b * 0.11;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      ink[y * w + x] = (bright < 170 || sat > 60) ? 1 : 0;
    }
  }
  return { data: ink, w, h };
}

// 行帯からランク文字の(x0,x1)候補を返す。ランク文字＝幅が規定範囲内かつ
// 直後に大きな隙間（各セル右端）。ラベル漢字群（幅広）は自然に除外される。
function rankLetterCells(data, width, rowRect) {
  const ink = rankInk(data, width, rowRect);
  const col = new Int32Array(ink.w);
  for (let x = 0; x < ink.w; x++) {
    let c = 0;
    for (let y = 0; y < ink.h; y++) c += ink.data[y * ink.w + x];
    col[x] = c;
  }
  const frags = [];
  let x = 0;
  while (x < ink.w) {
    if (col[x] > 2) { const x0 = x; while (x < ink.w && col[x] > 2) x++; frags.push([x0, x]); }
    else x++;
  }
  const minW = width * RANK_MIN_W_RATIO, maxW = width * RANK_MAX_W_RATIO;
  const gapAfterMin = width * CELL_GAP_RATIO, gapBeforeMin = width * CELL_PRE_GAP_RATIO;
  const result = [];
  for (let i = 0; i < frags.length; i++) {
    const [x0, x1] = frags[i];
    const w = x1 - x0;
    if (w < minW || w > maxW) continue;
    const nextStart = (i + 1 < frags.length) ? frags[i + 1][0] : ink.w;
    const prevEnd = (i > 0) ? frags[i - 1][1] : -Infinity;
    if (nextStart - x1 > gapAfterMin && x0 - prevEnd > gapBeforeMin) result.push([x0, x1]);
  }
  return { ink, cells: result };
}

// 距離適性・脚質適性の4セルずつを認識する。戻り値: {dist:[4文字], leg:[4文字]}
function recognizeAptitudeRanks(data, width, height, atlas) {
  const out = {};
  for (const row of ["dist", "leg"]) {
    const r = APTITUDE_ROW_RATIO[row];
    const rect = { x: 0, y: Math.round(height * r.yTop), w: width, h: Math.round(height * (r.yBottom - r.yTop)) };
    const { ink, cells } = rankLetterCells(data, width, rect);
    out[row] = cells.map(c => matchGlyph(normalizeGlyph(ink, c), atlas));
  }
  return out;
}

// 確認UIに出す切り抜き矩形。読み取った値の隣に元の画面を並べ、ゲームを開き直さずに
// 突き合わせられるようにする（スキル行のサムネイルと同じ考え方）。
//
// 切り出すのは中身だけ（ステータスは数字、適性はランク文字）。セル単位で機械的に
// 切ると隣のセルが写り込み、項目ごとに文字の大きさも位置もばらつく。中身にぴったり
// 合わせてから、中身の高さに対する同じ割合の余白を足せば、並べたときに揃って見える。
const CROP_PAD_RATIO = 0.30;   // 中身の高さに対する余白

// box の中でインクが占める最小の矩形。無ければ null。
function tightInkRect(data, width, box, isInk) {
  let x0 = box.x + box.w, x1 = box.x - 1, y0 = box.y + box.h, y1 = box.y - 1;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * width + x) * 4;
      if (!isInk(data[i], data[i + 1], data[i + 2])) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// 中身に余白を足す。ただし縦は探索に使った箱（ステータスは数字帯、適性は適性行）の
// 外へ出さない。外へ出すと上の緑の区切り線や下の"/最大値"が写り込む。
function padCropRect(rect, box, width) {
  const pad = Math.round(rect.h * CROP_PAD_RATIO);
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(box.y, rect.y - pad);
  const yEnd = Math.min(box.y + box.h, rect.y + rect.h + pad);
  return { x, y, w: Math.min(width - x, rect.w + pad * 2), h: yEnd - y };
}

function detailCropRects(data, width, height) {
  const isRankInk = (r, g, b) =>
    (r * 0.3 + g * 0.59 + b * 0.11) < 170 || (Math.max(r, g, b) - Math.min(r, g, b)) > 60;

  const stats = [];
  const bands = statOrangeBands(data, width, height);
  if (bands.length > 0) {
    const [y0, y1] = bands[0];
    for (let ci = 0; ci < 5; ci++) {
      const clusterX = statDigitClusterX(data, width, bands[0], ci);
      if (clusterX === null) { stats.push(null); continue; }
      const box = { x: clusterX[0], y: y0, w: clusterX[1] - clusterX[0], h: y1 - y0 };
      const tight = tightInkRect(data, width, box, statOrangeInk);
      stats.push(tight ? padCropRect(tight, box, width) : null);
    }
  }

  // 4個ずつ揃ったときだけ返す。個数が違うとどのランクの切り抜きか対応が取れない。
  const aptitudes = [];
  for (const row of ["dist", "leg"]) {
    const r = APTITUDE_ROW_RATIO[row];
    const rowRect = {
      x: 0, y: Math.round(height * r.yTop),
      w: width, h: Math.round(height * (r.yBottom - r.yTop)),
    };
    const { cells } = rankLetterCells(data, width, rowRect);
    if (cells.length !== 4) return { stats, aptitudes: [] };
    for (const [cx0, cx1] of cells) {
      const box = { x: cx0, y: rowRect.y, w: cx1 - cx0, h: rowRect.h };
      const tight = tightInkRect(data, width, box, isRankInk);
      aptitudes.push(tight ? padCropRect(tight, box, width) : null);
    }
  }
  return { stats, aptitudes };
}

// ---- ステータス値（詳細画面モーダル、現在評価点の算出用） ----
// 詳細モーダルは固定レイアウト。スピード〜賢さの5値がオレンジ数字で横一列に
// 並び、各セルは上段=現在値・下段="/最大値"の2段構成。両段ともオレンジの
// 横帯を成す。ステータスが上限に達したセルは現在値が数字ではなく "MAX" 表記に
// なるため、その場合は下段の"/最大値"（=現在値）から読む。
//
// 数字の字形はスキル必要SP（茶色・小さめ）とは別フォント（大きい橙数字）の
// ため専用アトラス stat_digit_atlas.json を用いる（複数テンプレートを "数字#連番"
// のキーで格納。matchGlyph が返すキーの "#" 以降を落として数字に還元する）。
//
// 既知の限界（適性ランク帯と同種）: 縦位置は解像度比に依存し、アスペクト比が
// 大きく異なる端末ではズレうる。実測 1080×2412 / 1206×2622 の両方で検証済み。
const STAT_KEYS_ORDER = ["speed", "stamina", "power", "guts", "wisdom"];
const STAT_REGION_RATIO = { yTop: 0.29, yBottom: 0.37 };   // 現在値帯＋/最大値帯を包含
const STAT_BAND_MIN_HEIGHT = 10;      // これ未満の高さの帯は数字帯ではないノイズ
const STAT_MAXLABEL_ASPECT = 1.3;     // 単一断片の幅が帯高×これを超えたら"MAX"表記とみなす
// 桁間ギャップ上限（左のランクバッジと数字列を分離する）。帯の高さに対する比で持つ。
// 固定15pxだと高解像度端末で破綻する。実測1440x3200では桁間ギャップが17pxまで開き、
// 数字列が途中で分断されて先頭桁が落ちた（パワー1159→159）。同じ画像でバッジと
// 数字の間は26px空いており、帯高42pxに対して桁間0.40・バッジ間0.62なので、
// 0.5倍で両者を分けられる。1080px幅の既存サンプルでは 31×0.5≒15 と従来値に一致する。
const STAT_CLUSTER_GAP_RATIO = 0.5;

// ステータス数字の二値化。閾値を固定せず、切り出した矩形ごとに大津の方法で決める。
//
// 数字には2色ある。金色（実測 RGB 207,152,8 / R-B=199）と濃い茶色（167,108,66 / R-B=101）で、
// 保有Pt用の固定閾値（R>150 かつ R-B>60）だと濃い茶色は輪郭のアンチエイリアス部分から
// 削れていき、字形が痩せて別の数字に化ける。デコードの微差で結果が揺れていたのもこれが原因。
// 実測: 金色のセルは全て正解、濃い茶色のセルは5枚中5枚で誤読。
//
// R-B を指標にするのは、背景（白〜薄灰）が R≒B で小さく、数字は金でも茶でも大きいため。
// 矩形ごとに閾値を決めるので、色が変わっても追随する。
function statDigitInk(data, width, rect) {
  const w = rect.w, h = rect.h;
  const value = new Uint8Array(w * h);
  const histogram = new Int32Array(256);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((rect.y + y) * width + (rect.x + x)) * 4;
      const d = Math.max(0, Math.min(255, data[i] - data[i + 2]));
      value[y * w + x] = d;
      histogram[d]++;
    }
  }
  const total = w * h;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let sumBelow = 0, countBelow = 0, bestVariance = 0, threshold = 0;
  for (let t = 0; t < 256; t++) {
    countBelow += histogram[t];
    if (countBelow === 0) continue;
    const countAbove = total - countBelow;
    if (countAbove === 0) break;
    sumBelow += t * histogram[t];
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (sum - sumBelow) / countAbove;
    const variance = countBelow * countAbove * (meanBelow - meanAbove) * (meanBelow - meanAbove);
    if (variance > bestVariance) { bestVariance = variance; threshold = t; }
  }
  const ink = new Uint8Array(w * h);
  for (let k = 0; k < value.length; k++) ink[k] = value[k] > threshold ? 1 : 0;
  return { data: ink, w, h };
}

// オレンジ数字のインク判定。橙は R高・G中・B低。灰/緑バッジ・白地を排除する。
function statOrangeInk(r, g, b) {
  return r > 150 && (r - b) > 60 && (r - g) > 25 && g < 170;
}

// ステータス数値帯（現在値帯・/最大値帯）の [yTop,yBottom) を上から順に返す。
function statOrangeBands(data, width, height) {
  const y0 = Math.round(height * STAT_REGION_RATIO.yTop);
  const y1 = Math.round(height * STAT_REGION_RATIO.yBottom);
  const rowInk = [];
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (statOrangeInk(data[i], data[i + 1], data[i + 2])) c++;
    }
    rowInk.push(c);
  }
  const peak = Math.max(...rowInk);
  const thr = Math.max(30, peak * 0.2);
  const bands = [];
  let start = -1;
  for (let k = 0; k < rowInk.length; k++) {
    if (rowInk[k] > thr) { if (start < 0) start = k; }
    else if (start >= 0) { bands.push([y0 + start, y0 + k]); start = -1; }
  }
  if (start >= 0) bands.push([y0 + start, y1]);
  // 現在値帯と/最大値帯は近接し、境界の単一行スパイクで微小帯に割れることが
  // あるため、実際の文字帯の高さに満たない帯を捨ててから上位2帯を採る。
  return bands.filter(b => b[1] - b[0] >= STAT_BAND_MIN_HEIGHT).slice(0, 2);
}

// セル内の数字列の断片[x0,x1)群を返す。数字は右寄せ・字間ギャップは小さく、
// 左のランクバッジとの間には大きな隙間があるため、最右クラスタ＝数字列となる。
// padY: 帯の上下に足す余白。現在値帯と"/最大値"帯は数pxしか離れていないことがあり
// （実測1440x3200では2px）、既定の3pxだと隣の帯の文字の上端を矩形に巻き込む。
// 呼び出し側が隣の帯までの距離から決める。
// セル内の「最右クラスタ＝数字列」の x 範囲。左のランクバッジと数字の間には
// 大きな隙間があるので、そこで切れば数字だけが残る。
// 探索はセル右端から少しだけはみ出させる（数字が右へ僅かに食み出すため）。
// 幅比で持つ（1080px幅での実測16pxに合わせる）。
const STAT_CELL_OVERHANG_RATIO = 16 / 1080;

function statDigitClusterX(data, width, band, cellIndex) {
  const cellWidth = width / 5;
  const xLeft = Math.round(cellIndex * cellWidth);
  const cellRight = Math.round((cellIndex + 1) * cellWidth);
  const xRight = cellRight + Math.round(width * STAT_CELL_OVERHANG_RATIO);
  const col = new Int32Array(width);
  for (let x = xLeft; x < xRight; x++) {
    let c = 0;
    for (let y = band[0]; y < band[1]; y++) {
      const i = (y * width + x) * 4;
      if (statOrangeInk(data[i], data[i + 1], data[i + 2])) c++;
    }
    col[x] = c;
  }
  const runs = [];
  let x = xLeft;
  while (x < xRight) {
    if (col[x] > 2) { const s = x; while (x < xRight && col[x] > 2) x++; runs.push([s, x]); }
    else x++;
  }
  if (runs.length === 0) return null;
  const gapMax = (band[1] - band[0]) * STAT_CLUSTER_GAP_RATIO;
  const clusters = [];
  let cur = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    if (runs[i][0] - cur[cur.length - 1][1] <= gapMax) cur.push(runs[i]);
    else { clusters.push(cur); cur = [runs[i]]; }
  }
  clusters.push(cur);
  // セル境界より右から始まる塊は隣のセルのもの。はみ出し分の探索は「数字の食み出し」を
  // 拾うためのもので、隣のランクバッジまで拾うと最右クラスタがそれになってしまう
  // （実測1440x3200: 根性セルが隣の金バッジの左端9pxを掴み、1123が1になった）。
  const own = clusters.filter(c => c[0][0] < cellRight);
  if (own.length === 0) return null;
  const cluster = own[own.length - 1];
  return [cluster[0][0], cluster[cluster.length - 1][1]];
}

// padY: 帯の上下に足す余白。現在値帯と"/最大値"帯は数pxしか離れていないことがあり
// （実測1440x3200では2px）、既定の3pxだと隣の帯の文字の上端を矩形に巻き込む。
// 呼び出し側が隣の帯までの距離から決める。
function statCellCells(data, width, band, cellIndex, padY = 3) {
  const clusterX = statDigitClusterX(data, width, band, cellIndex);
  if (clusterX === null) return null;

  const rect = {
    x: clusterX[0] - 2, y: band[0] - padY,
    w: (clusterX[1] - clusterX[0]) + 4, h: (band[1] - band[0]) + padY * 2,
  };
  const ink = isolateDigitRowBand(statDigitInk(data, width, rect));
  const { frags, col: fragCol } = inkFragments(ink);
  const cells = frags.filter(c => {
    const w = c[1] - c[0];
    if (w < ink.h * DIGIT_MIN_WIDTH_RATIO) return false;
    let maxDensity = 0;
    for (let fx = c[0]; fx < c[1]; fx++) maxDensity = Math.max(maxDensity, fragCol[fx]);
    return maxDensity >= ink.h * DIGIT_MIN_DENSITY_RATIO;
  });
  return { ink, cells };
}

// 断片群を数字文字列にする（statアトラスのキー "数字#連番" を数字へ還元）。
function statDigitsOf(cellData, atlas, dropFirstFragment) {
  let cells = cellData.cells;
  if (dropFirstFragment) cells = cells.slice(1);   // "/最大値"の先頭スラッシュを捨てる
  return cells.map(c => matchGlyph(normalizeGlyph(cellData.ink, c), atlas).split("#")[0]).join("");
}

// 現在値セルが "MAX" 表記か（3文字が連結し1つの幅広断片になる）。
function statIsMaxLabel(cellData) {
  return cellData.cells.length === 1
    && (cellData.cells[0][1] - cellData.cells[0][0]) > cellData.ink.h * STAT_MAXLABEL_ASPECT;
}

// 詳細画面から5ステータスの現在値を認識する。
// 戻り値: { speed, stamina, power, guts, wisdom }（読めなかった値は null）。
function recognizeStatsImage(data, width, height, statAtlas) {
  const bands = statOrangeBands(data, width, height);
  if (bands.length === 0) return null;
  // 2つの帯が近接している場合、余白が隣の帯へ届かないところまで詰める。
  const bandGap = bands[1] ? bands[1][0] - bands[0][1] : Infinity;
  const padY = Math.max(0, Math.min(3, Math.floor(bandGap / 2)));
  const out = {};
  for (let ci = 0; ci < 5; ci++) {
    const currentCell = statCellCells(data, width, bands[0], ci, padY);
    let value = null;
    if (currentCell && !statIsMaxLabel(currentCell)) {
      const s = statDigitsOf(currentCell, statAtlas, false);
      if (/^\d+$/.test(s)) value = parseInt(s, 10);
    }
    // 現在値が"MAX"表記または読めなかったときは、下段"/最大値"（=現在値）から読む。
    if (value === null && bands[1]) {
      const maxCell = statCellCells(data, width, bands[1], ci, padY);
      if (maxCell) {
        const s = statDigitsOf(maxCell, statAtlas, true);
        if (/^\d+$/.test(s)) value = parseInt(s, 10);
      }
    }
    out[STAT_KEYS_ORDER[ci]] = value;
  }
  return out;
}

// ---- 称号・キャラ名（詳細画面モーダル、キャラクターカードID特定用） ----
// 詳細画面ヘッダーのキャラ絵の右側には、上から順に必ず3行が並ぶ:
//   [称号]（二つ名）／ キャラ名 ／ 覚醒Lv N
// いずれも茶色文字。かつては固定の解像度比で切り出していたが、比率は
// アスペクト比が変わると約0.008ずれ（実測: 1080×2412 vs 1206×2622）、
// 称号と名前の行間（隙間）より大きいため、単一比率では両解像度でtightに
// 切り出せず名前が見切れて誤読した（§10.14の限界が顕在化）。
//
// そこで固定比率をやめ、ヘッダー領域の茶色文字行を検出して構造で特定する。
// 「最も幅広い行＝名前」は不成立（称号の方が長いことがある。例: ウオッカの
// [不凍のアクア・ウィタエ]）。上から数えた行順が常に [称号, 名前, 覚醒Lv]
// で安定しているため、名前＝2行目・称号＝1行目とする。
const CHARACTER_INFO_SEARCH = {
  xLeftRatio: 0.40, xRightRatio: 0.97,   // キャラ絵より右・共有アイコンより左
  yTopRatio: 0.16, yBottomRatio: 0.27,   // ヘッダー帯（称号〜覚醒Lv）を包含
  brightMax: 130, rMinusB: 20,           // 茶色文字のインク条件（spDigitInkと同系）
  minRowInk: 8,                          // 行とみなす最小の横インク画素数
  yPad: 5, xPad: 8,                      // 切り出しの余白
};

// 茶色文字の行を y方向に検出し、[称号行, 名前行, 覚醒Lv行...] の矩形配列を返す。
function detectCharacterInfoRows(data, width, height) {
  const c = CHARACTER_INFO_SEARCH;
  const x0 = Math.floor(width * c.xLeftRatio), x1 = Math.floor(width * c.xRightRatio);
  const yStart = Math.floor(height * c.yTopRatio), yEnd = Math.floor(height * c.yBottomRatio);
  const isInk = (x, y) => {
    const i = (y * width + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return (r - b) > c.rMinusB && (r * 0.3 + g * 0.59 + b * 0.11) < c.brightMax;
  };

  const rows = [];
  let y = yStart;
  while (y < yEnd) {
    let rowCount = 0;
    for (let x = x0; x < x1; x++) if (isInk(x, y)) rowCount++;
    if (rowCount <= c.minRowInk) { y++; continue; }
    const yTop = y;
    while (y < yEnd) {
      let cnt = 0;
      for (let x = x0; x < x1; x++) if (isInk(x, y)) cnt++;
      if (cnt <= c.minRowInk) break;
      y++;
    }
    // この行の左右インク端でxを絞る（称号の角括弧・名前の全幅を含む）
    let lo = x1, hi = x0;
    for (let yy = yTop; yy < y; yy++) {
      for (let x = x0; x < x1; x++) if (isInk(x, yy)) { if (x < lo) lo = x; if (x > hi) hi = x; }
    }
    rows.push({
      x: Math.max(0, lo - c.xPad), y: Math.max(0, yTop - c.yPad),
      w: (hi - lo) + c.xPad * 2, h: (y - yTop) + c.yPad * 2,
    });
  }
  return rows;
}

// 詳細画面から称号行・名前行の矩形を返す。行検出に失敗した場合は null。
function characterInfoRects(data, width, height) {
  const rows = detectCharacterInfoRows(data, width, height);
  if (rows.length < 2) return null;
  return { title: rows[0], name: rows[1] };   // 上から [称号, 名前, 覚醒Lv]
}

// ---- 獲得済み行の検出 ----
// 「獲得済」ラベル（マゼンタ寄りピンク）を色検出する。取得済みスキルの下地色
// （固有=虹色/金/緑）に引きずられないよう、ラベルの色そのものを判定基準にする。
const ACQUIRED_LABEL = { rMin: 160, gMax: 105, rMinusG: 80, rMinusB: 40 };
const ACQUIRED_X_RATIO = 0.72;   // ラベルは行の右寄りに出る
const ACQUIRED_MIN_ROW_PIXELS = 12;
const ACQUIRED_BAND_GAP = 15;
// 完全な「獲得済」バッジの高さは実測35〜37px。見切れ（行の一部だけが
// 画面内にあり、対応する名前テキストが読み取れない）ケースは実測6〜25px
// まで様々な潰れ方をする（目視確認: 高さ25pxの個体も名前テキストは完全に
// 画面外で読み取り不能だった）。完全なバッジより明確に低いしきい値30を
// 使い、見切れ個体をバッジ検出の時点で除外する（§10.17）。
const ACQUIRED_MIN_BAND_HEIGHT = 30;

// リスト領域（yStart以上yEnd未満）に限定して獲得済み行のy中心一覧を返す。
// yStart/yEndを渡さない場合はヘッダ・フッタ誤検出を避けるため呼び出し側で
// 絞り込むこと（実測: ヘッダの「トレーナーガイドON」バッジ、フッタの
// ソート設定バー内「獲得済」フィルタ表示チップが、いずれも本物の獲得済み
// ラベルと同系統の色で誤検出する。§10.13・§10.17）。
function detectAcquiredRowCenters(data, width, height, yStart = 0, yEnd = height) {
  const c = ACQUIRED_LABEL;
  const xStart = Math.floor(width * ACQUIRED_X_RATIO);
  const yLimit = Math.min(height, yEnd);
  const perRow = new Int32Array(height);
  for (let y = yStart; y < yLimit; y++) {
    let count = 0;
    for (let x = xStart; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > c.rMin && g < c.gMax && r - g > c.rMinusG && r - b > c.rMinusB) count++;
    }
    perRow[y] = count;
  }
  const ys = [];
  for (let y = yStart; y < yLimit; y++) if (perRow[y] > ACQUIRED_MIN_ROW_PIXELS) ys.push(y);
  if (ys.length === 0) return [];
  const bands = [];
  let s = ys[0], prev = ys[0];
  for (let k = 1; k < ys.length; k++) {
    const y = ys[k];
    if (y - prev > ACQUIRED_BAND_GAP) { bands.push([s, prev]); s = y; }
    prev = y;
  }
  bands.push([s, prev]);
  return bands
    .filter(([top, bot]) => (bot - top) >= ACQUIRED_MIN_BAND_HEIGHT)
    .map(([top, bot]) => (top + bot) >> 1);
}
