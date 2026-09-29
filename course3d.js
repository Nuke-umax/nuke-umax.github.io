// 3Dコース図。コースの帯そのものを「スキルでどれだけ速くなったか」で塗り分ける。
// v-tグラフと同じ役割を、時間軸ではなくコース上の位置で見せる。ドラッグで回転できる。
//
// 形は実測の座標ではなく、コーナー1つ＝90度として直線とコーナーの長さから組み立てる。
// 中山2500m（コーナー6つ＝1周半）でも形が合う。坂の高さは見やすさのため誇張する。
(function () {
  const TRACK_WIDTH_M = 46;             // 帯の幅（誇張）
  const SLOPE_EXAGGERATION = 14;        // 坂の高さの誇張倍率
  const SLOPE_UNIT = 1e6;               // course_data の slope は 15000 = 1.5%
  const PITCH = 0.95;                   // 見下ろす角度[rad]
  const CLUSTER_RATIO = 0.035;          // この距離比より近い発動はまとめて1本のピンにする
  const PIN_HEIGHT_RATIO = 0.08;        // ピンの高さ（コースの広がりに対する比）
  const NO_DIFF_MPS = 0.003;            // これ未満の速度差は「差なし」として塗らない

  // 色。差なしは淡い灰緑、速くなった区間は緑、遅くなった区間は赤。
  const NEUTRAL = [223, 229, 223];
  const FASTER = [24, 122, 74];
  const SLOWER = [190, 52, 40];

  function buildPath(shape, count) {
    const step = shape.distance / count;
    const turnSign = shape.turn === 2 ? 1 : -1;     // 左回りは反時計回り
    const points = [{ x: 0, y: 0, z: 0, heading: 0 }];
    let x = 0, y = 0, z = 0, heading = 0;
    for (let i = 1; i <= count; i++) {
      const middle = (i - 0.5) * step;
      const corner = (shape.corners || []).find(c => middle >= c.start && middle < c.start + c.length);
      if (corner && shape.turn !== 4) heading += turnSign * (Math.PI / 2) * (step / corner.length);
      x += Math.cos(heading) * step;
      y += Math.sin(heading) * step;
      const slope = (shape.slopes || []).find(s => middle >= s.start && middle < s.start + s.length);
      if (slope) z += (slope.slope / SLOPE_UNIT) * step * SLOPE_EXAGGERATION;
      points.push({ x, y, z, heading });
    }
    points[0].heading = points[1] ? points[1].heading : 0;
    return points;
  }

  // 速度差を色に。平方根の目盛りにして、小さな差でも色が乗るようにする
  // （線形だと、最大差の1割程度の区間がほぼ無色に見えた）。
  function colorOf(diff, maxAbs) {
    if (Math.abs(diff) < NO_DIFF_MPS) return `rgb(${NEUTRAL.join(",")})`;
    const t = 0.25 + 0.75 * Math.sqrt(Math.min(Math.abs(diff) / maxAbs, 1));
    const target = diff > 0 ? FASTER : SLOWER;
    const mix = NEUTRAL.map((c, i) => Math.round(c + (target[i] - c) * t));
    return `rgb(${mix.join(",")})`;
  }

  function clusterActivations(activations, distance) {
    const sorted = activations.slice().sort((a, b) => a.pos - b.pos);
    const clusters = [];
    sorted.forEach((act, i) => {
      const last = clusters[clusters.length - 1];
      if (last && act.pos - last.pos < distance * CLUSTER_RATIO) last.members.push({ act, no: i + 1 });
      else clusters.push({ pos: act.pos, members: [{ act, no: i + 1 }] });
    });
    return clusters;
  }

  function render(host, state) {
    const { shape, trace, activations } = state;
    const canvas = host.querySelector("canvas");
    const ratio = window.devicePixelRatio || 1;
    const width = host.clientWidth || 340, height = Math.round(width * 0.62);
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const count = trace ? trace.pos.length - 1 : 120;
    const path = buildPath(shape, count);
    const xs = path.map(p => p.x), ys = path.map(p => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 300);
    const diffs = trace ? trace.withSkills.map((v, i) => v - trace.withoutSkills[i]) : null;
    const maxAbs = diffs ? Math.max(...diffs.map(Math.abs), NO_DIFF_MPS * 2) : 1;

    const cosY = Math.cos(state.yaw), sinY = Math.sin(state.yaw);
    const cameraDistance = extent * 2.2;
    const project = (x, y, z) => {
      const X = x - cx, Y = y - cy;
      const xr = X * cosY - Y * sinY, yr = X * sinY + Y * cosY;
      const persp = cameraDistance / (cameraDistance + yr * Math.cos(PITCH) + z * Math.sin(PITCH));
      return { x: xr * persp, y: (yr * Math.sin(PITCH) - z * Math.cos(PITCH)) * persp,
               depth: yr * Math.cos(PITCH) + z * Math.sin(PITCH) };
    };
    const half = TRACK_WIDTH_M / 2;
    const edge = (p, side) => project(p.x - Math.sin(p.heading) * half * side, p.y + Math.cos(p.heading) * half * side, p.z);

    // 画面に収める
    const probe = path.flatMap(p => [edge(p, 1), edge(p, -1), project(p.x, p.y, p.z + extent * (PIN_HEIGHT_RATIO + 0.04))]);
    const minX = Math.min(...probe.map(q => q.x)), maxX = Math.max(...probe.map(q => q.x));
    const minY = Math.min(...probe.map(q => q.y)), maxY = Math.max(...probe.map(q => q.y));
    const margin = 16;
    const fit = Math.min((width - margin * 2) / (maxX - minX || 1), (height - margin * 2) / (maxY - minY || 1));
    const offsetX = margin + ((width - margin * 2) - (maxX - minX) * fit) / 2;
    const toScreen = q => ({ x: offsetX + (q.x - minX) * fit, y: margin + (q.y - minY) * fit, depth: q.depth });

    // 帯を区間ごとに、奥から順に塗る。
    const segments = [];
    for (let i = 0; i < path.length - 1; i++) {
      const pts = [edge(path[i], 1), edge(path[i + 1], 1), edge(path[i + 1], -1), edge(path[i], -1)].map(toScreen);
      segments.push({ pts, depth: pts.reduce((s, q) => s + q.depth, 0) / 4,
                      color: diffs ? colorOf(diffs[i + 1], maxAbs) : `rgb(${NEUTRAL.join(",")})` });
    }
    segments.sort((a, b) => b.depth - a.depth);
    for (const seg of segments) {
      ctx.beginPath();
      seg.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fillStyle = seg.color; ctx.fill();
      ctx.strokeStyle = seg.color; ctx.lineWidth = 0.8; ctx.stroke();   // 区間の継ぎ目の隙間を埋める
    }

    const at = pos => path[Math.min(Math.round(pos / shape.distance * (path.length - 1)), path.length - 1)];
    const label = (p, text) => {
      const q = toScreen(project(p.x, p.y, p.z));
      ctx.fillStyle = "#4d5751"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(text, q.x, q.y + 4);
    };
    label(path[0], "S");
    label(path[path.length - 1], "G");

    for (const cluster of clusterActivations(activations || [], shape.distance)) {
      const p = at(cluster.pos);
      const base = toScreen(project(p.x, p.y, p.z));
      const top = toScreen(project(p.x, p.y, p.z + extent * PIN_HEIGHT_RATIO));
      ctx.strokeStyle = "#1f4d36"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      const first = cluster.members[0].no, last = cluster.members[cluster.members.length - 1].no;
      const text = first === last ? String(first) : `${first}-${last}`;
      ctx.font = "bold 11px sans-serif";
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = "#1f4d36";
      ctx.beginPath(); ctx.roundRect(top.x - w / 2, top.y - 9, w, 18, 9); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(text, top.x, top.y + 4);
    }

    const legend = host.querySelector(".c3dLegend");
    legend.hidden = !diffs;
    if (diffs) legend.querySelector(".c3dMax").textContent = `+${maxAbs.toFixed(2)} m/s`;
    host.querySelector(".c3dCaption").textContent = diffs ? "色＝スキルで速くなった量" : "再計算すると色が付きます";
  }

  // 3Dコース図の部品を作る。trace が null なら灰色の帯とピンだけを描く。
  window.renderCourse3D = function (shape, trace, activations) {
    if (!shape || !shape.distance) return null;
    const host = document.createElement("div");
    host.className = "c3d";
    host.innerHTML = `<canvas aria-label="3Dコース図。ドラッグで回転できます。"></canvas>
      <div class="c3dBar"><span class="c3dCaption"></span>
      <span class="c3dLegend"><span>0</span><i></i><span class="c3dMax"></span></span></div>`;
    const state = { shape, trace, activations, yaw: -0.5 };
    const draw = () => render(host, state);

    // ドラッグ（指・マウス）で回す。縦方向のスクロールは妨げない。
    const canvas = host.querySelector("canvas");
    let dragX = null;
    canvas.addEventListener("pointerdown", e => { dragX = e.clientX; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", e => {
      if (dragX === null) return;
      state.yaw += (e.clientX - dragX) * 0.012; dragX = e.clientX; draw();
    });
    canvas.addEventListener("pointerup", () => { dragX = null; });
    canvas.style.touchAction = "pan-y";

    requestAnimationFrame(draw);
    new ResizeObserver(draw).observe(host);
    return host;
  };
})();
