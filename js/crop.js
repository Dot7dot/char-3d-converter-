// ---------------------------------------------------------------------------
// crop.js — crop (and rotate) a photo right after it is taken / chosen,
// before it goes into background removal and 3D conversion.
//
//   const out = await openCropper({ source: canvas, title });
//   out → { canvas }  (the cropped picture)   or   null when cancelled
// ---------------------------------------------------------------------------
import { makeCanvas } from './imageproc.js';

let dlg, els, S = null;

/** Rotate a canvas a quarter turn to the left. */
export function rotateLeft(s) {
  const c = makeCanvas(s.height, s.width), ctx = c.getContext('2d');
  ctx.translate(0, s.width); ctx.rotate(-Math.PI / 2); ctx.drawImage(s, 0, 0);
  return c;
}
const HIT = 18; // generous handle size — works with fingers

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'dialog crop-dlg';
  dlg.innerHTML = `
  <div class="dlg-inner">
    <header class="dlg-head"><h2>裁切照片 <small class="cr-name"></small></h2><button class="icon-btn" data-cancel aria-label="關閉">✕</button></header>
    <div class="cr-body">
      <div class="cr-stage"><canvas tabindex="0"></canvas></div>
      <p class="note cr-note">拖曳角落或邊框調整範圍，拖曳框內可移動，在框外拖曳可重新框選。只留下這個部位，背景越少，去背和 3D 成形越準。</p>
    </div>
    <footer class="dlg-foot">
      <button class="btn small" data-rot title="向左旋轉 90°">↺ 旋轉</button>
      <button class="btn small" data-auto title="自動框住主體">自動框選</button>
      <button class="btn small" data-full title="不裁切，使用整張照片">整張</button>
      <span class="al-spacer"></span>
      <span class="cr-size note"></span>
      <button class="btn ghost" data-cancel>取消</button>
      <button class="btn primary" data-ok>裁切並繼續</button>
    </footer>
  </div>`;
  document.body.appendChild(dlg);
  const q = (s) => dlg.querySelector(s);
  els = { name: q('.cr-name'), canvas: q('canvas'), stage: q('.cr-stage'), size: q('.cr-size') };
  dlg.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  q('[data-ok]').addEventListener('click', () => finish(true));
  q('[data-full]').addEventListener('click', () => { S.rect = { x: 0, y: 0, w: S.src.width, h: S.src.height }; draw(); });
  q('[data-auto]').addEventListener('click', () => { S.rect = suggest(S.src) || { x: 0, y: 0, w: S.src.width, h: S.src.height }; draw(); });
  q('[data-rot]').addEventListener('click', () => {
    // keep the selection on the same part of the picture
    const s = S.src, r = S.rect;
    S.rect = { x: r.y, y: s.width - r.x - r.w, w: r.h, h: r.w };
    S.src = rotateLeft(s); S.turns = (S.turns + 1) % 4;
    draw();
  });
  dlg.addEventListener('close', () => { if (S && !S.done) finish(false); });
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); finish(true); } });
  new ResizeObserver(() => { if (dlg.open) draw(); }).observe(els.stage);
  bindPointer();
}

function finish(ok) {
  if (!S) return;
  const st = S; S = null; st.done = true;
  let out = null;
  if (ok) {
    const r = clampRect(st.rect, st.src);
    const c = makeCanvas(r.w, r.h);
    c.getContext('2d').drawImage(st.src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    out = { canvas: c, turns: st.turns, cropped: r.w < st.src.width || r.h < st.src.height };
  }
  if (dlg.open) dlg.close();
  st.resolve(out);
}

/**
 * @param o { source: canvas (the photo), title?: string, turns?: number of left quarter-turns already wanted }
 * @returns Promise<{ canvas, turns, cropped } | null>
 */
export function openCropper(o) {
  if (!dlg) build();
  return new Promise((resolve) => {
    let src = o.source;
    const turns = ((o.turns || 0) % 4 + 4) % 4;
    for (let i = 0; i < turns; i++) src = rotateLeft(src);
    S = { src, rect: null, resolve, drag: null, done: false, turns };
    S.rect = suggest(S.src) || { x: 0, y: 0, w: S.src.width, h: S.src.height };
    els.name.textContent = o.title ? '· ' + o.title : '';
    dlg.showModal();
    draw();
    els.canvas.focus();
  });
}

// ------------------------------------------------------------- auto frame
/** Guess the subject's bounding box from how different pixels are from the border colour. */
function suggest(src) {
  const n = 96, W = src.width, H = src.height;
  const w = Math.max(8, Math.round(W >= H ? n : n * W / H)), h = Math.max(8, Math.round(H >= W ? n : n * H / W));
  const c = makeCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const at = (x, y) => (y * w + x) * 4;
  let transparent = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 32) transparent++;
  const fg = new Uint8Array(w * h);
  if (transparent > w * h * 0.02) {
    for (let i = 0; i < w * h; i++) fg[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  } else {
    // background = average of the border ring; it must be fairly uniform for the guess to be trusted
    let r = 0, g = 0, b = 0, k = 0;
    const ring = [];
    for (let x = 0; x < w; x++) ring.push(at(x, 0), at(x, h - 1));
    for (let y = 1; y < h - 1; y++) ring.push(at(0, y), at(w - 1, y));
    for (const i of ring) { r += d[i]; g += d[i + 1]; b += d[i + 2]; k++; }
    r /= k; g /= k; b /= k;
    let spread = 0;
    for (const i of ring) spread += Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b);
    if (spread / k > 60) return null;
    const tol = Math.max(48, (spread / k) * 2.2);
    for (let i = 0; i < w * h; i++) fg[i] = Math.abs(d[i * 4] - r) + Math.abs(d[i * 4 + 1] - g) + Math.abs(d[i * 4 + 2] - b) > tol ? 1 : 0;
  }
  // the subject = the largest connected blob (stray objects elsewhere in the photo are ignored)
  const label = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h);
  let best = null;
  for (let s0 = 0; s0 < w * h; s0++) {
    if (!fg[s0] || label[s0] >= 0) continue;
    let sp = 0, size = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    stack[sp++] = s0; label[s0] = s0;
    while (sp) {
      const q = stack[--sp]; size++;
      const x = q % w, y = (q / w) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const n = yy * w + xx;
        if (fg[n] && label[n] < 0) { label[n] = s0; stack[sp++] = n; }
      }
    }
    if (!best || size > best.size) best = { size, x0: bx0, y0: by0, x1: bx1, y1: by1 };
  }
  if (!best || best.size < 6) return null;
  const { x0, y0, x1, y1 } = best;
  if (x1 < 0 || y1 < 0) return null;
  const bw = (x1 - x0 + 1) / w, bh = (y1 - y0 + 1) / h;
  if (bw * bh < 0.02 || (bw > 0.94 && bh > 0.94)) return null;
  const m = 0.05 * Math.max(bw, bh);
  const fx0 = Math.max(0, x0 / w - m), fy0 = Math.max(0, y0 / h - m), fx1 = Math.min(1, (x1 + 1) / w + m), fy1 = Math.min(1, (y1 + 1) / h + m);
  return clampRect({ x: fx0 * W, y: fy0 * H, w: (fx1 - fx0) * W, h: (fy1 - fy0) * H }, src);
}

function clampRect(r, src) {
  let x = Math.round(Math.min(r.x, r.x + r.w)), y = Math.round(Math.min(r.y, r.y + r.h));
  let w = Math.round(Math.abs(r.w)), h = Math.round(Math.abs(r.h));
  x = Math.max(0, Math.min(src.width - 8, x)); y = Math.max(0, Math.min(src.height - 8, y));
  w = Math.max(8, Math.min(src.width - x, w)); h = Math.max(8, Math.min(src.height - y, h));
  return { x, y, w, h };
}

// ------------------------------------------------------------- drawing
function fit() {
  const W = els.stage.clientWidth, H = els.stage.clientHeight, m = 16;
  const s = Math.min((W - m * 2) / S.src.width, (H - m * 2) / S.src.height);
  return { s, ox: (W - S.src.width * s) / 2, oy: (H - S.src.height * s) / 2, W, H };
}
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#5b6cff'; }

function draw() {
  if (!S || !dlg.open) return;
  const f = fit();
  if (!f.W || !f.H) return;
  const c = els.canvas, dpr = Math.min(devicePixelRatio || 1, 2);
  c.width = f.W * dpr; c.height = f.H * dpr; c.style.width = f.W + 'px'; c.style.height = f.H + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, f.W, f.H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(S.src, f.ox, f.oy, S.src.width * f.s, S.src.height * f.s);
  const r = S.rect, x = f.ox + r.x * f.s, y = f.oy + r.y * f.s, w = r.w * f.s, h = r.h * f.s;
  // dim everything outside the selection
  ctx.save(); ctx.fillStyle = 'rgba(10, 12, 20, 0.6)';
  ctx.beginPath(); ctx.rect(0, 0, f.W, f.H); ctx.rect(x, y, w, h); ctx.fill('evenodd'); ctx.restore();
  const accent = css('--accent');
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath(); ctx.moveTo(x + (w * i) / 3, y); ctx.lineTo(x + (w * i) / 3, y + h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + (h * i) / 3); ctx.lineTo(x + w, y + (h * i) / 3); ctx.stroke();
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
  for (const [hx, hy] of HANDLES) {
    const px = x + w * (hx + 1) / 2, py = y + h * (hy + 1) / 2;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = accent; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(px - 6, py - 6, 12, 12); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
  const cr = clampRect(r, S.src);
  els.size.textContent = `${cr.w} × ${cr.h}`;
}
const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

// ------------------------------------------------------------- pointer
function bindPointer() {
  const c = els.canvas;
  const pos = (e) => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const hit = (px, py) => {
    const f = fit(), r = S.rect, x = f.ox + r.x * f.s, y = f.oy + r.y * f.s, w = r.w * f.s, h = r.h * f.s;
    let best = null, bd = HIT;
    for (const [hx, hy] of HANDLES) {
      const d = Math.hypot(px - (x + w * (hx + 1) / 2), py - (y + h * (hy + 1) / 2));
      if (d < bd) { bd = d; best = [hx, hy]; }
    }
    if (best) return { kind: 'size', h: best };
    if (px >= x && px <= x + w && py >= y && py <= y + h) return { kind: 'move' };
    return { kind: 'new' };
  };
  c.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !S) return;
    const [px, py] = pos(e), f = fit(), k = hit(px, py);
    const ix = (px - f.ox) / f.s, iy = (py - f.oy) / f.s;
    S.drag = { ...k, px, py, r0: { ...S.rect }, ix, iy, f };
    c.setPointerCapture(e.pointerId); e.preventDefault();
  });
  c.addEventListener('pointermove', (e) => {
    if (!S) return;
    const [px, py] = pos(e), d = S.drag;
    if (!d) {
      const k = hit(px, py);
      c.style.cursor = k.kind === 'move' ? 'move' : k.kind === 'new' ? 'crosshair'
        : (k.h[0] && k.h[1] ? (k.h[0] === k.h[1] ? 'nwse-resize' : 'nesw-resize') : k.h[0] ? 'ew-resize' : 'ns-resize');
      return;
    }
    const W = S.src.width, H = S.src.height;
    const dx = (px - d.px) / d.f.s, dy = (py - d.py) / d.f.s, r0 = d.r0;
    if (d.kind === 'move') {
      S.rect = { ...r0, x: Math.max(0, Math.min(W - r0.w, r0.x + dx)), y: Math.max(0, Math.min(H - r0.h, r0.y + dy)) };
    } else if (d.kind === 'size') {
      let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
      if (d.h[0] < 0) x0 = Math.max(0, Math.min(x1 - 8, x0 + dx)); else if (d.h[0] > 0) x1 = Math.min(W, Math.max(x0 + 8, x1 + dx));
      if (d.h[1] < 0) y0 = Math.max(0, Math.min(y1 - 8, y0 + dy)); else if (d.h[1] > 0) y1 = Math.min(H, Math.max(y0 + 8, y1 + dy));
      S.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else {
      // rubber-band a new selection once the pointer has moved a little
      if (Math.hypot(px - d.px, py - d.py) < 6) return;
      const ax = Math.max(0, Math.min(W, d.ix)), ay = Math.max(0, Math.min(H, d.iy));
      const bx = Math.max(0, Math.min(W, d.ix + dx)), by = Math.max(0, Math.min(H, d.iy + dy));
      S.rect = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.max(8, Math.abs(bx - ax)), h: Math.max(8, Math.abs(by - ay)) };
    }
    draw();
  });
  const end = () => { if (S) S.drag = null; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

export const _debug = { get state() { return S; }, fit };
