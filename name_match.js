// OCRで得た雑なスキル名を、マスタの正規名へ編集距離で照合する。
// 生の日本語OCRは誤りが多いが、候補集合が閉じているため最近傍で復元できる。
// タイ（最良と次点の距離差が小さい）はユーザー確認へ回す設計（引き継ぎ資料§6.2）。

// 表記ゆれを吸収する正規化。全半角統一・記号ゆれ・空白除去。
//
// 横棒に見える字「一」（漢数字）「ー」（長音符）「―」（U+2015）「—」（U+2014）は
// マスタ照合専用としてここで同一視する。いずれもアスペクト比保存で32×32正規化した
// 後のビットマップがほぼ同一（実測: 一とーの距離3）で、ゲームフォントの実際の
// レンダリングでは原理的に区別困難（細い横棒に潰れる）。マスタ全1821件をこの
// 正規化で調べても名前の一意性が失われるペアは0件だったため、照合精度の安全な
// 底上げとして適用する（表示に使う `name` フィールド自体は元の表記のまま保持
// される。影響するのは検索キーのみ）。
//
// 「―」を加えたのは、字形アトラスに「―」を採取した途端「勇迅一閃」の「一」が
// 「―」と読まれて照合を外し、曖昧行になったため（2026-07-15実測）。区別できない
// 字を無理に区別せず、照合キー側で吸収するのが本筋。「—」(U+2014)も同じ横棒で、
// 採取すれば同様に衝突するため予防的に同じクラスへ入れてある。
// 該当するマスタ名は「――お退きなさい」「――畏れよ、然して拝跪せよ」
// 「――さあ、踊りましょう」「尊み☆ﾗｽﾄｽﾊﾟ—(ﾟ∀ﾟ)—ﾄ!」の4件のみ。
function normalizeName(text) {
  if (!text) return "";
  return text.normalize("NFKC").replace(/〇/g, "○").replace(/\s+/g, "").replace(/[一ー―—]/g, "ー");
}

// 認識が原理的に出せない字。照合キーからは両側とも落とす。
//
// 内訳と理由:
//   . ' : - = ＝ / ／ ﾟ ﾞ …
//     点と線だけの記号。32×32へ引き伸ばすと識別情報が残らず他の字の一致を奪うため、
//     字形アトラスへ意図的に採取していない（build_name_atlas_from_cards.html の
//     DEGENERATE_MARKS。実測で回帰あり）。
//   [ ]
//     採取元がスキルカードなので、称号にしか出ない角括弧は採取される機会が無い。
//     しかも全262称号が [ ] で囲まれており、候補を分ける情報を持たない。
//
// マスタ側にだけ残すと、認識側が絶対に出せない分の距離が常に上乗せされる。
// 順位は全候補に等しく乗るので変わらないが、称号照合の「読めているか」を見る
// 絶対値ゲート（TITLE_MATCH_MAX_DISTANCE_RATIO）が本来より厳しくなり、
// 読めているカードまで棄却する。実測: 同名複数カード230枚のうち棄却17枚 → 2枚。
//
// スキル名側でも、本日追加の「ただその先へ」が「彼方、その先へ…」と距離3で
// 並ぶ引き分けが起きていた。落とすと 0 対 3 で決着する。
// マスタ1,846名・称号262件のいずれも、落としたことで一意性は失われない（実測0件）。
//
// normalizeName 自体は変えない。字形採取（harvest.js）が「正規化した名前の文字数」と
// 「切り出したセル数」の一致を前提にしており、文字を落とすと採取が止まるため。
const UNREADABLE_IN_MATCH_KEY = /[.':\-=＝/／ﾟﾞ…\[\]]/g;

// 編集距離で突き合わせるためのキー。認識側とマスタ側の両方に同じものを掛ける。
function matchKey(text) {
  return normalizeName(text).replace(UNREADABLE_IN_MATCH_KEY, "");
}

// マスタから照合候補の索引を構築する。
// families の skills / evolutions / negativeSkill と uniqueSkills を対象にする。
// 戻り値: [{ key, name, skillId, familyId, source }, ...]（key は正規化名）
function buildNameIndex(master) {
  const index = [];
  const push = (name, skillId, familyId, source) => {
    if (!name) return;
    index.push({ key: matchKey(name), name, skillId, familyId, source });
  };
  for (const family of master.families) {
    for (const s of family.skills || []) push(s.name, s.skillId, family.familyId, "skill");
    for (const e of family.evolutions || []) push(e.name, e.skillId, family.familyId, "evolution");
    if (family.negativeSkill) push(family.negativeSkill.name, family.negativeSkill.skillId, family.familyId, "negative");
  }
  for (const u of master.uniqueSkills || []) push(u.name, u.skillId, null, "unique");
  return index;
}

// レーベンシュタイン距離（1行DP）。
function editDistance(a, b) {
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}

// 順位付け専用の長さペナルティ重み。編集距離だけで順位付けすると、
// クエリがノイズだらけのとき「短い候補ほど絶対距離が小さくなりやすい」
// ため、無関係な短い名前が正解より有利になることがある（実測: 6文字クエリ
// の全滅に近いOCRノイズに対し、正解6文字(距離5)より無関係な3文字候補
// (距離4)が勝った）。文字数の食い違いをペナルティとして順位にのみ加え、
// 報告する distance は生の編集距離のまま保つ（曖昧判定の意味を変えない）。
const LENGTH_MISMATCH_PENALTY = 1;

// OCR名を索引に照合する。
// 戻り値: { best, second, distance, gap, ambiguous, tieNames }
//   gap = 次点距離 - 最良距離。gap が小さいほど曖昧（要確認）。
//   tieNames = 最良順位に並んだ候補名の一覧（同点が無ければ長さ1）。
//     best/second の2つしか返さないと、同点が3つ以上のとき正解が第3候補以降に
//     隠れても外から見えず、2択前提の曖昧解消が誤った名前を確定してしまう
//     （実測: 「練達の一歩」が「錬連の―歩」と誤読され「会心の一歩」
//      「勇気の一歩」と3候補同点になり、「会心の一歩」が確定した）。
function matchName(ocrText, index, gapThreshold = 1) {
  const query = matchKey(ocrText);
  const queryLength = query.length;
  let best = null, bestDist = Infinity, bestRank = Infinity;
  let second = null, secondDist = Infinity, secondRank = Infinity;
  let ties = [];
  for (const entry of index) {
    const d = editDistance(query, entry.key);
    const rank = d + Math.abs(entry.key.length - queryLength) * LENGTH_MISMATCH_PENALTY;
    if (rank < bestRank) {
      second = best; secondDist = bestDist; secondRank = bestRank;
      best = entry; bestDist = d; bestRank = rank;
      ties = [entry];
    } else if (rank === bestRank) {
      ties.push(entry);
      if (rank < secondRank) { second = entry; secondDist = d; secondRank = rank; }
    } else if (rank < secondRank) {
      second = entry; secondDist = d; secondRank = rank;
    }
  }
  const gap = secondDist - bestDist;
  // 同じ名前が複数エントリ（スキルと進化等）で載ることがあるため名前で一意化する
  const tieNames = [...new Set(ties.map(t => t.name))];
  return { best, second, distance: bestDist, gap, ambiguous: gap <= gapThreshold, tieNames };
}
