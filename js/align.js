// ---------------------------------------------------------------------------
// align.js — the 3-view alignment workbench.
//
// Front is the reference. The other views can be moved / scaled / rotated
// inside their own frames:
//   back — overlaid (mirrored) on the front so both silhouettes can be matched
//   side — placed next to the front, with horizontal guides for heights
//   top  — placed under the front, with vertical guides for widths
// The result is stored as params.align[view] = { dx, dy, sx, sy, rot }
// (in the view's own image coordinates) and applied before conversion.
// ---------------------------------------------------------------------------
import { drawAligned, mirrorCanvas, makeCanvas, IDENTITY_ALIGN } from './imageproc.js';

const TABS = [
  { id: 'back', name: '背面', help: '背面圖已左右鏡像疊在正面上。拖曳移動、拖曳角落/邊縮放，讓兩個輪廓重疊。也可按「自動對齊」。' },
  { id: 'side', name: '側面', help: '側面放在正面右邊。上下拖曳讓頭頂、下巴、腰等高度和正面的參考線對齊；水平縮放可調整深度分布。' },
  { id: 'top', name: '頂部', help: '頂部放在正面下方。左右拖曳/縮放讓寬度和正面的左右參考線對齊；上下對應物件的前後。' },
];

const clone = (t) => ({ ...IDENTITY_ALIGN, ...(t || {}) });
// back is displayed mirrored → convert between display space and image space
const toDisplay = (id, t) => (id === 'back' ? { ...t, dx: -t.dx, rot: -t.rot } : { ...t });
const fromDisplay = toDisplay;

let dlg, els, state;

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'dialog align-dlg';
  dlg.innerHTML = `
  <div class="dlg-inner">
    <header class="dlg-head"><h2>三視圖對齊 <small class="al-name"></small></h2><button class="icon-btn" data-close aria-label="關閉">✕</button></header>
    <div class="al-tabs seg" role="tablist"></div>
    <div class="al-body">
      <div class="al-stage"><canvas></canvas></div>
      <div class="al-side">
        <p class="al-help note"></p>
        <div class="row2">
          <label class="field"><span>水平位移 %</span><input type="number" step="0.5" data-k="dx"></label>
          <label class="field"><span>垂直位移 %</span><input type="number" step="0.5" data-k="dy"></label>
          <label class="field"><span>寬度 %</span><input type="number" step="1" min="20" max="400" data-k="sx"></label>
          <label class="field"><span>高度 %</span><input type="number" step="1" min="20" max="400" data-k="sy"></label>
        </div>
        <label class="field" style="margin-top:8px"><span>旋轉<output data-o="rot"></output></span><input type="range" min="-45" max="45" step="0.5" data-k="rot"></label>
        <label class="field check" style="margin-top:6px"><input type="checkbox" data-lock><span>等比縮放（或按住 Shift）</span></label>
        <div class="al-overlay">
          <label class="field" style="margin-top:6px"><span>疊圖透明度<output data-o="op"></output></span><input type="range" min="0.1" max="1" step="0.05" value="0.55" data-op></label>
          <label class="field check"><input type="checkbox" data-diff><span>差異模式（重疊處變黑）</span></label>
        </div>
        <div class="al-btns">
          <button class="btn" data-auto>自動對齊</button>
          <button class="btn" data-reset>重設</button>
        </div>
        <p class="note">快捷鍵：方向鍵微調（Shift ×10）、滾輪縮放。參考線可上下 / 左右拖曳。</p>
      </div>
    </div>
    <footer class="dlg-foot">
      <button class="btn ghost" data-close>取消</button>
      <button class="btn primary" data-apply>套用並重新轉換</button>
    </footer>
  </div>`;
  document.body.appendChild(dlg);
  els = {
    name: dlg.querySelector('.al-name'), tabs: dlg.querySelector('.al-tabs'), canvas: dlg.querySelector('canvas'),
    stage: dlg.querySelector('.al-stage'), help: dlg.querySelector('.al-help'), overlay: dlg.querySelector('.al-overlay'),
    lock: dlg.querySelector('[data-lock]'), op: dlg.querySelector('[data-op]'), diff: dlg.querySelector('[data-diff]'),
    auto: dlg.querySelector('[data-auto]'),
  };
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.querySelector('[data-apply]').addEventListener('click', () => {
    const out = {};
    for (const t of TABS) if (state.tabs[t.id]) out[t.id] = fromDisplay(t.id, state.tabs[t.id].T);
    dlg.close();
    state.onApply(out);
  });
  dlg.querySelector('[data-reset]').addEventListener('click', () => { cur().T = clone(); sync(); draw(); });
  els.auto.addEventListener('click', () => { autoAlignBack(); sync(); draw(); });
  dlg.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('input', () => {
    const T = cur().T, k = inp.dataset.k, v = parseFloat(inp.value);
    if (!Number.isFinite(v)) return;
    if (k === 'dx' || k === 'dy') T[k] = v / 100;
    else if (k === 'sx' || k === 'sy') T[k] = Math.min(4, Math.max(0.2, v / 100));
    else T.rot = v;
    sync(inp); draw();
  }));
  els.op.addEventListener('input', () => { sync(); draw(); });
  els.diff.addEventListener('change', draw);
  bindPointer();
  new ResizeObserver(() => { if (dlg.open) draw(); }).observe(els.stage);
  dlg.addEventListener('keydown', onKey);
}

const cur = () => state.tabs[state.tab];

/**
 * @param o { name, front, views: { back?, side?, top? } (raw processed views), align, tab, onApply }
 */
export function openAlignEditor(o) {
  if (!dlg) build();
  state = { name: o.name, front: o.front, tabs: {}, tab: null, guides: { side: [0.3, 0.6], top: [0.3, 0.7] }, onApply: o.onApply, drag: null };
  for (const t of TABS) {
    const v = o.views[t.id];
    if (!v) continue;
    state.tabs[t.id] = { view: v, img: t.id === 'back' ? mirrorCanvas(v.alphaCanvas) : v.alphaCanvas, T: toDisplay(t.id, clone(o.align?.[t.id])) };
  }
  state.tab = (o.tab && state.tabs[o.tab]) ? o.tab : TABS.find((t) => state.tabs[t.id])?.id;
  els.name.textContent = '· ' + o.name;
  els.tabs.innerHTML = TABS.map((t) => `<button role="tab" data-tab="${t.id}" ${state.tabs[t.id] ? '' : 'disabled'} aria-selected="${t.id === state.tab}">${t.name}</button>`).join('');
  els.tabs.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    els.tabs.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === state.tab));
    sync(); draw();
  }));
  dlg.showModal();
  sync(); draw();
  els.canvas.focus();
}

// ------------------------------------------------------------- layout
function layout() {
  const W = els.stage.clientWidth, H = els.stage.clientHeight;
  const m = 28;
  const F = state.front, tab = state.tab, v = cur().view;
  const fa = F.w / F.h;
  const L = { W, H };
  if (tab === 'back') {
    let h = H - m * 2, w = h * fa;
    if (w > W - m * 2) { w = W - m * 2; h = w / fa; }
    L.ref = { x: (W - w) / 2, y: (H - h) / 2, w, h };
    L.frame = { ...L.ref };
  } else if (tab === 'side') {
    const sa = v.w / v.h, gap = 36;
    let h = H - m * 2, total = h * (fa + sa) + gap;
    if (total > W - m * 2) { h = (W - m * 2 - gap) / (fa + sa); total = h * (fa + sa) + gap; }
    const x0 = (W - total) / 2, y0 = (H - h) / 2;
    L.ref = { x: x0, y: y0, w: h * fa, h };
    L.frame = { x: x0 + h * fa + gap, y: y0, w: h * sa, h };
  } else {
    const ta = v.h / v.w, gap = 30; // frame height per unit width
    let w = W - m * 2, total = w / fa + w * ta + gap;
    if (total > H - m * 2) { w = (H - m * 2 - gap) / (1 / fa + ta); total = w / fa + w * ta + gap; }
    const x0 = (W - w) / 2, y0 = (H - total) / 2;
    L.ref = { x: x0, y: y0, w, h: w / fa };
    L.frame = { x: x0, y: y0 + w / fa + gap, w, h: w * ta };
  }
  return L;
}

// transformed box corners in screen space
function boxGeom(frame, T) {
  const cx = frame.x + frame.w * (0.5 + T.dx), cy = frame.y + frame.h * (0.5 + T.dy);
  const hw = frame.w * T.sx / 2, hh = frame.h * T.sy / 2, r = (T.rot * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const pt = (lx, ly) => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
  const handles = [];
  for (const [hx, hy] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) {
    handles.push({ hx, hy, p: pt(hx * hw, hy * hh) });
  }
  return { cx, cy, hw, hh, cos, sin, handles, corners: [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)] };
}

// ------------------------------------------------------------- drawing
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }

function draw() {
  if (!state || !dlg.open) return;
  const c = els.canvas, dpr = Math.min(devicePixelRatio || 1, 2);
  const W = els.stage.clientWidth, H = els.stage.clientHeight;
  c.width = W * dpr; c.height = H * dpr; c.style.width = W + 'px'; c.style.height = H + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const L = layout(), tab = state.tab, t = cur();
  const accent = css('--accent'), muted = css('--muted');

  // reference (front)
  ctx.drawImage(state.front.alphaCanvas, L.ref.x, L.ref.y, L.ref.w, L.ref.h);
  dashed(ctx, L.ref, muted);
  label(ctx, '正面（參考）', L.ref.x, L.ref.y - 8, muted);

  // the adjustable view
  if (tab === 'back') {
    ctx.save();
    if (els.diff.checked) ctx.globalCompositeOperation = 'difference';
    ctx.globalAlpha = els.diff.checked ? 1 : parseFloat(els.op.value);
    ctx.beginPath(); ctx.rect(L.frame.x, L.frame.y, L.frame.w, L.frame.h); ctx.clip();
    drawAligned(ctx, t.img, L.frame.x, L.frame.y, L.frame.w, L.frame.h, t.T);
    ctx.restore();
  } else {
    ctx.save(); ctx.globalAlpha = 0.22;
    drawAligned(ctx, t.img, L.frame.x, L.frame.y, L.frame.w, L.frame.h, t.T);
    ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(L.frame.x, L.frame.y, L.frame.w, L.frame.h); ctx.clip();
    drawAligned(ctx, t.img, L.frame.x, L.frame.y, L.frame.w, L.frame.h, t.T);
    ctx.restore();
    dashed(ctx, L.frame, muted);
    label(ctx, tab === 'side' ? '側面（面朝右）' : '頂部（正面朝下）', L.frame.x, L.frame.y - 8, muted);
    // guides
    ctx.save(); ctx.strokeStyle = accent; ctx.lineWidth = 1;
    if (tab === 'side') {
      for (const y of [L.ref.y, L.ref.y + L.ref.h]) line(ctx, 0, y, L.W, y);
      ctx.setLineDash([6, 5]);
      for (const g of state.guides.side) { const y = L.ref.y + L.ref.h * g; line(ctx, 0, y, L.W, y); }
    } else {
      for (const x of [L.ref.x, L.ref.x + L.ref.w]) line(ctx, x, 0, x, L.H);
      ctx.setLineDash([6, 5]);
      for (const g of state.guides.top) { const x = L.ref.x + L.ref.w * g; line(ctx, x, 0, x, L.H); }
    }
    ctx.restore();
  }

  // transform box + handles
  const g = boxGeom(L.frame, t.T);
  ctx.save();
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
  ctx.beginPath(); g.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
  for (const h of g.handles) {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = accent;
    ctx.beginPath(); ctx.rect(h.p[0] - 5, h.p[1] - 5, 10, 10); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
function dashed(ctx, r, color) { ctx.save(); ctx.strokeStyle = color; ctx.setLineDash([4, 4]); ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h); ctx.restore(); }
function label(ctx, text, x, y, color) { ctx.save(); ctx.fillStyle = color; ctx.font = '12px system-ui, sans-serif'; ctx.fillText(text, x, y); ctx.restore(); }
function line(ctx, a, b, c, d) { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); }

function sync(except) {
  const tabDef = TABS.find((t) => t.id === state.tab);
  els.help.textContent = tabDef.help;
  els.overlay.hidden = state.tab !== 'back';
  els.auto.hidden = state.tab !== 'back';
  const T = cur().T;
  const vals = { dx: (T.dx * 100).toFixed(1), dy: (T.dy * 100).toFixed(1), sx: Math.round(T.sx * 100), sy: Math.round(T.sy * 100), rot: T.rot };
  dlg.querySelectorAll('[data-k]').forEach((inp) => { if (inp !== except) inp.value = vals[inp.dataset.k]; });
  dlg.querySelector('[data-o="rot"]').textContent = `${(+T.rot).toFixed(1)}°`;
  dlg.querySelector('[data-o="op"]').textContent = `${Math.round(els.op.value * 100)}%`;
}

// ------------------------------------------------------------- pointer
function bindPointer() {
  const c = els.canvas;
  c.tabIndex = 0;
  const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener('pointerdown', (e) => {
    const [x, y] = pos(e);
    const L = layout(), T = cur().T, g = boxGeom(L.frame, T);
    const h = g.handles.find((hh) => Math.abs(hh.p[0] - x) <= 8 && Math.abs(hh.p[1] - y) <= 8);
    if (h) state.drag = { kind: 'scale', h, T0: { ...T }, L };
    else if (inside(g, x, y)) state.drag = { kind: 'move', x, y, T0: { ...T }, L };
    else {
      const gi = guideHit(L, x, y);
      if (gi >= 0) state.drag = { kind: 'guide', gi, L };
    }
    if (state.drag) { c.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  c.addEventListener('pointermove', (e) => {
    const [x, y] = pos(e);
    const d = state.drag;
    if (!d) { setCursor(x, y); return; }
    const T = cur().T, F = d.L.frame;
    if (d.kind === 'move') {
      T.dx = d.T0.dx + (x - d.x) / F.w;
      T.dy = d.T0.dy + (y - d.y) / F.h;
    } else if (d.kind === 'scale') {
      const g = boxGeom(F, d.T0);
      const lx = (x - g.cx) * g.cos + (y - g.cy) * g.sin;
      const ly = -(x - g.cx) * g.sin + (y - g.cy) * g.cos;
      let sx = d.h.hx ? Math.abs(lx) * 2 / F.w : d.T0.sx;
      let sy = d.h.hy ? Math.abs(ly) * 2 / F.h : d.T0.sy;
      if ((e.shiftKey || els.lock.checked)) {
        const f = d.h.hx && d.h.hy ? (sx / d.T0.sx + sy / d.T0.sy) / 2 : d.h.hx ? sx / d.T0.sx : sy / d.T0.sy;
        sx = d.T0.sx * f; sy = d.T0.sy * f;
      }
      T.sx = Math.min(4, Math.max(0.2, sx)); T.sy = Math.min(4, Math.max(0.2, sy));
    } else if (d.kind === 'guide') {
      const R = d.L.ref;
      if (state.tab === 'side') state.guides.side[d.gi] = Math.min(1.2, Math.max(-0.2, (y - R.y) / R.h));
      else state.guides.top[d.gi] = Math.min(1.2, Math.max(-0.2, (x - R.x) / R.w));
    }
    sync(); draw();
  });
  const end = () => { state && (state.drag = null); };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('wheel', (e) => {
    e.preventDefault();
    const T = cur().T, f = e.deltaY < 0 ? 1.02 : 1 / 1.02;
    T.sx = Math.min(4, Math.max(0.2, T.sx * f)); T.sy = Math.min(4, Math.max(0.2, T.sy * f));
    sync(); draw();
  }, { passive: false });
}
function inside(g, x, y) {
  const lx = (x - g.cx) * g.cos + (y - g.cy) * g.sin, ly = -(x - g.cx) * g.sin + (y - g.cy) * g.cos;
  return Math.abs(lx) <= g.hw && Math.abs(ly) <= g.hh;
}
function guideHit(L, x, y) {
  if (state.tab === 'side') return state.guides.side.findIndex((g) => Math.abs(L.ref.y + L.ref.h * g - y) < 6);
  if (state.tab === 'top') return state.guides.top.findIndex((g) => Math.abs(L.ref.x + L.ref.w * g - x) < 6);
  return -1;
}
function setCursor(x, y) {
  const L = layout(), g = boxGeom(L.frame, cur().T);
  const h = g.handles.find((hh) => Math.abs(hh.p[0] - x) <= 8 && Math.abs(hh.p[1] - y) <= 8);
  let cur2 = 'default';
  if (h) cur2 = h.hx && h.hy ? (h.hx === h.hy ? 'nwse-resize' : 'nesw-resize') : h.hx ? 'ew-resize' : 'ns-resize';
  else if (inside(g, x, y)) cur2 = 'move';
  else if (guideHit(L, x, y) >= 0) cur2 = state.tab === 'side' ? 'row-resize' : 'col-resize';
  els.canvas.style.cursor = cur2;
}
function onKey(e) {
  if (!state || e.target.tagName === 'INPUT') return;
  const step = e.shiftKey ? 10 : 1;
  const L = layout(), T = cur().T;
  const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const m = map[e.key];
  if (!m) return;
  e.preventDefault();
  T.dx += (m[0] * step) / L.frame.w; T.dy += (m[1] * step) / L.frame.h;
  sync(); draw();
}

// ------------------------------------------------------------- auto align
function maskGrid(canvas, n) {
  const c = makeCanvas(n, n);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  const m = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) m[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  return m;
}
/** Grid-search translation + scale that maximises silhouette overlap (IoU). */
function autoAlignBack() {
  const t = state.tabs.back;
  if (!t) return;
  const n = 64;
  const A = maskGrid(state.front.alphaCanvas, n), Bm = maskGrid(t.img, n);
  const score = (T) => {
    let inter = 0, uni = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n - 0.5 - T.dx, v = (y + 0.5) / n - 0.5 - T.dy;
      const sx = Math.floor((u / T.sx + 0.5) * n), sy = Math.floor((v / T.sy + 0.5) * n);
      const b = sx >= 0 && sy >= 0 && sx < n && sy < n ? Bm[sy * n + sx] : 0;
      const a = A[y * n + x];
      if (a && b) inter++;
      if (a || b) uni++;
    }
    return uni ? inter / uni : 0;
  };
  let best = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 }, bs = score(best);
  const search = (c, rT, rS, steps) => {
    for (let i = -steps; i <= steps; i++) for (let j = -steps; j <= steps; j++)
      for (let a = -steps; a <= steps; a++) for (let b = -steps; b <= steps; b++) {
        const T = { dx: c.dx + i * rT / steps, dy: c.dy + j * rT / steps, sx: c.sx * (1 + a * rS / steps), sy: c.sy * (1 + b * rS / steps), rot: 0 };
        const s = score(T);
        if (s > bs) { bs = s; best = T; }
      }
  };
  search(best, 0.15, 0.2, 4);
  search({ ...best }, 0.04, 0.05, 3);
  search({ ...best }, 0.01, 0.015, 2);
  t.T = best;
}
