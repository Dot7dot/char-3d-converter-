// ---------------------------------------------------------------------------
// align.js — the view workbench: align the views to each other and touch
// them up before conversion.
//
// Tabs:  front (reference) · back · side · top
// Tools: move / scale / rotate   (not for the front, which is the reference)
//        warp   — put N points on the picture's outline, drag them to reshape it
//        erase  — rub out stray parts
//
// Everything is non-destructive: the result is { align, edits } stored in the
// slot's params and replayed on the original upload (see imgedit.js).
// A small live 3D preview shows the effect while the dialog is open.
// ---------------------------------------------------------------------------
import { makeCanvas, IDENTITY_ALIGN } from './imageproc.js';
import { PAD, padOf, toPadded, cloneCanvas, applyOps, eraseStroke, warpCanvas, warpMoved, outlinePoints, hasEdits } from './imgedit.js';

const TABS = [
  { id: 'front', name: '正面', help: '正面是其他視圖的基準，不能移動，但可以用「變形點」修外形、用「橡皮擦」擦掉多餘的部分。' },
  { id: 'back', name: '背面', help: '背面圖已左右鏡像疊在正面上。拖曳移動、拖角落或邊縮放，讓兩個輪廓重疊；也可按「自動對齊」。' },
  { id: 'side', name: '側面', help: '側面放在正面右邊。上下拖曳讓頭頂、下巴、腰等高度對上參考線。超出上下虛線的部分會被裁掉；左右方向決定深度，可以自由伸展。' },
  { id: 'top', name: '頂部', help: '頂部放在正面下方。左右拖曳或縮放，讓寬度對上參考線。超出左右虛線的部分會被裁掉；上下方向決定深度。' },
];
const TOOLS = [['move', '移動縮放'], ['warp', '變形點'], ['erase', '橡皮擦']];
const TOOL_HELP = {
  warp: '輸入點數後按「生成變形點」，輪廓上會出現控制點。拖曳任一點，附近的圖會跟著變形，其他點會把其餘部分固定住。再按一次生成，會在目前結果上重新佈點。',
  erase: '在圖上按住拖曳即可擦除。擦掉的地方不會參與 3D 成形。',
};

const clone = (t) => ({ ...IDENTITY_ALIGN, ...(t || {}) });
// back is displayed mirrored → convert between display space and image space
const flipT = (t) => ({ ...t, dx: -t.dx, rot: -t.rot });
const r4 = (v) => Math.round(v * 1e4) / 1e4;

let dlg, els, S = null;

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'dialog align-dlg';
  dlg.innerHTML = `
  <div class="dlg-inner">
    <header class="dlg-head"><h2>三視圖對齊與修圖 <small class="al-name"></small></h2><button class="icon-btn" data-close aria-label="關閉">✕</button></header>
    <div class="al-bar">
      <div class="al-tabs seg" role="tablist"></div>
      <div class="al-tools seg" role="tablist"></div>
      <span class="al-spacer"></span>
      <button class="btn small" data-undo title="復原上一步 (Ctrl+Z)">↶ 復原</button>
    </div>
    <div class="al-body">
      <div class="al-stage"><canvas tabindex="0"></canvas></div>
      <div class="al-side">
        <p class="al-help note"></p>

        <div class="al-panel" data-panel="move">
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
          <div class="al-btns"><button class="btn small" data-auto>自動對齊</button><button class="btn small" data-reset-move>重設位置</button></div>
        </div>

        <div class="al-panel" data-panel="warp">
          <div class="al-gen">
            <label class="field"><span>點數</span><input type="number" min="3" max="64" step="1" value="12" data-n></label>
            <button class="btn primary small" data-gen>生成變形點</button>
          </div>
          <p class="note" data-warp-info></p>
          <div class="al-btns"><button class="btn small" data-reset-warp>清除所有變形</button></div>
        </div>

        <div class="al-panel" data-panel="erase">
          <label class="field"><span>橡皮擦大小<output data-o="er"></output></span><input type="range" min="0.01" max="0.2" step="0.005" value="0.05" data-er></label>
          <div class="al-btns"><button class="btn small" data-reset-erase>還原所有擦除</button></div>
        </div>

        <div class="al-preview">
          <canvas width="320" height="320" title="拖曳可旋轉"></canvas>
          <span>3D 即時預覽 · 拖曳旋轉</span>
        </div>
        <p class="note">方向鍵微調（Shift ×10）、滾輪縮放、Ctrl+Z 復原。</p>
      </div>
    </div>
    <footer class="dlg-foot">
      <button class="btn ghost" data-reset-all>這張圖全部重設</button>
      <span class="al-spacer"></span>
      <button class="btn ghost" data-close>取消</button>
      <button class="btn primary" data-apply>完成</button>
    </footer>
  </div>`;
  document.body.appendChild(dlg);
  const q = (s) => dlg.querySelector(s);
  els = {
    name: q('.al-name'), tabs: q('.al-tabs'), tools: q('.al-tools'), canvas: q('.al-stage canvas'), stage: q('.al-stage'),
    help: q('.al-help'), overlay: q('.al-overlay'), lock: q('[data-lock]'), op: q('[data-op]'), diff: q('[data-diff]'),
    auto: q('[data-auto]'), n: q('[data-n]'), er: q('[data-er]'), warpInfo: q('[data-warp-info]'), undo: q('[data-undo]'),
    preview: q('.al-preview canvas'),
  };
  els.tools.innerHTML = TOOLS.map(([k, t]) => `<button role="tab" data-tool="${k}">${t}</button>`).join('');
  els.tools.addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b && !b.disabled) setTool(b.dataset.tool); });
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  q('[data-apply]').addEventListener('click', () => { S.applied = true; const out = payload(); dlg.close(); S.onApply(out); });
  dlg.addEventListener('close', () => {
    if (!S) return;
    clearTimeout(S.liveTimer);
    S.onPreview && S.onPreview(null);
    if (!S.applied) S.onCancel && S.onCancel();
    S = null;
  });
  q('[data-reset-move]').addEventListener('click', () => change(() => { cur().T = clone(); }));
  q('[data-reset-warp]').addEventListener('click', () => change(() => { const t = cur(); t.ops = t.ops.filter((o) => o.t !== 'warp'); rebuild(t); }));
  q('[data-reset-erase]').addEventListener('click', () => change(() => { const t = cur(); t.ops = t.ops.filter((o) => o.t !== 'erase'); rebuild(t); }));
  q('[data-reset-all]').addEventListener('click', () => change(() => { const t = cur(); t.ops = []; t.T = clone(); rebuild(t); }));
  els.auto.addEventListener('click', () => change(autoAlignBack));
  q('[data-gen]').addEventListener('click', generatePoints);
  els.undo.addEventListener('click', undo);
  dlg.querySelectorAll('[data-k]').forEach((inp) => {
    inp.addEventListener('focus', pushUndo);
    inp.addEventListener('input', () => {
      const T = cur().T, k = inp.dataset.k, v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      if (k === 'dx' || k === 'dy') T[k] = v / 100;
      else if (k === 'sx' || k === 'sy') T[k] = Math.min(4, Math.max(0.2, v / 100));
      else T.rot = v;
      sync(inp); draw(); live();
    });
  });
  els.op.addEventListener('input', () => { sync(); draw(); });
  els.er.addEventListener('input', () => { sync(); draw(); });
  els.diff.addEventListener('change', draw);
  bindPointer();
  bindPreviewDrag();
  new ResizeObserver(() => { if (dlg.open) draw(); }).observe(els.stage);
  dlg.addEventListener('keydown', onKey);
}

const cur = () => S.tabs[S.tab];

/**
 * @param o { name, views: { front, back?, side?, top? } raw processed views,
 *            align, edits, tab,
 *            onApply({align, edits}), onLive({align, edits}), onCancel(), onPreview(canvas | null, getAngle) }
 */
export function openAlignEditor(o) {
  if (!dlg) build();
  S = {
    name: o.name, tabs: {}, tab: null, tool: 'move', guides: { side: [0.3, 0.6], top: [0.3, 0.7] },
    onApply: o.onApply, onLive: o.onLive, onCancel: o.onCancel, onPreview: o.onPreview,
    drag: null, undo: [], hover: null, applied: false, liveTimer: null, angle: null, frontRef: null,
  };
  for (const t of TABS) {
    const v = o.views[t.id];
    if (!v) continue;
    // work on a preview-sized copy; coordinates are resolution independent
    const s = Math.min(1, 520 / Math.max(v.w, v.h));
    const w = Math.max(2, Math.round(v.w * s)), h = Math.max(2, Math.round(v.h * s));
    const img = makeCanvas(w, h);
    img.getContext('2d', { willReadFrequently: true }).drawImage(v.alphaCanvas, 0, 0, w, h);
    const tab = {
      id: t.id, img, w, h, mirror: t.id === 'back',
      T: t.id === 'front' ? clone() : (t.id === 'back' ? flipT(clone(o.align?.[t.id])) : clone(o.align?.[t.id])),
      ops: JSON.parse(JSON.stringify(o.edits?.[t.id] || [])), cur: null, base: null, active: -1,
    };
    rebuild(tab);
    S.tabs[t.id] = tab;
  }
  S.tab = (o.tab && S.tabs[o.tab]) ? o.tab : (['back', 'side', 'top'].find((id) => S.tabs[id]) || 'front');
  els.name.textContent = '· ' + o.name;
  els.tabs.innerHTML = TABS.map((t) => `<button role="tab" data-tab="${t.id}" ${S.tabs[t.id] ? '' : 'disabled'}>${t.name}</button>`).join('');
  els.tabs.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  dlg.showModal();
  setTab(S.tab);
  S.onPreview && S.onPreview(els.preview, () => S && S.angle);
  els.canvas.focus();
}

function setTab(id) {
  S.tab = id;
  S.frontRef = null;
  els.tabs.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === id));
  const isFront = id === 'front';
  els.tools.querySelector('[data-tool="move"]').disabled = isFront;
  setTool(isFront && S.tool === 'move' ? 'warp' : S.tool);
}
function setTool(tool) {
  S.tool = tool; S.hover = null;
  els.tools.querySelectorAll('[data-tool]').forEach((x) => x.setAttribute('aria-selected', x.dataset.tool === tool));
  dlg.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tool; });
  sync(); draw();
}

// ------------------------------------------------------------- edit state
/** Recompute a tab's working canvases from its op list. */
function rebuild(tab) {
  const n = tab.ops.length;
  const lastWarp = n && tab.ops[n - 1].t === 'warp';
  if (lastWarp) {
    tab.base = applyOps(tab.img, tab.w, tab.h, tab.ops, n - 1);
    tab.cur = warpCanvas(tab.base, tab.ops[n - 1], tab.w, tab.h);
    tab.active = n - 1;
  } else {
    tab.cur = applyOps(tab.img, tab.w, tab.h, tab.ops);
    tab.base = null; tab.active = -1;
  }
  if (S) S.frontRef = null;
}
function pushUndo() {
  const t = cur();
  const snap = JSON.stringify({ tab: t.id, ops: t.ops, T: t.T });
  if (S.undo[S.undo.length - 1] === snap) return;
  S.undo.push(snap);
  if (S.undo.length > 80) S.undo.shift();
  els.undo.disabled = false;
}
function undo() {
  const snap = S.undo.pop();
  els.undo.disabled = !S.undo.length;
  if (!snap) return;
  const d = JSON.parse(snap), t = S.tabs[d.tab];
  t.ops = d.ops; t.T = d.T; rebuild(t);
  if (S.tab !== d.tab) setTab(d.tab); else { sync(); draw(); }
  live();
}
/** Run a mutation with undo, redraw and live preview. */
function change(fn) { pushUndo(); fn(); sync(); draw(); live(); }

function generatePoints() {
  const t = cur();
  const n = Math.min(64, Math.max(3, Math.round(+els.n.value) || 12));
  els.n.value = n;
  const pts = outlinePoints(t.cur, t.w, t.h, n);
  if (!pts.length) { els.warpInfo.textContent = '找不到輪廓（圖片是空的？）'; return; }
  pushUndo();
  // an untouched previous layer is simply replaced
  if (t.active >= 0 && !warpMoved(t.ops[t.active])) t.ops.pop();
  t.ops.push({ t: 'warp', src: pts, dst: pts.slice() });
  t.base = cloneCanvas(t.cur); t.active = t.ops.length - 1;
  sync(); draw();
}

function cleanOps(ops) {
  return ops.filter((o) => o.t === 'erase' || warpMoved(o)).map((o) => (o.t === 'erase'
    ? { t: 'erase', r: r4(o.r), pts: o.pts.map(r4) }
    : { t: 'warp', src: o.src.map(r4), dst: o.dst.map(r4) }));
}
function payload() {
  const out = { align: {}, edits: {} };
  for (const t of Object.values(S.tabs)) {
    out.edits[t.id] = cleanOps(t.ops);
    if (t.id !== 'front') {
      const T = t.mirror ? flipT(t.T) : t.T;
      out.align[t.id] = { dx: r4(T.dx), dy: r4(T.dy), sx: r4(T.sx), sy: r4(T.sy), rot: r4(T.rot) };
    }
  }
  return out;
}
function live() {
  if (!S.onLive) return;
  clearTimeout(S.liveTimer);
  S.liveTimer = setTimeout(() => { if (S && !S.drag) S.onLive(payload()); }, 350);
}

// ------------------------------------------------------------- layout
/** The front as the other views will see it: edited and cropped to its outline. */
function frontRef() {
  if (S.frontRef) return S.frontRef;
  const f = S.tabs.front;
  const p = padOf(f.w, f.h);
  let box = { x: p, y: p, w: f.w, h: f.h };
  if (hasEdits(f.ops)) {
    const d = f.cur.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, f.cur.width, f.cur.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < f.cur.height; y++) for (let x = 0; x < f.cur.width; x++) if (d[(y * f.cur.width + x) * 4 + 3] >= 128) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 >= 0) box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  return (S.frontRef = { canvas: f.cur, box });
}

function layout() {
  const W = els.stage.clientWidth, H = els.stage.clientHeight;
  const m = 34, t = cur(), tab = S.tab;
  const L = { W, H };
  if (tab === 'front') {
    // leave the working margin visible so points can be pulled outwards
    const a = t.w / t.h, k = 1 + PAD * 1.2;
    let h = (H - m * 2) / k, w = h * a;
    if (w * k > W - m * 2) { w = (W - m * 2) / k; h = w / a; }
    L.frame = { x: (W - w) / 2, y: (H - h) / 2, w, h };
    return L;
  }
  const ref = frontRef(), fa = ref.box.w / ref.box.h;
  if (tab === 'back') {
    let h = (H - m * 2) / 1.15, w = h * fa;
    if (w > (W - m * 2) / 1.15) { w = (W - m * 2) / 1.15; h = w / fa; }
    L.ref = { x: (W - w) / 2, y: (H - h) / 2, w, h };
    L.frame = { ...L.ref };
  } else if (tab === 'side') {
    const sa = t.w / t.h, gap = 40;
    let h = (H - m * 2) / 1.1, total = h * (fa + sa * 1.25) + gap;
    if (total > W - m * 2) { h = (W - m * 2 - gap) / (fa + sa * 1.25); total = h * (fa + sa * 1.25) + gap; }
    const x0 = (W - total) / 2, y0 = (H - h) / 2;
    L.ref = { x: x0, y: y0, w: h * fa, h };
    L.frame = { x: x0 + h * fa + gap + h * sa * 0.125, y: y0, w: h * sa, h };
  } else {
    const ta = t.h / t.w, gap = 34; // frame height per unit width
    let w = (W - m * 2) / 1.1, total = w / fa + w * ta * 1.25 + gap;
    if (total > H - m * 2) { w = (H - m * 2 - gap) / (1 / fa + ta * 1.25); total = w / fa + w * ta * 1.25 + gap; }
    const x0 = (W - w) / 2, y0 = (H - total) / 2;
    L.ref = { x: x0, y: y0, w, h: w / fa };
    L.frame = { x: x0, y: y0 + w / fa + gap + w * ta * 0.125, w, h: w * ta };
  }
  return L;
}

/** Centre / axes of the (moved, scaled, rotated) frame on screen. */
function geom(F, T) {
  const cx = F.x + F.w * (0.5 + T.dx), cy = F.y + F.h * (0.5 + T.dy);
  const r = (T.rot * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return { cx, cy, cos, sin, hw: F.w * T.sx / 2, hh: F.h * T.sy / 2 };
}
/** frame fraction (u, v) → screen */
function toScreen(L, t, u, v) {
  const g = geom(L.frame, t.T);
  const lx = ((t.mirror ? 1 - u : u) - 0.5) * L.frame.w * t.T.sx, ly = (v - 0.5) * L.frame.h * t.T.sy;
  return [g.cx + lx * g.cos - ly * g.sin, g.cy + lx * g.sin + ly * g.cos];
}
/** screen → frame fraction (u, v) */
function fromScreen(L, t, x, y) {
  const g = geom(L.frame, t.T);
  const dx = x - g.cx, dy = y - g.cy;
  const lx = (dx * g.cos + dy * g.sin) / (L.frame.w * t.T.sx) + 0.5, ly = (-dx * g.sin + dy * g.cos) / (L.frame.h * t.T.sy) + 0.5;
  return [t.mirror ? 1 - lx : lx, ly];
}
function boxHandles(L, t) {
  const g = geom(L.frame, t.T);
  const pt = (lx, ly) => [g.cx + lx * g.cos - ly * g.sin, g.cy + lx * g.sin + ly * g.cos];
  const handles = [];
  for (const [hx, hy] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) handles.push({ hx, hy, p: pt(hx * g.hw, hy * g.hh) });
  return { ...g, handles, corners: [pt(-g.hw, -g.hh), pt(g.hw, -g.hh), pt(g.hw, g.hh), pt(-g.hw, g.hh)] };
}

// ------------------------------------------------------------- drawing
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }

function drawImageOf(ctx, L, t) {
  const g = geom(L.frame, t.T), p = padOf(t.w, t.h);
  const W = L.frame.w * (t.cur.width / t.w), H = L.frame.h * (t.cur.height / t.h);
  ctx.save();
  ctx.translate(g.cx, g.cy); ctx.rotate((t.T.rot * Math.PI) / 180); ctx.scale(t.T.sx * (t.mirror ? -1 : 1), t.T.sy);
  ctx.drawImage(t.cur, -W / 2, -H / 2, W, H);
  ctx.restore();
  return p;
}

function draw() {
  if (!S || !dlg.open) return;
  const c = els.canvas, dpr = Math.min(devicePixelRatio || 1, 2);
  const W = els.stage.clientWidth, H = els.stage.clientHeight;
  if (!W || !H) return;
  c.width = W * dpr; c.height = H * dpr; c.style.width = W + 'px'; c.style.height = H + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const L = layout(), tab = S.tab, t = cur();
  const accent = css('--accent'), muted = css('--muted'), surface = css('--surface');
  const F = L.frame;

  if (tab !== 'front') {
    const ref = frontRef();
    ctx.drawImage(ref.canvas, ref.box.x, ref.box.y, ref.box.w, ref.box.h, L.ref.x, L.ref.y, L.ref.w, L.ref.h);
    label(ctx, '正面（基準）', L.ref.x, L.ref.y - 8, muted);
  }
  // the editable picture
  if (tab === 'back') {
    ctx.save();
    if (els.diff.checked && S.tool === 'move') ctx.globalCompositeOperation = 'difference';
    ctx.globalAlpha = S.tool === 'move' ? (els.diff.checked ? 1 : parseFloat(els.op.value)) : 0.85;
    drawImageOf(ctx, L, t);
    ctx.restore();
  } else drawImageOf(ctx, L, t);

  // what gets cut away (the part outside the directions locked to the front)
  ctx.save(); ctx.fillStyle = surface; ctx.globalAlpha = 0.78;
  if (tab === 'side' || tab === 'back') { ctx.fillRect(0, 0, W, F.y); ctx.fillRect(0, F.y + F.h, W, H - F.y - F.h); }
  if (tab === 'top' || tab === 'back') { ctx.fillRect(0, 0, F.x, H); ctx.fillRect(F.x + F.w, 0, W - F.x - F.w, H); }
  ctx.restore();

  // frame + guides
  ctx.save(); ctx.strokeStyle = muted; ctx.setLineDash([4, 4]);
  if (tab === 'side') { line(ctx, 0, F.y, W, F.y); line(ctx, 0, F.y + F.h, W, F.y + F.h); }
  else if (tab === 'top') { line(ctx, F.x, 0, F.x, H); line(ctx, F.x + F.w, 0, F.x + F.w, H); }
  else ctx.strokeRect(F.x + 0.5, F.y + 0.5, F.w, F.h);
  ctx.restore();
  if (tab === 'side' || tab === 'top') {
    label(ctx, tab === 'side' ? '側面（面朝右）' : '頂部（正面朝下）', F.x, F.y - 8, muted);
    ctx.save(); ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.setLineDash([6, 5]);
    if (tab === 'side') for (const g of S.guides.side) { const y = L.ref.y + L.ref.h * g; line(ctx, 0, y, W, y); }
    else for (const g of S.guides.top) { const x = L.ref.x + L.ref.w * g; line(ctx, x, 0, x, H); }
    ctx.restore();
  }

  if (S.tool === 'move' && tab !== 'front') {
    const g = boxHandles(L, t);
    ctx.save(); ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); g.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
    for (const h of g.handles) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.rect(h.p[0] - 5, h.p[1] - 5, 10, 10); ctx.fill(); ctx.stroke(); }
    ctx.restore();
  } else if (S.tool === 'warp' && t.active >= 0) {
    const op = t.ops[t.active], n = op.dst.length / 2;
    ctx.save();
    for (let i = 0; i < n; i++) {
      const a = toScreen(L, t, op.src[i * 2], op.src[i * 2 + 1]), b = toScreen(L, t, op.dst[i * 2], op.dst[i * 2 + 1]);
      const moved = Math.hypot(a[0] - b[0], a[1] - b[1]) > 1;
      if (moved) { ctx.strokeStyle = accent; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.5; line(ctx, a[0], a[1], b[0], b[1]); ctx.globalAlpha = 1; }
      const hot = S.hover === i || (S.drag && S.drag.kind === 'point' && S.drag.i === i);
      ctx.beginPath(); ctx.arc(b[0], b[1], hot ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = moved ? accent : '#fff'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = moved ? '#fff' : accent; ctx.stroke();
    }
    ctx.restore();
  } else if (S.tool === 'erase' && S.mouse) {
    const r = eraserScreenRadius(L, t);
    ctx.save(); ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(S.mouse[0], S.mouse[1], r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
}
const eraserScreenRadius = (L, t) => parseFloat(els.er.value) * Math.max(L.frame.w * t.T.sx, L.frame.h * t.T.sy);
function label(ctx, text, x, y, color) { ctx.save(); ctx.fillStyle = color; ctx.font = '12px system-ui, sans-serif'; ctx.fillText(text, x, y); ctx.restore(); }
function line(ctx, a, b, c, d) { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); }

function sync(except) {
  const tabDef = TABS.find((t) => t.id === S.tab), t = cur();
  els.help.textContent = S.tool === 'move' ? tabDef.help : (S.tab === 'front' ? tabDef.help + ' ' : '') + TOOL_HELP[S.tool];
  els.overlay.hidden = S.tab !== 'back';
  els.auto.hidden = S.tab !== 'back';
  const T = t.T;
  const vals = { dx: (T.dx * 100).toFixed(1), dy: (T.dy * 100).toFixed(1), sx: Math.round(T.sx * 100), sy: Math.round(T.sy * 100), rot: T.rot };
  dlg.querySelectorAll('[data-k]').forEach((inp) => { if (inp !== except) inp.value = vals[inp.dataset.k]; });
  dlg.querySelector('[data-o="rot"]').textContent = `${(+T.rot).toFixed(1)}°`;
  dlg.querySelector('[data-o="op"]').textContent = `${Math.round(els.op.value * 100)}%`;
  dlg.querySelector('[data-o="er"]').textContent = `${Math.round(els.er.value * 100)}%`;
  const layers = t.ops.filter((o) => o.t === 'warp' && warpMoved(o)).length, strokes = t.ops.filter((o) => o.t === 'erase').length;
  els.warpInfo.textContent = t.active >= 0
    ? `輪廓上有 ${t.ops[t.active].dst.length / 2} 個點，拖曳它們來變形。${layers > 1 ? `（已累積 ${layers} 層變形）` : ''}`
    : (layers ? `已套用 ${layers} 層變形。按「生成變形點」可在目前結果上繼續修。` : '尚未生成變形點。');
  // mark edited tabs
  els.tabs.querySelectorAll('[data-tab]').forEach((b) => {
    const tb = S.tabs[b.dataset.tab];
    b.classList.toggle('edited', !!tb && (hasEdits(tb.ops) || (tb.id !== 'front' && JSON.stringify(tb.T) !== JSON.stringify(clone()))));
  });
  els.undo.disabled = !S.undo.length;
  dlg.querySelector('[data-reset-erase]').disabled = !strokes;
  dlg.querySelector('[data-reset-warp]').disabled = !t.ops.some((o) => o.t === 'warp');
}

// ------------------------------------------------------------- pointer
function bindPointer() {
  const c = els.canvas;
  const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const nearestPoint = (L, t, x, y) => {
    if (t.active < 0) return -1;
    const d = t.ops[t.active].dst;
    let best = -1, bd = 14;
    for (let i = 0; i < d.length / 2; i++) { const p = toScreen(L, t, d[i * 2], d[i * 2 + 1]); const dist = Math.hypot(p[0] - x, p[1] - y); if (dist < bd) { bd = dist; best = i; } }
    return best;
  };
  c.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [x, y] = pos(e), L = layout(), t = cur();
    if (S.tool === 'move' && S.tab !== 'front') {
      const g = boxHandles(L, t);
      const h = g.handles.find((hh) => Math.abs(hh.p[0] - x) <= 9 && Math.abs(hh.p[1] - y) <= 9);
      if (h) S.drag = { kind: 'scale', h, T0: { ...t.T }, L };
      else if (inside(g, x, y)) S.drag = { kind: 'move', x, y, T0: { ...t.T }, L };
      else { const gi = guideHit(L, x, y); if (gi >= 0) S.drag = { kind: 'guide', gi, L }; }
      if (S.drag && S.drag.kind !== 'guide') pushUndo();
    } else if (S.tool === 'warp') {
      const i = nearestPoint(L, t, x, y);
      if (i >= 0) { pushUndo(); S.drag = { kind: 'point', i, L }; }
    } else if (S.tool === 'erase') {
      pushUndo();
      const [u, v] = fromScreen(L, t, x, y);
      const m = Math.max(L.frame.w * t.T.sx, L.frame.h * t.T.sy);
      const op = { t: 'erase', r: eraserScreenRadius(L, t) / m, pts: [u, v] };
      t.ops.push(op); t.active = -1; t.base = null;
      eraseStroke(t.cur, op, t.w, t.h);
      S.drag = { kind: 'erase', op, L, last: [x, y] };
      S.frontRef = null;
    }
    if (S.drag) { c.setPointerCapture(e.pointerId); e.preventDefault(); draw(); }
  });
  c.addEventListener('pointermove', (e) => {
    const [x, y] = pos(e);
    S.mouse = [x, y];
    const d = S.drag, t = cur();
    if (!d) {
      const L = layout();
      if (S.tool === 'warp') { const h = nearestPoint(L, t, x, y); if (h !== S.hover) { S.hover = h; draw(); } c.style.cursor = h >= 0 ? 'grab' : 'default'; }
      else if (S.tool === 'erase') { c.style.cursor = 'none'; draw(); }
      else setCursor(L, x, y);
      return;
    }
    const F = d.L.frame, T = t.T;
    if (d.kind === 'move') {
      T.dx = d.T0.dx + (x - d.x) / F.w; T.dy = d.T0.dy + (y - d.y) / F.h;
    } else if (d.kind === 'scale') {
      const g = geom(F, d.T0);
      const lx = (x - g.cx) * g.cos + (y - g.cy) * g.sin, ly = -(x - g.cx) * g.sin + (y - g.cy) * g.cos;
      let sx = d.h.hx ? Math.abs(lx) * 2 / F.w : d.T0.sx, sy = d.h.hy ? Math.abs(ly) * 2 / F.h : d.T0.sy;
      if (e.shiftKey || els.lock.checked) {
        const f = d.h.hx && d.h.hy ? (sx / d.T0.sx + sy / d.T0.sy) / 2 : d.h.hx ? sx / d.T0.sx : sy / d.T0.sy;
        sx = d.T0.sx * f; sy = d.T0.sy * f;
      }
      T.sx = Math.min(4, Math.max(0.2, sx)); T.sy = Math.min(4, Math.max(0.2, sy));
    } else if (d.kind === 'guide') {
      const R = d.L.ref;
      if (S.tab === 'side') S.guides.side[d.gi] = Math.min(1.2, Math.max(-0.2, (y - R.y) / R.h));
      else S.guides.top[d.gi] = Math.min(1.2, Math.max(-0.2, (x - R.x) / R.w));
    } else if (d.kind === 'point') {
      const op = t.ops[t.active];
      const [u, v] = fromScreen(d.L, t, x, y);
      op.dst[d.i * 2] = Math.min(1 + PAD * 0.9, Math.max(-PAD * 0.9, u));
      op.dst[d.i * 2 + 1] = Math.min(1 + PAD * 0.9, Math.max(-PAD * 0.9, v));
      t.cur = warpCanvas(t.base, op, t.w, t.h);
      S.frontRef = null;
      c.style.cursor = 'grabbing';
    } else if (d.kind === 'erase') {
      if (Math.hypot(x - d.last[0], y - d.last[1]) < 2) return;
      const [u, v] = fromScreen(d.L, t, x, y);
      d.op.pts.push(u, v);
      eraseStroke(t.cur, d.op, t.w, t.h, d.op.pts.length / 2 - 2);
      d.last = [x, y];
    }
    sync(); draw();
  });
  const end = () => {
    if (!S || !S.drag) return;
    const kind = S.drag.kind;
    S.drag = null;
    if (kind !== 'guide') { sync(); draw(); live(); }
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('pointerleave', () => { if (S) { S.mouse = null; if (S.tool === 'erase') draw(); } });
  c.addEventListener('wheel', (e) => {
    if (!S || S.tool !== 'move' || S.tab === 'front') return;
    e.preventDefault();
    pushUndo();
    const T = cur().T, f = e.deltaY < 0 ? 1.02 : 1 / 1.02;
    T.sx = Math.min(4, Math.max(0.2, T.sx * f)); T.sy = Math.min(4, Math.max(0.2, T.sy * f));
    sync(); draw(); live();
  }, { passive: false });
}
function inside(g, x, y) {
  const lx = (x - g.cx) * g.cos + (y - g.cy) * g.sin, ly = -(x - g.cx) * g.sin + (y - g.cy) * g.cos;
  return Math.abs(lx) <= g.hw && Math.abs(ly) <= g.hh;
}
function guideHit(L, x, y) {
  if (S.tab === 'side') return S.guides.side.findIndex((g) => Math.abs(L.ref.y + L.ref.h * g - y) < 6);
  if (S.tab === 'top') return S.guides.top.findIndex((g) => Math.abs(L.ref.x + L.ref.w * g - x) < 6);
  return -1;
}
function setCursor(L, x, y) {
  let c = 'default';
  if (S.tab !== 'front') {
    const g = boxHandles(L, cur());
    const h = g.handles.find((hh) => Math.abs(hh.p[0] - x) <= 9 && Math.abs(hh.p[1] - y) <= 9);
    if (h) c = h.hx && h.hy ? (h.hx === h.hy ? 'nwse-resize' : 'nesw-resize') : h.hx ? 'ew-resize' : 'ns-resize';
    else if (inside(g, x, y)) c = 'move';
    else if (guideHit(L, x, y) >= 0) c = S.tab === 'side' ? 'row-resize' : 'col-resize';
  }
  els.canvas.style.cursor = c;
}
function onKey(e) {
  if (!S) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.target.tagName === 'INPUT') return;
  if (S.tool !== 'move' || S.tab === 'front') return;
  const step = e.shiftKey ? 10 : 1;
  const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const m = map[e.key];
  if (!m) return;
  e.preventDefault();
  const L = layout();
  change(() => { const T = cur().T; T.dx += (m[0] * step) / L.frame.w; T.dy += (m[1] * step) / L.frame.h; });
}

// drag on the 3D preview to turn it
function bindPreviewDrag() {
  const c = els.preview;
  let down = null;
  c.addEventListener('pointerdown', (e) => { down = { x: e.clientX, a: S.angle ?? 0 }; c.setPointerCapture(e.pointerId); });
  c.addEventListener('pointermove', (e) => { if (down && S) S.angle = down.a + (e.clientX - down.x) * 0.015; });
  const up = () => { down = null; };
  c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
}

// ------------------------------------------------------------- auto align
/** n × n mask of what currently sits in a tab's frame (edits applied, no move). */
function frameMask(t, n) {
  const c = makeCanvas(n, n), ctx = c.getContext('2d', { willReadFrequently: true });
  const p = padOf(t.w, t.h);
  if (t.mirror) { ctx.translate(n, 0); ctx.scale(-1, 1); }
  ctx.drawImage(t.cur, p, p, t.w, t.h, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data, m = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) m[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  return m;
}
/** Grid-search translation + scale that maximises silhouette overlap (IoU). */
function autoAlignBack() {
  const t = S.tabs.back;
  if (!t) return;
  const n = 64, ref = frontRef();
  const fc = makeCanvas(n, n), fctx = fc.getContext('2d', { willReadFrequently: true });
  fctx.drawImage(ref.canvas, ref.box.x, ref.box.y, ref.box.w, ref.box.h, 0, 0, n, n);
  const fd = fctx.getImageData(0, 0, n, n).data, A = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) A[i] = fd[i * 4 + 3] >= 128 ? 1 : 0;
  const Bm = frameMask(t, n);
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

// used by tests
export const _debug = { get state() { return S; }, layout, toScreen, payload: () => payload() };
// (toPadded is re-exported for callers that only need the padding convention)
export { toPadded };
