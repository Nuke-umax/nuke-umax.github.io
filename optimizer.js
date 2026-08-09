// スキル評価点最大化エンジン（optimizer_v10.py のJS移植）。
// 多肢選択ナップザック問題(MCKP)を動的計画法で厳密に解く。
//
// 評価点 = round_half_up(累積基礎点 × 適性倍率)。
// 倍率は {11,9,8,7}/10 の積。浮動小数だと 85×0.7=59.4999… で四捨五入が
// 59（正しくは60）にずれるため、分子/分母の整数で厳密に扱う。

const APTITUDE_FACTOR = {   // 適性ランク群 → 倍率（分子/分母）
  SA: { num: 11, den: 10 },
  BC: { num: 9, den: 10 },
  DEF: { num: 8, den: 10 },
  G: { num: 7, den: 10 },
};
const RANK_GROUPS_BEST_FIRST = ["SA", "BC", "DEF", "G"];
const RANK_TO_GROUP = {
  S: "SA", A: "SA", B: "BC", C: "BC", D: "DEF", E: "DEF", F: "DEF", G: "G",
};
const SURFACE_KEYS = new Set(["shiba", "dirt"]);

// 0.5切り上げの四捨五入。value = num/den（den>0、num は負もあり得る）。
// floor((2num + den) / (2den)) を整数で厳密に求める（浮動小数の誤差を補正）。
function roundHalfUp(num, den) {
  const a = 2 * num + den, b = 2 * den;
  let q = Math.floor(a / b);
  while (q * b > a) q--;
  while ((q + 1) * b <= a) q++;
  return q;
}

function normalizeRank(rank) {
  return (rank in APTITUDE_FACTOR) ? rank : RANK_TO_GROUP[rank];
}

// 条件グループから適性倍率(分子/分母)を求める。
// グループ内はOR（最良ランク採用）、グループ間はAND（積）。芝ダは既定で無視。
function aptitudeMultiplier(conditionGroups, aptitudes, surfaceEnabled = false) {
  let num = 1, den = 1;
  for (const group of conditionGroups) {
    const keys = group.filter(k => surfaceEnabled || !SURFACE_KEYS.has(k));
    if (keys.length === 0) continue;
    let bestIdx = Infinity;
    for (const k of keys) {
      const idx = RANK_GROUPS_BEST_FIRST.indexOf(normalizeRank(aptitudes[k]));
      if (idx < bestIdx) bestIdx = idx;
    }
    const f = APTITUDE_FACTOR[RANK_GROUPS_BEST_FIRST[bestIdx]];
    num *= f.num; den *= f.den;
  }
  return { num, den };
}

// スキル1件を最上位として取得したときの評価点。
function scoreOf(skill, aptitudes, surfaceEnabled = false) {
  const m = aptitudeMultiplier(skill.conditionGroups, aptitudes, surfaceEnabled);
  return roundHalfUp(skill.cumulativeScore * m.num, m.den);
}

// マスタを前処理する（skillId 索引と既定値）。masterはfetch済みのオブジェクト。
function loadMaster(master) {
  if (master.schemaVersion !== "1.0") throw new Error("schema v1.0 のマスタが必要です");
  master.uniqueSkills = master.uniqueSkills || [];
  master.scenarioSkills = master.scenarioSkills || [];
  master.unpurchasableSkills = master.unpurchasableSkills || [];
  for (const family of master.families) {
    const byId = new Map();
    for (const s of family.skills) byId.set(s.skillId, s);
    for (const e of family.evolutions) byId.set(e.skillId, e);
    family._skillById = byId;
    if (family.negativeSkill === undefined) family.negativeSkill = null;
    if (family.kind === undefined) family.kind = "normal";
  }
  return master;
}

// 指定キャラが所持している固有スキルを1つ返す（購入対象外・基準点）。
function uniqueSkillOfCharacter(master, characterCardId, talentAwakened = true) {
  if (characterCardId == null) return null;
  const candidates = master.uniqueSkills.filter(s => s.characterCardId === characterCardId);
  if (candidates.length === 0) return null;
  const matched = candidates.filter(s => s.isAwakened === talentAwakened);
  return matched.length ? matched[0] : candidates[0];
}

// 購入と無関係に得られている評価点（固有スキル分）。
function baselineScore(master, state) {
  const skill = uniqueSkillOfCharacter(master, state.characterCardId, state.talentAwakened !== false);
  if (skill === null) return 0;
  return scoreOf(skill, state.aptitudes, state.surfaceMultiplierEnabled === true);
}

// 進化フラグに応じて選択可能なプランを絞り込む。
//
// 進化先候補は「そのキャラ専用の進化（characterCardIdが一致）」または
// 「シナリオ進化等キャラ非依存の進化（characterCardIdがnull）」のみに限定
// する。以前は「キャラ専用の候補が0件ならフィルタ前の全候補（＝他キャラ
// 専用の進化まで含む）にフォールバックする」実装になっており、そのキャラ
// では絶対に入手できない他キャラの進化先を誤って提案しうるバグがあった。
//
// state.evolutionChoices は { [金スキルID]: 進化後skillId | "none" } の形式。
// "none" はユーザーが明示的に「進化しない」を選んだことを示し、元の金
// プランをそのまま維持する（進化プランへの置換をスキップする）。
function selectablePlans(family, state) {
  const evolved = state.evolvedGoldSkillIds || new Set();
  const choices = state.evolutionChoices || {};
  const characterCardId = state.characterCardId;
  const aptitudes = state.aptitudes;
  const surface = state.surfaceMultiplierEnabled === true;

  const plans = family.plans.filter(p => !p.usesEvolution);
  const evolutionPlans = family.plans.filter(p => p.usesEvolution);
  if (evolutionPlans.length === 0) return plans;

  const evolvedGolds = new Set(
    evolutionPlans.map(p => p.fromGoldSkillId).filter(id => evolved.has(id)));

  const result = [];
  for (const plan of plans) {
    const isEvolvingAway = evolvedGolds.has(plan.topSkillId) && choices[plan.topSkillId] !== "none";
    if (isEvolvingAway) continue;   // 進化に置換されるので金プランは除く
    result.push(plan);
  }

  for (const goldId of evolvedGolds) {
    if (choices[goldId] === "none") continue;   // 進化しない選択
    const candidates = evolutionPlans.filter(p =>
      p.fromGoldSkillId === goldId && (p.characterCardId === characterCardId || p.characterCardId == null));
    if (candidates.length === 0) continue;   // このキャラで入手できる進化先が無い
    const chosenId = choices[goldId];
    let chosen = candidates.find(p => p.topSkillId === chosenId);
    if (chosen === undefined) {
      // 指定がなければ倍率適用後の評価点が最も高い進化を採用（累積値では不可）
      chosen = candidates.reduce((best, p) =>
        scoreOf(family._skillById.get(p.topSkillId), aptitudes, surface) >
        scoreOf(family._skillById.get(best.topSkillId), aptitudes, surface) ? p : best);
    }
    result.push(chosen);
  }
  return result;
}

// 画面に出ている白ティアより下の白ティアは、取得済みだから一覧から消えている。
//
// ゲームは1ファミリーにつき白ティアを1行しか出さない（未取得なら次に買えるティア、
// 取得済みなら最上位ティアを「獲得済」として）。したがって下位が一覧に無いことは
// 「取得済み」の証拠になる。○を取得すると○の行は消え、◎が増分SPで表示される
// （実測: 中距離直線◎ の表示SP66 は ◎ の増分コスト110×ヒント割引0.6）。
//
// 見落とすと上位ティアを「新規取得」として丸ごと数える。実測: 中距離直線◎ が
// ○の239を引かずに288と出ていた（正しくは差分の49）。8キャラ中5キャラ・32件が
// 該当し、右回り◎・春ウマ娘◎・先行直線◎ のような適性/脚質系のありふれたスキル
// ばかりだった。上位ティアの価値が5〜6倍に見え、最適化が過剰に優先していた。
// ユーザーが実機で発見（2026-08-10）。
//
// 金ティア（rarity=2）は下位と独立に表示されるので対象外。白ティアだけを見る。
// availableSkillIds が null（スクショによる絞り込み無し）のときは全スキルが
// 「一覧にある」扱いになり、この推論は働かない（安全側）。
function impliedAcquiredWhites(family, state) {
  const acquired = state.acquired || new Set();
  const displayedCost = state.displayedCost || null;
  const available = state.availableSkillIds || null;
  const whites = family.skills.filter(s => s.rarity === 1).sort((a, b) => a.tier - b.tier);
  const isListed = (s) => acquired.has(s.skillId)
    || (displayedCost !== null && displayedCost.has(s.skillId))
    || (available !== null && available.has(s.skillId));
  const firstListed = whites.findIndex(isListed);
  return firstListed > 0 ? whites.slice(0, firstListed) : [];
}

// ファミリーから選べる (コスト, 評価点増分, プラン) を列挙する。
function enumerateFamilyOptions(family, state) {
  const aptitudes = state.aptitudes;
  const acquired = state.acquired || new Set();
  const available = state.availableSkillIds || null;   // null なら全スキルが候補
  const surface = state.surfaceMultiplierEnabled === true;
  // 表示SP（画面の割引後SP）。指定時はコストにこれを使う（引き継ぎ資料§2.5）。
  const displayedCost = state.displayedCost || null;
  const byId = family._skillById;

  // 一覧に無い下位の白ティアも取得済みとして数える（impliedAcquiredWhites 参照）。
  const acquiredHere = family.skills.filter(s => acquired.has(s.skillId))
    .concat(impliedAcquiredWhites(family, state));
  let currentScore = 0;
  if (acquiredHere.length) {
    const topAcquired = acquiredHere.reduce((a, b) =>
      b.cumulativeScore > a.cumulativeScore ? b : a);
    currentScore = scoreOf(topAcquired, aptitudes, surface);
  }

  const negative = family.negativeSkill;
  const negativeAcquired = negative !== null
    && (state.negativeSkillIds || new Set()).has(negative.skillId);
  if (negativeAcquired && acquiredHere.length === 0) {
    currentScore = scoreOf(negative, aptitudes, surface);
  }

  const options = [];
  if (negativeAcquired && negative.removalCost != null) {
    // 消去するだけでもマイナス分がなくなり評価点が上がる
    options.push({
      cost: negative.removalCost,
      score: -currentScore,
      plan: {
        name: `${negative.name} を消去`, topSkillId: negative.skillId,
        memberIds: [], usesEvolution: false, removesNegativeSkill: true,
      },
    });
  }
  // ヒント割引率の推定。表示されている白ティア（rarity=1）の 表示SP/baseCost。
  // 同一スキルのティア（○/◎）は同じヒントLvを共有するため割引は一律で、画面に
  // 出ない白上位ティア（○表示時の◎）の増分コストをこの率で見積もれる
  // （実測: 右回り○54/base90=0.6、◎増分110×0.6=66 が実表示と一致）。
  let hintDiscount = null;
  if (displayedCost !== null) {
    for (const s of family.skills) {
      if (s.rarity === 1 && s.baseCost > 0 && displayedCost.has(s.skillId)) {
        hintDiscount = displayedCost.get(s.skillId) / s.baseCost;
        break;   // family.skills はティア昇順。最下位の表示白ティアを採る
      }
    }
  }
  for (const plan of selectablePlans(family, state)) {
    const members = plan.memberIds;
    if (members.length === 0) continue;
    const top = byId.get(plan.topSkillId);
    const topDisplayed = displayedCost !== null && displayedCost.has(plan.topSkillId);
    // 白の上位ティア（◎）は、下位の白ティア（○）が表示されていれば画面に無くても
    // 獲得できる（ゲーム仕様）。金ティア(rarity=2)・進化は表示時のみ獲得可。
    const whiteInferable = top.rarity === 1 && hintDiscount !== null;
    if (!topDisplayed && !whiteInferable && available !== null
        && members.some(m => !available.has(m) && !acquired.has(m))) {
      continue;   // スクリーンショットに写っていないスキルは取得できない
    }
    // コスト:
    // ・topが表示されている場合、その表示SPは下位ティア分を含む累積値なので
    //   そのまま使う。member合算だと白+金を二重計上する（コンセントレーション217は
    //   集中力91を含むのに 91+217=308 としてしまう。実際は金217だけで取得可能）。
    // ・未表示の白上位ティア（◎）は、未取得memberのうち表示済みは実表示SP、
    //   未表示はbaseCost×ヒント割引で見積もって積む（○54＋◎推定66＝120）。
    // ・割引率が取れないときはbaseCost（増分）をそのまま積む従来方式。
    let cost;
    if (topDisplayed) {
      cost = displayedCost.get(plan.topSkillId);
    } else {
      cost = 0;
      for (const m of members) {
        if (acquired.has(m)) continue;
        if (displayedCost !== null && displayedCost.has(m)) cost += displayedCost.get(m);
        else if (whiteInferable) cost += Math.round(byId.get(m).baseCost * hintDiscount);
        else cost += byId.get(m).baseCost;
      }
    }
    const score = scoreOf(byId.get(plan.topSkillId), aptitudes, surface) - currentScore;
    if (cost === 0 && score <= 0) continue;
    if (score <= 0) continue;   // 取得済みより下がるプランは選ばない
    options.push({ cost, score, plan });
  }
  return options;
}

// 多肢選択ナップザック問題を動的計画法で厳密に解く。
function solveDp(master, state) {
  const budget = state.skillPoints;
  const familyOptions = [];
  const families = [];
  for (const family of master.families) {
    const options = enumerateFamilyOptions(family, state);
    if (options.length) { familyOptions.push(options); families.push(family); }
  }

  let dp = new Int32Array(budget + 1);
  const choices = familyOptions.map(() => new Uint8Array(budget + 1));

  for (let index = 0; index < familyOptions.length; index++) {
    const options = familyOptions[index];
    const newDp = dp.slice();   // 「このファミリーからは選ばない」が初期値
    const choiceRow = choices[index];
    for (let oi = 0; oi < options.length; oi++) {
      const { cost, score } = options[oi];
      if (cost > budget) continue;
      for (let j = budget; j >= cost; j--) {
        const candidate = dp[j - cost] + score;
        if (candidate > newDp[j]) { newDp[j] = candidate; choiceRow[j] = oi + 1; }
      }
    }
    dp = newDp;
  }

  const selected = [];
  let j = budget;
  for (let index = familyOptions.length - 1; index >= 0; index--) {
    const optionIndex = choices[index][j];
    if (optionIndex === 0) continue;
    const option = familyOptions[index][optionIndex - 1];
    selected.push({ family: families[index], ...option });
    j -= option.cost;
  }
  selected.reverse();

  const purchasedScore = selected.reduce((s, o) => s + o.score, 0);
  const baseline = baselineScore(master, state);
  return {
    totalScore: purchasedScore,
    baselineScore: baseline,
    totalScoreWithBaseline: purchasedScore + baseline,
    totalCost: selected.reduce((s, o) => s + o.cost, 0),
    selectedPlans: selected,
    warnings: [],
  };
}

// 目標評価ランクの上限を超えない範囲で評価点を最大化する（スコア次元DP）。
//
// 通常の solveDp は「コスト次元」DP（dp[SP]=最大評価点）で、評価点の上限
// 制約を表現できない。目標ランク指定時は「スコア次元」DPに切り替える:
//   dp[s] = 追加評価点ちょうど s を達成する最小コスト（s = 0..scoreCap）
//   答え  = dp[s] ≤ 保有SP を満たす最大の s
// これで「評価点 ≤ scoreCap（＝目標ランク上限を超えない）」かつ
// 「コスト ≤ 保有SP」を同時に満たす最大評価点が厳密に求まる（改修計画§3.5）。
//
// scoreCap = 目標ランク上限 − 現在の総合評価点（呼び出し側で算出して渡す）。
const SCORE_CAP_INFINITY = 0x7fffffff;
function solveDpScoreCapped(master, state, scoreCap) {
  const budget = state.skillPoints;
  const familyOptions = [];
  const families = [];
  for (const family of master.families) {
    const options = enumerateFamilyOptions(family, state);
    if (options.length) { familyOptions.push(options); families.push(family); }
  }

  // dp[s] = 追加評価点ちょうど s を達成する最小コスト。未到達は INF。
  const dp = new Int32Array(scoreCap + 1).fill(SCORE_CAP_INFINITY);
  dp[0] = 0;
  const choices = familyOptions.map(() => new Uint8Array(scoreCap + 1));

  for (let index = 0; index < familyOptions.length; index++) {
    const options = familyOptions[index];
    const choiceRow = choices[index];
    // 0/1ナップザック（各ファミリーから高々1プラン）。s降順で上書きを防ぐ。
    for (let s = scoreCap; s >= 0; s--) {
      let bestCost = dp[s];
      let bestOption = choiceRow[s];   // 既定（このファミリーを使わない）を保持
      for (let oi = 0; oi < options.length; oi++) {
        const { cost, score } = options[oi];
        if (score > s) continue;
        const prev = dp[s - score];
        if (prev === SCORE_CAP_INFINITY) continue;
        const candidate = prev + cost;
        if (candidate < bestCost) { bestCost = candidate; bestOption = oi + 1; }
      }
      dp[s] = bestCost;
      choiceRow[s] = bestOption;
    }
  }

  // 予算内で到達できる最大の追加評価点を探す。
  let bestScore = 0;
  for (let s = scoreCap; s >= 0; s--) {
    if (dp[s] <= budget) { bestScore = s; break; }
  }

  // choicesは「そのsに至る各ファミリーの選択」を記録していないため、
  // ファミリーを逆順にたどりながら残スコアを減らして復元する。
  const selected = [];
  let s = bestScore;
  for (let index = familyOptions.length - 1; index >= 0; index--) {
    const optionIndex = choices[index][s];
    if (optionIndex === 0) continue;
    const option = familyOptions[index][optionIndex - 1];
    selected.push({ family: families[index], ...option });
    s -= option.score;
  }
  selected.reverse();

  const purchasedScore = selected.reduce((sum, o) => sum + o.score, 0);
  const baseline = baselineScore(master, state);
  return {
    totalScore: purchasedScore,
    baselineScore: baseline,
    totalScoreWithBaseline: purchasedScore + baseline,
    totalCost: selected.reduce((sum, o) => sum + o.cost, 0),
    selectedPlans: selected,
    warnings: [],
    scoreCap,
  };
}

// 効率降順に貪欲採用する近似解（DPの検証用）。
function solveGreedy(master, state) {
  const budget = state.skillPoints;
  const candidates = [];
  for (const family of master.families) {
    for (const option of enumerateFamilyOptions(family, state)) {
      if (option.cost > 0) candidates.push([option.score / option.cost, family, option]);
    }
  }
  candidates.sort((a, b) => b[0] - a[0]);

  const usedFamilies = new Set();
  let remaining = budget;
  const selected = [];
  for (const [, family, option] of candidates) {
    if (usedFamilies.has(family.familyId) || option.cost > remaining) continue;
    usedFamilies.add(family.familyId);
    remaining -= option.cost;
    selected.push({ family, ...option });
  }
  return {
    totalScore: selected.reduce((s, o) => s + o.score, 0),
    totalCost: selected.reduce((s, o) => s + o.cost, 0),
    selectedPlans: selected,
  };
}

// 獲得済みスキルの評価点合計（現在の総合評価点の一部）。
// eval_validation_test.html で実サンプル4件に対し実機表示と完全一致を確認した
// 合算方式と同じく、同一ファミリーは最上位ティア（最大cumulativeScore、進化含む）
// のみを計上し、適性倍率をかけて合算する。シナリオ/購入不可スキルも加算する。
// 固有スキルは uniqueSkills 側でファミリー解決されないため自然に除外される
// （固有分は 170×固有Lv として呼び出し側で別途加算する）。
//
// state.acquired は buildOptimizerState が作る獲得済みskillIdの集合で、
// enumerateFamilyOptions の currentScore（増分計算の基準）と同じ集合を使う。
// これにより「現在評価点 ＋ 最適化の増分 ＝ 獲得後評価点」が二重計上なく成り立つ。
function acquiredSkillEval(master, state) {
  const aptitudes = state.aptitudes;
  const acquired = state.acquired || new Set();
  const surface = state.surfaceMultiplierEnabled === true;
  const scenario = [...(master.scenarioSkills || []), ...(master.unpurchasableSkills || [])];
  const scenarioById = new Map(scenario.map(s => [s.skillId, s]));

  // キャラ自身の固有スキルは獲得画面に虹枠で並び、ファミリー側にも
  // （kind="inheritedUnique"の1件ファミリーとして）実体を持つため、ここで
  // 名前一致で除外する。自前固有は 170×固有Lv として呼び出し側で別途計上する
  // （eval_validation の合算方式と一致。二重計上を防ぐ）。継承固有（親から継いだ
  // 別名の固有）は自前固有と名前が異なるため除外されず、通常どおり計上される。
  const ownUnique = uniqueSkillOfCharacter(master, state.characterCardId, state.talentAwakened !== false);
  const ownUniqueName = ownUnique ? ownUnique.name : null;

  const familyTop = new Map();   // familyId -> 最大cumulativeScoreのスキル
  let extraTotal = 0;
  for (const skillId of acquired) {
    let owned = null, family = null;
    for (const f of master.families) {
      if (f._skillById.has(skillId)) { owned = f._skillById.get(skillId); family = f; break; }
    }
    if (owned) {
      if (ownUniqueName && owned.name === ownUniqueName) continue;   // 自前固有は170×Lvで別計上
      const cur = familyTop.get(family.familyId);
      if (!cur || owned.cumulativeScore > cur.cumulativeScore) familyTop.set(family.familyId, owned);
      continue;
    }
    if (scenarioById.has(skillId)) extraTotal += scoreOf(scenarioById.get(skillId), aptitudes, surface);
    // それ以外（uniqueSkills側の固有スキル等）は総合評価点では別枠のためスキップ
  }

  // 一覧に無い下位の白ティアも現在評価点に含める（impliedAcquiredWhites 参照）。
  // enumerateFamilyOptions の増分計算と同じ集合を見ないと、
  // 「現在評価点 ＋ 増分 ＝ 獲得後評価点」が崩れる（上のコメント参照）。
  for (const family of master.families) {
    for (const implied of impliedAcquiredWhites(family, state)) {
      const cur = familyTop.get(family.familyId);
      if (!cur || implied.cumulativeScore > cur.cumulativeScore) {
        familyTop.set(family.familyId, implied);
      }
    }
  }

  let total = extraTotal;
  for (const skill of familyTop.values()) total += scoreOf(skill, aptitudes, surface);
  return total;
}

// Node/ブラウザ両対応のエクスポート
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    roundHalfUp, aptitudeMultiplier, scoreOf, loadMaster, uniqueSkillOfCharacter,
    acquiredSkillEval, solveDpScoreCapped,
    baselineScore, selectablePlans, enumerateFamilyOptions, solveDp, solveGreedy,
  };
}
