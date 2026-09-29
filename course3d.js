// 3Dコース図。コースの上に「スキルでどれだけ速くなったか」を壁の高さと色で立てる。
// v-tグラフと同じ役割を、時間軸ではなくコース上の位置で見せる。ドラッグで回転できる。
//
// 形は実測の座標ではなく、コーナー1つ＝90度として直線とコーナーの長さから組み立てる。
// 中山2500m（コーナー6つ＝1周半）でも形が合う。坂の高さは見やすさのため誇張する。
(function () {
  const TRACK_WIDTH_M = 46;             // 帯の幅（誇張）
  const SLOPE_EXAGGERATION = 14;        // 坂の高さの誇張倍率
  const SLOPE_UNIT = 1e6;               // course_data の slope は 15000 = 1.5%
  const PITCH = 0.95;                   // 見下ろす角度[rad]
  const WALL_HEIGHT_RATIO = 0.22;       // 壁の最大の高さ（コースの広がりに対する比）
  const MIN_WALL_SHARE = 0.12;          // 差がある区間の最低の高さ（最大に対する比）。小さな差も見えるように
  const NO_DIFF_MPS = 0.003;            // これ未満の速度差は「差なし」として壁を立てない

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

  // 差の大きさを 0〜1 に。差が無ければ 0、あれば最低 MIN_WALL_SHARE。
  // 平方根の目盛りにして、小さな差でも高さと色が乗るようにする
  // （線形だと、最大差の1割程度の区間がほぼ平らで無色に見えた）。
  function strengthOf(diff, maxAbs) {
    if (Math.abs(diff) < NO_DIFF_MPS) return 0;
    return MIN_WALL_SHARE + (1 - MIN_WALL_SHARE) * Math.sqrt(Math.min(Math.abs(diff) / maxAbs, 1));
  }

  function colorOf(diff, maxAbs) {
    if (Math.abs(diff) < NO_DIFF_MPS) return `rgb(${NEUTRAL.join(",")})`;
    const t = 0.25 + 0.75 * strengthOf(diff, maxAbs);
    const target = diff > 0 ? FASTER : SLOWER;
    const mix = NEUTRAL.map((c, i) => Math.round(c + (target[i] - c) * t));
    return `rgb(${mix.join(",")})`;
  }

  function render(host, state) {
    const { shape, trace } = state;
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
    const wallMax = extent * WALL_HEIGHT_RATIO;

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

    // 画面に収める（帯の両端と、壁の最大の高さまで）
    const probe = path.flatMap(p => [edge(p, 1), edge(p, -1), project(p.x, p.y, p.z + wallMax)]);
    const minX = Math.min(...probe.map(q => q.x)), maxX = Math.max(...probe.map(q => q.x));
    const minY = Math.min(...probe.map(q => q.y)), maxY = Math.max(...probe.map(q => q.y));
    const margin = 16;
    const fit = Math.min((width - margin * 2) / (maxX - minX || 1), (height - margin * 2) / (maxY - minY || 1));
    const offsetX = margin + ((width - margin * 2) - (maxX - minX) * fit) / 2;
    const toScreen = q => ({ x: offsetX + (q.x - minX) * fit, y: margin + (q.y - minY) * fit, depth: q.depth });

    // 帯を先に全部塗り、その上に壁を奥から順に立てる。
    // 帯と壁を同じ並びで描くと、手前の帯が壁の根元を塗りつぶして欠ける。
    const neutral = `rgb(${NEUTRAL.join(",")})`;
    const quads = [];
    for (let i = 0; i < path.length - 1; i++) {
      const p0 = path[i], p1 = path[i + 1];
      const band = [edge(p0, 1), edge(p1, 1), edge(p1, -1), edge(p0, -1)].map(toScreen);
      quads.push({ pts: band, depth: band.reduce((sum, q) => sum + q.depth, 0) / 4, color: neutral, isWall: false });
      if (!diffs) continue;
      const h0 = strengthOf(diffs[i], maxAbs) * wallMax, h1 = strengthOf(diffs[i + 1], maxAbs) * wallMax;
      if (h0 === 0 && h1 === 0) continue;
      const wall = [project(p0.x, p0.y, p0.z), project(p1.x, p1.y, p1.z),
                    project(p1.x, p1.y, p1.z + h1), project(p0.x, p0.y, p0.z + h0)].map(toScreen);
      quads.push({ pts: wall, depth: (wall[0].depth + wall[1].depth) / 2,
                   color: colorOf(diffs[i + 1], maxAbs), isWall: true });
    }
    quads.sort((a, b) => a.isWall !== b.isWall ? (a.isWall ? 1 : -1) : b.depth - a.depth);
    for (const quad of quads) {
      ctx.beginPath();
      quad.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fillStyle = quad.color; ctx.fill();
      ctx.strokeStyle = quad.color; ctx.lineWidth = 0.8; ctx.stroke();   // 区間の継ぎ目の隙間を埋める
      if (quad.isWall) {                                                 // 壁の上端だけ濃く縁取る
        ctx.strokeStyle = "#1f4d36"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(quad.pts[3].x, quad.pts[3].y); ctx.lineTo(quad.pts[2].x, quad.pts[2].y); ctx.stroke();
      }
    }

    const label = (p, text) => {
      const q = toScreen(project(p.x, p.y, p.z));
      ctx.fillStyle = "#4d5751"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(text, q.x, q.y + 4);
    };
    label(path[0], "S");
    label(path[path.length - 1], "G");

    const legend = host.querySelector(".c3dLegend");
    legend.hidden = !diffs;
    if (diffs) legend.querySelector(".c3dMax").textContent = `+${maxAbs.toFixed(2)} m/s`;
    host.querySelector(".c3dCaption").textContent = diffs ? "高さ・色＝スキルで速くなった量" : "再計算すると表示します";
  }

  // 3Dコース図の部品を作る。trace が null なら灰色の帯だけを描く。
  window.renderCourse3D = function (shape, trace) {
    if (!shape || !shape.distance) return null;
    const host = document.createElement("div");
    host.className = "c3d";
    host.innerHTML = `<canvas aria-label="3Dコース図。ドラッグで回転できます。"></canvas>
      <div class="c3dBar"><span class="c3dCaption"></span>
      <span class="c3dLegend"><span>0</span><i></i><span class="c3dMax"></span></span></div>`;
    const state = { shape, trace, yaw: -0.5 };
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
