// ステータス値（スピード等）→ 評価点（査定値）への変換。
// 目標評価ランク制約付き最大化（改修計画§3）で「現在の総合評価点」を
// ツール側で算出するために使う。
//
// 出典と検証:
//  - 計算式は umakonga「評価点計算」(GitHub Pages・オープンソース)から抽出した
//    ゲームの査定式そのもの。https://umakonga-t.github.io/hyokatenCalc/
//  - GameWith「評価点の計算式まとめ」の参照値5点と完全一致を確認済み:
//    ステ100→66 / 600→1143 / 1000→2635 / 1100→3171 / 1200→3841。
//  - 3区間の階段関数。ステが高いほど1あたりの評価点が大きい（特化型が有利）
//    というゲームの仕様と整合する。
//
// 未確認: 育成完了リザルトの総合評価点（＝ステ＋固有Lv＋獲得スキルの合算）
//   との突合は、実サンプル入手後に別途行う（改修計画§3.4「精度の担保」）。

const STAT_EVAL_MAX = 2500;   // ステータス上限クランプ（umakonga定数 k）

// 1200以下の区間の1ステあたり係数（49・99の区切りの後、50ごとに1段上がる）。
const STAT_EVAL_TIER1 = [
  5, 8, 10, 13, 16, 18, 21, 24, 26, 28, 29, 30, 31, 33, 34, 35, 39, 41, 42, 43,
  52, 55, 66, 68, 68,
];
// 1201〜2000の区間の係数（1209・1219の区切りの後、10ごとに1段上がる）。
// 基点 38413 は 1200 までの累積生値（round(38413/10)=3841 が参照値と一致）。
const STAT_EVAL_TIER2_BASE = 38413;
const STAT_EVAL_TIER2 = [
  79, 80, 81, 83, 84, 85, 86, 88, 89, 90, 92, 93, 94, 96, 97, 98, 100, 101, 102, 103,
  105, 106, 107, 109, 110, 111, 113, 114, 115, 117, 118, 119, 121, 122, 123, 124, 126, 127, 128, 130,
  131, 132, 134, 135, 136, 138, 139, 140, 141, 143, 144, 145, 147, 148, 149, 151, 152, 153, 155, 156,
  157, 159, 160, 161, 162, 164, 165, 166, 168, 169, 170, 172, 173, 174, 176, 177, 178, 179, 181, 182,
  182,
];
// 2001超の区間の基点と初期係数（25ごとに係数+1）。
const STAT_EVAL_TIER3_BASE = 142796;
const STAT_EVAL_TIER3_START_COEFF = 183;

// 単一ステータス値の評価点。ゲーム表示と同じく各ステ個別に算出する。
function statEval(value) {
  const t = Math.max(0, Math.min(STAT_EVAL_MAX, Math.floor(value)));
  if (t === 0) return 0;

  let raw;
  if (t <= 1200) {
    let tier = 0, sum = 0;
    for (let c = 1; c <= t; c++) {
      if (c <= 49) tier = 0;
      else if (c <= 99) tier = 1;
      else if (c % 50 === 0) tier++;
      sum += STAT_EVAL_TIER1[tier];
    }
    raw = sum;
  } else if (t <= 2000) {
    let tier = 0, sum = STAT_EVAL_TIER2_BASE;
    for (let c = 1201; c <= t; c++) {
      if (c <= 1209) tier = 0;
      else if (c <= 1219) tier = 1;
      else if (c % 10 === 0) tier++;
      sum += STAT_EVAL_TIER2[tier];
    }
    raw = sum;
  } else {
    let block = 0, sum = STAT_EVAL_TIER3_BASE, coeff = STAT_EVAL_TIER3_START_COEFF;
    for (let c = 2001; c <= t; c++) {
      if (block >= 25) { coeff++; block = 0; }
      sum += coeff;
      block++;
    }
    raw = sum;
  }
  return Math.round(raw / 10);
}

// 5ステータスの合計ステータス評価点。
// stats: { speed, stamina, power, guts, wisdom }（現在値）。
function totalStatEval(stats) {
  return statEval(stats.speed) + statEval(stats.stamina) + statEval(stats.power)
    + statEval(stats.guts) + statEval(stats.wisdom);
}
