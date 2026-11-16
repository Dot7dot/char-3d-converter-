// ---------------------------------------------------------------------------
// imageproc.js — 2D image handling: loading, background removal, cropping,
// texture bleeding and signed-distance fields for silhouettes.
// ---------------------------------------------------------------------------

const MAX_SIDE = 1024;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Load a File / Blob / dataURL into an HTMLImageElement. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('無法讀取圖片'));
    if (src instanceof Blob) {
      const url = URL.createObjectURL(src);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.src = url;
    } else {
      img.src = src;
    }
  });
}

/** Normalise any image to a dataURL (PNG) limited to MAX_SIDE. */
export async function fileToDataURL(file) {
  const img = await loadImage(file);
  const s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function colorDist2(d, i, r, g, b) {
  const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
  return dr * dr + dg * dg + db * db;
}

/**
 * Build a foreground mask.
 * - If the image has real transparency, use alpha.
 * - Otherwise flood-fill from the border with colours close to the corner colours.
 */
function buildMask(imgData, removeBg, tolerance) {
  const { data, width: w, height: h } = imgData;
  const n = w * h;
  const mask = new Uint8Array(n);
  let transparent = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 32) transparent++;

  if (transparent > n * 0.01) {
    for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    return { mask, method: 'alpha' };
  }
  mask.fill(1);
  if (!removeBg) return { mask, method: 'none' };

  // reference colours: averages of the 4 corner patches
  const refs = [];
  const p = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  for (const [cx, cy] of [[0, 0], [w - p, 0], [0, h - p], [w - p, h - p]]) {
    let r = 0, g = 0, b = 0, c = 0;
    for (let y = cy; y < cy + p; y++) for (let x = cx; x < cx + p; x++) {
      const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; c++;
    }
    refs.push([r / c, g / c, b / c]);
  }
  const tol = Math.pow(8 + tolerance * 1.6, 2);
  const isBg = (pix) => {
    const i = pix * 4;
    for (const [r, g, b] of refs) if (colorDist2(data, i, r, g, b) <= tol) return true;
    return false;
  };
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const push = (pix) => { if (!visited[pix] && isBg(pix)) { visited[pix] = 1; stack[sp++] = pix; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp > 0) {
    const pix = stack[--sp];
    mask[pix] = 0;
    const x = pix % w, y = (pix / w) | 0;
    if (x > 0) push(pix - 1);
    if (x < w - 1) push(pix + 1);
    if (y > 0) push(pix - w);
    if (y < h - 1) push(pix + w);
  }
  return { mask, method: 'flood' };
}

/** Remove tiny islands (noise) — keep components >= 1.5% of the largest one. */
function cleanMask(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = sizes.length; let size = 0, sp = 0;
    stack[sp++] = s; label[s] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && mask[q] && label[q] < 0) { label[q] = id; stack[sp++] = q; }
    }
    sizes.push(size);
  }
  if (!sizes.length) return;
  const max = Math.max(...sizes);
  for (let i = 0; i < w * h; i++) if (mask[i] && sizes[label[i]] < max * 0.015) mask[i] = 0;
}

/** Push opaque colours outward so UV samples near the silhouette never hit background. */
function bleed(data, mask, w, h, iterations = 24) {
  let cur = mask.slice();
  let next = new Uint8Array(w * h);
  for (let it = 0; it < iterations; it++) {
    next.set(cur);
    let changed = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (cur[p]) continue;
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (cur[q]) { r += data[q * 4]; g += data[q * 4 + 1]; b += data[q * 4 + 2]; c++; }
      }
      if (c) {
        data[p * 4] = r / c; data[p * 4 + 1] = g / c; data[p * 4 + 2] = b / c; data[p * 4 + 3] = 255;
        next[p] = 1; changed++;
      }
    }
    [cur, next] = [next, cur];
    if (!changed) break;
  }
  // anything still empty gets the average colour
  let r = 0, g = 0, b = 0, c = 0;
  for (let p = 0; p < w * h; p++) if (mask[p]) { r += data[p * 4]; g += data[p * 4 + 1]; b += data[p * 4 + 2]; c++; }
  c = Math.max(1, c);
  for (let p = 0; p < w * h; p++) if (!cur[p]) {
    data[p * 4] = r / c; data[p * 4 + 1] = g / c; data[p * 4 + 2] = b / c; data[p * 4 + 3] = 255;
  }
}

function averageColor(data, mask, w, h, y0 = 0, y1 = 1) {
  let r = 0, g = 0, b = 0, c = 0;
  const ya = Math.floor(h * y0), yb = Math.ceil(h * y1);
  for (let y = ya; y < yb; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!mask[p]) continue;
    r += data[p * 4]; g += data[p * 4 + 1]; b += data[p * 4 + 2]; c++;
  }
  if (!c) return '#888888';
  const hex = (v) => Math.round(v / c).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

/**
 * Process one view image.
 * Returns {
 *   colorCanvas  — cropped, opaque, bled colours (for 3D textures)
 *   alphaCanvas  — cropped colours with the real mask as alpha (for planes / previews)
 *   maskCanvas   — white silhouette on transparent (for SDF resampling)
 *   w, h, avgColor, topColor, method
 * }
 */
export async function processView(src, { removeBg = true, tolerance = 30, flipX = false } = {}) {
  const img = await loadImage(src);
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (flipX) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(img, 0, 0);
  const full = ctx.getImageData(0, 0, W, H);
  const { mask, method } = buildMask(full, removeBg, tolerance);
  cleanMask(mask, W, H);

  // bounding box
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; mask.fill(1); }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;

  const crop = new ImageData(w, h);
  const cmask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((y + y0) * W + (x + x0)), d = y * w + x;
    cmask[d] = mask[s];
    crop.data[d * 4] = full.data[s * 4];
    crop.data[d * 4 + 1] = full.data[s * 4 + 1];
    crop.data[d * 4 + 2] = full.data[s * 4 + 2];
    crop.data[d * 4 + 3] = mask[s] ? 255 : 0;
  }

  const alphaCanvas = makeCanvas(w, h);
  alphaCanvas.getContext('2d').putImageData(crop, 0, 0);

  const maskData = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    maskData.data[i * 4] = maskData.data[i * 4 + 1] = maskData.data[i * 4 + 2] = 255;
    maskData.data[i * 4 + 3] = cmask[i] ? 255 : 0;
  }
  const maskCanvas = makeCanvas(w, h);
  maskCanvas.getContext('2d').putImageData(maskData, 0, 0);

  const avgColor = averageColor(crop.data, cmask, w, h);
  const topColor = averageColor(crop.data, cmask, w, h, 0, 0.18);

  const bled = new ImageData(new Uint8ClampedArray(crop.data), w, h);
  bleed(bled.data, cmask, w, h, Math.max(8, Math.round(Math.max(w, h) * 0.04)));
  const colorCanvas = makeCanvas(w, h);
  colorCanvas.getContext('2d').putImageData(bled, 0, 0);

  const coreCanvas = makeCoreCanvas(alphaCanvas);
  return { colorCanvas, alphaCanvas, maskCanvas, coreCanvas, w, h, avgColor, topColor, method };
}

/**
 * "Core" colours: the drawing with its outer rim (usually a dark outline) removed and the
 * interior colours pushed outward. Used for surfaces that face sideways, so the outline
 * is not smeared along the depth of the model.
 */
function makeCoreCanvas(alphaCanvas) {
  const W = alphaCanvas.width, H = alphaCanvas.height;
  const s = Math.min(1, 256 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(alphaCanvas, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  const k = Math.max(2, Math.round(Math.max(w, h) * 0.035));
  for (let it = 0; it < k; it++) {
    const next = mask.slice();
    let left = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) next[p] = 0;
      else left++;
    }
    if (!left) break; // keep at least something
    mask = next;
  }
  // un-premultiply edge pixels: treat only the eroded core as known colours
  for (let i = 0; i < w * h; i++) d[i * 4 + 3] = mask[i] ? 255 : 0;
  bleed(d, mask, w, h, Math.max(w, h));
  ctx.putImageData(img, 0, 0);
  return c;
}

// --------------------------- signed distance fields -------------------------

const INF = 1e20;
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}
/** Felzenszwalb squared Euclidean distance transform, grid: 0 = feature, INF elsewhere. */
function edt2d(grid, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
}

/**
 * Resample a silhouette canvas to (cw × ch) cells with `pad` empty cells around,
 * and return a signed distance field in cell units (positive inside).
 * Row 0 = top of the image.
 */
export function silhouetteSDF(maskCanvas, cw, ch, pad) {
  const W = cw + pad * 2, H = ch + pad * 2;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(maskCanvas, pad, pad, cw, ch);
  const a = ctx.getImageData(0, 0, W, H).data;
  const cov = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) cov[i] = a[i * 4 + 3] / 255;
  const inside = new Float64Array(W * H), outside = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const isIn = cov[i] >= 0.5;
    inside[i] = isIn ? INF : 0;   // distance to nearest outside pixel
    outside[i] = isIn ? 0 : INF;  // distance to nearest inside pixel
  }
  edt2d(inside, W, H);
  edt2d(outside, W, H);
  const sdf = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    // sub-pixel correction using coverage
    sdf[i] = cov[i] >= 0.5 ? Math.sqrt(inside[i]) - 0.5 + (cov[i] - 0.5) : -(Math.sqrt(outside[i]) - 0.5) + (cov[i] - 0.5);
  }
  return { sdf, W, H };
}

/** Make a solid-colour canvas of the given size (used as synthetic back views). */
export function solidCanvas(w, h, color) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

export function mirrorCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  ctx.translate(src.width, 0); ctx.scale(-1, 1); ctx.drawImage(src, 0, 0);
  return c;
}
