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

// マスタから照合候補の索引を構築する。
// families の skills / evolutions / negativeSkill と uniqueSkills を対象にする。
// 戻り値: [{ key, name, skillId, familyId, source }, ...]（key は正規化名）
function buildNameIndex(master) {
  const index = [];
  const push = (name, skillId, familyId, source) => {
    if (!name) return;
    index.push({ key: normalizeName(name), name, skillId, familyId, source });
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
// 戻り値: { best, second, distance, gap, ambiguous }
//   gap = 次点距離 - 最良距離。gap が小さいほど曖昧（要確認）。
function matchName(ocrText, index, gapThreshold = 1) {
  const query = normalizeName(ocrText);
  const queryLength = query.length;
  let best = null, bestDist = Infinity, bestRank = Infinity;
  let second = null, secondDist = Infinity, secondRank = Infinity;
  for (const entry of index) {
    const d = editDistance(query, entry.key);
    const rank = d + Math.abs(entry.key.length - queryLength) * LENGTH_MISMATCH_PENALTY;
    if (rank < bestRank) {
      second = best; secondDist = bestDist; secondRank = bestRank;
      best = entry; bestDist = d; bestRank = rank;
    } else if (rank < secondRank) {
      second = entry; secondDist = d; secondRank = rank;
    }
  }
  const gap = secondDist - bestDist;
  return { best, second, distance: bestDist, gap, ambiguous: gap <= gapThreshold };
}
