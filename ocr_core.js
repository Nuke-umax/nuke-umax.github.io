// スキル獲得画面の行アンカー検出とフィールド切り出し（ブラウザcanvas版）。
// Python POC(poc_anchor.py)で実証した幾何をJSへ移植したもの。
// 設計方針: アンカー＝緑「＋」ボタン。切り出し窓は全て
//   ・横 … 画像幅Wの比率、またはボタン幅の倍数
//   ・縦 … 検出したボタン高さ(bandHeight)の倍数
// で定義する。絶対座標・絶対色マッチを持たないため、他解像度へスケールし、
// 将来④B（左アイコンのアンカー検出）へ破壊的変更なしで拡張できる。

const OCR_CONFIG = {
  // 緑「＋」ボタンの色条件（下地に依存しない緑）。
  //
  // gMin は「明るさ」ではなく「緑であること」の最低条件にとどめる。所持スキルPtが
  // 足りない行の＋ボタンは減光表示になり、色相は同じまま暗くなるためである
  // （実測 1206×2622: 通常の緑は g の中央値192、減光時は122。gMin=140 では
  //  減光した行が1つも拾えず、18枚すべてで＋ボタン行の検出が0件になった。
  //  さらに＋ボタン行が消えると行ピッチの推定も崩れ、同じ画像の獲得済み行まで
  //  巻き添えで読めなくなる）。
  // 実測での安定域は gMin=100〜130（この範囲では新旧6枚すべてで検出数が不変）。
  // その中央付近を採り、上下に余裕を持たせる。色の判別は g-r / g-b の色相差が担う。
  plus: {
    gMin: 115, rMax: 160, bMax: 110, grDiff: 30, gbDiff: 60,
    rightRegionRatio: 0.80,   // ＋ボタンは画面右側に限定
    minGreenPerRowRatio: 0.012, // 行と判定する最小緑画素数 ÷ W
    bandGapRatio: 0.008,        // これ以上離れたら別バンド ÷ W
    minBandHeightRatio: 0.018,  // 見切れ行を除外する最小バンド高 ÷ W
  },
  // 必要SP数値ボックス（＋ボタン左端からボタン幅の倍数で相対指定）
  spBox: {
    leftFactor: 2.6,   // x_left = x_plus_left - buttonWidth * 2.6
    rightGapPx: 2,     // x_right = x_plus_left - 2
    halfHeightFactor: 0.55, // 縦半幅 = bandHeight * 0.55
  },
  // 名前テキスト領域（横は画像幅比率、縦はバンド高の倍数）
  name: {
    xLeftRatio: 0.197, xRightRatio: 0.611,
    topFactor: -1.21, bottomFactor: 0.05, // 中心からの縦オフセット ÷ bandHeight
  },
  // 進化ⓘバッジ（名前の下・青い「i」円を色検出）
  evolution: {
    xLeftRatio: 0.185, xRightRatio: 0.435,
    topFactor: 0.10, bottomFactor: 1.46,  // 中心からの縦オフセット ÷ bandHeight
    blueMin: 120, blueOverR: 15, blueOverG: 10,
    minBluePixelRatio: 0.003, // 進化ありと判定する青画素数 ÷ サブ領域画素数
  },
};

// RGBA配列(ImageData.data)から緑「＋」ボタンの行バンドを検出する。
// 戻り値: [{ yCenter, xPlusLeft, xPlusRight, bandTop, bandBottom }, ...]
function detectPlusButtonRows(data, width, height, config = OCR_CONFIG) {
  const cfg = config.plus;
  const rightRegionStart = Math.floor(width * cfg.rightRegionRatio);
  const greenPerRow = new Int32Array(height);
  const rowGreenRightEdge = new Int32Array(height); // 参考用（未使用でも将来用に保持しない）

  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = rightRegionStart; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const isPlus = g > cfg.gMin && r < cfg.rMax && b < cfg.bMax
        && g - r > cfg.grDiff && g - b > cfg.gbDiff;
      if (isPlus) count++;
    }
    greenPerRow[y] = count;
  }

  const minGreen = width * cfg.minGreenPerRowRatio;
  const bandGap = Math.max(4, width * cfg.bandGapRatio);
  const minBandHeight = width * cfg.minBandHeightRatio;

  // 緑画素の多い行を連続バンドにまとめる
  const bands = [];
  let bandStart = -1, prev = -1;
  for (let y = 0; y < height; y++) {
    if (greenPerRow[y] > minGreen) {
      if (bandStart < 0) bandStart = y;
      else if (y - prev > bandGap) { bands.push([bandStart, prev]); bandStart = y; }
      prev = y;
    }
  }
  if (bandStart >= 0) bands.push([bandStart, prev]);

  const rows = [];
  for (const [top, bottom] of bands) {
    if (bottom - top < minBandHeight) continue; // 見切れ行を除外
    const yCenter = (top + bottom) >> 1;
    // バンド内で＋ボタンの横範囲を求める
    let xLeft = width, xRight = 0;
    for (let y = top; y <= bottom; y++) {
      for (let x = rightRegionStart; x < width; x++) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const isPlus = g > cfg.gMin && r < cfg.rMax && b < cfg.bMax
          && g - r > cfg.grDiff && g - b > cfg.gbDiff;
        if (isPlus) { if (x < xLeft) xLeft = x; if (x > xRight) xRight = x; }
      }
    }
    rows.push({ yCenter, xPlusLeft: xLeft, xPlusRight: xRight, bandTop: top, bandBottom: bottom });
  }
  return rows;
}

// 1行の各フィールドの切り出し矩形を返す（描画・OCR共通）。
// 戻り値: { sp:{x,y,w,h}, name:{x,y,w,h}, evolution:{x,y,w,h} }
function fieldRects(row, width, config = OCR_CONFIG) {
  const bandHeight = row.bandBottom - row.bandTop;
  const buttonWidth = row.xPlusRight - row.xPlusLeft;
  const cy = row.yCenter;

  const sp = (() => {
    const c = config.spBox;
    const x = row.xPlusLeft - buttonWidth * c.leftFactor;
    const xr = row.xPlusLeft - c.rightGapPx;
    const half = bandHeight * c.halfHeightFactor;
    return { x: Math.round(x), y: Math.round(cy - half), w: Math.round(xr - x), h: Math.round(half * 2) };
  })();

  const name = (() => {
    const c = config.name;
    const x = width * c.xLeftRatio, xr = width * c.xRightRatio;
    const yt = cy + bandHeight * c.topFactor, yb = cy + bandHeight * c.bottomFactor;
    return { x: Math.round(x), y: Math.round(yt), w: Math.round(xr - x), h: Math.round(yb - yt) };
  })();

  const evolution = (() => {
    const c = config.evolution;
    const x = width * c.xLeftRatio, xr = width * c.xRightRatio;
    const yt = cy + bandHeight * c.topFactor, yb = cy + bandHeight * c.bottomFactor;
    return { x: Math.round(x), y: Math.round(yt), w: Math.round(xr - x), h: Math.round(yb - yt) };
  })();

  return { sp, name, evolution };
}

// 名前テキストバンドを探索で見つける（説明省略ON/OFFの違いに非依存）。
// fieldRects().name は固定オフセットでON専用だが、OFF（説明文あり）は
// 名前位置が大きく上へずれるため、Python(name_band.py)で検証した「カード内で
// 名前サイズの最上段バンドを探す」方式をここに移植する。探索窓をカード内
// （行ピッチ基準）に限定することでヘッダーや隣カードの誤検出を防ぐ。
const NAME_BAND_CONFIG = {
  xLeftRatio: 0.197, xRightRatio: 0.611,
  darkMax: 110,
  minTextRowRatio: 0.03,   // 文字行とみなす最小暗画素比率
  minHeightFactor: 0.42,   // 名前サイズとみなす最小バンド高 ÷ ＋ボタン高
  searchUpFactor: 0.48,    // 中心から上方向の探索範囲 ÷ ピッチ
  searchDownFactor: 0.10,  // 中心から下方向の探索範囲 ÷ ピッチ
};

// searchFloorY: この y より上は探索しない（省略時は画像上端まで）。
// リスト先頭行（ヘッダー直下）は、通常のピッチベースの上方探索窓
// （pitch×0.48、実測86px前後）がヘッダー〜キャラ絵領域まで届いてしまい、
// そこにある文字っぽい暗色領域（キャラの服の縁等）を名前と誤検出することが
// ある（実測: 探索窓を素朴にヘッダー方向へ広げた結果、キャラ絵が名前として
// 切り出された）。リスト開始位置（呼び出し側で判明している比率）を
// フロアとして渡すことで、先頭行に限らずどの行でもヘッダー領域への
// 侵入を防ぐ（§10.17）。
function findNameBand(data, width, height, row, pitch, config = NAME_BAND_CONFIG, searchFloorY = 0) {
  const buttonHeight = row.bandBottom - row.bandTop;
  const x0 = Math.floor(width * config.xLeftRatio);
  const x1 = Math.floor(width * config.xRightRatio);
  const ys = Math.max(searchFloorY, row.yCenter - Math.floor(pitch * config.searchUpFactor));
  const ye = Math.min(height, row.yCenter + Math.floor(pitch * config.searchDownFactor));

  const isTextRow = [];
  for (let y = ys; y < ye; y++) {
    let dark = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const bright = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
      if (bright < config.darkMax) dark++;
    }
    isTextRow.push(dark > (x1 - x0) * config.minTextRowRatio);
  }

  const rawBands = [];
  let bandStart = -1;
  for (let i = 0; i < isTextRow.length; i++) {
    if (isTextRow[i]) { if (bandStart < 0) bandStart = i; }
    else if (bandStart >= 0) { rawBands.push([bandStart, i]); bandStart = -1; }
  }
  if (bandStart >= 0) rawBands.push([bandStart, isTextRow.length]);

  // 「二」「三」のように横線主体の文字は、線と線の隙間で暗画素が一瞬途切れ、
  // 本来1つの文字バンドが複数の低いバンドに割れる。その結果 minHeight に届かず
  // 名前バンド未検出(null)になり、2文字名（無二・無三・圧倒等）が丸ごと脱落
  // していた（実測: 無二は h18+h6 に割れ、最小高20.16未満で消えた）。
  // 文字内部の隙間程度（＋ボタン高の1割）で隣接バンドを結合してから高さ判定する。
  const mergeGap = Math.max(2, Math.round(buttonHeight * 0.1));
  const bands = [];
  for (const b of rawBands) {
    const last = bands[bands.length - 1];
    if (last && b[0] - last[1] <= mergeGap) last[1] = b[1];
    else bands.push(b.slice());
  }

  const minHeight = buttonHeight * config.minHeightFactor;
  for (const [bTop, bBottom] of bands) {
    if (bBottom - bTop >= minHeight) return { top: ys + bTop, bottom: ys + bBottom };
  }
  return null;
}

// findNameBand の結果を fieldRects 互換の矩形にする（ON/OFF両対応の名前領域）。
function nameRectAdaptive(data, width, height, row, pitch, config = NAME_BAND_CONFIG, searchFloorY = 0) {
  const band = findNameBand(data, width, height, row, pitch, config, searchFloorY);
  if (band === null) return null;
  const x0 = Math.floor(width * config.xLeftRatio);
  const x1 = Math.floor(width * config.xRightRatio);
  return { x: x0, y: band.top - 4, w: x1 - x0, h: (band.bottom - band.top) + 8 };
}

// マスタの置き場所。開発中は webtool/ の1つ上、公開時は同じディレクトリに置く。
// 公開ビルドが webtool/ の中身をルートへ展開するため、位置が変わる。
// ビルド時にコードを書き換える方式は壊れやすいので、候補を順に試す方式にした。
// 公開側で無駄な404を出さないため、同ディレクトリを先に試す（開発時のみ1回404が出る）。
const MASTER_URL_CANDIDATES = ["skill_master_v10.json", "../skill_master_v10.json"];

async function fetchMasterJson(init) {
  for (const url of MASTER_URL_CANDIDATES) {
    const res = await fetch(url, init);
    if (res.ok) return res.json();
  }
  throw new Error("スキルマスタを読み込めませんでした");
}

// スキルアイコンの矩形。名前帯の左にある正方形アイコンで、確認・修正UIに出す。
// レイアウトは全て幅比で決まる（名前は幅の19.7%から始まる）ので、アイコンも比率で取る。
// 実測（1206px幅）: アイコンは x=68・一辺152px、名前帯の上端より14px上から始まる。
// 進化条件達成バッジがアイコン上端に少しかかる行があるが、識別には影響しない。
const ICON_RECT_RATIO = { x: 0.056, size: 0.126, topOffset: 0.012 };

// 確認・修正UIに出す名前帯サムネイルの矩形。切り出す高さを一定にする。
//
// nameRect の高さは字形次第で変わる（実測437行で幅比2.82%〜4.15%＝1.5倍の開き）。
// 幅は19.6%〜61.0%で全行同一なので、高さだけが違う画像を同じ高さに縮めて並べると
// 縮小率が行ごとに変わり、右端が不揃いに見える。高さを固定すれば縦横比が揃う。
// 実測の最大4.15%に余裕を持たせて4.5%とする（行間はピッチの17%なので隣へは食い込まない）。
// 未知の端末で帯がこれより高くても文字が切れないよう、下限として nameRect の高さも採る。
// その端末では縦横比が揃わないが、文字が欠けるより見た目の不揃いの方が軽い。
const NAME_THUMB_HEIGHT_RATIO = 0.045;

function thumbRectOf(nameRect, width, height) {
  const h = Math.max(Math.round(width * NAME_THUMB_HEIGHT_RATIO), nameRect.h);
  const y = Math.round(nameRect.y + nameRect.h / 2 - h / 2);
  return { x: nameRect.x, y: Math.max(0, Math.min(height - h, y)), w: nameRect.w, h };
}

function iconRectOf(nameRect, width) {
  const size = Math.round(width * ICON_RECT_RATIO.size);
  return {
    x: Math.round(width * ICON_RECT_RATIO.x),
    y: Math.max(0, nameRect.y - Math.round(width * ICON_RECT_RATIO.topOffset)),
    w: size, h: size,
  };
}

// 進化ⓘバッジの有無を青画素数で判定する。
function hasEvolutionFlag(data, width, rect, config = OCR_CONFIG) {
  const c = config.evolution;
  let blue = 0, total = 0;
  const x1 = Math.max(0, rect.x), x2 = rect.x + rect.w;
  const y1 = Math.max(0, rect.y), y2 = rect.y + rect.h;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (b > c.blueMin && b - r > c.blueOverR && b - g > c.blueOverG) blue++;
      total++;
    }
  }
  return blue >= total * c.minBluePixelRatio;
}

// 検出したバンド中心列から代表ピッチを求める。
//
// 単純な最小値ではなく「中央値の半分未満の間隔を外れ値として除いた上での
// 最小値」を使う。
//
// 最小値だけだと2つの理由で壊れる:
// (a) 水増し側: 獲得済み行（＋ボタンが無くdetectPlusButtonRowsが検出しない）
//     が挟まると、その前後の間隔は本来のピッチの整数倍（2倍・3倍…）になる。
//     行数が少ない画像ではこれが中央値に選ばれ、ピッチが実際の2倍等に狂う
//     （実測: 獲得済み行1つを挟んだ4行の画像で中央値=368、真のピッチ184）。
// (b) 過小側: 画面下端の固定フッター（ソート設定バー内の「獲得済」フィルタ
//     表示チップ）が、たまたまリスト最終行の獲得済みバッジのすぐ近くに
//     写り込むと、間隔が実測26pxのような異常に小さい値になる。これが
//     最小値としてそのまま採用されると探索窓が狭くなりすぎ、全行が
//     名前バンド未検出（null）で失われる（実測: この1件だけで画像1枚が
//     まるごと0行になった）。
//
// 中央値の半分未満の間隔は「同一行由来の重複検出」等のノイズとみなして
// 除外し、残った間隔の最小値を採る。真の行ピッチは複数箇所で繰り返し
// 現れるため中央値自体は水増し・過小どちらにも強く、それを基準にする
// ことで両方の外れ値を同時に弾ける。
//
// extraYCenters（省略可）に獲得済み行のy中心（detectAcquiredRowCenters）を
// 渡すと、＋ボタン行だけでは埋まらない抜けを補って真のピッチをより確実に
// 復元できる（1画像内の＋ボタン行が2つしかなく、間に獲得済み行が複数挟まる
// ケースは＋ボタン行だけでは原理的に真のピッチへ到達できない。§10.13）。
function medianPitch(rows, extraYCenters = []) {
  const allY = [...rows.map(r => r.yCenter), ...extraYCenters].sort((a, b) => a - b);
  if (allY.length < 2) return null;
  const diffs = [];
  for (let i = 1; i < allY.length; i++) diffs.push(allY[i] - allY[i - 1]);
  if (diffs.length === 1) return diffs[0];
  const sorted = diffs.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const plausible = sorted.filter(d => d >= median * 0.5);
  return Math.min(...(plausible.length ? plausible : sorted));
}
