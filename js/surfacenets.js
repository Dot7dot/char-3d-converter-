// ---------------------------------------------------------------------------
// surfacenets.js — Naive Surface Nets iso-surface extraction.
// Field convention: value > 0 = inside, iso level 0.
// Grid index: x + nx * (y + ny * z)
// ---------------------------------------------------------------------------

const CORNERS = [];
for (let i = 0; i < 8; i++) CORNERS.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);
const EDGES = [];
for (let i = 0; i < 8; i++) for (let b = 0; b < 3; b++) {
  const j = i ^ (1 << b);
  if (i < j) EDGES.push([i, j]);
}

export function surfaceNets(field, nx, ny, nz) {
  const at = (x, y, z) => field[x + nx * (y + ny * z)];
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const pos = [];
  const v = new Float32Array(8);
  let count = 0;

  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const k = CORNERS[c];
      v[c] = at(x + k[0], y + k[1], z + k[2]);
      if (v[c] > 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of EDGES) {
      const ia = (mask >> a) & 1, ib = (mask >> b) & 1;
      if (ia === ib) continue;
      const t = v[a] / (v[a] - v[b]);
      const A = CORNERS[a], B = CORNERS[b];
      sx += A[0] + t * (B[0] - A[0]);
      sy += A[1] + t * (B[1] - A[1]);
      sz += A[2] + t * (B[2] - A[2]);
      n++;
    }
    pos.push(x + sx / n, y + sy / n, z + sz / n);
    cellVert[x + nx * (y + ny * z)] = count++;
  }

  const idx = [];
  const cv = (x, y, z) => cellVert[x + nx * (y + ny * z)];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (!flip) idx.push(a, b, c, a, c, d);
    else idx.push(a, c, b, a, d, c);
  };
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const inside = at(x, y, z) > 0;
    // x-edge
    if (inside !== (at(x + 1, y, z) > 0)) {
      quad(cv(x, y - 1, z - 1), cv(x, y, z - 1), cv(x, y, z), cv(x, y - 1, z), !inside);
    }
    // y-edge
    if (inside !== (at(x, y + 1, z) > 0)) {
      quad(cv(x - 1, y, z - 1), cv(x - 1, y, z), cv(x, y, z), cv(x, y, z - 1), !inside);
    }
    // z-edge
    if (inside !== (at(x, y, z + 1) > 0)) {
      quad(cv(x - 1, y - 1, z), cv(x, y - 1, z), cv(x, y, z), cv(x - 1, y, z), !inside);
    }
  }
  return { positions: new Float32Array(pos), indices: idx };
}

/** Trilinear sample of field. */
export function sampleField(field, nx, ny, nz, x, y, z) {
  x = Math.min(Math.max(x, 0), nx - 1.001);
  y = Math.min(Math.max(y, 0), ny - 1.001);
  z = Math.min(Math.max(z, 0), nz - 1.001);
  const x0 = x | 0, y0 = y | 0, z0 = z | 0;
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const i = (a, b, c) => field[a + nx * (b + ny * c)];
  const c00 = i(x0, y0, z0) * (1 - fx) + i(x0 + 1, y0, z0) * fx;
  const c10 = i(x0, y0 + 1, z0) * (1 - fx) + i(x0 + 1, y0 + 1, z0) * fx;
  const c01 = i(x0, y0, z0 + 1) * (1 - fx) + i(x0 + 1, y0, z0 + 1) * fx;
  const c11 = i(x0, y0 + 1, z0 + 1) * (1 - fx) + i(x0 + 1, y0 + 1, z0 + 1) * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}
