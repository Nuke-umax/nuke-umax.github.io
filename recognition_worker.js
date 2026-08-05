// 認識処理をメインスレッドから切り離すWeb Worker。
// 画像デコード〜字形照合〜重複除去までの重い処理をここで行い、
// UIの応答性を保つ（引き継ぎ資料§10.6項目5）。
// 画像は一切外部送信しない点はメインスレッドと同じ（フェッチ先はマスタ/アトラスJSONのみ）。

importScripts(
  "ocr_core.js?v=90", "fields.js?v=90", "optimizer.js?v=90", "name_match.js?v=90",
  "recognizer.js?v=90", "harvest.js?v=90", "dedup.js?v=90", "pipeline.js?v=90",
);

let resourcesPromise = null;

function loadResourcesOnce() {
  if (resourcesPromise === null) {
    resourcesPromise = (async () => {
      const noCache = { cache: "no-store" };
      const master = loadMaster(await fetchMasterJson(noCache));
      const index = buildNameIndex(master);
      const nameAtlas = unpackAtlas(await (await fetch("atlas_v1.json", noCache)).json());
      const digitAtlas = unpackAtlas(await (await fetch("digit_atlas.json", noCache)).json());
      const rankAtlas = unpackAtlas(await (await fetch("rank_atlas.json", noCache)).json());
      const statAtlas = unpackAtlas(await (await fetch("stat_digit_atlas.json", noCache)).json());
      const titles = await (await fetch("character_card_titles.json", noCache)).json();
      const titleIndex = buildCharacterTitleIndex(titles);
      return { master, index, nameAtlas, digitAtlas, rankAtlas, statAtlas, titleIndex };
    })();
  }
  return resourcesPromise;
}

async function blobToRGBA(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height };
}

// 全行について、確認・修正UI用のサムネイルPNGを切り出す（アイコンと名前欄）。
// nameRect / iconRect はこのあと捨てる＝メインスレッドへは画像座標を渡さずBlobだけ渡す。
//
// 曖昧行だけでなく全行に付ける。確信して誤読した行はユーザーが気付かないと直せず、
// 元のスクショと見比べる作業は現実的でないため、その場で原画を見せる必要がある。
// 名前帯は小さなPNG（数KB）、アイコンは正方形に縮小して載せる。
const ICON_THUMB_PX = 64;

async function cropToBlob(full, rect, outW, outH) {
  const canvas = new OffscreenCanvas(outW, outH);
  canvas.getContext("2d").drawImage(full, rect.x, rect.y, rect.w, rect.h, 0, 0, outW, outH);
  return canvas.convertToBlob({ type: "image/png" });
}

async function attachThumbnail(row, imageData, width) {
  if (row.nameRect === undefined) return row;
  const full = new OffscreenCanvas(width, imageData.length / 4 / width);
  full.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(imageData), width), 0, 0);
  const { nameRect, iconRect, thumbRect, ...rest } = row;
  const band = thumbRect || nameRect;
  const thumbnail = await cropToBlob(full, band, band.w, band.h);
  const icon = iconRect ? await cropToBlob(full, iconRect, ICON_THUMB_PX, ICON_THUMB_PX) : undefined;
  return { ...rest, thumbnail, ...(icon ? { icon } : {}) };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "recognizeAcquisitions") {
      const { master, index, nameAtlas, digitAtlas } = await loadResourcesOnce();
      const perImageRows = [];
      const skillPointsPerImage = [];
      const scrollProfiles = [];
      for (let i = 0; i < msg.blobs.length; i++) {
        const { data, width, height } = await blobToRGBA(msg.blobs[i]);
        const result = recognizeAcquisitionImage(data, width, height, nameAtlas, digitAtlas, master, index);
        const rows = await Promise.all(result.rows.map(r => attachThumbnail(r, data, width)));
        perImageRows.push(rows);
        skillPointsPerImage.push(result.skillPointsGuess);
        scrollProfiles.push(result.scrollProfile);
        self.postMessage({ type: "progress", done: i + 1, total: msg.blobs.length });
      }
      const merged = mergeAcquisitionRows(perImageRows, scrollProfiles);
      // 複数キャラ混在の警告用。保有Ptは1キャラのスクロール中は不変なので、
      // 2種以上の値が現れたら別キャラのスクショが混ざっている。
      const characterMix = detectMultipleCharacters(skillPointsPerImage);
      // 保有Pt（最適化の予算）は、混在していなければ唯一の信頼値、混在時は
      // 最頻値を採る（先頭画像が別キャラでも代表値を外さない）。
      const skillPointsGuess = mostFrequentSkillPoints(skillPointsPerImage);
      // 配列に付けた付加情報は postMessage の複製で落ちるので、別のフィールドで渡す。
      const missingRangeCount = merged.missingRangeCount ?? null;
      self.postMessage({ type: "acquisitionResult", rows: merged, skillPointsGuess, characterMix, missingRangeCount });
    } else if (msg.type === "recognizeDetail") {
      const { rankAtlas, nameAtlas, statAtlas, titleIndex } = await loadResourcesOnce();
      const { data, width, height } = await blobToRGBA(msg.blob);
      const aptitudeRanks = recognizeAptitudeImage(data, width, height, rankAtlas);
      const characterCardId = recognizeCharacterCardId(data, width, height, nameAtlas, titleIndex);
      const stats = recognizeStatsImage(data, width, height, statAtlas);
      // 確認UIに並べる元画面の切り抜き。座標は渡さずBlobだけ返す。
      const rects = detailCropRects(data, width, height);
      const full = new OffscreenCanvas(width, height);
      full.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), width), 0, 0);
      // 高さを揃えて出す。中身の余白の割合も揃えてあるので、並べたとき文字の大きさが揃う。
      const CHECK_CROP_HEIGHT = 56;
      const crop = (r) => r === null ? null
        : cropToBlob(full, r, Math.max(1, Math.round(r.w * CHECK_CROP_HEIGHT / r.h)), CHECK_CROP_HEIGHT);
      const statCrops = await Promise.all(rects.stats.map(crop));
      const aptitudeCrops = await Promise.all(rects.aptitudes.map(crop));
      self.postMessage({ type: "detailResult", aptitudeRanks, characterCardId, stats, statCrops, aptitudeCrops });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
};
