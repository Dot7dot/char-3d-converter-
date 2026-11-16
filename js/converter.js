// ---------------------------------------------------------------------------
// converter.js — the 2D → 3D engine.
//
// Every conversion builds a 3D scalar field (positive = inside) from the
// silhouettes of the supplied views, extracts its surface with Surface Nets,
// smooths it, unwraps it into six planar charts and bakes the original drawings
// into one texture atlas (blended by surface normal, so projections never show
// a visible border):   [ front | back ]
//                      [ right | left | top | bottom ]
//
// Modes
//   inflate  — balloon-like volume from the front silhouette (local thickness)
//   extrude  — flat cut-out with rounded bevel (weapons, wings, badges)
//   revolve  — lathe around the vertical axis (hats, bottles, round things)
//   profile  — front silhouette inflated, depth of every row taken from the side
//              view. Follows the side drawing but never cuts holes when the
//              views disagree — the forgiving choice for characters.
//   hull     — three-view carving: front ∩ side (∩ top). Exact, for hard objects.
//   plane    — two-sided alpha card (hair strands, capes, effects)
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { silhouetteSDF, makeCanvas, solidCanvas, bleed } from './imageproc.js';
import { surfaceNets } from './surfacenets.js';
import { MeshoptSimplifier } from '../vendor/meshoptimizer/meshopt_simplifier.js';

export const simplifierReady = MeshoptSimplifier.ready;

/** Triangle budgets (per part) applied after all manual edits. */
export const BUDGETS = {
  full: { name: '原始（不減面）', tris: Infinity, error: 0 },
  high: { name: '細緻', tris: 10000, error: 0.004 },
  game: { name: '遊戲（建議）', tris: 4000, error: 0.01 },
  low: { name: '低模', tris: 1500, error: 0.03 },
};

export const MODES = {
  auto: '自動判斷',
  inflate: '膨脹 Inflate（圓潤物件）',
  extrude: '擠出 Extrude（扁平物件）',
  revolve: '旋轉體 Revolve（帽子/瓶罐）',
  profile: '側面輪廓塑形 Profile（柔和、不易變形）',
  hull: '三視圖雕刻 3-View Carve（精準、硬物件）',
  plane: '平面卡片 Plane',
};

export const QUALITY = { low: 40, medium: 60, high: 88 };

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

export function resolveMode(mode, views, slotDefault = 'inflate', sideDefault = 'hull') {
  if (mode === 'auto') {
    if (views.side) return sideDefault;
    return views.top ? 'hull' : slotDefault;
  }
  if (mode === 'profile' && !views.side) return views.top ? 'hull' : 'inflate';
  if (mode === 'hull' && !views.side && !views.top) return 'inflate';
  return mode;
}

/**
 * Reduce a part to a triangle budget (meshoptimizer). Vertices keep their
 * original normals / UVs, so shading and texturing are unchanged.
 */
export function simplifyGeometry(src, budget, share = 1) {
  const b = BUDGETS[budget] || BUDGETS.full;
  if (!src.index) return src;
  const idx = src.index.array;
  const tris = idx.length / 3;
  if (!Number.isFinite(b.tris) || tris <= 64) return src;
  const pos = src.getAttribute('position'), nor = src.getAttribute('normal'), uv = src.getAttribute('uv');
  const target = Math.max(60, Math.min(idx.length, Math.floor(b.tris * share) * 3));
  const attrs = new Float32Array(pos.count * 3);
  attrs.set(nor.array);
  let out;
  try {
    [out] = MeshoptSimplifier.simplifyWithAttributes(
      idx instanceof Uint32Array ? idx : new Uint32Array(idx), pos.array, 3, attrs, 3, [0.4, 0.4, 0.4], null, target, b.error, []);
  } catch (e) { console.warn('simplify failed', e); return src; }
  if (!out || out.length < 12 || out.length >= idx.length) return src;
  // compact the vertex buffers
  const remap = new Int32Array(pos.count).fill(-1);
  let n = 0;
  for (let i = 0; i < out.length; i++) { if (remap[out[i]] < 0) remap[out[i]] = n++; }
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
  for (let v = 0; v < pos.count; v++) {
    const r = remap[v]; if (r < 0) continue;
    P[r * 3] = pos.array[v * 3]; P[r * 3 + 1] = pos.array[v * 3 + 1]; P[r * 3 + 2] = pos.array[v * 3 + 2];
    N[r * 3] = nor.array[v * 3]; N[r * 3 + 1] = nor.array[v * 3 + 1]; N[r * 3 + 2] = nor.array[v * 3 + 2];
    U[r * 2] = uv.array[v * 2]; U[r * 2 + 1] = uv.array[v * 2 + 1];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  const ni = n > 65535 ? new Uint32Array(out.length) : new Uint16Array(out.length);
  for (let i = 0; i < out.length; i++) ni[i] = remap[out[i]];
  g.setIndex(new THREE.BufferAttribute(ni, 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------ atlas helpers
const CELL = { front: 0, back: 1, side: 2, top: 3 };

function buildAtlas(views, size, useAlpha, backFill) {
  const atlas = makeCanvas(size, size);
  // CPU-backed canvas: exporting (PNG encoding) never has to wait for a GPU read-back
  const ctx = atlas.getContext('2d', { willReadFrequently: true });
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
  return { geometry: g, atlas, alpha: true, mode: 'plane', frame: { w: A, h: 1, d: 0.01, zc: 0 }, info: '平面卡片' };
}

// ------------------------------------------------------------------- main
/**
 * @param views  { front, side?, back?, top? } processed views (see imageproc.processView)
 * @param p      { mode, depth, roundness, smooth, backFill: 'mirror'|'color', }
 * @param opts   { resolution, atlasSize, slotDefault }
 */
export function convertPart(allViews, p, opts) {
  const F = allViews.front;
  // view roles: side / top can shape the model, texture it, or both
  const roles = p.roles || {};
  const use = (id, what) => allViews[id] && (roles[id] || 'both') !== what ? allViews[id] : null;
  const views = { front: F, side: use('side', 'texture'), top: use('top', 'texture') };          // shape
  const texViews = { front: F, back: allViews.back || null, side: use('side', 'shape'), top: use('top', 'shape') };
  const mode = resolveMode(p.mode, views, opts.slotDefault, opts.sideDefault);
  if (mode === 'plane') return buildPlane(texViews, p, opts.atlasSize);

  const N = opts.resolution;
  const pad = 2;
  const X = F.w / F.h, Y = 1;
  let Zest = 0;
  const framed = mode === 'hull' || mode === 'profile'; // depth frame comes from the side / top image
  if (framed) Zest = views.side ? views.side.w / views.side.h : (views.top.h / views.top.w) * X;
  else if (mode === 'revolve') Zest = X;
  const g = Math.max(X, Y, Zest) / N;
  const cx = Math.max(2, Math.round(X / g)), cy = Math.max(2, Math.round(Y / g));
  const nx = cx + pad * 2, ny = cy + pad * 2;

  const front = silhouetteSDF(F.maskCanvas, cx, cy, pad).sdf; // row 0 = top
  const sF = (i, j) => front[i + nx * (ny - 1 - j)];

  let nz, cz = 0, field;
  const fieldAt = (i, j, k) => i + nx * (j + ny * k);

  // balloon height of the front silhouette (used by inflate and profile)
  const inflateHeights = () => {
    const sd = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sd[i + nx * j] = sF(i, j);
    const R = localRadius(sd, nx, ny);
    let hgt = new Float32Array(nx * ny);
    for (let q = 0; q < nx * ny; q++) {
      const s = sd[q];
      if (s <= 0) { hgt[q] = s; continue; }
      const r = Math.max(R[q], s);
      hgt[q] = Math.sqrt(Math.max(0, s * (2 * r - s)));
    }
    hgt = blurInside(hgt, sd, nx, ny, 2);
    return { sd, hgt };
  };

  if (mode === 'profile') {
    cz = Math.max(2, Math.round(Zest / g));
    nz = cz + pad * 2;
    const side = silhouetteSDF(views.side.maskCanvas, cz, cy, pad).sdf;
    const sS = (k, j) => side[k + nz * (ny - 1 - j)];
    const sd = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sd[i + nx * j] = sF(i, j);
    // per-row depth interval from the side view (sub-cell accurate), gaps filled from neighbours
    const lo = new Float32Array(ny).fill(NaN), hi = new Float32Array(ny).fill(NaN);
    for (let j = 0; j < ny; j++) {
      let a = -1, b = -1;
      for (let k = 0; k < nz; k++) if (sS(k, j) > 0) { if (a < 0) a = k; b = k; }
      if (a >= 0) {
        const fa = a > 0 ? sS(a, j) / (sS(a, j) - sS(a - 1, j)) : 0;
        const fb = b < nz - 1 ? sS(b, j) / (sS(b, j) - sS(b + 1, j)) : 0;
        lo[j] = a - Math.min(1, fa); hi[j] = b + Math.min(1, fb);
      }
    }
    const fill = (arr) => {
      let last = NaN;
      for (let j = 0; j < ny; j++) { if (!Number.isNaN(arr[j])) last = arr[j]; else if (!Number.isNaN(last)) arr[j] = last; }
      last = NaN;
      for (let j = ny - 1; j >= 0; j--) { if (!Number.isNaN(arr[j])) last = arr[j]; else if (!Number.isNaN(last)) arr[j] = last; }
    };
    fill(lo); fill(hi);
    const blur1 = (arr) => { const o = arr.slice(); for (let j = 1; j < ny - 1; j++) o[j] = (arr[j - 1] + 2 * arr[j] + arr[j + 1]) / 4; return o; };
    const lo2 = blur1(lo), hi2 = blur1(hi);
    // every row's cross-section is a (super)ellipse: as wide as the front silhouette, as deep as the side one
    const expo = 2 + (1 - p.roundness) * 2.4;
    const hn = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      let i = 0;
      while (i < nx) {
        if (sd[i + nx * j] <= 0) { i++; continue; }
        let e = i;
        while (e + 1 < nx && sd[e + 1 + nx * j] > 0) e++;
        const sa = sd[i + nx * j], sb = sd[e + nx * j];
        const xa = i - (i > 0 ? Math.min(1, sa / (sa - sd[i - 1 + nx * j])) : 0);
        const xb = e + (e < nx - 1 ? Math.min(1, sb / (sb - sd[e + 1 + nx * j])) : 0);
        const xc2 = (xa + xb) / 2, w = Math.max(0.5, (xb - xa) / 2);
        for (let q = i; q <= e; q++) {
          const t = Math.min(1, Math.abs(q - xc2) / w);
          hn[q + nx * j] = Math.pow(Math.max(0, 1 - Math.pow(t, expo)), 1 / expo);
        }
        i = e + 1;
      }
    }
    // soften row-to-row steps of the profile
    const hs = hn.slice();
    for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx; i++) {
      const q = i + nx * j;
      if (sd[q] > 0) hs[q] = (hn[q - nx] + 2 * hn[q] + hn[q + nx]) / 4;
    }
    field = new Float32Array(nx * ny * nz);
    for (let j = 0; j < ny; j++) {
      const halfD = Math.max(0.6, (hi2[j] - lo2[j]) / 2), mid = (hi2[j] + lo2[j]) / 2;
      for (let i = 0; i < nx; i++) {
        const q = i + nx * j, s = sd[q];
        for (let k = 0; k < nz; k++) {
          field[fieldAt(i, j, k)] = s <= 0 ? Math.min(s, -0.01) : Math.min(s + 0.5, hs[q] * halfD - Math.abs(k - mid) + 0.3);
        }
      }
    }
  } else if (mode === 'inflate') {
    const { sd, hgt } = inflateHeights();
    let hmax = 1;
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

  // ---- texture: unwrap into 6 planar charts and bake the views into one atlas.
  // Every texel blends the front / back / side / top drawings by the surface normal,
  // so there are no visible borders where two projections meet.
  const backFill = texViews.back ? { type: 'image' }
    : p.backFill === 'color' ? { type: 'color', color: F.topColor } : { type: 'mirror' };
  const hasSideTex = !!texViews.side;
  const hasTopTex = !!texViews.top;
  // z range that the side / top images span: the carving frame, or the mesh depth
  let zStart = pad - 0.5, zSpan = cz;
  let gmin = [Infinity, Infinity, Infinity], gmax = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vcount; v++) for (let k = 0; k < 3; k++) {
    const q = gp[v * 3 + k]; if (q < gmin[k]) gmin[k] = q; if (q > gmax[k]) gmax[k] = q;
  }
  if (!framed) { zStart = gmin[2]; zSpan = Math.max(1e-3, gmax[2] - gmin[2]); }
  const gspan = [0, 1, 2].map((k) => Math.max(1e-3, gmax[k] - gmin[k]));

  const size = opts.atlasSize, half = size / 2, quarter = size / 4, margin = 4;
  //            +z front              -z back                  -x right                  +x left                        +y top                            -y bottom
  const RECT = [[0, 0, half, half], [half, 0, half, half], [0, half, quarter, half], [quarter, half, quarter, half], [2 * quarter, half, quarter, half], [3 * quarter, half, quarter, half]];
  const chartPx = (c, gx, gy, gz) => {
    const nxg = (gx - gmin[0]) / gspan[0], nyg = (gy - gmin[1]) / gspan[1], nzg = (gz - gmin[2]) / gspan[2];
    let u, v;
    if (c === 0) { u = nxg; v = 1 - nyg; } else if (c === 1) { u = 1 - nxg; v = 1 - nyg; }
    else if (c === 2) { u = nzg; v = 1 - nyg; } else if (c === 3) { u = 1 - nzg; v = 1 - nyg; }
    else if (c === 4) { u = nxg; v = nzg; } else { u = nxg; v = 1 - nzg; }
    const r = RECT[c];
    return [r[0] + margin + u * (r[2] - 2 * margin), r[1] + margin + v * (r[3] - 2 * margin)];
  };

  // source pixels
  const px = (view, key) => {
    if (!view) return null;
    const cache = view._px || (view._px = {});
    if (!cache[key]) {
      const cv = view[key];
      cache[key] = { d: cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
    }
    return cache[key];
  };
  const srcFront = px(F, 'colorCanvas'), srcCore = px(F, 'coreCanvas');
  const srcBack = px(texViews.back, 'colorCanvas'), srcSide = px(texViews.side, 'colorCanvas'), srcTop = px(texViews.top, 'colorCanvas');
  const fillRGB = backFill.type === 'color' ? [parseInt(backFill.color.slice(1, 3), 16), parseInt(backFill.color.slice(3, 5), 16), parseInt(backFill.color.slice(5, 7), 16)] : null;
  const smp = [0, 0, 0];
  const sample = (img, u, v) => {
    const x = Math.min(Math.max(u, 0), 1) * (img.w - 1), y = Math.min(Math.max(v, 0), 1) * (img.h - 1);
    const x0 = x | 0, y0 = y | 0, x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1), fx = x - x0, fy = y - y0;
    const a = (y0 * img.w + x0) * 4, b = (y0 * img.w + x1) * 4, c = (y1 * img.w + x0) * 4, e = (y1 * img.w + x1) * 4, d = img.d;
    for (let k = 0; k < 3; k++) smp[k] = (d[a + k] * (1 - fx) + d[b + k] * fx) * (1 - fy) + (d[c + k] * (1 - fx) + d[e + k] * fx) * fy;
  };
  const band = Math.max(cx, cy) * 0.032;
  const sFb = (x, y) => {
    x = Math.min(Math.max(x, 0), nx - 1.001); y = Math.min(Math.max(y, 0), ny - 1.001);
    const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
    return (sF(x0, y0) * (1 - tx) + sF(x0 + 1, y0) * tx) * (1 - ty) + (sF(x0, y0 + 1) * (1 - tx) + sF(x0 + 1, y0 + 1) * tx) * ty;
  };
  const out = [0, 0, 0];
  const shade = (gx, gy, gz, n0, n1, n2) => {
    const l = Math.hypot(n0, n1, n2) || 1; n0 /= l; n1 /= l; n2 /= l;
    const uF = (gx + 0.5 - pad) / cx, vF = 1 - (gy + 0.5 - pad) / cy, uZ = (gz - zStart) / zSpan;
    let wf = Math.max(n2, 0), wb = Math.max(-n2, 0), ws = hasSideTex ? Math.abs(n0) : 0, wt = hasTopTex ? Math.max(n1, 0) : 0;
    wf *= wf; wf *= wf; wb *= wb; wb *= wb; ws *= ws; ws *= ws; wt *= wt; wt *= wt;
    let W = wf + wb + ws + wt;
    if (W < 1e-6) { wf = n2 >= 0 ? 1 : 0; wb = 1 - wf; W = 1; }
    let r = 0, g2 = 0, b = 0;
    if (wf > 0) { sample(srcFront, uF, vF); r += smp[0] * wf; g2 += smp[1] * wf; b += smp[2] * wf; }
    if (wb > 0) {
      if (srcBack) sample(srcBack, 1 - uF, vF); else if (fillRGB) { smp[0] = fillRGB[0]; smp[1] = fillRGB[1]; smp[2] = fillRGB[2]; } else sample(srcFront, uF, vF);
      r += smp[0] * wb; g2 += smp[1] * wb; b += smp[2] * wb;
    }
    if (ws > 0) { sample(srcSide, uZ, vF); r += smp[0] * ws; g2 += smp[1] * ws; b += smp[2] * ws; }
    if (wt > 0) { sample(srcTop, uF, uZ); r += smp[0] * wt; g2 += smp[1] * wt; b += smp[2] * wt; }
    r /= W; g2 /= W; b /= W;
    if (!hasSideTex) {
      // sideways-facing surface, or the rim where 2D art has its outline → outline-free core colours
      const tn = Math.min(1, Math.max(0, (0.62 - Math.abs(n2)) / 0.27));
      const tr = Math.min(1, Math.max(0, (band - sFb(gx, gy)) / (band * 0.6)));
      const t = Math.max(tn, tr);
      if (t > 0) { sample(srcCore, uF, vF); r += (smp[0] - r) * t; g2 += (smp[1] - g2) * t; b += (smp[2] - b) * t; }
    }
    out[0] = r; out[1] = g2; out[2] = b;
  };

  const T = indices.length / 3;
  const img = new ImageData(size, size), pix = img.data, covered = new Uint8Array(size * size);
  const P = new Float32Array(T * 9), Nn = new Float32Array(T * 9), UV = new Float32Array(T * 6);
  for (let t = 0; t < T; t++) {
    const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
    // face normal (local space) → chart
    const ax = local[ia * 3], ay = local[ia * 3 + 1], az = local[ia * 3 + 2];
    const e1x = local[ib * 3] - ax, e1y = local[ib * 3 + 1] - ay, e1z = local[ib * 3 + 2] - az;
    const e2x = local[ic * 3] - ax, e2y = local[ic * 3 + 1] - ay, e2z = local[ic * 3 + 2] - az;
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const cand = [fz, -fz, -fx, fx, fy, -fy];
    let c = 0; for (let k = 1; k < 6; k++) if (cand[k] > cand[c]) c = k;
    const tri = [ia, ib, ic], sx = [0, 0, 0], sy = [0, 0, 0];
    for (let s = 0; s < 3; s++) {
      const vi = tri[s];
      const [X2, Y2] = chartPx(c, gp[vi * 3], gp[vi * 3 + 1], gp[vi * 3 + 2]);
      sx[s] = X2; sy[s] = Y2;
      P[t * 9 + s * 3] = local[vi * 3]; P[t * 9 + s * 3 + 1] = local[vi * 3 + 1]; P[t * 9 + s * 3 + 2] = local[vi * 3 + 2];
      Nn[t * 9 + s * 3] = nrm[vi * 3]; Nn[t * 9 + s * 3 + 1] = nrm[vi * 3 + 1]; Nn[t * 9 + s * 3 + 2] = nrm[vi * 3 + 2];
      UV[t * 6 + s * 2] = X2 / size; UV[t * 6 + s * 2 + 1] = Y2 / size;
    }
    // rasterise the triangle into the atlas
    const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2]) - 1)), x1 = Math.min(size - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2]) + 1));
    const y0 = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2]) - 1)), y1 = Math.min(size - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2]) + 1));
    const eps = -0.75 / Math.sqrt(Math.abs(area) + 1); // slightly conservative so neighbours overlap
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const pxc = x + 0.5, pyc = y + 0.5;
      let w0 = ((sx[1] - pxc) * (sy[2] - pyc) - (sx[2] - pxc) * (sy[1] - pyc)) / area;
      let w1 = ((sx[2] - pxc) * (sy[0] - pyc) - (sx[0] - pxc) * (sy[2] - pyc)) / area;
      let w2 = 1 - w0 - w1;
      if (w0 < eps || w1 < eps || w2 < eps) continue;
      const o = y * size + x;
      const inside = w0 >= 0 && w1 >= 0 && w2 >= 0;
      if (covered[o] === 2 || (covered[o] === 1 && !inside)) continue;
      shade(
        gp[ia * 3] * w0 + gp[ib * 3] * w1 + gp[ic * 3] * w2,
        gp[ia * 3 + 1] * w0 + gp[ib * 3 + 1] * w1 + gp[ic * 3 + 1] * w2,
        gp[ia * 3 + 2] * w0 + gp[ib * 3 + 2] * w1 + gp[ic * 3 + 2] * w2,
        nrm[ia * 3] * w0 + nrm[ib * 3] * w1 + nrm[ic * 3] * w2,
        nrm[ia * 3 + 1] * w0 + nrm[ib * 3 + 1] * w1 + nrm[ic * 3 + 1] * w2,
        nrm[ia * 3 + 2] * w0 + nrm[ib * 3 + 2] * w1 + nrm[ic * 3 + 2] * w2,
      );
      pix[o * 4] = out[0]; pix[o * 4 + 1] = out[1]; pix[o * 4 + 2] = out[2]; pix[o * 4 + 3] = 255;
      covered[o] = inside ? 2 : 1;
    }
  }
  for (let o = 0; o < covered.length; o++) if (covered[o]) covered[o] = 1;
  bleed(pix, covered, size, size, 6);
  const atlas = makeCanvas(size, size);
  // CPU-backed canvas: exporting (PNG encoding) never has to wait for a GPU read-back
  atlas.getContext('2d', { willReadFrequently: true }).putImageData(img, 0, 0);

  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  geometry = mergeVertices(geometry, 1e-5);
  ig.dispose();

  return {
    geometry, atlas, alpha: false, mode,
    // where the source images sit in part space (for reference overlays)
    frame: { w: cx * g, h: cy * g, d: zSpan * g * depth, zc: (zStart + zSpan / 2 - zc) * g * depth },
    info: `${MODES[mode].split(' ')[0]} · 體素 ${nx}×${ny}×${nz}`,
  };
}
