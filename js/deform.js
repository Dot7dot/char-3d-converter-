// ---------------------------------------------------------------------------
// deform.js — manual 3D shape adjustment applied after conversion.
//
//  1. stretch  — width / height / depth scale about the part's bottom-centre
//  2. lattice  — 3×3×3 free-form deformation cage (quadratic Bernstein FFD).
//                Offsets come from the taper / bend sliders plus points the user
//                drags in the 3D viewport. Normals are transformed with the
//                deformation Jacobian so shading stays smooth.
//
// Lattice index: i (x, left→right), j (y, bottom→top), k (z, back→front)
//   idx = i + 3 * (j + 3 * k); offsets are stored as fractions of the cage size.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { replaySculpt } from './sculpt.js';

export const LATTICE_N = 27;
export const latticeIndex = (i, j, k) => i + 3 * (j + 3 * k);

export function defaultTaper() {
  return { w: [1, 1, 1], d: [1, 1, 1], bend: [0, 0], twist: 0 };
}

export function hasDeform(p) {
  const s = p.stretch || [1, 1, 1];
  if (s.some((v) => Math.abs(v - 1) > 1e-4)) return true;
  if (p.sculpt && p.sculpt.length) return true;
  return latticeActive(p);
}

export function latticeActive(p) {
  const t = p.taper || defaultTaper();
  if ([...t.w, ...t.d].some((v) => Math.abs(v - 1) > 1e-4)) return true;
  if (t.bend.some((v) => Math.abs(v) > 1e-4) || Math.abs(t.twist || 0) > 1e-4) return true;
  return !!(p.lattice && p.lattice.some((v) => Math.abs(v) > 1e-5));
}

/** Combine taper / bend / twist sliders with free point offsets → Float32Array(81). */
export function latticeOffsets(p) {
  const t = p.taper || defaultTaper();
  const out = new Float32Array(LATTICE_N * 3);
  // middle row control values are compensated so the slider value is what you get
  // at mid-height (a quadratic Bernstein cage only reaches mid-row control points halfway).
  const ctrl = (arr) => [arr[0], 2 * arr[1] - 0.5 * (arr[0] + arr[2]), arr[2]];
  const W = ctrl(t.w), D = ctrl(t.d);
  for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const q = latticeIndex(i, j, k) * 3;
    const h = j / 2, curve = j === 1 ? 0 : h * h; // bend: bottom fixed, top moves
    let x = (i - 1) * 0.5 * (W[j] - 1);
    let z = (k - 1) * 0.5 * (D[j] - 1);
    x += t.bend[1] * curve;
    z += t.bend[0] * curve;
    if (t.twist) {
      const a = (t.twist * Math.PI / 180) * h;
      const px = (i - 1) * 0.5, pz = (k - 1) * 0.5;
      x += px * Math.cos(a) - pz * Math.sin(a) - px;
      z += px * Math.sin(a) + pz * Math.cos(a) - pz;
    }
    out[q] = x; out[q + 1] = 0; out[q + 2] = z;
    if (p.lattice) { out[q] += p.lattice[q]; out[q + 1] += p.lattice[q + 1]; out[q + 2] += p.lattice[q + 2]; }
  }
  return out;
}

/** World (geometry-space) position of a cage point. */
export function latticePoint(box, offsets, i, j, k, target = new THREE.Vector3()) {
  const size = cageSize(box);
  const q = latticeIndex(i, j, k) * 3;
  return target.set(
    box.min.x + size.x * (i / 2 + offsets[q]),
    box.min.y + size.y * (j / 2 + offsets[q + 1]),
    box.min.z + size.z * (k / 2 + offsets[q + 2]),
  );
}

export function cageSize(box) {
  const s = box.getSize(new THREE.Vector3());
  const m = Math.max(s.x, s.y, s.z, 1e-4);
  return s.set(Math.max(s.x, m * 0.02), Math.max(s.y, m * 0.02), Math.max(s.z, m * 0.02));
}

const B = (t) => [(1 - t) * (1 - t), 2 * t * (1 - t), t * t];
const dB = (t) => [-2 * (1 - t), 2 - 4 * t, 2 * t];

/** Apply stretch to a clone of the geometry. */
export function stretchGeometry(src, stretch) {
  const g = src.clone();
  const [sx, sy, sz] = stretch;
  const p = g.getAttribute('position'), n = g.getAttribute('normal');
  for (let v = 0; v < p.count; v++) {
    p.setXYZ(v, p.getX(v) * sx, p.getY(v) * sy, p.getZ(v) * sz);
    if (n) {
      const x = n.getX(v) / sx, y = n.getY(v) / sy, z = n.getZ(v) / sz;
      const l = Math.hypot(x, y, z) || 1;
      n.setXYZ(v, x / l, y / l, z / l);
    }
  }
  g.computeBoundingBox();
  return g;
}

/** Free-form deformation (in place on `g`) using the cage around `box`. */
export function ffdInPlace(g, box, offsets) {
  const size = cageSize(box);
  const p = g.getAttribute('position'), n = g.getAttribute('normal');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), t3 = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let v = 0; v < p.count; v++) {
    const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    const s = Math.min(1, Math.max(0, (x - box.min.x) / size.x));
    const t = Math.min(1, Math.max(0, (y - box.min.y) / size.y));
    const u = Math.min(1, Math.max(0, (z - box.min.z) / size.z));
    const bs = B(s), bt = B(t), bu = B(u), ds = dB(s), dt = dB(t), du = dB(u);
    let ox = 0, oy = 0, oz = 0;
    // Jacobian columns (derivative of the displacement wrt x, y, z)
    let jxx = 0, jxy = 0, jxz = 0, jyx = 0, jyy = 0, jyz = 0, jzx = 0, jzy = 0, jzz = 0;
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const q = latticeIndex(i, j, k) * 3;
      const dx = offsets[q] * size.x, dy = offsets[q + 1] * size.y, dz = offsets[q + 2] * size.z;
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const w = bs[i] * bt[j] * bu[k];
      ox += w * dx; oy += w * dy; oz += w * dz;
      const wx = ds[i] * bt[j] * bu[k] / size.x, wy = bs[i] * dt[j] * bu[k] / size.y, wz = bs[i] * bt[j] * du[k] / size.z;
      jxx += wx * dx; jxy += wx * dy; jxz += wx * dz;
      jyx += wy * dx; jyy += wy * dy; jyz += wy * dz;
      jzx += wz * dx; jzy += wz * dy; jzz += wz * dz;
    }
    p.setXYZ(v, x + ox, y + oy, z + oz);
    if (n) {
      a.set(1 + jxx, jxy, jxz); b.set(jyx, 1 + jyy, jyz); c.set(jzx, jzy, 1 + jzz);
      // inverse-transpose × normal  ∝  nx (b×c) + ny (c×a) + nz (a×b)
      t1.crossVectors(b, c).multiplyScalar(n.getX(v));
      t2.crossVectors(c, a).multiplyScalar(n.getY(v));
      t3.crossVectors(a, b).multiplyScalar(n.getZ(v));
      nn.copy(t1).add(t2).add(t3).normalize();
      n.setXYZ(v, nn.x, nn.y, nn.z);
    }
  }
  p.needsUpdate = true;
  if (n) n.needsUpdate = true;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Full pipeline: base → stretch → lattice → sculpt strokes.
 * Returns { geometry, cageBox } where cageBox is the box the lattice is defined on.
 * `topo` (see sculpt.buildTopo) is required for replaying sculpt strokes.
 */
export function deformPart(base, p, topo = null, { sculpt = true } = {}) {
  const stretch = p.stretch || [1, 1, 1];
  const g = stretchGeometry(base, stretch);
  const cageBox = g.boundingBox.clone();
  if (latticeActive(p)) ffdInPlace(g, cageBox, latticeOffsets(p));
  if (sculpt && topo && p.sculpt && p.sculpt.length) replaySculpt(g, topo, p.sculpt);
  return { geometry: g, cageBox };
}
