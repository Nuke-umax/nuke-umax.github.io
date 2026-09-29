// 3Dコース図。コースを立体の帯で描き、その上に「スキルでどこで差がついたか」を壁で立てる。
// v-tグラフと同じ役割を、時間軸ではなくコース上の位置で見せる。ドラッグで回転できる。
//
// 形は実測の座標ではなく、コーナー1つ＝90度として直線とコーナーの長さから組み立てる。
// 中山2500m（コーナー6つ＝1周半）でも形が合う。坂の高さは見やすさのため誇張する。
(function () {
  const TRACE_TRACK_WIDTH_M = 34;       // 帯の幅（誇張）
  const SLOPE_EXAGGERATION = 14;        // 坂の高さの誇張倍率
  const SLOPE_UNIT = 1e6;               // course_data の slope は 15000 = 1.5%
  const WALL_HEIGHT_RATIO = 0.32;       // 壁の最大の高さ（コースの広がりに対する比）
  const PITCH = 0.95;                   // 見下ろす角度[rad]
  const CLUSTER_RATIO = 0.035;          // この距離比より近い発動はまとめて1本のピンにする
  const BASHIN_METERS = 2.5;

  // コース上の各地点の (x, y, z, heading)。
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
      points.push({ x, y, z, heading, inCorner: !!corner });
    }
    points[0].heading = points[1] ? points[1].heading : 0;
    return points;
  }

  // 同じ時刻で比べたリード（バ身）。位置ごとの速度から、通過時刻の差を積み上げる。
  // リード[m] ≒ 時刻差 × その地点の速度。ゴールでの値は計算結果のバ身とおおむね一致する。
  function cumulativeLead(trace) {
    const lead = [0];
    let timeGap = 0;
    for (let i = 1; i < trace.pos.length; i++) {
      const dx = trace.pos[i] - trace.pos[i - 1];
      const withV = Math.max(trace.withSkills[i], 0.1), withoutV = Math.max(trace.withoutSkills[i], 0.1);
      timeGap += dx / withoutV - dx / withV;
      lead.push(timeGap * withV / BASHIN_METERS);
    }
    return lead;
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
    const { shape, trace, activations, nameOf, mode } = state;
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

    // 壁の高さ。差モードはリード（バ身）、速度モードは速度そのもの。
    let wallWith = null, wallWithout = null, heat = null;
    if (trace) {
      const wallMax = extent * WALL_HEIGHT_RATIO;
      if (mode === "speed") {
        const all = trace.withSkills.concat(trace.withoutSkills);
        const floor = Math.min(...all) - 0.5, top = Math.max(...all);
        const scale = wallMax / Math.max(top - floor, 0.1);
        wallWith = trace.withSkills.map(v => (v - floor) * scale);
        wallWithout = trace.withoutSkills.map(v => (v - floor) * scale);
      } else {
        const lead = cumulativeLead(trace);
        const peak = Math.max(...lead.map(Math.abs), 0.05);
        wallWith = lead.map(v => Math.max(v, 0) / peak * wallMax);
      }
      heat = trace.withSkills.map((v, i) => v - trace.withoutSkills[i]);   // 速度差（色に使う）
    }

    const yaw = state.yaw, cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const cameraDistance = extent * 2.2;
    const project = (x, y, z) => {
      const X = x - cx, Y = y - cy;
      const xr = X * cosY - Y * sinY, yr = X * sinY + Y * cosY;
      const sy = yr * Math.sin(PITCH) - z * Math.cos(PITCH);
      const depth = yr * Math.cos(PITCH) + z * Math.sin(PITCH);
      const persp = cameraDistance / (cameraDistance + depth);
      return { x: xr * persp, y: sy * persp, depth };
    };

    // 画面に収める。帯と壁の頂点すべてで範囲を取る。
    const half = TRACE_TRACK_WIDTH_M / 2;
    const edge = (p, side) => ({ x: p.x - Math.sin(p.heading) * half * side, y: p.y + Math.cos(p.heading) * half * side, z: p.z });
    const probe = [];
    path.forEach((p, i) => {
      const a = edge(p, 1), b = edge(p, -1);
      probe.push(project(a.x, a.y, a.z), project(b.x, b.y, b.z));
      if (wallWith) probe.push(project(p.x, p.y, p.z + Math.max(wallWith[i], wallWithout ? wallWithout[i] : 0)));
    });
    const minX = Math.min(...probe.map(q => q.x)), maxX = Math.max(...probe.map(q => q.x));
    const minY = Math.min(...probe.map(q => q.y)), maxY = Math.max(...probe.map(q => q.y));
    const margin = 18;
    const fit = Math.min((width - margin * 2) / (maxX - minX || 1), (height - margin * 2 - 10) / (maxY - minY || 1));
    const toScreen = q => ({ x: margin + (q.x - minX) * fit + ((width - margin * 2) - (maxX - minX) * fit) / 2,
                             y: margin + 10 + (q.y - minY) * fit, depth: q.depth });
    const screen = (x, y, z) => toScreen(project(x, y, z));

    // 奥から順に描く（画家のアルゴリズム）。帯と壁を区間ごとの四角形として集める。
    const quads = [];
    for (let i = 0; i < path.length - 1; i++) {
      const p0 = path[i], p1 = path[i + 1];
      const a0 = edge(p0, 1), b0 = edge(p0, -1), a1 = edge(p1, 1), b1 = edge(p1, -1);
      const pts = [screen(a0.x, a0.y, a0.z), screen(a1.x, a1.y, a1.z), screen(b1.x, b1.y, b1.z), screen(b0.x, b0.y, b0.z)];
      quads.push({ depth: pts.reduce((s, q) => s + q.depth, 0) / 4 + 1, kind: "track", pts, corner: p1.inCorner });
      if (wallWithout) quads.push(wallQuad(p0, p1, wallWithout[i], wallWithout[i + 1], "without", 0));
      if (wallWith) quads.push(wallQuad(p0, p1, wallWith[i], wallWith[i + 1], "with", heat ? heat[i + 1] : 0));
    }
    function wallQuad(p0, p1, h0, h1, kind, diff) {
      const pts = [screen(p0.x, p0.y, p0.z), screen(p1.x, p1.y, p1.z),
                   screen(p1.x, p1.y, p1.z + h1), screen(p0.x, p0.y, p0.z + h0)];
      return { depth: (pts[0].depth + pts[1].depth) / 2, kind, pts, diff };
    }
    // 帯を先に全部描き、その上に壁を奥から順に重ねる。
    // 帯と壁を同じ並びで描くと、手前の帯が壁の根元を塗りつぶして三角の欠けが出る。
    quads.sort((a, b) => (a.kind === "track") !== (b.kind === "track")
      ? (a.kind === "track" ? -1 : 1) : b.depth - a.depth);

    const maxHeat = heat ? Math.max(...heat.map(Math.abs), 0.05) : 1;
    for (const quad of quads) {
      ctx.beginPath();
      quad.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      if (quad.kind === "track") {
        ctx.fillStyle = quad.corner ? "#cfd9cf" : "#e3e8e2";
        ctx.fill();
      } else if (quad.kind === "without") {
        ctx.fillStyle = "rgba(120,128,124,0.28)"; ctx.fill();
        ctx.strokeStyle = "rgba(90,98,94,0.7)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(quad.pts[3].x, quad.pts[3].y); ctx.lineTo(quad.pts[2].x, quad.pts[2].y); ctx.stroke();
      } else {
        // 速度が上がっている区間ほど濃い緑、下がっている区間は赤。差が出ていない区間は淡く。
        const strength = Math.min(Math.abs(quad.diff) / maxHeat, 1);
        const alpha = 0.18 + 0.55 * strength;
        ctx.fillStyle = quad.diff >= 0 ? `rgba(47,111,79,${alpha})` : `rgba(179,38,30,${alpha})`;
        ctx.fill();
        ctx.strokeStyle = "#1f4d36"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(quad.pts[3].x, quad.pts[3].y); ctx.lineTo(quad.pts[2].x, quad.pts[2].y); ctx.stroke();
      }
    }

    // スタートとゴールの旗、発動位置のピン
    const at = pos => path[Math.min(Math.round(pos / shape.distance * (path.length - 1)), path.length - 1)];
    const flag = (p, text) => {
      const q = screen(p.x, p.y, p.z);
      ctx.fillStyle = "#6a746e"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(text, q.x, q.y + 14);
    };
    flag(path[0], "スタート");
    flag(path[path.length - 1], "ゴール");

    for (const cluster of clusterActivations(activations || [], shape.distance)) {
      const p = at(cluster.pos);
      const index = path.indexOf(p);
      const wall = wallWith ? Math.max(wallWith[index], wallWithout ? wallWithout[index] : 0) : 0;
      const base = screen(p.x, p.y, p.z), top = screen(p.x, p.y, p.z + wall + extent * 0.07);
      ctx.strokeStyle = "#2f6f4f"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      const first = cluster.members[0].no, last = cluster.members[cluster.members.length - 1].no;
      const label = first === last ? String(first) : `${first}-${last}`;
      ctx.font = "bold 11px sans-serif";
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = "#2f6f4f";
      ctx.beginPath(); ctx.roundRect(top.x - w / 2, top.y - 9, w, 18, 9); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(label, top.x, top.y + 4);
    }

    const caption = host.querySelector(".c3dCaption");
    if (!trace) caption.textContent = "再計算すると、差がついた場所を表示します";
    else if (mode === "speed") caption.textContent = "高さ＝速度（緑：スキルあり／灰：なし）";
    // ゴールでの差の数値は出さない。図は1回だけ走らせた形で、結果欄の値（複数回の平均）と一致しない。
    else caption.textContent = "高さ＝差の広がり（濃い緑＝速度が上がっている区間）";
  }

  // 3Dコース図の部品を作る。trace が null なら帯とピンだけを描く。
  window.renderCourse3D = function (shape, trace, activations, nameOf) {
    if (!shape || !shape.distance) return null;
    const host = document.createElement("div");
    host.className = "c3d";
    host.innerHTML = `<canvas aria-label="3Dコース図。ドラッグで回転できます。"></canvas>
      <div class="c3dBar"><span class="c3dCaption"></span>
      <span class="c3dModes"><button type="button" data-mode="lead" class="on">差</button><button type="button" data-mode="speed">速度</button></span></div>`;
    const state = { shape, trace, activations, nameOf, mode: "lead", yaw: -0.5 };
    const draw = () => render(host, state);

    host.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      host.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("on", b === button));
      draw();
    }));
    host.querySelector(".c3dModes").hidden = !trace;

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

    // 画面に入ってから描く（幅が決まっていないと大きさを測れない）。
    requestAnimationFrame(draw);
    new ResizeObserver(draw).observe(host);
    return host;
  };
})();
