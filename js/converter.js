// ---------------------------------------------------------------------------
// converter.js — the 2D → 3D engine.
//
// Every conversion builds a 3D scalar field (positive = inside) from the
// silhouettes of the supplied views, extracts its surface with Surface Nets,
// smooths it and projects the original drawings back onto the mesh through a
// 2×2 texture atlas  [front | back]
//                    [side  | top ]
//
// Modes
//   inflate  — balloon-like volume from the front silhouette (local thickness)
//   extrude  — flat cut-out with rounded bevel (weapons, wings, badges)
//   revolve  — lathe around the vertical axis (hats, bottles, round things)
//   hull     — three-view carving: front ∩ side (∩ top). Most accurate.
//   plane    — two-sided alpha card (hair strands, capes, effects)
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { silhouetteSDF, makeCanvas, solidCanvas } from './imageproc.js';
import { surfaceNets } from './surfacenets.js';

export const MODES = {
  auto: '自動判斷',
  inflate: '膨脹 Inflate（圓潤物件）',
  extrude: '擠出 Extrude（扁平物件）',
  revolve: '旋轉體 Revolve（帽子/瓶罐）',
  hull: '三視圖雕刻 3-View Carve',
  plane: '平面卡片 Plane',
};

export const QUALITY = { low: 36, medium: 54, high: 84 };

function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Rounded intersection of two inside-positive distance fields. */
function roundIntersect(a, b, r) {
  const ua = Math.max(r - a, 0), ub = Math.max(r - b, 0);
  return -(Math.min(-r, Math.max(-a, -b)) + Math.hypot(ua, ub));
}

export function resolveMode(mode, views, slotDefault = 'inflate') {
  if (mode === 'auto') return (views.side || views.top) ? 'hull' : slotDefault;
  if (mode === 'hull' && !views.side && !views.top) return 'inflate';
  return mode;
}

// ------------------------------------------------------------ atlas helpers
const CELL = { front: 0, back: 1, side: 2, top: 3 };

function buildAtlas(views, size, useAlpha, backFill) {
  const atlas = makeCanvas(size, size);
  const ctx = atlas.getContext('2d');
  const half = size / 2;
  ctx.imageSmoothingQuality = 'high';
  const put = (canvas, cell) => {
    if (!canvas) return;
    const cx = (cell % 2) * half, cy = Math.floor(cell / 2) * half;
    ctx.drawImage(canvas, cx, cy, half, half);
  };
  const pick = (v) => v && (useAlpha ? v.alphaCanvas : v.colorCanvas);
  put(pick(views.front), CELL.front);
  if (views.back) put(pick(views.back), CELL.back);
  else if (backFill.type === 'color') put(solidCanvas(8, 8, backFill.color), CELL.back);
  // side cell: the real side view, or (if none) the outline-free "core" of the front view
  put(views.side ? pick(views.side) : (useAlpha ? null : views.front.coreCanvas), CELL.side);
  put(pick(views.top), CELL.top);
  return atlas;
}

function cellUV(cell, u, v, inset) {
  u = Math.min(Math.max(u, inset), 1 - inset);
  v = Math.min(Math.max(v, inset), 1 - inset);
  return [((cell % 2) + u) / 2, (Math.floor(cell / 2) + v) / 2];
}

// --------------------------------------------------------- inflate helpers
function localRadius(sd, w, h) {
  const R = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) R[i] = Math.max(0, sd[i]);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, s = sd[p];
    if (s <= 0.5) continue;
    const m = Math.max(sd[p - 1], sd[p + 1], sd[p - w], sd[p + w]);
    if (m - s >= 0.6) continue; // not on the medial ridge
    const r = Math.ceil(s);
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= w) continue;
        if (dx * dx + dy * dy > s * s) continue;
        const q = yy * w + xx;
        if (R[q] < s) R[q] = s;
      }
    }
  }
  return R;
}

function blurInside(hgt, sd, w, h, passes) {
  let a = hgt, b = new Float32Array(hgt.length);
  for (let it = 0; it < passes; it++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (sd[p] <= 0) { b[p] = a[p]; continue; }
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (sd[q] > 0) { s += a[q]; c++; }
      }
      b[p] = s / c;
    }
    [a, b] = [b, a];
  }
  return a;
}

// ----------------------------------------------------------- mesh helpers
function taubin(pos, idx, vcount, iterations) {
  if (!iterations) return;
  const nbStart = new Int32Array(vcount + 1);
  for (let t = 0; t < idx.length; t++) nbStart[idx[t] + 1] += 2;
  for (let i = 0; i < vcount; i++) nbStart[i + 1] += nbStart[i];
  const fill = nbStart.slice(0, vcount);
  const nb = new Int32Array(nbStart[vcount]);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nb[fill[a]++] = b; nb[fill[a]++] = c;
    nb[fill[b]++] = c; nb[fill[b]++] = a;
    nb[fill[c]++] = a; nb[fill[c]++] = b;
  }
  const tmp = new Float32Array(pos.length);
  const step = (lambda) => {
    for (let i = 0; i < vcount; i++) {
      const s = nbStart[i], e = nbStart[i + 1];
      if (e === s) { tmp[i * 3] = pos[i * 3]; tmp[i * 3 + 1] = pos[i * 3 + 1]; tmp[i * 3 + 2] = pos[i * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let k = s; k < e; k++) { const j = nb[k]; x += pos[j * 3]; y += pos[j * 3 + 1]; z += pos[j * 3 + 2]; }
      const n = e - s;
      tmp[i * 3] = pos[i * 3] + lambda * (x / n - pos[i * 3]);
      tmp[i * 3 + 1] = pos[i * 3 + 1] + lambda * (y / n - pos[i * 3 + 1]);
      tmp[i * 3 + 2] = pos[i * 3 + 2] + lambda * (z / n - pos[i * 3 + 2]);
    }
    pos.set(tmp);
  };
  for (let i = 0; i < iterations; i++) { step(0.5); step(-0.53); }
}

// ------------------------------------------------------------------ plane
function buildPlane(views, p, atlasSize) {
  const F = views.front;
  const A = F.w / F.h;
  const backFill = views.back ? { type: 'image' } : { type: 'mirror' };
  const atlas = buildAtlas(views, atlasSize, true, backFill);
  const x0 = -A / 2, x1 = A / 2, t = 0.004 * p.depth;
  const inset = 1 / atlasSize;
  const f = (u, v) => cellUV(CELL.front, u, v, inset);
  const b = (u, v) => views.back ? cellUV(CELL.back, 1 - u, v, inset) : cellUV(CELL.front, u, v, inset);
  const P = [], N = [], UV = [];
  const quad = (pts, n, uvf) => {
    for (const [x, y, z, u, v] of pts) { P.push(x, y, z); N.push(...n); UV.push(...uvf(u, v)); }
  };
  // front (CCW seen from +z)
  quad([[x0, 0, t, 0, 1], [x1, 0, t, 1, 1], [x1, 1, t, 1, 0], [x0, 0, t, 0, 1], [x1, 1, t, 1, 0], [x0, 1, t, 0, 0]], [0, 0, 1], f);
  // back (CCW seen from -z)
  quad([[x1, 0, -t, 1, 1], [x0, 0, -t, 0, 1], [x0, 1, -t, 0, 0], [x1, 0, -t, 1, 1], [x0, 1, -t, 0, 0], [x1, 1, -t, 1, 0]], [0, 0, -1], b);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  return { geometry: g, atlas, alpha: true, mode: 'plane', info: '平面卡片 · 4 三角形' };
}

// ------------------------------------------------------------------- main
/**
 * @param views  { front, side?, back?, top? } processed views (see imageproc.processView)
 * @param p      { mode, depth, roundness, smooth, backFill: 'mirror'|'color', }
 * @param opts   { resolution, atlasSize, slotDefault }
 */
export function convertPart(views, p, opts) {
  const F = views.front;
  const mode = resolveMode(p.mode, views, opts.slotDefault);
  if (mode === 'plane') return buildPlane(views, p, opts.atlasSize);

  const N = opts.resolution;
  const pad = 2;
  const X = F.w / F.h, Y = 1;
  let Zest = 0;
  if (mode === 'hull') Zest = views.side ? views.side.w / views.side.h : (views.top.h / views.top.w) * X;
  else if (mode === 'revolve') Zest = X;
  const g = Math.max(X, Y, Zest) / N;
  const cx = Math.max(2, Math.round(X / g)), cy = Math.max(2, Math.round(Y / g));
  const nx = cx + pad * 2, ny = cy + pad * 2;

  const front = silhouetteSDF(F.maskCanvas, cx, cy, pad).sdf; // row 0 = top
  const sF = (i, j) => front[i + nx * (ny - 1 - j)];

  let nz, cz = 0, field;
  const fieldAt = (i, j, k) => i + nx * (j + ny * k);

  if (mode === 'inflate') {
    const sd = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sd[i + nx * j] = sF(i, j);
    const R = localRadius(sd, nx, ny);
    let hgt = new Float32Array(nx * ny);
    let hmax = 1;
    for (let q = 0; q < nx * ny; q++) {
      const s = sd[q];
      if (s <= 0) { hgt[q] = s; continue; }
      const r = Math.max(R[q], s);
      hgt[q] = Math.sqrt(Math.max(0, s * (2 * r - s)));
    }
    hgt = blurInside(hgt, sd, nx, ny, 2);
    for (let q = 0; q < nx * ny; q++) if (hgt[q] > hmax) hmax = hgt[q];
    cz = Math.ceil(hmax) * 2 + 2;
    nz = cz + pad * 2;
    const zc = (nz - 1) / 2;
    field = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      const dz = Math.abs(k - zc);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const q = i + nx * j;
        field[fieldAt(i, j, k)] = Math.min(sd[q], hgt[q] - dz);
      }
    }
  } else if (mode === 'extrude') {
    const T = Math.max(2.2, 0.1 / g);
    cz = Math.ceil(T) + 2;
    nz = cz + pad * 2;
    const zc = (nz - 1) / 2;
    const bevel = Math.min(T / 2, 4) * (0.4 + p.roundness * 1.6);
    field = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      const slab = T / 2 - Math.abs(k - zc);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) field[fieldAt(i, j, k)] = smin(sF(i, j), slab, bevel);
    }
  } else if (mode === 'revolve') {
    nz = nx; cz = cx;
    const ax = (nx - 1) / 2, zc = (nz - 1) / 2;
    const sample = (x, j) => {
      if (x < 0) return sF(0, j) + x;
      if (x > nx - 1) return sF(nx - 1, j) - (x - nx + 1);
      const x0 = Math.floor(x), t = x - x0, x1 = Math.min(nx - 1, x0 + 1);
      return sF(x0, j) * (1 - t) + sF(x1, j) * t;
    };
    field = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const r = Math.hypot(i - ax, k - zc);
      for (let j = 0; j < ny; j++) field[fieldAt(i, j, k)] = Math.max(sample(ax + r, j), sample(ax - r, j));
    }
  } else { // hull
    cz = Math.max(2, Math.round(Zest / g));
    nz = cz + pad * 2;
    const side = views.side ? silhouetteSDF(views.side.maskCanvas, cz, cy, pad).sdf : null;
    const top = views.top ? silhouetteSDF(views.top.maskCanvas, cx, cz, pad).sdf : null;
    // rounded intersection: the crease where two silhouettes meet becomes an arc of radius r,
    // so cross-sections are rounded rectangles → ellipses instead of sharp boxes.
    let mF = 0, mS = 0;
    for (const v of front) if (v > mF) mF = v;
    for (const v of (side || top)) if (v > mS) mS = v;
    const r = Math.max(0.5, p.roundness * Math.min(mF, mS) * 1.6);
    field = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let f = sF(i, j);
      if (side) f = roundIntersect(f, side[k + nz * (ny - 1 - j)], r);
      if (top) f = roundIntersect(f, top[i + nx * k], r);
      field[fieldAt(i, j, k)] = f;
    }
  }

  // ---- surface extraction
  const { positions: gp, indices } = surfaceNets(field, nx, ny, nz);
  const vcount = gp.length / 3;
  if (!vcount) throw new Error('無法從這張圖產生形狀（輪廓太小或去背失敗）');
  taubin(gp, indices, vcount, p.smooth);

  // grid → local units. Origin: bottom-centre of the front silhouette.
  const depth = p.depth;
  const xc = (nx - 1) / 2, zc = (nz - 1) / 2;
  const local = new Float32Array(gp.length);
  for (let v = 0; v < vcount; v++) {
    local[v * 3] = (gp[v * 3] - xc) * g;
    local[v * 3 + 1] = (gp[v * 3 + 1] + 0.5 - pad) * g;
    local[v * 3 + 2] = (gp[v * 3 + 2] - zc) * g * depth;
  }
  const ig = new THREE.BufferGeometry();
  ig.setAttribute('position', new THREE.BufferAttribute(local, 3));
  ig.setIndex(indices);
  ig.computeVertexNormals();
  const nrm = ig.getAttribute('normal').array;

  // ---- texture projection
  const backFill = views.back ? { type: 'image' }
    : p.backFill === 'color' ? { type: 'color', color: F.topColor } : { type: 'mirror' };
  const atlas = buildAtlas(views, opts.atlasSize, false, backFill);
  const inset = 1.5 / (opts.atlasSize / 2);
  const hasSideTex = !!views.side && mode === 'hull';
  const hasTopTex = !!views.top && mode === 'hull';
  const zSpan = mode === 'hull' ? cz : 0;

  const band = Math.max(cx, cy) * 0.032;
  const sFb = (x, y) => {
    x = Math.min(Math.max(x, 0), nx - 1.001); y = Math.min(Math.max(y, 0), ny - 1.001);
    const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
    return (sF(x0, y0) * (1 - tx) + sF(x0 + 1, y0) * tx) * (1 - ty) + (sF(x0, y0 + 1) * (1 - tx) + sF(x0 + 1, y0 + 1) * tx) * ty;
  };
  const T = indices.length / 3;
  const P = new Float32Array(T * 9), Nn = new Float32Array(T * 9), UV = new Float32Array(T * 6);
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  for (let t = 0; t < T; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    va.fromArray(local, a * 3); vb.fromArray(local, b * 3); vc.fromArray(local, c * 3);
    fn.crossVectors(e1.subVectors(vb, va), e2.subVectors(vc, va)).normalize();
    // choose projection
    let best = 'front', w = fn.z;
    if (-fn.z > w) { best = 'back'; w = -fn.z; }
    if (hasSideTex && Math.abs(fn.x) > w) { best = 'side'; w = Math.abs(fn.x); }
    if (hasTopTex && fn.y > w) { best = 'top'; w = fn.y; }
    if (!hasSideTex && (best === 'front' || best === 'back')) {
      // near the silhouette (where 2D art usually has its outline) or facing sideways → core colours
      const rim = Math.min(sFb(gp[a * 3], gp[a * 3 + 1]), sFb(gp[b * 3], gp[b * 3 + 1]), sFb(gp[c * 3], gp[c * 3 + 1]));
      if (Math.abs(fn.z) < 0.5 || rim < band) best = 'core';
    }
    const tri = [a, b, c];
    for (let s = 0; s < 3; s++) {
      const vi = tri[s];
      const gx = gp[vi * 3], gy = gp[vi * 3 + 1], gz = gp[vi * 3 + 2];
      const uF = (gx + 0.5 - pad) / cx, vF = 1 - (gy + 0.5 - pad) / cy;
      let uv;
      if (best === 'front') uv = cellUV(CELL.front, uF, vF, inset);
      else if (best === 'back') uv = backFill.type === 'mirror' ? cellUV(CELL.front, uF, vF, inset) : cellUV(CELL.back, 1 - uF, vF, inset);
      else if (best === 'core') uv = cellUV(CELL.side, uF, vF, inset);
      else if (best === 'side') uv = cellUV(CELL.side, (gz + 0.5 - pad) / zSpan, vF, inset);
      else uv = cellUV(CELL.top, uF, (gz + 0.5 - pad) / zSpan, inset);
      P[t * 9 + s * 3] = local[vi * 3]; P[t * 9 + s * 3 + 1] = local[vi * 3 + 1]; P[t * 9 + s * 3 + 2] = local[vi * 3 + 2];
      Nn[t * 9 + s * 3] = nrm[vi * 3]; Nn[t * 9 + s * 3 + 1] = nrm[vi * 3 + 1]; Nn[t * 9 + s * 3 + 2] = nrm[vi * 3 + 2];
      UV[t * 6 + s * 2] = uv[0]; UV[t * 6 + s * 2 + 1] = uv[1];
    }
  }
  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  geometry = mergeVertices(geometry, 1e-5);
  ig.dispose();

  return {
    geometry, atlas, alpha: false, mode,
    info: `${MODES[mode].split(' ')[0]} · 網格 ${nx}×${ny}×${nz} · ${T.toLocaleString()} 三角形`,
  };
}
