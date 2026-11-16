// ---------------------------------------------------------------------------
// sculpt.js — brush sculpting on converted parts.
//
// Strokes are stored as data (params.sculpt) in part space and replayed after
// every re-conversion, so sculpting survives changing depth, quality, etc.
//
//   stroke = { t: 'grab',    r, sym, c: [x,y,z], d: [dx,dy,dz] }
//          | { t: 'inflate', r, s, sym, dabs: [x,y,z, x,y,z, …] }   (s < 0 = dent)
//          | { t: 'smooth',  r, s, sym, dabs: […] }
//          | { t: 'flatten', r, s, sym, dabs: […] }
//
// Meshes have duplicated vertices along texture seams, so all editing happens
// on "weld groups" (vertices sharing a position) and is written back to every
// member — seams never crack and normals stay smooth across them.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

export const BRUSHES = {
  grab: { name: '拉扯', key: 'G', tip: '按住拖曳，把表面拉出或推入（最適合對照參考圖修外形）' },
  inflate: { name: '鼓起', key: 'I', tip: '沿表面方向鼓起；按住 Ctrl 變成凹陷' },
  deflate: { name: '凹陷', key: 'D', tip: '沿表面方向壓入' },
  smooth: { name: '平滑', key: 'S', tip: '撫平凹凸；任何筆刷按住 Shift 也是平滑' },
  flatten: { name: '壓平', key: 'L', tip: '把表面壓成平面（做出平底、平頂）' },
};

/** Weld topology — computed once per base mesh, valid for all its deformations. */
export function buildTopo(geom) {
  const pos = geom.getAttribute('position').array;
  const n = pos.length / 3;
  const groupOf = new Int32Array(n);
  const map = new Map();
  let G = 0;
  const Q = 1e4;
  for (let v = 0; v < n; v++) {
    const key = `${Math.round(pos[v * 3] * Q)},${Math.round(pos[v * 3 + 1] * Q)},${Math.round(pos[v * 3 + 2] * Q)}`;
    let g = map.get(key);
    if (g === undefined) { g = G++; map.set(key, g); }
    groupOf[v] = g;
  }
  const rep = new Int32Array(G).fill(-1);
  for (let v = 0; v < n; v++) if (rep[groupOf[v]] < 0) rep[groupOf[v]] = v;
  const idx = geom.index.array;
  const faces = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = groupOf[idx[t]], b = groupOf[idx[t + 1]], c = groupOf[idx[t + 2]];
    if (a !== b && b !== c && a !== c) faces.push(a, b, c);
  }
  // CSR adjacency
  const start = new Int32Array(G + 1);
  for (let i = 0; i < faces.length; i++) start[faces[i] + 1] += 2;
  for (let g = 0; g < G; g++) start[g + 1] += start[g];
  const fill = start.slice(0, G);
  const nb = new Int32Array(start[G]);
  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t], b = faces[t + 1], c = faces[t + 2];
    nb[fill[a]++] = b; nb[fill[a]++] = c;
    nb[fill[b]++] = c; nb[fill[b]++] = a;
    nb[fill[c]++] = a; nb[fill[c]++] = b;
  }
  return { n, G, groupOf, rep, faces: new Int32Array(faces), start, nb };
}

export function readGroups(topo, geom, out = new Float32Array(topo.G * 3)) {
  const pos = geom.getAttribute('position').array;
  for (let g = 0; g < topo.G; g++) {
    const v = topo.rep[g];
    out[g * 3] = pos[v * 3]; out[g * 3 + 1] = pos[v * 3 + 1]; out[g * 3 + 2] = pos[v * 3 + 2];
  }
  return out;
}

export function groupNormals(topo, gp, out = new Float32Array(topo.G * 3)) {
  out.fill(0);
  const f = topo.faces;
  for (let t = 0; t < f.length; t += 3) {
    const a = f[t] * 3, b = f[t + 1] * 3, c = f[t + 2] * 3;
    const ux = gp[b] - gp[a], uy = gp[b + 1] - gp[a + 1], uz = gp[b + 2] - gp[a + 2];
    const vx = gp[c] - gp[a], vy = gp[c + 1] - gp[a + 1], vz = gp[c + 2] - gp[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let g = 0; g < topo.G; g++) {
    const l = Math.hypot(out[g * 3], out[g * 3 + 1], out[g * 3 + 2]) || 1;
    out[g * 3] /= l; out[g * 3 + 1] /= l; out[g * 3 + 2] /= l;
  }
  return out;
}

/** Write group positions (+ fresh smooth normals) back to the geometry. */
export function writeGroups(topo, geom, gp, gn) {
  const pos = geom.getAttribute('position'), nor = geom.getAttribute('normal');
  const P = pos.array, N = nor.array;
  for (let v = 0; v < topo.n; v++) {
    const g = topo.groupOf[v] * 3;
    P[v * 3] = gp[g]; P[v * 3 + 1] = gp[g + 1]; P[v * 3 + 2] = gp[g + 2];
    N[v * 3] = gn[g]; N[v * 3 + 1] = gn[g + 1]; N[v * 3 + 2] = gn[g + 2];
  }
  pos.needsUpdate = true; nor.needsUpdate = true;
  geom.boundingBox = null; geom.boundingSphere = null;
}

const falloff = (t) => { const k = 1 - t * t; return k * k; };

/** Move groups near c by vector d (smooth falloff). `from` = positions at stroke start. */
export function applyGrab(topo, gp, from, c, r, d) {
  const r2 = r * r;
  for (let g = 0; g < topo.G; g++) {
    const q = g * 3;
    const dx = from[q] - c[0], dy = from[q + 1] - c[1], dz = from[q + 2] - c[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) { gp[q] = from[q]; gp[q + 1] = from[q + 1]; gp[q + 2] = from[q + 2]; continue; }
    const w = falloff(Math.sqrt(d2) / r);
    gp[q] = from[q] + d[0] * w; gp[q + 1] = from[q + 1] + d[1] * w; gp[q + 2] = from[q + 2] + d[2] * w;
  }
}

/** One brush dab. `gn` = normals captured at stroke start. */
export function applyDab(topo, gp, gn, type, c, r, s) {
  const r2 = r * r;
  if (type === 'inflate') {
    const amt = s * r * 0.22;
    for (let g = 0; g < topo.G; g++) {
      const q = g * 3;
      const dx = gp[q] - c[0], dy = gp[q + 1] - c[1], dz = gp[q + 2] - c[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const w = falloff(Math.sqrt(d2) / r) * amt;
      gp[q] += gn[q] * w; gp[q + 1] += gn[q + 1] * w; gp[q + 2] += gn[q + 2] * w;
    }
    return;
  }
  // collect affected groups first (smooth / flatten read neighbours)
  const ids = [], ws = [];
  for (let g = 0; g < topo.G; g++) {
    const q = g * 3;
    const dx = gp[q] - c[0], dy = gp[q + 1] - c[1], dz = gp[q + 2] - c[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < r2) { ids.push(g); ws.push(falloff(Math.sqrt(d2) / r)); }
  }
  if (!ids.length) return;
  if (type === 'smooth') {
    const tmp = new Float32Array(ids.length * 3);
    for (let it = 0; it < 2; it++) {
      for (let k = 0; k < ids.length; k++) {
        const g = ids[k], a = topo.start[g], b = topo.start[g + 1];
        let x = 0, y = 0, z = 0;
        for (let e = a; e < b; e++) { const j = topo.nb[e] * 3; x += gp[j]; y += gp[j + 1]; z += gp[j + 2]; }
        const m = Math.max(1, b - a), w = Math.min(1, Math.abs(s) * ws[k]) * 0.7, q = g * 3;
        tmp[k * 3] = gp[q] + (x / m - gp[q]) * w;
        tmp[k * 3 + 1] = gp[q + 1] + (y / m - gp[q + 1]) * w;
        tmp[k * 3 + 2] = gp[q + 2] + (z / m - gp[q + 2]) * w;
      }
      for (let k = 0; k < ids.length; k++) { const q = ids[k] * 3; gp[q] = tmp[k * 3]; gp[q + 1] = tmp[k * 3 + 1]; gp[q + 2] = tmp[k * 3 + 2]; }
    }
  } else if (type === 'flatten') {
    // plane through the weighted centre, along the average normal
    let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, W = 0;
    for (let k = 0; k < ids.length; k++) {
      const q = ids[k] * 3, w = ws[k];
      cx += gp[q] * w; cy += gp[q + 1] * w; cz += gp[q + 2] * w;
      nx += gn[q] * w; ny += gn[q + 1] * w; nz += gn[q + 2] * w; W += w;
    }
    cx /= W; cy /= W; cz /= W;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < ids.length; k++) {
      const q = ids[k] * 3;
      const dist = (gp[q] - cx) * nx + (gp[q + 1] - cy) * ny + (gp[q + 2] - cz) * nz;
      const w = Math.min(1, Math.abs(s) * ws[k]) * 0.6 * dist;
      gp[q] -= nx * w; gp[q + 1] -= ny * w; gp[q + 2] -= nz * w;
    }
  }
}

const mirrorPt = (c) => [-c[0], c[1], c[2]];

/** Apply one stored stroke to group positions. */
export function applyStroke(topo, gp, st) {
  if (st.t === 'grab') {
    let from = gp.slice();
    applyGrab(topo, gp, from, st.c, st.r, st.d);
    if (st.sym && Math.abs(st.c[0]) > st.r * 0.05) { from = gp.slice(); applyGrab(topo, gp, from, mirrorPt(st.c), st.r, mirrorPt(st.d)); }
    return;
  }
  const gn = groupNormals(topo, gp);
  const d = st.dabs;
  for (let i = 0; i < d.length; i += 3) {
    const c = [d[i], d[i + 1], d[i + 2]];
    applyDab(topo, gp, gn, st.t, c, st.r, st.s);
    if (st.sym && Math.abs(c[0]) > st.r * 0.05) applyDab(topo, gp, gn, st.t, mirrorPt(c), st.r, st.s);
  }
}

/** Replay all strokes on a (deformed) geometry in place. */
export function replaySculpt(geom, topo, strokes) {
  if (!strokes || !strokes.length) return geom;
  const gp = readGroups(topo, geom);
  for (const st of strokes) applyStroke(topo, gp, st);
  writeGroups(topo, geom, gp, groupNormals(topo, gp));
  geom.computeBoundingBox(); geom.computeBoundingSphere();
  return geom;
}

/** Ring that shows the brush footprint on the surface. */
export function makeBrushCursor() {
  const pts = [];
  for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0)); }
  const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xff3d71, depthTest: false, transparent: true }));
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3d71, depthTest: false }));
  const g = new THREE.Group();
  g.add(ring, dot);
  g.renderOrder = 30; ring.renderOrder = 30; dot.renderOrder = 30;
  g.userData.helper = true; g.visible = false;
  return g;
}
