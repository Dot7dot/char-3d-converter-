// ---------------------------------------------------------------------------
// imgedit.js — non-destructive touch-ups for an uploaded view.
//
// A view keeps a list of operations (params.edits[view]) that are replayed on
// the background-removed image every time it is processed:
//
//   { t: 'erase', r, pts: [u, v, u, v, …] }        eraser stroke
//   { t: 'warp',  src: [u, v, …], dst: [u, v, …] } outline points dragged from src → dst
//
// Coordinates are fractions of the view's own frame (0…1; may go slightly
// outside), radii are fractions of the frame's longer side, so the same list
// works at preview resolution and at full resolution.
// ---------------------------------------------------------------------------
import { makeCanvas, finishView, isIdentityAlign } from './imageproc.js';

export const PAD = 0.3; // working margin around the frame, as a fraction of its longer side
export const padOf = (w, h) => Math.round(Math.max(w, h) * PAD);

/** Copy `img` (w × h) into a canvas with a transparent margin for edits that grow the shape. */
export function toPadded(img, w, h) {
  const p = padOf(w, h);
  const c = makeCanvas(w + p * 2, h + p * 2);
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, p, p, w, h);
  return c;
}
export function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0);
  return c;
}

// ------------------------------------------------------------------ erase
/** Draw (part of) an eraser stroke. `from` = index of the first point to draw. */
export function eraseStroke(canvas, op, w, h, from = 0) {
  const p = padOf(w, h), m = Math.max(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pts = op.pts;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = op.r * m * 2;
  ctx.fillStyle = ctx.strokeStyle = '#000';
  const X = (i) => p + pts[i * 2] * w, Y = (i) => p + pts[i * 2 + 1] * h;
  const n = pts.length / 2;
  const a = Math.max(0, Math.min(from, n - 1));
  ctx.beginPath(); ctx.arc(X(a), Y(a), op.r * m, 0, Math.PI * 2); ctx.fill();
  if (n - a > 1) {
    ctx.beginPath(); ctx.moveTo(X(a), Y(a));
    for (let i = a + 1; i < n; i++) ctx.lineTo(X(i), Y(i));
    ctx.stroke();
  }
  ctx.restore();
}

// ------------------------------------------------------------------- warp
export function warpMoved(op) {
  for (let i = 0; i < op.src.length; i++) if (Math.abs(op.src[i] - op.dst[i]) > 1e-5) return true;
  return false;
}

/** Thin-plate-spline interpolation of 2D displacements given at control points. */
function solveTPS(px, py, vx, vy) {
  const n = px.length, N = n + 3;
  const A = new Float64Array(N * N), bx = new Float64Array(N), by = new Float64Array(N);
  const U = (r2) => (r2 < 1e-14 ? 0 : r2 * Math.log(r2));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = px[i] - px[j], dy = py[i] - py[j];
      A[i * N + j] = U(dx * dx + dy * dy);
    }
    A[i * N + i] += 1e-5; // tiny regularisation: stable even when two points coincide
    A[i * N + n] = 1; A[i * N + n + 1] = px[i]; A[i * N + n + 2] = py[i];
    A[n * N + i] = 1; A[(n + 1) * N + i] = px[i]; A[(n + 2) * N + i] = py[i];
    bx[i] = vx[i]; by[i] = vy[i];
  }
  // Gaussian elimination with partial pivoting, two right-hand sides
  for (let c = 0; c < N; c++) {
    let piv = c, best = Math.abs(A[c * N + c]);
    for (let r = c + 1; r < N; r++) { const v = Math.abs(A[r * N + c]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-12) continue;
    if (piv !== c) {
      for (let k = 0; k < N; k++) { const t = A[c * N + k]; A[c * N + k] = A[piv * N + k]; A[piv * N + k] = t; }
      let t = bx[c]; bx[c] = bx[piv]; bx[piv] = t; t = by[c]; by[c] = by[piv]; by[piv] = t;
    }
    const d = A[c * N + c];
    for (let r = c + 1; r < N; r++) {
      const f = A[r * N + c] / d; if (!f) continue;
      for (let k = c; k < N; k++) A[r * N + k] -= f * A[c * N + k];
      bx[r] -= f * bx[c]; by[r] -= f * by[c];
    }
  }
  for (let c = N - 1; c >= 0; c--) {
    const d = A[c * N + c];
    if (Math.abs(d) < 1e-12) { bx[c] = 0; by[c] = 0; continue; }
    let sx = bx[c], sy = by[c];
    for (let k = c + 1; k < N; k++) { sx -= A[c * N + k] * bx[k]; sy -= A[c * N + k] * by[k]; }
    bx[c] = sx / d; by[c] = sy / d;
  }
  return (x, y) => {
    let ox = bx[n] + bx[n + 1] * x + bx[n + 2] * y, oy = by[n] + by[n + 1] * x + by[n + 2] * y;
    for (let i = 0; i < n; i++) {
      const dx = x - px[i], dy = y - py[i], u = U(dx * dx + dy * dy);
      ox += bx[i] * u; oy += by[i] * u;
    }
    return [ox, oy];
  };
}

/**
 * Warp a padded canvas so every outline point moves from src → dst, and the
 * rest of the picture follows smoothly. Returns a new canvas.
 */
export function warpCanvas(canvas, op, w, h) {
  if (!warpMoved(op)) return cloneCanvas(canvas);
  const W = canvas.width, H = canvas.height, p = padOf(w, h), m = Math.max(w, h);
  const n = op.src.length / 2;
  // backward mapping: for an output position near dst, read the input near src
  const px = [], py = [], vx = [], vy = [];
  for (let i = 0; i < n; i++) {
    const sx = op.src[i * 2] * w / m, sy = op.src[i * 2 + 1] * h / m, dx = op.dst[i * 2] * w / m, dy = op.dst[i * 2 + 1] * h / m;
    px.push(dx); py.push(dy); vx.push(sx - dx); vy.push(sy - dy);
  }
  // pin the far corners so the rest of the canvas stays put
  for (const [cx, cy] of [[-PAD, -PAD], [w / m + PAD, -PAD], [-PAD, h / m + PAD], [w / m + PAD, h / m + PAD]]) { px.push(cx); py.push(cy); vx.push(0); vy.push(0); }
  const f = solveTPS(px, py, vx, vy);
  // displacement on a coarse grid, then bilinear per pixel
  const G = 56, gw = G + 1;
  const gx = new Float32Array(gw * gw), gy = new Float32Array(gw * gw);
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
    const [ox, oy] = f((i / G * W - p) / m, (j / G * H - p) / m);
    gx[j * gw + i] = ox * m; gy[j * gw + i] = oy * m;
  }
  const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const out = new ImageData(W, H), o = out.data;
  for (let y = 0; y < H; y++) {
    const fy = (y + 0.5) / H * G, j = Math.min(G - 1, fy | 0), ty = fy - j;
    for (let x = 0; x < W; x++) {
      const fx = (x + 0.5) / W * G, i = Math.min(G - 1, fx | 0), tx = fx - i;
      const a = j * gw + i, b = a + 1, c = a + gw, d = c + 1;
      const sxp = x + (gx[a] * (1 - tx) + gx[b] * tx) * (1 - ty) + (gx[c] * (1 - tx) + gx[d] * tx) * ty;
      const syp = y + (gy[a] * (1 - tx) + gy[b] * tx) * (1 - ty) + (gy[c] * (1 - tx) + gy[d] * tx) * ty;
      if (sxp < 0 || syp < 0 || sxp > W - 1 || syp > H - 1) continue;
      const x0 = sxp | 0, y0 = syp | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), ax = sxp - x0, ay = syp - y0;
      const q0 = (y0 * W + x0) * 4, q1 = (y0 * W + x1) * 4, q2 = (y1 * W + x0) * 4, q3 = (y1 * W + x1) * 4;
      const w0 = (1 - ax) * (1 - ay), w1 = ax * (1 - ay), w2 = (1 - ax) * ay, w3 = ax * ay;
      const a0 = src[q0 + 3] * w0, a1 = src[q1 + 3] * w1, a2 = src[q2 + 3] * w2, a3 = src[q3 + 3] * w3;
      const al = a0 + a1 + a2 + a3;
      if (al < 1) continue;
      const t = (y * W + x) * 4;
      // interpolate with pre-multiplied alpha so transparent pixels don't darken the edge
      o[t] = (src[q0] * a0 + src[q1] * a1 + src[q2] * a2 + src[q3] * a3) / al;
      o[t + 1] = (src[q0 + 1] * a0 + src[q1 + 1] * a1 + src[q2 + 1] * a2 + src[q3 + 1] * a3) / al;
      o[t + 2] = (src[q0 + 2] * a0 + src[q1 + 2] * a1 + src[q2 + 2] * a2 + src[q3 + 2] * a3) / al;
      o[t + 3] = al;
    }
  }
  const res = makeCanvas(W, H);
  res.getContext('2d', { willReadFrequently: true }).putImageData(out, 0, 0);
  return res;
}

/** Replay a list of operations. `img` is the w × h view; returns the padded result. */
export function applyOps(img, w, h, ops, upTo = Infinity) {
  let c = toPadded(img, w, h);
  const n = Math.min(ops ? ops.length : 0, upTo);
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    if (op.t === 'erase') eraseStroke(c, op, w, h);
    else if (op.t === 'warp' && warpMoved(op)) c = warpCanvas(c, op, w, h);
  }
  return c;
}

// --------------------------------------------------------------- outline
const DIRS = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]]; // clockwise from west

/** Outer outlines of every sizeable shape in a padded canvas → [[x, y, …] in pixels]. */
function traceOutlines(canvas) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) fg[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? fg[y * W + x] : 0);
  const seen = new Uint8Array(W * H), stack = new Int32Array(W * H);
  const loops = [];
  for (let s = 0; s < W * H; s++) {
    if (!fg[s] || seen[s]) continue;
    // flood the component so it is traced once; remember its size
    let sp = 0, area = 0; stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const q = stack[--sp]; area++;
      const x = q % W, y = (q / W) | 0;
      if (x > 0 && fg[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack[sp++] = q - 1; }
      if (x < W - 1 && fg[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack[sp++] = q + 1; }
      if (y > 0 && fg[q - W] && !seen[q - W]) { seen[q - W] = 1; stack[sp++] = q - W; }
      if (y < H - 1 && fg[q + W] && !seen[q + W]) { seen[q + W] = 1; stack[sp++] = q + W; }
    }
    // Moore-neighbour tracing from the first pixel of the component (its west side is empty)
    const sx = s % W, sy = (s / W) | 0;
    const pts = [sx + 0.5, sy + 0.5];
    let cx = sx, cy = sy, start = 1, first = -1;
    for (let guard = 0; guard < W * H * 4; guard++) {
      let found = -1;
      for (let k = 0; k < 8; k++) { const dd = (start + k) % 8; if (at(cx + DIRS[dd][0], cy + DIRS[dd][1])) { found = dd; break; } }
      if (found < 0) break; // single pixel
      if (cx === sx && cy === sy) { if (first < 0) first = found; else if (found === first) break; }
      cx += DIRS[found][0]; cy += DIRS[found][1];
      pts.push(cx + 0.5, cy + 0.5);
      start = (found % 2 === 0 ? found + 7 : found + 6) % 8;
    }
    loops.push({ pts, area });
  }
  if (!loops.length) return [];
  const max = Math.max(...loops.map((l) => l.area));
  return loops.filter((l) => l.area >= max * 0.03 && l.pts.length >= 6).map((l) => l.pts);
}

/** `count` points spread evenly along the outline(s) of the picture, in frame fractions. */
export function outlinePoints(canvas, w, h, count) {
  const p = padOf(w, h);
  const loops = traceOutlines(canvas).map((pts) => {
    let len = 0;
    const n = pts.length / 2, seg = new Float32Array(n);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; seg[i] = Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]); len += seg[i]; }
    return { pts, seg, len, n };
  }).filter((l) => l.len > 0);
  if (!loops.length) return [];
  const total = loops.reduce((a, l) => a + l.len, 0);
  // share the points between shapes by perimeter (at least 3 each when possible)
  let left = count;
  const share = loops.map((l) => { const k = Math.max(Math.min(3, count), Math.round(count * l.len / total)); left -= k; return k; });
  const big = loops.indexOf(loops.reduce((a, l) => (l.len > a.len ? l : a)));
  share[big] = Math.max(1, share[big] + left);
  const out = [];
  loops.forEach((l, li) => {
    const k = share[li], step = l.len / k;
    let i = 0, acc = 0;
    for (let q = 0; q < k; q++) {
      const target = q * step;
      while (i < l.n - 1 && acc + l.seg[i] < target) { acc += l.seg[i]; i++; }
      const t = l.seg[i] ? (target - acc) / l.seg[i] : 0, j = (i + 1) % l.n;
      const x = l.pts[i * 2] + (l.pts[j * 2] - l.pts[i * 2]) * t, y = l.pts[i * 2 + 1] + (l.pts[j * 2 + 1] - l.pts[i * 2 + 1]) * t;
      out.push(+((x - p) / w).toFixed(4), +((y - p) / h).toFixed(4));
    }
  });
  return out;
}

// -------------------------------------------------------------- pipeline
export const hasEdits = (ops) => !!(ops && ops.some((o) => o.t === 'erase' || warpMoved(o)));

/** Binarise the alpha, drop crumbs left behind by the eraser, return the content's bounds. */
function contentBox(canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) fg[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  // connected components: keep those at least 1.5 % the size of the largest
  const label = new Int32Array(W * H).fill(-1), sizes = [], stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!fg[s] || label[s] >= 0) continue;
    const id = sizes.length; let size = 0, sp = 0;
    stack[sp++] = s; label[s] = id;
    while (sp) {
      const q = stack[--sp]; size++;
      const x = q % W, y = (q / W) | 0;
      if (x > 0 && fg[q - 1] && label[q - 1] < 0) { label[q - 1] = id; stack[sp++] = q - 1; }
      if (x < W - 1 && fg[q + 1] && label[q + 1] < 0) { label[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0 && fg[q - W] && label[q - W] < 0) { label[q - W] = id; stack[sp++] = q - W; }
      if (y < H - 1 && fg[q + W] && label[q + W] < 0) { label[q + W] = id; stack[sp++] = q + W; }
    }
    sizes.push(size);
  }
  const min = sizes.length ? Math.max(...sizes) * 0.015 : 0;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, keep = fg[i] && sizes[label[i]] >= min;
    d[i * 4 + 3] = keep ? 255 : 0; // crisp silhouette
    if (keep) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  ctx.putImageData(img, 0, 0);
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Full touch-up pipeline for one view:  edits → alignment → crop.
 *  - front: cropped to its new outline (it defines the part's width and height)
 *  - side : height stays locked to the front's frame, depth follows the content
 *  - top  : width stays locked to the front's frame, depth follows the content
 *  - back : stays in the front's frame
 * Returns a processed view (or `raw` itself when nothing changes).
 */
export function editView(raw, ops, align, kind) {
  const edited = hasEdits(ops), moved = kind !== 'front' && !isIdentityAlign(align);
  if (!edited && !moved) return raw;
  const w = raw.w, h = raw.h, p = padOf(w, h);
  let c = applyOps(raw.alphaCanvas, w, h, ops);
  if (moved) {
    const t = makeCanvas(c.width, c.height), ctx = t.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(p + w * (0.5 + align.dx), p + h * (0.5 + align.dy));
    ctx.rotate((align.rot * Math.PI) / 180);
    ctx.scale(align.sx, align.sy);
    ctx.drawImage(c, -(w / 2 + p), -(h / 2 + p));
    c = t;
  }
  const box = contentBox(c);
  if (!box) throw new Error('圖片內容被完全擦除或移出範圍了');
  let x0 = p, y0 = p, x1 = p + w - 1, y1 = p + h - 1; // the frame
  if (kind === 'front') ({ x0, y0, x1, y1 } = box);
  else if (kind === 'side') { x0 = box.x0; x1 = box.x1; }
  else if (kind === 'top') { y0 = box.y0; y1 = box.y1; }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = makeCanvas(cw, ch);
  out.getContext('2d', { willReadFrequently: true }).drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
  return finishView(out, raw.method);
}
