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
    // ＋ボタンは「買えない行」で減光される。所持スキルPtが少ないキャラでは全行が
    // 減光され、しきい値が高いと未取得行を1つも検出できない
    // （実測: 保有12ptのキャラで20枚すべて検出0。未取得31行が丸ごと消えていた）。
    //
    // ボタン面の実測（1206px幅）:
    //   買える    R105 G194 B15   g-r=89  g-b=179
    //   買えない  R49  G76  B1    g-r=27  g-b=75
    // 減光側を確実に拾い、かつ他のUI要素を拾わない値にする。
    // 減光ボタンは青成分がほぼ0で g-b が大きく、他の暗色と区別できる。
    gMin: 60, rMax: 160, bMax: 110, grDiff: 20, gbDiff: 50,
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

// スクロール終端に浮かぶ並び替えツールバー（「説明省略」ボタン）の上端yを返す。
// 見つからなければ null。
//
// このボタンより下に中心を持つ行は、必要SPの数値や字形がボタンに覆われて壊れる。
// 位置比の決め打ちでは端末差を吸収できない（実測: 同一解像度1206×2622でも
// Android系は画像高の80.60%、iPhone系は76.16%と4.43ポイント違う）。
// ボタン自体を色で見つければ、どちらにも追随できる。
//
// 手掛かりは「緑の横方向の連続長」。画面左下には緑のスキルアイコンも並ぶが、
// アイコンの緑は最大でも幅の9.2%しか続かない。ボタンは塗りつぶしなので19.2%続く
// （実測97枚。両者は完全に分離し、中間の15%を基準にできる）。
//
// バンドは緩い基準で作ってから最大連続長で絞ること。順序を逆にすると、白い文字
// 「説明省略」で緑が途切れる行が先に弾かれ、ボタンのバンドが成立しない。
// 横方向の比率は端末を選ばない。実測で、画面幅に対する比は縦横比の違う2機種で
// 0.03〜0.24%しか違わなかった（名前帯の幅0.03%・左端0.11%・高さ0.09%・
// ＋ボタンのx 0.24%）。ゲームUIは画面幅を基準にスケールし、余った縦に行を多く
// 表示する作りになっている。縦の位置だけが端末で動く（ツールバーは4.43ポイント）。
// スキル一覧の表示領域を、右端のスクロールバーの溝（トラック）から求める。
//
// なぜ必要か: 縦位置は端末で動く。ツールバー上端は色検出に移したが、リスト上端は
// まだ高さ比の決め打ち（35.5%）で、実測すると2機種で逆方向にずれていた
// （Android 機では溝の上端より26px下＝リストを削り、iPhone 機では57px上＝
//  ヘッダーへ侵入）。実害も出ており、Android の42枚中2枚で1行目が丸ごと捨てられて
// いた（「継続は力なり」「登山家」。隣のスクショに同じ行が写っていたため最終結果
// では表に出ていなかっただけ）。
//
// 溝はリストの表示領域そのものの縁なので、上端＝リスト上端・下端＝リスト下端。
//
// 横位置は決め打ちにしない。当初は2機種の実測（どちらも 0.970W）から
// 「幅比で端末非依存」と決め打ちしたが、3機種目（1440x3200）では 0.956W にあり
// 探索列を外した。しかも null に落ちず画面下部の暗部（2282〜画面下端3199）を
// 溝と誤認し、16枚で17行まで崩れた（ユーザーが実機で報告）。範囲を走査する。
//
// 明るさは絶対値で判定しない。溝の最明画素は 213〜227 で、固定しきい値 230 では
// 余裕が3しかなかった。代わりに「その列の背景よりどれだけ暗いか」で見る。
// 実測のコントラストは 16.8〜20.4 なので、しきい値はその下に置く。
const LIST_TRACK_CONFIG = {
  xFrom: 0.940, xTo: 0.995,   // 溝の横位置の探索範囲（幅比）。実測 0.956／0.971 を含む
  contrastMin: 12,          // 背景よりこれ以上暗ければ溝。実測の最小16.8の下に置く
  minLengthRatio: 0.25,     // 溝はリスト表示領域ぶん伸びる（高さ比）
  backgroundPercentile: 0.90,
  backgroundSkipRatio: 0.25,   // 上部はヘッダーのキャラ絵。背景の推定から外す
  bottomEdgeMargin: 2,      // 画面下端に接する暗部は溝ではない（下記）
};

function listTrackColumnBrightness(data, width, height, x) {
  const v = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const i = (y * width + x) * 4;
    v[y] = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
  }
  return v;
}

// 列の暗部の連続をすべて返す。最長の1本だけを返すと、その1本が下端に接していて
// 除外されたときに、同じ列にある本物の溝まで一緒に失う。
function listTrackRuns(v, height, threshold, yStart) {
  const runs = [];
  let start = -1;
  for (let y = yStart; y < height; y++) {
    if (v[y] < threshold) { if (start < 0) start = y; }
    else if (start >= 0) { runs.push([start, y - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, height - 1]);
  return runs;
}

// 戻り値: { top, bottom }（リスト表示領域の上端・下端）。見つからなければ null。
//
// searchStartY にはヘッダーの下端を渡す。ここから下だけを探すのが要点で、
// 「最も長い run を採る」だけではヘッダーのキャラ絵に負ける。リストが短い端末ほど
// 溝が短くなる一方、絵が作る暗部の長さは変わらないためである（実測: 縦横比1.55の
// 合成画像で、絵の609pxが溝の447pxを上回り、絵を溝と誤認して幻の行が2件生まれた）。
// 絵の濃さはキャラごとに違うので、縦横比だけの問題ではない。
//
// 画面下端に接する暗部は溝ではない。溝はツールバーの少し下で必ず終わり、画面の
// 縁までは伸びないためである。この規則が無いと、リストが短い端末で画面下部の暗部が
// 溝より長くなって勝つ（実測: 縦横比1.55の合成画像で、下端に接する471pxが本物の
// 溝443pxを上回った。1440x3200の実機でも下部の917pxを溝と誤認していた）。
function detectListTrack(data, width, height, searchStartY = 0, config = LIST_TRACK_CONFIG) {
  const yStart = Math.max(0, Math.min(Math.floor(searchStartY), height - 1));
  const minLength = height * config.minLengthRatio;
  const skip = Math.max(yStart, Math.floor(height * config.backgroundSkipRatio));
  const bottomEdge = height - 1 - config.bottomEdgeMargin;
  const xFrom = Math.floor(width * config.xFrom);
  const xTo = Math.min(width, Math.floor(width * config.xTo));
  let best = null;
  for (let x = xFrom; x < xTo; x++) {
    const v = listTrackColumnBrightness(data, width, height, x);
    const sample = Array.from(v.slice(skip)).sort((a, b) => a - b);
    const background = sample[Math.floor(sample.length * config.backgroundPercentile)];
    for (const [top, bottom] of listTrackRuns(v, height, background - config.contrastMin, yStart)) {
      if (bottom - top < minLength) continue;
      if (bottom >= bottomEdge) continue;              // 画面の縁まで伸びる＝溝ではない
      if (best === null || (bottom - top) > (best.bottom - best.top)) best = { top, bottom };
    }
  }
  return best;
}

// ヘッダーの下端。「現在のスキルPt」の緑ラベルの下端を使う。
// このラベルは実測134枚すべてで検出できており、溝の上端との間隔は
// Android機70px・iPhone機77pxの余裕がある。検出できなければ0（画像上端）を返し、
// 従来どおり全体から探す。
function headerBottomOf(data, width, height) {
  const bands = skillPointLabelBands(data, width, height);
  return bands.length === 0 ? 0 : bands[bands.length - 1].yBottom;
}

// 溝の上端から探索フロアまでの控えしろ（幅比）。
//
// 溝は角丸で、リストの表示領域より少し内側から始まる。溝の上端をそのまま
// フロアにすると1行目の名前帯を削る端末がある。実測で挟み込んだ許容範囲は
//   下限 0.0141（iPhone機: 1行目の名前が溝の上端より17px上から始まる）
//   上限 0.0630（Android機: ヘッダーの誤検出が現れる位置）
// その中間を採る。余裕は iPhone 側19px・Android 側36px。
const LIST_TOP_INSET_WIDTH_RATIO = 0.030;

// リスト上端（名前帯やラベルの探索フロア）を返す。
// 溝を取れない端末では従来どおり高さ比の決め打ちに落ちる（悪化はしない）。
function listTopOf(data, width, height, fallbackY, track) {
  const found = track === undefined
    ? detectListTrack(data, width, height, headerBottomOf(data, width, height)) : track;
  if (found === null) return fallbackY;
  return Math.max(0, Math.round(found.top - width * LIST_TOP_INSET_WIDTH_RATIO));
}

const TOOLBAR_CONFIG = {
  leftRegionRatio: 0.28,   // 「説明省略」は左端。中央の「決定」ボタンを避ける
  bandRunRatio: 0.015,     // バンドを作る緩い基準（幅比）
  buttonRunRatio: 0.15,    // ボタンと判定する最大連続長（幅比）
};

// searchStartY にはリストの上端を渡す。ここから下だけを探せば、リストより上にある
// 緑の要素（「シナリオ進化スキル」バッジ等）を拾わない。比率で決め打ちしない。
function detectToolbarTopY(data, width, height, searchStartY, config = OCR_CONFIG) {
  const cfg = config.plus, tb = TOOLBAR_CONFIG;
  const xEnd = Math.floor(width * tb.leftRegionRatio);
  const yStart = Math.max(0, Math.floor(searchStartY));
  const longestRun = new Int32Array(height);
  for (let y = yStart; y < height; y++) {
    let run = 0, best = 0;
    for (let x = 0; x < xEnd; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (g > cfg.gMin && r < cfg.rMax && b < cfg.bMax
          && g - r > cfg.grDiff && g - b > cfg.gbDiff) { run++; if (run > best) best = run; }
      else run = 0;
    }
    longestRun[y] = best;
  }

  const bandGap = Math.max(4, width * cfg.bandGapRatio);
  const minBandHeight = width * cfg.minBandHeightRatio;
  const minBandRun = width * tb.bandRunRatio;
  const minButtonRun = width * tb.buttonRunRatio;

  let start = -1, prev = -1;
  const closeBand = (top, bottom) => {
    if (bottom - top < minBandHeight) return null;
    let maxRun = 0;
    for (let y = top; y <= bottom; y++) if (longestRun[y] > maxRun) maxRun = longestRun[y];
    return maxRun >= minButtonRun ? top : null;
  };
  for (let y = yStart; y < height; y++) {
    if (longestRun[y] <= minBandRun) continue;
    if (start < 0) { start = y; }
    else if (y - prev > bandGap) {
      const top = closeBand(start, prev);
      if (top !== null) return top;      // 最も上のボタンバンドを採る
      start = y;
    }
    prev = y;
  }
  return start >= 0 ? closeBand(start, prev) : null;
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
  // 名前サイズとみなす最小バンド高 ÷ 画面幅。
  //
  // 以前は＋ボタン高の0.42倍としていたが、＋ボタン高は緑検出の揺れで幅比4.42〜5.39%と
  // 22%ばらつく。フォントサイズと無関係なばらつきが閾値に乗るため、たまたまボタンが
  // 大きく検出された行で本物の名前が弾かれた（実測: IMG_6225「パイオニア」は
  // バンド高26pxに対し最小高27.3pxで1.3px足りず、行ごと消えていた。ユーザーが報告）。
  //
  // 文字サイズは画面幅に比例する（縦横比の違う2機種で名前帯の高さの幅比が0.09%しか
  // 違わないことを実測済み）ので、幅を基準にすれば揺れが乗らない。
  // 全6キャラ611行の実測: 本物の名前は幅比2.130%以上、雑音は1.574%以下で重ならない。
  // その中間を採る。
  minHeightWidthRatio: 0.0185,
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

  const minHeight = width * config.minHeightWidthRatio;
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
