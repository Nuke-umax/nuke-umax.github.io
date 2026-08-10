// スクリーンショット群から最適化結果までを一気通しで処理するパイプライン。
// 全処理はブラウザ内で完結し、画像は一切外部送信しない。

// 獲得済み行（＋ボタンが無い代わりに「獲得済」ラベルが出る行）の平均バンド高。
// 実測の＋ボタン行の高さをそのまま流用する（同一UIの行なので高さは共通）。
const ACQUIRED_ROW_HEIGHT_FACTOR = 0.26;   // フォールバック時 ÷ ピッチ

// スキル一覧画面に写り込むヘッダー/フッターUIの既知ラベル文字列。
// 位置ベースの除外（yStart/yEnd・バンド高フィルタ・searchFloorY、§10.13・
// §10.17）が主防御線だが、解像度・端末が変わると位置の想定が崩れる可能性
// がある（§10.14: 適性ランク・保有Pt等は比率依存、＋ボタン検出のみ真に
// 解像度非依存）。位置に関わらず「読み取った文字列がスキル名ではなく
// これらUIラベルそのものに近い」場合は行ごと破棄する、内容ベースの
// 第二の防御線として機能する。
const UI_CHROME_LABELS = [
  "獲得済", "デフォルト", "昇順", "降順", "説明省略", "決定", "リセット", "戻る",
  "スキルフィルター", "未設定", "変更", "能力詳細", "現在のスキルPt",
  "トレーナーガイド", "スキル獲得", "シナリオ進化スキル",
].map(normalizeName);

// 認識した生文字列（正規化前提）がUIラベルそのものか。
// 完全一致のみを見る（編集距離1まで許すと実在スキル「決定打」が
// 「決定」に巻き込まれて誤って破棄される実害が確認できたため）。
function looksLikeUiChrome(recog) {
  const q = normalizeName(recog);
  if (q.length === 0) return false;
  return UI_CHROME_LABELS.includes(q);
}

// 並び替えツールバー（「説明省略」「デフォルト」「昇順」）はリストの上に浮いて
// 最下段の行を覆う。覆われた行は文字の大半が別物として読まれ、誤った名前で
// 確定したり、統合の重なり判定を壊したりする（実測: メジロラモーヌの最終行が
// 「ホークアイ」5文字中4文字誤読／新キャラ3体目では覆われた行と無傷の行が
// 重複として残り、曖昧解消の負担になっていた）。
//
// 位置で問答無用に捨てる。読めているかどうかを判定してから捨てる方式は、
// 遮られていない行まで巻き込んで実在スキルを消していた（実測: SP28キャラの
// 「ペースアップ」「急襲」「戦略家」がどの画像でも認識されず消えていた。正解値83→86）。
//
// 捨てても情報を失わない。ツールに「重ねて撮る」よう案内しているため、覆われた行は
// 次の画像の上部に無傷で写る（実測: 5キャラ97枚で覆われた行25件すべてが、
// 他の画像に確信行として存在した）。
//
// 境界はボタンを色で見つけて決める（detectToolbarTopY）。位置比の決め打ちでは
// 端末差を吸収できない。実測では同一解像度でもAndroid系80.60%・iPhone系76.16%と
// 4.43ポイント違い、比率0.74ではAndroid側で切る必要のない行まで捨てていた。
//
// 判定に使うのは名前帯の上端ではなく行の中心。名前は行の上部にあるため、
// 名前が読めていても行の下半分（必要SPの数値）がボタンに隠れることがある。
const TOOLBAR_TOP_RATIO_FALLBACK = 0.76;   // ボタンを見つけられない端末向け

function toolbarTopOf(imageData, width, height, listTopY) {
  const detected = detectToolbarTopY(imageData, width, height, listTopY);
  return detected === null ? height * TOOLBAR_TOP_RATIO_FALLBACK : detected;
}

function isCoveredByToolbar(rowCenterY, toolbarTopY) {
  return rowCenterY >= toolbarTopY;
}

// マスタ照合結果が曖昧（2択で確定できない）かどうかを判定する。
//
// gap（次点候補との距離差）<=1 を曖昧の目安とする素朴な判定は、名前が短い
// ほど過敏になる欠陥がある。2文字名の編集距離は最大でも2にしかならず、
// distance=1（1文字だけ字形を誤読）になった時点で、次点候補が
// 内容的にまったく無関係でも必ずgap<=1に収まってしまう（実測: 「巨歩」が
// 「巨ま」と読まれると、次点「青嵐」との共通点はゼロなのにgap=1で曖昧
// 判定された。メジロラモーヌ・別キャラの双方で同じ形で再現。§10.20・
// §10.21）。真のタイ（gap=0）だけを曖昧とみなし、それ以外は確信扱いに
// 緩和する。3文字以上の名前では通常通りgap<=1を曖昧とみなす（長い名前では
// gap=1が実際に紛らわしいケース、例:「レース場」の長音符/漢字混同、が
// 確認されているため、閾値は変えない）。
const SHORT_NAME_MAX_LENGTH = 2;
// 兄弟スキル（同長1字違い）で、識別字の字形がこの余裕以上に勝者へ近ければ確信。
// 実測の分離: 確信ケース ◎:165/○:249=余裕84・体:95/速:圏外=余裕128、に対し
// 揺らぐケースはこれ未満に収まる。純CJK32x32のハミングノイズを踏まえ40とする。
const DISTINGUISH_MARGIN_MIN = 40;
function isNameAmbiguous(best) {
  const sameNameTie = best.secondName === best.name;
  if (best.distance === 0 || sameNameTie) return false;
  if (best.gap === undefined) return true;
  const gapThreshold = best.name.length <= SHORT_NAME_MAX_LENGTH ? 0 : 1;
  return best.gap <= gapThreshold;
}

// 編集距離の最良順位に複数候補が並んだ行（同点）に、字形決着を反映する。
//
// 同点の第1候補は索引の並び順で決まるだけの当てずっぽうで、正解が第3候補以降に
// 隠れていることがある（実測: 「練達の一歩」が3候補同点になり、2択前提の曖昧解消が
// 誤った第1候補「会心の一歩」を要確認フラグなしで確定した）。そこで候補どうしが
// 食い違う位置の字形を直接比較し（decideTieByGlyphs）、明差で勝てば勝者へ
// 差し替えて確信、決着できなければ曖昧のまま残す。
//
// 戻り値の tieCount は行に載り、2択前提の曖昧解消（resolveAmbiguousByUniqueness
// 等）が3候補以上の行を対象外にするために使う。
function applyTieDecision(best) {
  if (best.tieCount === undefined || best.tieCount < 2) return { tieResolved: false, tieCount: 0 };
  const decision = best.tieDecision;
  if (decision != null && decision.margin >= DISTINGUISH_MARGIN_MIN) {
    best.name = decision.winner;
    return { tieResolved: true, tieCount: best.tieCount };
  }
  return { tieResolved: false, tieCount: best.tieCount };
}

// 1画面ぶんのスキル取得画面を認識する。
// 戻り値: { rows: [{name, skillId, sp, evolution, hash, acquired}], skillPointsGuess }
function recognizeAcquisitionImage(imageData, width, height, nameAtlas, digitAtlas, master, index) {
  const rows = detectPlusButtonRows(imageData, width, height);
  // 獲得済み行（＋ボタンを持たずdetectPlusButtonRowsに写らない）のy中心。
  // ＋ボタン行だけでは埋まらないピッチ推定の抜けを埋める（§10.10・§10.13）。
  // ヘッダの「トレーナーガイドON」バッジ・フッタのソート設定バー内
  // 「獲得済」フィルタ表示チップが、いずれも本物の獲得済みラベルと同系統の
  // ピンク/マゼンタ色のため、リスト領域の外を誤検出することがある。
  // スキル一覧は必ずこの範囲内に表示されるため、yStart/yEndで除外する
  // （実測: ヘッダ側は高さ比0.17付近、フッタ側は比0.81〜0.84付近に固定の
  // 誤検出。実際の行はどの画像でも比0.31〜0.79の範囲に収まる。§10.17）。
  //
  // 開始側は既存の SKILL_POINT_SEARCH_RATIO.yBottom（保有スキルPt表示の
  // 下端、比0.327）を流用する。ヘッダーが写る画像では保有Ptの下端＝
  // リストの開始位置と一致するため、これより上を探索対象から外せば
  // ヘッダー・キャラ絵への侵入を防げる（実測: 比0.30では浅すぎて1行目の
  // 名前検索がキャラ絵を拾うことがあった。§10.17）。
  // 終了側は並び替えツールバーの上端。以前は比0.80の決め打ちだったが、実測では
  // ツールバーの位置が端末で4.43ポイント動く（Android 80.60% / iPhone 76.16%）。
  // 決め打ちだとiPhone側では覆われた行まで探し、Android側では手前で打ち切っていた。
  // ツールバーより下の行はどのみち破棄するので、そこを終端にすれば無駄も消える。
  //
  // 縦位置は3つのアンカーから求める。ヘッダー下端（緑の「現在のスキルPt」ラベル）を
  // 起点に、ツールバー上端（緑の「説明省略」ボタン）と溝（スクロールバー）を
  // **互いに独立に**検出し、最後に2つを突き合わせて溝の妥当性を確かめる
  // （verifiedListTrack）。ツールバー検出の起点に溝由来の値を渡すと巻き添えで
  // 壊れて突き合わせが意味を失うため、起点はヘッダー下端にしてある
  // （実測150枚で、起点を変えてもツールバーの検出位置は1枚も動かない）。
  const headerBottomY = headerBottomOf(imageData, width, height);
  const toolbarTopY = toolbarTopOf(imageData, width, height, headerBottomY);
  const listTrack = verifiedListTrack(imageData, width, height, headerBottomY, toolbarTopY);
  const listSearchFloorY = listTopOf(imageData, width, height,
    Math.round(height * SKILL_POINT_SEARCH_RATIO.yBottom), listTrack);
  const allAcquiredCenters = detectAcquiredRowCenters(
    imageData, width, height, listSearchFloorY, Math.round(toolbarTopY));

  // 獲得済み行にも＋ボタンはある（減光表示）。＋の検出条件を減光側まで下げたため、
  // 同じ行が「ピンクの獲得済ラベル」と「＋ボタン」の両方で見つかる。両方を残すと
  // 行が二重に出るうえ、2〜3pxずれた中心が隣接値として並ぶため medianPitch が
  // 行間ではなくそのズレを拾って崩壊する（実測: 本来205のピッチが2.0になり、
  // 名前帯の探索窓が潰れて認識が全滅した）。
  //
  // 重複の判定にピッチは使えない（ピッチを求める前に重複を除く必要があるため）。
  // 画面幅を基準にする。レイアウトは幅に比例し、行間は幅の約16.5%、同じ行を指す
  // 2つの検出のズレは1%未満なので、その中間の2%で確実に切り分けられる。
  const SAME_ROW_WIDTH_RATIO = 0.02;
  const sameRowGap = width * SAME_ROW_WIDTH_RATIO;
  const plusCenterOf = (r) => (r.bandTop + r.bandBottom) / 2;
  const acquiredYCenters = allAcquiredCenters.filter(
    y => !rows.some(r => Math.abs(plusCenterOf(r) - y) < sameRowGap));
  const acquiredCenterNear = (y) =>
    allAcquiredCenters.some(v => Math.abs(v - y) < sameRowGap);

  const pitch = medianPitch(rows, acquiredYCenters);
  const matchFn = (s) => {
    const m = matchName(s, index);
    return {
      name: m.best ? m.best.name : "?", distance: m.distance, gap: m.gap,
      secondName: m.second ? m.second.name : null,
      tieNames: m.tieNames,
    };
  };

  const familyOf = (id) => master.families.find(f => f._skillById.has(id)) || null;

  const outRows = [];

  // 獲得済み行は＋ボタンが無いため fieldRects の元になる行オブジェクトを
  // 持たない。近傍の＋ボタン行の平均バンド高で代用した合成行を作り、
  // 既存の nameRectAdaptive をそのまま再利用する。
  const avgBandHeight = rows.length
    ? rows.reduce((s, r) => s + (r.bandBottom - r.bandTop), 0) / rows.length
    : pitch * ACQUIRED_ROW_HEIGHT_FACTOR;

  // acquiredYCenters は＋ボタンと重ならないものだけに絞り込み済み（上部参照）。
  for (const yCenter of acquiredYCenters) {
    if (isCoveredByToolbar(yCenter, toolbarTopY)) continue;
    const synthRow = { yCenter, bandTop: yCenter - avgBandHeight / 2, bandBottom: yCenter + avgBandHeight / 2 };
    const nameRect = nameRectAdaptive(imageData, width, height, synthRow, pitch, undefined, listSearchFloorY);
    if (nameRect === null) continue;
    const best = recognizeNameBest(imageData, width, nameRect, nameAtlas, matchFn);
    if (best === null || best.name === null) continue;
    if (looksLikeUiChrome(best.recog)) continue;   // ヘッダー/フッターUIの取り違え（§10.17）
    const { tieResolved, tieCount } = applyTieDecision(best);
    const nameEntry = index.find(e => e.name === best.name);
    if (nameEntry === undefined) continue;
    const nameAmbiguous = tieResolved ? false : isNameAmbiguous(best);
    const secondEntry = nameAmbiguous ? index.find(e => e.name === best.secondName) : undefined;
    // 獲得済みでも進化はできる（画面にも「進化可能」バッジと「進化ⓘ」が出る）。
    // 進化はスキルPtを消費せず評価点だけが上がるので、拾わないと取りこぼしになる。
    // 進化バッジの矩形は行の中心とバンド高だけで決まる（＋ボタンの位置は使わない）ので、
    // ＋ボタンを持たない獲得済み行でもそのまま判定できる。
    const evo = hasEvolutionFlag(imageData, width, fieldRects(synthRow, width).evolution);
    outRows.push({
      name: best.name, skillId: nameEntry.skillId, sp: null, evo, acquired: true,
      hash: computeNameHash(imageData, width, nameRect), ambiguous: nameAmbiguous,
      // nameRect は全行に載せる。Worker がサムネイルを切り出したあと捨てるので
      // メインスレッドへは渡らない。確信して誤読した行もユーザーが原画と
      // 見比べて直せるようにするため、曖昧行だけに限定しない。
      nameRect, iconRect: iconRectOf(nameRect, width),
      thumbRect: thumbRectOf(nameRect, width, height),
      ...(nameAmbiguous ? {
        spReliable: true, secondName: best.secondName,
        secondSkillId: secondEntry ? secondEntry.skillId : null,
        distinguishMargin: best.distinguishMargin,
        ...(tieCount >= 3 ? { tieCount } : {}),
      } : {}),
    });
    if (evo) {
      const fam = familyOf(nameEntry.skillId);
      if (fam) {
        outRows[outRows.length - 1].evolutionSkillIds =
          fam.evolutions.filter(e => e.fromGoldSkillId === nameEntry.skillId).map(e => e.skillId);
      }
    }
  }

  for (const row of rows) {
    if (isCoveredByToolbar((row.bandTop + row.bandBottom) / 2, toolbarTopY)) continue;
    const nameRect = nameRectAdaptive(imageData, width, height, row, pitch, undefined, listSearchFloorY);
    if (nameRect === null) continue;
    const rects = fieldRects(row, width);
    const evo = hasEvolutionFlag(imageData, width, rects.evolution);

    const best = recognizeNameBest(imageData, width, nameRect, nameAtlas, matchFn);
    if (best === null || best.name === null) continue;
    if (looksLikeUiChrome(best.recog)) continue;   // ヘッダー/フッターUIの取り違え（§10.17）
    const { tieResolved, tieCount } = applyTieDecision(best);
    const nameEntry = index.find(e => e.name === best.name);
    if (nameEntry === undefined) continue;

    // 獲得済みの行は必要SPの欄が「獲得済」ラベルに置き換わる。ピンクのラベルが
    // 近くにあるかで判定し、数字の読み取り自体を行わない（読もうとすると
    // ラベルの模様を桁と誤読し、信頼できないSPで曖昧行が増える）。
    const acquired = acquiredCenterNear((row.bandTop + row.bandBottom) / 2);

    const spInk = acquired ? null : spDigitInk(imageData, width, rects.sp);
    const spRaw = acquired ? "" : recognizeDigits(spInk, digitAtlas);
    // 1桁でも認識不能(?)を含む場合、桁が欠けた誤った数値になる
    // （例: "1?2"を数字だけ残すと142ではなく12になる）。無言の桁欠けを
    // 防ぐため、?を含むSPは信頼できないものとしてnullにする。
    const spReliable = acquired ? true : (spRaw.length > 0 && !spRaw.includes("?"));
    const sp = (acquired || !spReliable) ? null : parseInt(spRaw, 10);

    // isNameAmbiguous の設計意図（gap基準の確信判定、distance=0の安全弁、
    // 同名タイの除外、短い名前の特例）はコメント参照。
    const nameAmbiguous = tieResolved ? false : isNameAmbiguous(best);
    const hash = computeNameHash(imageData, width, nameRect);
    const ambiguous = nameAmbiguous || !spReliable;
    const secondEntry = nameAmbiguous ? index.find(e => e.name === best.secondName) : undefined;
    outRows.push({
      name: best.name, skillId: nameEntry.skillId, sp, evo, hash, ambiguous,
      ...(acquired ? { acquired: true } : {}),
      // nameRect は全行に載せる（Worker がサムネイル化したあと捨てる）。
      // 曖昧行以外の項目は確信行では不要なので省略し、ペイロードを小さく保つ。
      nameRect, iconRect: iconRectOf(nameRect, width),
      thumbRect: thumbRectOf(nameRect, width, height),
      ...(ambiguous ? {
        spReliable,
        secondName: nameAmbiguous ? best.secondName : null,
        secondSkillId: secondEntry ? secondEntry.skillId : null,
        distinguishMargin: nameAmbiguous ? best.distinguishMargin : null,
        ...(nameAmbiguous && tieCount >= 3 ? { tieCount } : {}),
      } : {}),
    });

    if (evo) {
      // 進化フラグ付きの金スキルは複数のキャラ別進化先を持つことがある
      // （例: 「好転一息」は3キャラ分の進化先を持つ）。単一IDだけを保持すると
      // 他キャラの進化しか橋渡しされず、実際のプレイヤーのキャラでは
      // 進化プランが選択肢から漏れる。familyの全進化IDを保持し、
      // optimizer.js本来の characterCardId フィルタ（selectablePlans）に
      // 絞り込みを委ねる。
      const fam = familyOf(nameEntry.skillId);
      if (fam) {
        const ids = fam.evolutions.filter(e => e.fromGoldSkillId === nameEntry.skillId).map(e => e.skillId);
        outRows[outRows.length - 1].evolutionSkillIds = ids;
      }
    }
  }

  // 保有スキルPt（ヘッダ。値が無い画像もある＝スクロール後の画像等）。
  // 2桁以上を要求する（1桁は、ヘッダの無いスクロール画像でクロップが拾う
  // ゴミを誤って数値化するのを防ぐ。実測: Vodkaのスクロール画像で "1" を
  // 誤読し複数キャラ検知が誤爆した）。2桁の保有Pt（例: 28/12）は複数キャラ
  // 検知の要となるため 3桁ではなく 2桁まで読む。
  //
  // 探索位置は単一のアンカーに賭けず、確からしい順の候補を試す。数字が読めたか
  // どうかがそのまま当たり判定になるので、外した候補は自然に捨てられる。
  let skillPointsGuess = null;
  for (const rect of skillPointSearchRects(width, height, imageData)) {
    const raw = recognizeDigits(skillPointDigitInk(imageData, width, rect), digitAtlas);
    if (raw.length >= 2 && !raw.includes("?")) { skillPointsGuess = parseInt(raw, 10); break; }
  }

  // 撮影順の復元に使うスクロールバーの読み取り値（dedup.js）。
  // 画素を持ち出さず、暗部の中心yだけを持つ小さな配列にして返す。
  // 探索範囲は溝そのもの。従来の高さ比（28%〜82%）は Android 機で溝の下端
  // （83.5%）を31px切っており、リストの末尾までスクロールした画像でつまみが
  // 途中で断ち切られていた。
  const scrollProfile = scrollbarRunCenters(imageData, width, height, listTrack);

  // 画面に写っている順（上から下）に並べ直してから返す。
  //
  // 行は「獲得済み行」と「＋ボタン行」を別々のループで集めているため、
  // outRows の並びは収集順であって画面順ではない。1画面に両方が混在すると、
  // 未取得の行が画面上部にあっても獲得済みの後ろへ回る
  // （実測: IMG_6217 は上から 冬ウマ娘◎(未取得)・コーナー巧者○・コーナー回復○・
  //  直線巧者・ペースアップ の順なのに、冬ウマ娘◎が末尾に置かれていた。
  //  結果一覧でも「ペースアップとペースキープの間」に表示されてユーザーが気付いた）。
  //
  // 既存の5キャラで露見しなかったのは、各画像がたまたま獲得済みだけ／未取得だけで
  // 構成されていたため。混在する画像を1枚でも含むキャラでは必ず起きる。
  outRows.sort((a, b) => a.nameRect.y - b.nameRect.y);

  return { rows: outRows, skillPointsGuess, scrollProfile };
}

// 複数キャラのスクショが混在していないかを検知する。
//
// 獲得画面ヘッダの「現在のスキルPt（保有Pt）」は、1キャラのスクロール中は
// 常に同じ値で、別キャラでは異なる。信頼できる保有Pt値が2種以上（各2枚以上
// に出現）現れたら、複数キャラのスクショが混在していると判定する。「2枚以上」
// を課すのは、1枚だけに出る誤読値（ゴミ）を本物のキャラと取り違えないため。
//
// 別案「スキル表示順のリセット検知」も検討した（1キャラ内では表示順が単調で、
// 別キャラの先頭で先頭に戻る）。境界は確かに存在するが、OCRの前後誤りと
// 撮影開始位置のばらつきで単独キャラ内でも表示順の後退が大きく（実測: 単独で
// 画像中央値の後退873 ≈ 境界906）、単純な閾値では境界と区別できなかったため
// 採用しない。行数はスクロール量依存で無意味（同一キャラでも45〜114行）。
function detectMultipleCharacters(skillPointsPerImage) {
  const countByValue = new Map();
  for (const sp of skillPointsPerImage) {
    if (sp === null) continue;
    countByValue.set(sp, (countByValue.get(sp) || 0) + 1);
  }
  const significantValues = [...countByValue.entries()]
    .filter(([, count]) => count >= 2)
    .map(([value]) => value)
    .sort((a, b) => a - b);
  return { mixed: significantValues.length >= 2, skillPointValues: significantValues };
}

// 保有スキルPt（最適化の予算）を、最頻値で代表させる。先頭画像が別キャラや
// ヘッダ欠けでも代表値を外さない（従来の「先頭の非null」は先頭依存で脆かった）。
function mostFrequentSkillPoints(skillPointsPerImage) {
  const countByValue = new Map();
  for (const sp of skillPointsPerImage) {
    if (sp === null) continue;
    countByValue.set(sp, (countByValue.get(sp) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [value, count] of countByValue) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

// 曖昧行を「同一画面内にスキル名の重複は無い」という制約で解消する
// （ユーザー提案。§10.19）。
//
// 曖昧行は best/secondName の2択タイだが、一覧全体を見渡すと、どちらか
// 一方が既に別の行で確信的（非曖昧）に読み取れていることがある。1回の
// スキル取得画面キャプチャの中で同じスキルが2行に渡って表示されることは
// 無い（＝重複除去済みのリストでは各スキル名は高々1回しか出現しない）ため、
// 既に確信行として存在する方は排除でき、曖昧行はもう一方に確定できる。
// 両方とも既に確信行として存在する／どちらも存在しない場合は判別材料が
// 無いため曖昧のまま残す（安全側）。
//
// 1回の解消が別の行の確信集合を更新しうるため、変化が無くなるまで
// 繰り返す（例: A/Bのタイが確定したことで、別の行のB/Cのタイも解消できる）。
//
// 同点3候補以上の行（tieCount >= 3）は対象外。この解消は「候補はbestとsecondの
// 2つだけ」という前提で片方を排除して他方に確定するが、正解が第3候補以降に
// 隠れていると誤った名前を要確認フラグなしで確定してしまう（実測: 「練達の一歩」の
// 3候補同点で、次点「勇気の一歩」が確定済みという理由で誤った第1候補
// 「会心の一歩」が確定した）。以降の2択前提の解消も同じ理由で対象外にする。
function resolveAmbiguousByUniqueness(rows) {
  let changed = true;
  while (changed) {
    changed = false;
    const confidentNames = new Set(rows.filter(r => !r.ambiguous).map(r => r.name));
    for (const row of rows) {
      if (!row.ambiguous || !row.secondName) continue;
      if (row.tieCount >= 3) continue;   // 2択前提が成り立たない（コメント参照）
      const bestTaken = confidentNames.has(row.name);
      const secondTaken = confidentNames.has(row.secondName);
      if (bestTaken === secondTaken) continue;   // 両方確定済み or 両方未確定 → 判別不能
      if (secondTaken) {
        row.ambiguous = false;   // secondNameは重複となるためbestに確定
        changed = true;
      } else if (row.secondSkillId) {
        row.name = row.secondName;   // bestは重複となるためsecondNameに切り替え
        row.skillId = row.secondSkillId;
        row.ambiguous = false;
        changed = true;
      }
    }
  }
  return rows;
}

// 曖昧行のうち、同一の(name,secondName)ペアが複数行で独立に出現する場合、
// nameを正解として確定する（§10.20）。破損したクロップ同士が偶然同じ
// 誤ったペアに合意する確率は低く、複数回の独立した読み取りが一致すること
// 自体が強い証拠になる（実測: 短い2文字名「巨歩」はマスタ内の候補との
// distance差が本質的に小さく出やすく、resolveAmbiguousByUniquenessでは
// 解消できないが、2枚の別スクショで同じ「巨歩/青嵐」ペアが独立に出現し
// 一致した）。
function resolveByPairConsensus(rows) {
  const pairCounts = new Map();
  for (const row of rows) {
    if (!row.ambiguous || !row.secondName) continue;
    if (row.tieCount >= 3) continue;   // 2択前提が成り立たない（resolveAmbiguousByUniqueness 参照）
    const key = row.name + " " + row.secondName;
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }
  for (const row of rows) {
    if (!row.ambiguous || !row.secondName) continue;
    if (row.tieCount >= 3) continue;
    const key = row.name + " " + row.secondName;
    if (pairCounts.get(key) >= 2) row.ambiguous = false;
  }
  return rows;
}

// 曖昧のまま解消できなかった行のうち、名前自体は既に別の確信行と完全一致
// しているものは、同一スキルの重複読み取り（見切れ・UIオーバーレイ等で
// SPだけ破損した二重キャプチャ）とみなし除外する。情報はすでに確信行側に
// あるため、破損した重複を残す意味が無い（§10.20）。
function dropRedundantDuplicates(rows) {
  const confidentNames = new Set(rows.filter(r => !r.ambiguous).map(r => r.name));
  return rows.filter(row => !(row.ambiguous && confidentNames.has(row.name)));
}

// mergeAcrossImages（dedup.js）は隣接画像の「末尾/先頭」境界でのみ重複を
// 除去する設計のため、スクロール量が小さく同じ行が両画像の中盤（境界では
// ない位置）に写り込むケースを見逃す（実測: 「巨歩」がIMG_6171/6172双方の
// 中盤に写り込み、hash完全一致・SP一致にも関わらず境界重複判定にかからず
// 2行残った。§10.20）。
//
// ただし isSameRow のhamming距離閾値（24/256bit）は「連続する複数行が
// 全て一致する」という境界検出の強い制約とセットで初めて安全になる緩さで
// あり、単独ペアの総当たりにそのまま使うと別スキル同士まで誤って同一視
// する（実測: Vodka 114→81行、Chrono 108→51行まで行数が激減する重大な
// 回帰を確認）。境界を伴わない総当たり判定では、hash完全一致（境界検出済み
// クロップの再ハーベストのような紛れが無いケース）に限定する。
// 視覚ハッシュの完全一致だけでは足りない。獲得済み行は必要SPを持たず進化フラグも
// 揃うため、判定材料が実質ハッシュ1つになる。名前帯は余白が多く、別スキルどうしでも
// ハッシュが完全一致することがある（実測: 深呼吸↔打開策・早仕掛け↔中盤巧者・
// 快速↔端緒↔光明 の5組が衝突し、実在する4スキルが消えた）。
// そこで「同じスキルを指している」ことを名前でも裏取りする。
function dedupeExactMatches(rows) {
  const kept = [];
  for (const row of rows) {
    const isExactDuplicate = kept.some(k =>
      k.name === row.name
      && k.sp === row.sp && k.evo === row.evo && hammingDistance(k.hash, row.hash) === 0);
    if (isExactDuplicate) continue;
    kept.push(row);
  }
  return kept;
}

// dedupeExactMatches（視覚ハッシュの完全一致）では捉えられない「ほぼ同一だが
// 完全一致ではない」重複を除去する（実測: Chronoで「春ウマ娘○」等11件が
// hamming距離8前後で境界外に写り込み残存。§10.20 ⑨）。
//
// isSameRow（dedup.js）の緩いhamming閾値(24)は「連続する複数行が全て一致
// する」という境界検出の強い制約とセットで初めて安全になるもので、境界を
// 伴わない総当たりにそのまま使うと別スキル同士まで誤って同一視する回帰が
// 実測済み（Vodka 114→81行、Chrono 108→51行）。そこで視覚ハッシュではなく
// 「OCRで解決済みのskillId」という、この一覧内では別スキル同士が絶対に
// 一致しない強い信号のみで同一性を判定する。
//
// 同一性の判定キーは skillId・獲得済み状態・進化フラグの3つ。skillIdは
// スキル一覧内で一意（同じスキルを二度取得することはできない）なため、この
// 3つが一致する行は同一スキルの重複読み取り以外に説明がつかない。SPは判定
// キーに含めない。同一スキルでも重複スクショ間でSP読取が食い違うことがあり
// （実測: ネバーギブアップがIMG_6183/6184で299/288に割れ、SP一致要求のため
// 重複除去に失敗して2行残った）、SPを含めると本来1行の重複を取りこぼす。
// 獲得済み行のSPは購入コストではなく最適化に影響しないため、残す側のSPが
// どちらでも結果は変わらない。曖昧行（ambiguous）はskillId自体が未確定の
// 当てずっぽうのため対象から除外する（安全側。曖昧解消は
// resolveAmbiguousByUniqueness等が別途担う）。
function dedupeSameSkillMatches(rows) {
  const kept = [];
  for (const row of rows) {
    const isSameSkillDuplicate = !row.ambiguous && kept.some(k =>
      !k.ambiguous && k.skillId === row.skillId && k.acquired === row.acquired &&
      k.evo === row.evo);
    if (isSameSkillDuplicate) continue;
    kept.push(row);
  }
  return kept;
}

// 複数画像の認識結果を、画像またぎの重複を除去して1本のリストにする。
//
// 曖昧解消（resolveAmbiguousByUniqueness・resolveByPairConsensus）を
// dedupeExactMatchesより先に行う。逆順にすると、独立した2回の観測が
// 完全一致するはずの曖昧行（例:「巨歩」）がdedupeExactMatchesで先に1行へ
// 統合されてしまい、resolveByPairConsensusが必要とする「2件の独立した
// 合意」の材料が1件に減って解消できなくなる回帰が実測で確認できた
// （§10.20）。曖昧解消を先に済ませてから重複除去する順序が正しい。
function mergeAcquisitionRows(perImageRows, scrollProfiles) {
  const asDedupRows = perImageRows.map(rs => rs.map(r => ({ hash: r.hash, sp: r.sp, evo: r.evo, ...r })));
  // 入力の並び順は当てにならないので、画像の中身から撮影順を復元してから連結する。
  const order = orderImagesByContent(asDedupRows, scrollProfiles);
  const ordered = order.map(i => asDedupRows[i]);
  // 撮り漏れは黙って評価点を下げるので、検出できたときは呼び出し側へ知らせる。
  const missingRanges = scrollProfiles ? detectMissingRanges(scrollProfiles, order) : null;
  const { merged } = mergeAcrossImages(ordered);
  resolveAmbiguousByUniqueness(merged);
  resolveByPairConsensus(merged);
  resolveAmbiguousByUniqueness(merged);
  const withoutRedundant = dropRedundantDuplicates(merged);
  const withoutExactDuplicates = dedupeExactMatches(withoutRedundant);
  const deduped = dedupeSameSkillMatches(withoutExactDuplicates);
  const rows = resolveDistinguishedSiblings(deduped);
  // 撮り漏れの件数だけを添える。行の配列そのものは従来どおり返す
  // （呼び出し側が配列として扱っている箇所を壊さないため、プロパティで持たせる）。
  rows.missingRangeCount = missingRanges === null ? null : missingRanges.length;
  return rows;
}

// 同長の兄弟スキルで、相違位置の字形合算マージン（distinguishingCharMargin）に
// より曖昧を解消する。マージンが明確に正なら勝者で確定、明確に負なら「第1候補が
// 誤読・実は次点が正しい」ため次点へ訂正して確定、僅差なら曖昧のまま確認へ回す。
//
// この最終段でのみ行うのが要点。マージ・重複除去・合意解消は元の曖昧フラグの
// まま実行済みなので、行集合は変えずユーザー向けの確信度と（訂正時のみ）名前を
// 補正する。認識段階で解除すると「確信名の集合」が変わり resolveByPairConsensus 等の
// 合意解消がカスケードで崩れ別行が湧く回帰を実測（Char3が91→92・おひとり様○出現）。
// SP不確実(spReliable=false)による曖昧はスキル名の問題ではないため対象外。
// 訂正時、次点名が既存の確信行と重複する場合は行を増やさないため訂正しない。
function resolveDistinguishedSiblings(rows) {
  const confidentNames = new Set(rows.filter(r => !r.ambiguous).map(r => r.name));
  for (const row of rows) {
    if (!row.ambiguous || row.spReliable === false) continue;
    if (row.tieCount >= 3) continue;   // 2択前提が成り立たない（resolveAmbiguousByUniqueness 参照）
    const margin = row.distinguishMargin;
    if (typeof margin !== "number") continue;
    if (margin >= DISTINGUISH_MARGIN_MIN) {
      row.ambiguous = false;                         // 勝者確定
    } else if (margin <= -DISTINGUISH_MARGIN_MIN && row.secondName && row.secondSkillId != null
               && !confidentNames.has(row.secondName)) {
      row.name = row.secondName;                     // 第1候補が誤読→次点へ訂正
      row.skillId = row.secondSkillId;
      row.ambiguous = false;
    }
  }
  return rows;
}

// 適性ランク詳細画面を認識する。戻り値: { dist:[4文字], leg:[4文字] }
function recognizeAptitudeImage(imageData, width, height, rankAtlas) {
  return recognizeAptitudeRanks(imageData, width, height, rankAtlas);
}

// character_card_titles.json（{ characterCardId: {title, name} }）から
// キャラ名・称号それぞれの照合用インデックスを構築する。
// キャラ名は複数カードで共有されるため、name→[{characterCardId,title,name}]の
// グループに、称号は正規化済み文字列そのものを保持する。
// キャラ名の照合キーは濁点・半濁点を落とす。
//
// 32×32へ正規化すると「゛」「゜」は数ビットにしかならず、原理的に読み分けられない
// （実測: ビワハヤヒデ が「ピワハヤヒテ」と読まれ、ビ→ピ・デ→テ の2字誤読になった）。
// 名前の許容誤読は1字なので距離2で弾かれ、称号を読む前に判別を放棄していた。
//
// 許容を2字に緩める案は採らない。キャラ名どうしが距離2以内の組が実在するため
// （キセキ/フジキセキ、ゴールドシチー/ゴールドシップ）、別キャラを取り違える。
// 一方、濁点・半濁点を落としても全131名で衝突は0件だった。区別できない字は
// 無理に区別せず照合キー側で吸収する（name_match.js の 一/ー/― と同じ方針）。
// 称号の読みが当たっていると認めるための上限（1位の編集距離 ÷ 読み取り文字数）。
// 実測7件: 正解 0.23〜0.50 / 誤り 1.09。その中間。詳細は recognizeCharacterCardId 参照。
const TITLE_MATCH_MAX_DISTANCE_RATIO = 0.75;

function characterNameKey(name) {
  return normalizeName(name).normalize("NFD")
    .replace(/[゙゚]/g, "").normalize("NFC");
}

function buildCharacterTitleIndex(titles) {
  const byName = new Map();
  for (const [characterCardId, { title, name }] of Object.entries(titles)) {
    const key = characterNameKey(name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ characterCardId, title, name, titleKey: normalizeName(title) });
  }
  return byName;
}

// 詳細画面の「[称号]」＋キャラ名の2行からcharacterCardIdを特定する。
// 2段階マッチング: ①キャラ名（安定して読める。多くのスキル名と同じ
// カタカナのため字形アトラスの被覆が良い）で候補カードを絞り込み、
// ②候補が複数（同一キャラの複数カード）ある場合のみ称号で絞り込む。
// 称号にはラテン文字・記号等アトラス未収録の字形が多く単独では信頼性が
// 低いが、候補が2〜3件に絞られた状態での相対比較なら実用上十分な精度に
// なる（§10.19）。該当キャラが1カードしかない場合は称号を読まずに確定
// できる。判別できない場合はnullを返す（安全側＝評価点最大の進化を仮採用）。
function recognizeCharacterCardId(imageData, width, height, nameAtlas, titleIndex) {
  const rects = characterInfoRects(imageData, width, height);   // 行検出（解像度非依存）
  if (rects === null) return null;
  const nameRecog = recognizeName(imageData, width, rects.name, nameAtlas);
  const nameKey = characterNameKey(nameRecog);   // 濁点・半濁点は落として比べる
  let candidates = titleIndex.get(nameKey);
  if (candidates === undefined) {
    // 完全一致キーが無ければ、登録済みキャラ名の中から最近傍を探す
    // （字形1〜2文字の誤読を許容する）。
    let bestKey = null, bestDist = Infinity;
    for (const key of titleIndex.keys()) {
      const d = editDistance(nameKey, key);
      if (d < bestDist) { bestDist = d; bestKey = key; }
    }
    if (bestKey === null || bestDist > 1) return null;   // 遠すぎる＝未知のキャラ名として判別放棄
    candidates = titleIndex.get(bestKey);
  }
  if (candidates.length === 1) return candidates[0].characterCardId;

  const titleRecog = recognizeName(imageData, width, rects.title, nameAtlas);
  const titleKey = normalizeName(titleRecog);
  let best = null, bestDist = Infinity, secondDist = Infinity;
  for (const cand of candidates) {
    const d = editDistance(titleKey, cand.titleKey);
    if (d < bestDist) { secondDist = bestDist; best = cand; bestDist = d; }
    else if (d < secondDist) { secondDist = d; }
  }
  if (best === null || secondDist - bestDist < 1) return null;   // 称号でも判別できない＝安全側でnull

  // 「2位より近い」だけでは足りない。称号が全く読めていないときも、たまたま
  // どれかが少し近くなって差が開き、別カードを確信して選んでしまう
  // （実測: ビワハヤヒデの称号「[Engineered Victory]」はラテン文字でほぼ全滅し
  //  「In小nーmd!い∞☆」と読まれ、無関係な「[ノエルージュ・キャロル]」を選んだ）。
  // 読みが当たっているかを絶対値でも確かめる。距離が読み取り文字数を超えるなら、
  // 共通する構造が無い＝照合として無意味。
  //
  // 実測7件の分離: 正解した5件は 0.23/0.25/0.36/0.50、外した1件は 1.09。
  // 間が2倍以上空いているので、その中間を採る。誤りの重さが非対称なので迷ったら
  // 捨てる側に倒す（null なら評価点最大の進化を仮採用する安全側の挙動になる）。
  if (bestDist > titleKey.length * TITLE_MATCH_MAX_DISTANCE_RATIO) return null;
  return best.characterCardId;
}

// 認識結果からoptimizer用stateを組み立てる。
// aptitudeRanks: {dist:[4], leg:[4]}（distはmile,chuKyori...の順ではなく画面表示順=
//   短距離,マイル,中距離,長距離。呼び出し側でaptitudesオブジェクトへの割当を担う）
function buildOptimizerState(recognizedRows, aptitudes, skillPoints, characterCardId = null, evolutionChoices = {}) {
  const availableSkillIds = new Set();
  const displayedCost = new Map();
  const evolvedGoldSkillIds = new Set();
  const acquired = new Set();

  for (const row of recognizedRows) {
    // 曖昧マッチ(名前照合が非完全一致)の行も、第1候補を採用して計算に入れる。
    //
    // 以前は除外していたが、除外は安全側ではなかった。画面に写っているスキルが
    // 黙って結果から消え、評価点が実際より低く出るためである。曖昧行は
    // 「要確認」タグと次点候補ボタン付きで確認・修正UIに出るので、誤りは
    // ユーザーが直せる。出さずに黙って落とすより、出して直せる方がよい。
    //
    // SP不明の行だけは値段が付けられないので下の row.sp === null で落ちる。
    if (row.acquired) {
      acquired.add(row.skillId);
      // 獲得済みの金スキルでも進化はできる。進化はスキルPtを消費せず評価点だけが
      // 上がるので、費用0の選択肢として登録する。登録しないと「取れば必ず得なのに
      // 提示されない」取りこぼしになる（実測: 所持28Ptのキャラで進化候補が1件も出なかった）。
      if (row.evo && row.evolutionSkillIds) {
        evolvedGoldSkillIds.add(row.skillId);
        for (const evoId of row.evolutionSkillIds) {
          availableSkillIds.add(evoId);
          displayedCost.set(evoId, 0);
        }
      }
      continue;
    }
    if (row.sp === null) continue;
    availableSkillIds.add(row.skillId);
    displayedCost.set(row.skillId, row.sp);
    if (row.evo && row.evolutionSkillIds) {
      evolvedGoldSkillIds.add(row.skillId);
      // 進化コストは金スキルと同額＝画面の表示SPをそのまま使う（§2.5・§2.4）。
      for (const evoId of row.evolutionSkillIds) {
        availableSkillIds.add(evoId);
        displayedCost.set(evoId, row.sp);
      }
    }
  }

  return {
    skillPoints, aptitudes, acquired,
    availableSkillIds, displayedCost, evolvedGoldSkillIds, evolutionChoices,
    negativeSkillIds: new Set(), characterCardId, talentAwakened: true,
  };
}

// 画面表示順(短距離,マイル,中距離,長距離 / 逃げ,先行,差し,追込)の4ランクから
// optimizer用の適性キーへ変換する。
const APTITUDE_DIST_KEYS = ["tanKyori", "mile", "chuKyori", "choKyori"];
const APTITUDE_LEG_KEYS = ["nige", "senko", "sashi", "oikomi"];

function aptitudeRanksToKeys(ranks) {
  const out = { shiba: "A", dirt: "A" };   // 芝・ダートは倍率に影響しないため既定値でよい
  APTITUDE_DIST_KEYS.forEach((k, i) => { out[k] = ranks.dist[i] || "G"; });
  APTITUDE_LEG_KEYS.forEach((k, i) => { out[k] = ranks.leg[i] || "G"; });
  return out;
}
