/* ============================================================================
   STK 영수증 비전 — 사진 한 장에서 영수증을 찾아 바로 세우고, 두 방식으로 읽을 이미지를 만든다.
   (Python 시험판 pipe2.py 를 그대로 옮긴 것 — 실제 영수증 8장에서 핵심 항목 93%)

   1) PaddleOCR PP-OCRv5 글줄 검출(ONNX, 언어 무관) — 책상 · 손 · 그림자를 빼고 글자 줄만 찾는다.
   2) 방향 — 글줄 상자가 대부분 세로로 길면 90° 돌리고, PaddleOCR 방향 분류기로 180° 를 가른다. 작은 기울기는 상자 각도의 중앙값으로 편다.
   3) 영수증 나누기 — 종이(밝고 채도 낮은 영역) 단위로 묶고, 한 종이 안에 영수증이 붙어 있으면 글 간격으로 다시 나눈다.
      그림자 · 구김으로 종이에서 빠진 글줄은 버리지 않고 가장 가까운 영수증에 붙인다.
   4) 읽을 이미지 두 가지 — ① 영역: 글줄 밖을 흰색으로 지운 영수증 영역 ② 글줄 시트: 검출 상자를 줄마다 잘라
      대비 · 높이를 맞춰 다시 쌓은 것. 앱이 둘 다 Tesseract 로 읽고 ReceiptParser.mergeReadings 로 항목마다 고른다.

   필요: window.ort(onnxruntime-web). 모델: models/det.onnx · models/cls.onnx(PaddleOCR, Apache-2.0).
   ========================================================================== */
(function (root) {
  "use strict";
  const DEG = Math.PI / 180;
  let _det = null, _cls = null;
  async function sessions(base) {
    if (!_det) {
      const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      [_det, _cls] = await Promise.all([ort.InferenceSession.create(base + "det.onnx", opt), ort.InferenceSession.create(base + "cls.onnx", opt)]);
    }
    return { det: _det, cls: _cls };
  }

  // ── 캔버스 도우미 ──────────────────────────────────────────────────────────
  const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const ctx2 = (c) => c.getContext("2d", { willReadFrequently: true });
  function rotateCanvas(src, deg) {                                     // 90 · 180 · 270 은 크기 바뀜, 그 밖은 같은 크기(흰 바탕)
    const q = ((deg % 360) + 360) % 360;
    const swap = q === 90 || q === 270;
    const c = swap ? mk(src.height, src.width) : mk(src.width, src.height), x = ctx2(c);
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.translate(c.width / 2, c.height / 2); x.rotate(deg * DEG); x.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }
  // 사각형의 방향은 180° 마다 같다 — (-90°, 90°] 로 맞춘다. 안 맞추면 캘리퍼가 돌려준 ±180° 근처 각도 때문에
  // 글줄 조각이 뒤집혀 잘리고, 방향 분류기가 「뒤집힘」 이라 해 영수증 전체를 거꾸로 세웠다(시험에서 확인).
  const normA = (a) => { a = ((a + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2; return a <= -Math.PI / 2 + 1e-9 ? a + Math.PI : a; };
  // 회전 사각형 { cx, cy, w, h, a(라디안, w 변의 방향) } 을 잘라 가로로 눕힌 캔버스로
  function rectCrop(src, b, pad = 0) {
    let { cx, cy, w, h, a } = b;
    if (w < h) { [w, h] = [h, w]; a += Math.PI / 2; }
    a = normA(a);
    const e = Math.min(w, h) * pad; w += e; h += e;
    const c = mk(w, h), x = ctx2(c);
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.translate(c.width / 2, c.height / 2); x.rotate(-a); x.drawImage(src, -cx, -cy);
    return c;
  }
  function boxPoints(b, grow = 0) {
    const w = b.w + grow, h = b.h + grow, ca = Math.cos(b.a), sa = Math.sin(b.a);
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [b.cx + x * ca - y * sa, b.cy + x * sa + y * ca]);
  }
  const shortSide = (b) => Math.min(b.w, b.h);
  function grayOf(c) {
    const d = ctx2(c).getImageData(0, 0, c.width, c.height).data, g = new Float32Array(c.width * c.height);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return g;
  }
  function putGray(g, w, h) {
    const c = mk(w, h), x = ctx2(c), im = x.createImageData(w, h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) { const v = g[j] < 0 ? 0 : g[j] > 255 ? 255 : g[j]; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
    x.putImageData(im, 0, 0); return c;
  }
  function boxBlur(src, w, h, r) {                                        // 가로 · 세로 누적합
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) { let s = 0; const o = y * w;
      for (let x = -r; x < w; x++) { if (x + r < w) s += src[o + x + r]; if (x - r - 1 >= 0) s -= src[o + x - r - 1]; if (x >= 0) tmp[o + x] = s / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1); } }
    for (let x = 0; x < w; x++) { let s = 0;
      for (let y = -r; y < h; y++) { if (y + r < h) s += tmp[(y + r) * w + x]; if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * w + x]; if (y >= 0) out[y * w + x] = s / (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1); } }
    return out;
  }
  function percentile(g, p) {
    const hist = new Uint32Array(256); for (let j = 0; j < g.length; j++) hist[Math.max(0, Math.min(255, g[j] | 0))]++;
    let c = 0, n = g.length * p; for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= n) return v; } return 255;
  }
  function stretch(g, lo, hi) { const k = 255 / Math.max(1, hi - lo); for (let j = 0; j < g.length; j++) g[j] = Math.max(0, Math.min(255, (g[j] - lo) * k)); return g; }
  function minMaxFilter(m, w, h, rx, ry, isMax) {                          // 이진 팽창(max) · 침식(min), 가로 → 세로
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = isMax ? 0 : 1; for (let k = Math.max(0, x - rx); k <= Math.min(w - 1, x + rx); k++) { const q = m[y * w + k]; if (isMax ? q : !q) { v = isMax ? 1 : 0; break; } } t[y * w + x] = v; }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let v = isMax ? 0 : 1; for (let k = Math.max(0, y - ry); k <= Math.min(h - 1, y + ry); k++) { const q = t[k * w + x]; if (isMax ? q : !q) { v = isMax ? 1 : 0; break; } } o[y * w + x] = v; }
    return o;
  }
  function components(m, w, h) {                                          // 4-이웃 연결 요소 → 라벨(0 = 배경)
    const lab = new Int32Array(w * h); let n = 0; const st = [];
    for (let i = 0; i < m.length; i++) {
      if (!m[i] || lab[i]) continue; n++; lab[i] = n; st.push(i);
      while (st.length) { const p = st.pop(), x = p % w, y = (p / w) | 0;
        if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = n; st.push(p - 1); }
        if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = n; st.push(p + 1); }
        if (y > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = n; st.push(p - w); }
        if (y < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = n; st.push(p + w); } }
    }
    return { lab, n };
  }
  function fillBoxes(w, h, boxes, scale, grow = 0) {                      // 상자들을 채운 마스크(0/1)
    const c = mk(w, h), x = ctx2(c); x.fillStyle = "#fff";
    for (const b of boxes) { const p = boxPoints(b, grow).map(([u, v]) => [u * scale, v * scale]); x.beginPath(); x.moveTo(p[0][0], p[0][1]); for (let k = 1; k < 4; k++) x.lineTo(p[k][0], p[k][1]); x.closePath(); x.fill(); }
    const d = x.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < m.length; i += 4, j++) m[j] = d[i] > 127 ? 1 : 0;
    return m;
  }

  // ── 최소 넓이 회전 사각형(볼록 껍질 + 회전 캘리퍼) ──────────────────────────
  function hull(pts) {
    pts = pts.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function minAreaRect(pts) {
    const H = hull(pts);
    if (H.length < 3) { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1, a: 0 }; }
    let best = null;
    for (let i = 0; i < H.length; i++) {
      const p = H[i], q = H[(i + 1) % H.length], th = Math.atan2(q[1] - p[1], q[0] - p[0]), c = Math.cos(th), s = Math.sin(th);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of H) { const u = x * c + y * s, v = -x * s + y * c; if (u < x0) x0 = u; if (u > x1) x1 = u; if (v < y0) y0 = v; if (v > y1) y1 = v; }
      const area = (x1 - x0) * (y1 - y0);
      if (!best || area < best.area) { const mu = (x0 + x1) / 2, mv = (y0 + y1) / 2; best = { area, cx: mu * c - mv * s, cy: mu * s + mv * c, w: x1 - x0 + 1, h: y1 - y0 + 1, a: th }; }
    }
    best.a = normA(best.a);
    return best;
  }

  // ── 글줄 검출(DB) ──────────────────────────────────────────────────────────
  async function detect(src, S, maxSide = 1600) {
    const W = src.width, H = src.height, k = Math.min(1, maxSide / Math.max(W, H));
    const w = Math.max(32, Math.round((W * k) / 32) * 32), h = Math.max(32, Math.round((H * k) / 32) * 32);
    const c = mk(w, h); ctx2(c).drawImage(src, 0, 0, w, h);
    const d = ctx2(c).getImageData(0, 0, w, h).data, n = w * h, x = new Float32Array(3 * n);
    // PaddleOCR 은 BGR 순서 · mean(0.485, 0.456, 0.406) · std(0.229, 0.224, 0.225) — 시험판(cv2)과 같게
    for (let i = 0, j = 0; j < n; i += 4, j++) { x[j] = (d[i + 2] / 255 - 0.485) / 0.229; x[n + j] = (d[i + 1] / 255 - 0.456) / 0.224; x[2 * n + j] = (d[i] / 255 - 0.406) / 0.225; }
    const out = await S.det.run({ x: new ort.Tensor("float32", x, [1, 3, h, w]) });
    const prob = out[Object.keys(out)[0]].data;
    const bin = new Uint8Array(n); for (let j = 0; j < n; j++) bin[j] = prob[j] > 0.3 ? 1 : 0;
    const { lab, n: cnt } = components(bin, w, h);
    const pts = Array.from({ length: cnt + 1 }, () => []), sum = new Float32Array(cnt + 1), num = new Uint32Array(cnt + 1);
    for (let j = 0; j < n; j++) { const l = lab[j]; if (!l) continue; sum[l] += prob[j]; num[l]++;
      const xx = j % w, yy = (j / w) | 0;                                  // 경계 화소만 껍질 후보로
      if (xx === 0 || yy === 0 || xx === w - 1 || yy === h - 1 || !bin[j - 1] || !bin[j + 1] || !bin[j - w] || !bin[j + w]) pts[l].push([xx, yy]); }
    const sx = W / w, sy = H / h, boxes = [];
    for (let l = 1; l <= cnt; l++) {
      if (num[l] < 12 || sum[l] / num[l] < 0.5) continue;
      const r = minAreaRect(pts[l]); const e = Math.min(r.w, r.h) * 0.3 + 1;   // unclip ≈ 1.6
      boxes.push({ cx: r.cx * sx, cy: r.cy * sy, w: (r.w + 2 * e) * sx, h: (r.h + 2 * e) * sy, a: r.a, score: sum[l] / num[l] });
    }
    return boxes;
  }
  // 상자의 긴 변이 세로인가(화면 기준 투영 크기로)
  function longVertical(b) { const p = boxPoints(b), xs = p.map((q) => q[0]), ys = p.map((q) => q[1]); return Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs); }
  function longAngleDeg(b) { let a = b.w >= b.h ? b.a : b.a + Math.PI / 2; a = ((a / DEG + 90) % 180 + 180) % 180 - 90; return a; }
  async function is180(src, boxes, S) {
    let votes = 0;
    const pick = boxes.slice().sort((p, q) => q.w * q.h - p.w * p.h).slice(0, 24);
    for (const b of pick) {
      const c = rectCrop(src, b); if (c.width < c.height * 1.5) continue;
      const t = mk(192, 48); ctx2(t).drawImage(c, 0, 0, 192, 48);
      const d = ctx2(t).getImageData(0, 0, 192, 48).data, n = 192 * 48, x = new Float32Array(3 * n);
      for (let i = 0, j = 0; j < n; i += 4, j++) { x[j] = (d[i + 2] / 255 - 0.5) / 0.5; x[n + j] = (d[i + 1] / 255 - 0.5) / 0.5; x[2 * n + j] = (d[i] / 255 - 0.5) / 0.5; }
      const o = await S.cls.run({ x: new ort.Tensor("float32", x, [1, 3, 48, 192]) }); const p = o[Object.keys(o)[0]].data;
      votes += p[1] > p[0] ? 1 : -1;
    }
    return votes > 0;
  }

  // ── 영수증 나누기 ──────────────────────────────────────────────────────────
  const dist = (b, c) => Math.hypot(b.cx - c.cx, b.cy - c.cy);
  function attach(rest, big) { for (const b of rest) { let k = 0, best = Infinity; big.forEach((g, i) => { for (const c of g) { const d = dist(b, c); if (d < best) { best = d; k = i; } } }); big[k].push(b); } }
  function paperGroups(src, boxes) {
    const W = src.width, H = src.height, s = 1000 / Math.max(W, H), w = Math.round(W * s), h = Math.round(H * s);
    const c = mk(w, h); ctx2(c).drawImage(src, 0, 0, w, h);
    const d = ctx2(c).getImageData(0, 0, w, h).data, V = new Float32Array(w * h), Sa = new Float32Array(w * h);
    for (let i = 0, j = 0; j < V.length; i += 4, j++) { const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); V[j] = mx; Sa[j] = mx ? ((mx - mn) / mx) * 255 : 0; }
    const v = boxBlur(boxBlur(V, w, h, 2), w, h, 2), sat = boxBlur(boxBlur(Sa, w, h, 2), w, h, 2);
    // Otsu
    const hist = new Float64Array(256); for (const q of v) hist[Math.max(0, Math.min(255, q | 0))]++;
    let tot = v.length, sumAll = 0; for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let wB = 0, sB = 0, best = -1, th = 128;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sumAll - sB) / wF, bv = wB * wF * (mB - mF) ** 2; if (bv > best) { best = bv; th = t; } }
    const fill = fillBoxes(w, h, boxes, s);
    let m = new Uint8Array(w * h); for (let j = 0; j < m.length; j++) m[j] = (v[j] > th && sat[j] < 70) || fill[j] ? 1 : 0;
    m = minMaxFilter(minMaxFilter(m, w, h, 4, 4, false), w, h, 4, 4, true);   // 열기 9×9 — 가는 다리 끊기
    const { lab } = components(m, w, h), by = new Map();
    for (const b of boxes) { const x = Math.min(w - 1, Math.max(0, Math.round(b.cx * s))), y = Math.min(h - 1, Math.max(0, Math.round(b.cy * s))); const g = lab[y * w + x]; if (!by.has(g)) by.set(g, []); by.get(g).push(b); }
    const big = [], rest = [];
    for (const [g, v2] of by) (g && v2.length >= 6 ? big : rest).push(...(g && v2.length >= 6 ? [v2] : v2));
    if (!big.length) return [];
    attach(rest, big);                                                       // 그림자 속 글줄도 버리지 않는다
    return big.sort((p, q) => Math.min(...p.map((b) => b.cx)) - Math.min(...q.map((b) => b.cx)));
  }
  function textGroups(boxes, W, H) {
    const s = 1000 / Math.max(W, H), w = Math.round(W * s), h = Math.round(H * s);
    const mh = median(boxes.map(shortSide)) * s || 8;
    const m = minMaxFilter(fillBoxes(w, h, boxes, s), w, h, Math.max(1, Math.round(mh * 1.1)), Math.max(1, Math.round(mh * 1.3)), true);
    const { lab } = components(m, w, h), by = new Map();
    for (const b of boxes) { const x = Math.min(w - 1, Math.max(0, Math.round(b.cx * s))), y = Math.min(h - 1, Math.max(0, Math.round(b.cy * s))); const g = lab[y * w + x]; if (!by.has(g)) by.set(g, []); by.get(g).push(b); }
    return [...by.values()].filter((v) => v.length >= 6).sort((p, q) => Math.min(...p.map((b) => b.cx)) - Math.min(...q.map((b) => b.cx)));
  }
  function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }
  /* 한 종이 영역 안에 붙은 영수증 나누기 — 어떤 글줄도 가로지르지 않는 「빈 띠」 로 가른다.
     나란한 두 영수증 사이에는 위아래 끝까지 이어진 빈 띠가 있고, 한 영수증 안의 라벨 · 오른쪽 금액 사이는
     폭 전체를 쓰는 줄(주소 · 구분선 등)이 가로질러 빈 띠가 생기지 않는다. 팽창 크기에 기대던 예전 방식은
     상자 두께가 7% 달라지는 것만으로 붙어 버렸다(시험에서 확인). 두 쪽이 모두 영수증다워야(글줄 10개 이상 ·
     길이 방향으로 절반 이상) 나눈다 — 금액 열 같은 조각은 제자리에 둔다. */
  function gapSplit(g) {
    const mh = median(g.map(shortSide)) || 10;
    // 좌우로 나란한 경우만 — 영수증 안에도 단락 사이 가로 빈 띠가 있어 위아래로 가르면 한 장이 여러 조각이 된다(시험에서 확인).
    // 위아래로 놓인 영수증은 사이에 배경이 보여 종이 단위 묶기에서 이미 갈린다.
    for (const ax of [0]) {
      const ext = g.map((b) => { const p = boxPoints(b).map((q) => q[ax]); return [Math.min(...p), Math.max(...p), b]; }).sort((p, q) => p[0] - q[0]);
      let end = ext[0][1], cands = [];
      for (let i = 1; i < ext.length; i++) { if (ext[i][0] - end >= 0.8 * mh) cands.push({ at: (end + ext[i][0]) / 2, gap: ext[i][0] - end }); end = Math.max(end, ext[i][1]); }
      cands.sort((p, q) => q.gap - p.gap);
      const o = 1 - ax, span = (v) => { const c = v.map((b) => (o ? b.cy : b.cx)); return Math.max(...c) - Math.min(...c); }, spanG = span(g);
      for (const c of cands) {
        const A = g.filter((b) => (ax ? b.cy : b.cx) < c.at), B = g.filter((b) => (ax ? b.cy : b.cx) >= c.at);
        const ok = (v) => v.length >= 10 && span(v) > 0.5 * spanG;
        if (ok(A) && ok(B)) return [...gapSplit(A), ...gapSplit(B)];
      }
    }
    return [g];
  }
  function splitGroups(gs) { return gs.flatMap(gapSplit); }


  // ── 읽을 이미지 ① 영역 ② 글줄 시트 ────────────────────────────────────────
  function bounds(bs, grow = 20, W = Infinity, H = Infinity) {
    const p = bs.flatMap((b) => boxPoints(b)); const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - grow)), y0 = Math.max(0, Math.floor(Math.min(...ys) - grow));
    return { x0, y0, x1: Math.min(W, Math.ceil(Math.max(...xs) + grow)), y1: Math.min(H, Math.ceil(Math.max(...ys) + grow)) };
  }
  function regionImage(src, bs) {
    const r = bounds(bs, 20, src.width, src.height), w = r.x1 - r.x0, h = r.y1 - r.y0;
    const c = mk(w, h); ctx2(c).drawImage(src, r.x0, r.y0, w, h, 0, 0, w, h);
    let g = grayOf(c); const rr = Math.max(12, Math.round(w / 56)), bg = boxBlur(g, w, h, rr);
    for (let j = 0; j < g.length; j++) g[j] = Math.min(255, (g[j] / (bg[j] + 1)) * 255);
    g = stretch(g, percentile(g, 0.02), Math.max(percentile(g, 0.02) + 1, percentile(g, 0.98)));
    const moved = bs.map((b) => ({ ...b, cx: b.cx - r.x0, cy: b.cy - r.y0 }));
    const keep = fillBoxes(w, h, moved.map((b) => ({ ...b, w: b.w + shortSide(b) * 0.35, h: b.h + shortSide(b) * 0.35 })), 1);
    for (let j = 0; j < g.length; j++) if (!keep[j]) g[j] = 255;               // 글줄 밖은 흰색 — 배경 무늬 제거
    const k = 44 / Math.max(8, median(bs.map(shortSide)));
    const base = putGray(g, w, h), out = mk(w * k, h * k); const x = ctx2(out); x.imageSmoothingQuality = "high"; x.drawImage(base, 0, 0, out.width, out.height);
    return { canvas: out, k, x0: r.x0, y0: r.y0 };
  }
  function rowsOf(bs) {
    const it = bs.map((b) => ({ b, cy: b.cy, h: shortSide(b), cx: b.cx })).sort((p, q) => p.cy - q.cy), rows = [];
    for (const x of it) { const r = rows.find((r) => Math.abs(r.cy - x.cy) < 0.55 * Math.min(r.h, x.h)); if (r) { r.items.push(x); r.cy = r.items.reduce((s, q) => s + q.cy, 0) / r.items.length; } else rows.push({ cy: x.cy, h: x.h, items: [x] }); }
    rows.forEach((r) => r.items.sort((p, q) => p.cx - q.cx));
    return rows.sort((p, q) => p.cy - q.cy);
  }
  function sheetImage(src, bs, H = 46, gapX = 36, gapY = 22) {
    const rows = rowsOf(bs), strips = [];
    for (const r of rows) {
      const parts = [];
      for (const { b } of r.items) {
        const c = rectCrop(src, b, 0.18); const k = H / Math.max(1, c.height), w = Math.max(1, Math.round(c.width * k));
        const t = mk(w, H); const x = ctx2(t); x.imageSmoothingQuality = "high"; x.drawImage(c, 0, 0, w, H);
        let g = grayOf(t); g = stretch(g, percentile(g, 0.03), Math.max(percentile(g, 0.03) + 1, percentile(g, 0.97)));   // 조각마다 대비 — 그림자 쪽도 같게
        parts.push(putGray(g, w, H));
      }
      if (!parts.length) continue;
      const w = parts.reduce((s, p) => s + p.width, 0) + gapX * (parts.length - 1), st = mk(w, H), x = ctx2(st);
      x.fillStyle = "#fff"; x.fillRect(0, 0, w, H); let px = 0; for (const p of parts) { x.drawImage(p, px, 0); px += p.width + gapX; }
      const bb = bounds(r.items.map((q) => q.b), 2);
      strips.push({ c: st, box: bb });
    }
    const W = Math.max(...strips.map((s) => s.c.width)) + 40, Ht = strips.reduce((s, q) => s + q.c.height + gapY, 0) + 40;
    const sh = mk(W, Ht), x = ctx2(sh); x.fillStyle = "#fff"; x.fillRect(0, 0, W, Ht);
    let y = 20; const rowsOut = [];
    for (const s of strips) { x.drawImage(s.c, 20, y); rowsOut.push({ y0: y, y1: y + s.c.height, box: s.box }); y += s.c.height + gapY; }
    return { canvas: sh, rows: rowsOut };
  }

  // ── 본체 — 사진 한 장 → 영수증들 ───────────────────────────────────────────
  async function analyze(file, opt = {}) {
    const S = await sessions(opt.modelBase || "models/");
    const say = opt.onStep || (() => {});
    say("영수증을 찾는 중…");
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, (opt.maxSide || 3200) / Math.max(bmp.width, bmp.height));
    let img = mk(bmp.width * k, bmp.height * k); ctx2(img).drawImage(bmp, 0, 0, img.width, img.height);
    let boxes = await detect(img, S);
    if (!boxes.length) return { receipts: [], image: img };
    say("방향을 맞추는 중…");
    if (boxes.filter(longVertical).length > boxes.length / 2) { img = rotateCanvas(img, 90); boxes = await detect(img, S); }
    if (await is180(img, boxes, S)) { img = rotateCanvas(img, 180); boxes = await detect(img, S); }
    const angs = boxes.filter((b) => Math.max(b.w, b.h) > 3 * Math.min(b.w, b.h)).map(longAngleDeg).filter((a) => Math.abs(a) < 15);
    const skew = median(angs);
    if (Math.abs(skew) > 0.7) { img = rotateCanvas(img, -skew); boxes = await detect(img, S); }
    let gs = paperGroups(img, boxes); if (!gs.length) gs = textGroups(boxes, img.width, img.height); if (!gs.length) gs = [boxes];
    gs = splitGroups(gs);
    const receipts = gs.map((bs) => {
      const vb = bounds(bs, 30, img.width, img.height), vw = vb.x1 - vb.x0, vh = vb.y1 - vb.y0;
      const view = mk(vw, vh); ctx2(view).drawImage(img, vb.x0, vb.y0, vw, vh, 0, 0, vw, vh);   // 리뷰 화면 · 저장용(바로 세운 컬러 영수증)
      return { boxes: bs, view, viewBox: vb, region: regionImage(img, bs), sheet: sheetImage(img, bs) };
    });
    return { receipts, image: img };
  }

  const api = { analyze, minAreaRect, hull, rowsOf, median };
  root.ReceiptVision = api;
})(typeof window !== "undefined" ? window : globalThis);
