// ---------------------------------------------------------------------------
// main.js — application shell: state, UI, viewport, export flow.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SLOTS, SLOT_BY_ID, VIEWS, defaultParams, icon } from './slots.js';
import { processView, fileToDataURL } from './imageproc.js';
import { convertPart, MODES, QUALITY, resolveMode } from './converter.js';
import { buildCharacter, makeMaterial } from './character.js';
import * as EX from './exporter.js';
import { characterSamples, objectSample } from './samples.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ============================================================== state
const state = {
  mode: 'character',
  settings: { name: 'MyHero', colors: { skin: '#ffd9bf', shirt: '#6c8cff', pants: '#3a3f58' }, quality: 'medium', atlas: 1024 },
  slots: {},
  anim: 'Idle',
  selected: null,
};
for (const s of SLOTS) state.slots[s.id] = freshSlot(s);

function freshSlot(slot) {
  return { views: { front: null, side: null, back: null, top: null }, params: defaultParams(slot), part: null, status: 'empty', info: '', open: false };
}

// ============================================================== viewport
const vp = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
vp.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
camera.position.set(3.2, 2.6, 7.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1.5, 0);
controls.minDistance = 1; controls.maxDistance = 40;

scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa3b8, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(3, 7, 5); sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 6, bottom: -2, near: 0.5, far: 20 });
scene.add(sun);
const rim = new THREE.DirectionalLight(0xc8d4ff, 0.6); rim.position.set(-4, 3, -5); scene.add(rim);
const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.ShadowMaterial({ opacity: 0.18 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(12, 24, 0x8890a6, 0x8890a6);
grid.material.transparent = true; grid.material.opacity = 0.18; scene.add(grid);

let current = null; // { root, clips, sockets, pickable, height }
let mixer = null;
const view = { wire: false, sockets: false, spin: false };

function resize() {
  const w = vp.clientWidth, h = vp.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(vp);
resize();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (mixer) mixer.update(dt);
  if (view.spin && current) current.root.rotation.y += dt * 0.6;
  controls.update();
  renderer.render(scene, camera);
});

function frame() {
  if (!current) return;
  const box = new THREE.Box3().setFromObject(current.root);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.y, size.x * 1.2, size.z) * 0.5;
  const dist = r / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.3 / Math.min(1, camera.aspect * 1.1);
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0.38, 0.22, 1).normalize().multiplyScalar(dist));
  camera.updateProjectionMatrix();
}

// picking: click on a part selects its card
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || !current) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(p, camera);
  const hit = ray.intersectObjects(current.pickable, false)[0];
  if (hit) selectSlot(hit.object.userData.slot, true);
});

// ============================================================== status / toast
let busyCount = 0;
function setBusy(delta, text) {
  busyCount = Math.max(0, busyCount + delta);
  $('#statusPill').classList.toggle('busy', busyCount > 0);
  if (text) $('#statusText').textContent = text;
  else if (!busyCount) $('#statusText').textContent = statsText();
}
function statsText() {
  if (!current) return '準備就緒';
  let tris = 0, meshes = 0;
  current.root.traverse((o) => {
    if (!o.isMesh || o.userData.helper) return;
    meshes++;
    const g = o.geometry; tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  const converted = activeSlots().filter((s) => state.slots[s.id].part).length;
  return `${converted} 個部位已轉換 · ${meshes} 網格 · ${Math.round(tris).toLocaleString()} 三角形`;
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ============================================================== conversion
const activeSlots = () => SLOTS.filter((s) => (state.mode === 'object' ? s.group === 'prop' : s.group !== 'prop'));

async function ensureProcessed(slotState) {
  const p = slotState.params;
  const out = {};
  for (const v of VIEWS) {
    const view = slotState.views[v.id];
    if (!view) continue;
    const key = `${view.flip ? 1 : 0}|${p.removeBg ? 1 : 0}|${p.tolerance}`;
    if (!view.processed || view.key !== key) {
      view.processed = await processView(view.src, { removeBg: p.removeBg, tolerance: p.tolerance, flipX: !!view.flip });
      view.key = key;
    }
    out[v.id] = view.processed;
  }
  return out;
}

const pending = new Map();
function scheduleConvert(id, delay = 140) {
  clearTimeout(pending.get(id));
  pending.set(id, setTimeout(() => { pending.delete(id); convertSlot(id); }, delay));
}

const convertSeq = {};
async function convertSlot(id) {
  const slot = SLOT_BY_ID[id], st = state.slots[id];
  const seq = (convertSeq[id] = (convertSeq[id] || 0) + 1);
  if (!st.views.front) {
    disposePart(st.part); st.part = null;
    st.status = 'empty'; st.info = st.views.side || st.views.back || st.views.top ? '請先上傳「正面」圖' : '';
    updateCard(id); assemble();
    return;
  }
  st.status = 'busy'; updateCard(id);
  setBusy(+1, `轉換「${slot.name}」中…`);
  await new Promise((r) => setTimeout(r, 16)); // let the UI paint
  try {
    const views = await ensureProcessed(st);
    if (seq !== convertSeq[id]) return;
    const t0 = performance.now();
    const res = convertPart(views, st.params, {
      resolution: QUALITY[state.settings.quality], atlasSize: state.settings.atlas, slotDefault: slot.mode,
    });
    res.name = slot.en.replace(/\W+/g, '');
    const material = makeMaterial(res);
    disposePart(st.part);
    st.part = { geometry: res.geometry, material, atlas: res.atlas, params: st.params, slot, mode: res.mode };
    st.status = 'ok';
    st.info = `${res.info} · ${Math.round(performance.now() - t0)} ms`;
  } catch (err) {
    console.error(err);
    st.status = 'err'; st.info = err.message || String(err);
  } finally {
    setBusy(-1);
  }
  if (seq !== convertSeq[id]) return;
  updateCard(id);
  assemble();
}

function disposePart(part) {
  if (!part) return;
  part.geometry.dispose();
  if (part.material.map) part.material.map.dispose();
  part.material.dispose();
}

function partsMap() {
  const m = {};
  for (const s of activeSlots()) {
    const st = state.slots[s.id];
    if (st.part) m[s.id] = { ...st.part, params: st.params };
  }
  return m;
}

function assemble({ keepCamera = true } = {}) {
  const first = !current;
  const keep = new Set();
  for (const s of SLOTS) { const p = state.slots[s.id].part; if (p) { keep.add(p.geometry); keep.add(p.material); } }
  if (current) {
    scene.remove(current.root);
    current.root.traverse((o) => {
      if (!o.isMesh) return;
      if (!keep.has(o.geometry)) o.geometry.dispose();
      if (!keep.has(o.material)) o.material.dispose();
    });
  }
  if (mixer) mixer.stopAllAction();
  current = buildCharacter(partsMap(), { ...state.settings, mode: state.mode });
  // socket markers (helpers — removed on export)
  const markerGeo = new THREE.SphereGeometry(0.045, 12, 8);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xff3d71, depthTest: false });
  for (const s of Object.values(current.sockets)) {
    const m = new THREE.Mesh(markerGeo, markerMat);
    m.userData.helper = true; m.renderOrder = 10; m.visible = view.sockets; m.name = 'helper';
    s.add(m);
  }
  applyWire();
  scene.add(current.root);
  mixer = new THREE.AnimationMixer(current.root);
  renderAnimBar();
  playAnim(state.anim);
  if (first || !keepCamera) frame();
  if (!busyCount) setBusy(0);
}

function applyWire() {
  if (!current) return;
  current.root.traverse((o) => { if (o.isMesh && !o.userData.helper) o.material.wireframe = view.wire; });
}

// ============================================================== animation bar
function renderAnimBar() {
  const bar = $('#animBar');
  const names = ['Rest', ...current.clips.map((c) => c.name)];
  if (!names.includes(state.anim)) state.anim = state.mode === 'object' ? 'Rest' : 'Idle';
  const label = { Rest: '靜止', Idle: '待機', Walk: '走路', Run: '跑步', Jump: '跳躍', Wave: '揮手', Spin: '旋轉展示' };
  const sig = names.join();
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    bar.innerHTML = names.map((n) => `<button class="tbtn" data-anim="${n}">${label[n] || n}</button>`).join('');
  }
  $$('[data-anim]', bar).forEach((b) => b.setAttribute('aria-pressed', b.dataset.anim === state.anim));
}
$('#animBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-anim]'); if (!b) return;
  playAnim(b.dataset.anim);
  renderAnimBar();
});
function playAnim(name) {
  state.anim = name;
  if (!mixer || !current) return;
  mixer.stopAllAction();
  const clip = current.clips.find((c) => c.name === name);
  if (clip) mixer.clipAction(clip).play();
}

// ============================================================== toolbar
function toggleBtn(id, key, after) {
  const b = $(id);
  b.addEventListener('click', () => {
    view[key] = !view[key]; b.setAttribute('aria-pressed', view[key]);
    after && after();
  });
}
toggleBtn('#tWire', 'wire', applyWire);
toggleBtn('#tSockets', 'sockets', () => current && current.root.traverse((o) => { if (o.userData.helper) o.visible = view.sockets; }));
toggleBtn('#tSpin', 'spin', () => { if (!view.spin && current) current.root.rotation.y = 0; });
$('#tView').addEventListener('click', () => { if (current) current.root.rotation.y = 0; frame(); });

// ============================================================== slot cards
const ranges = [
  ['depth', '厚度 / 深度', 0.1, 3, 0.05],
  ['roundness', '圓潤度', 0, 1, 0.05],
  ['smooth', '表面平滑', 0, 6, 1],
  ['size', '大小', 0.3, 2.5, 0.05],
];

function renderSlots() {
  const wrap = $('#slotGroups');
  const groups = state.mode === 'object'
    ? [['prop', '物件', '單一物件轉 3D']]
    : [['body', '身體（三頭身）', '頭 · 胸 · 腳'], ['acc', '配件', '各自獨立上傳']];
  wrap.innerHTML = groups.map(([g, title, sub]) => `
    <div class="group-title"><span>${title}</span><small>${sub}</small></div>
    ${SLOTS.filter((s) => s.group === g).map(cardHTML).join('')}
  `).join('');
  for (const s of SLOTS.filter((x) => groups.some(([g]) => g === x.group))) bindCard(s.id);
}

function cardHTML(s) {
  const st = state.slots[s.id], p = st.params;
  const modeOpts = Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${p.mode === k ? 'selected' : ''}>${k === 'auto' ? `${v}（預設：${MODES[s.mode].split(' ')[0]}）` : v}</option>`).join('');
  return `
  <section class="card slot ${st.open ? 'open' : ''}" data-slot="${s.id}">
    <button class="card-head" data-toggle>
      <span class="ico">${icon(s.icon)}</span>
      <span class="title">${s.name}<small>${s.en}</small></span>
      <span class="badge"></span>
      <span class="chev"></span>
    </button>
    <div class="card-body">
      <p class="hint">${s.hint}</p>
      <div class="views">
        ${VIEWS.map((v) => `
          <label class="drop" data-view="${v.id}" title="${v.tip}">
            <input type="file" accept="image/*">
            <img alt="" hidden>
            <span class="lbl"><b>${v.name}${v.required ? ' *' : ''}</b><i>${v.required ? '點擊或拖放' : '選填'}</i></span>
            <button type="button" class="mini flip" title="水平翻轉" aria-pressed="false">⇋</button>
            <button type="button" class="mini x" title="移除">✕</button>
          </label>`).join('')}
      </div>
      <div class="info"></div>
      <div class="ctrls">
        <label class="field full"><span>轉換方式</span><select data-p="mode">${modeOpts}</select></label>
        ${ranges.map(([k, label, min, max, step]) => `
          <label class="field"><span>${label}<output>${p[k]}</output></span>
          <input type="range" data-p="${k}" min="${min}" max="${max}" step="${step}" value="${p[k]}"></label>`).join('')}
        <label class="field full"><span>背面（沒有背面圖時）</span>
          <select data-p="backFill">
            <option value="mirror" ${p.backFill === 'mirror' ? 'selected' : ''}>沿用正面圖案（對稱物件）</option>
            <option value="color" ${p.backFill === 'color' ? 'selected' : ''}>以頂部主色填補（頭髮、背面單色）</option>
          </select></label>
        <details class="adv">
          <summary>進階：去背、位置、旋轉</summary>
          <div class="ctrls">
            <label class="field check"><input type="checkbox" data-p="removeBg" ${p.removeBg ? 'checked' : ''}><span>自動去背</span></label>
            <label class="field check"><input type="checkbox" data-p="visible" ${p.visible ? 'checked' : ''}><span>顯示此部位</span></label>
            <label class="field full"><span>去背容差<output>${p.tolerance}</output></span><input type="range" data-p="tolerance" min="0" max="100" step="1" value="${p.tolerance}"></label>
            <div class="field full"><span>位置偏移 X / Y / Z（頭身單位）</span>
              <div class="vec">${[0, 1, 2].map((i) => `<input type="number" step="0.05" data-vec="offset" data-i="${i}" value="${p.offset[i]}">`).join('')}</div></div>
            <div class="field full"><span>旋轉 X / Y / Z（度）</span>
              <div class="vec">${[0, 1, 2].map((i) => `<input type="number" step="5" data-vec="rotation" data-i="${i}" value="${p.rotation[i]}">`).join('')}</div></div>
            ${s.id === 'legs' ? `<label class="field check full"><input type="checkbox" data-p="splitLegs" ${p.splitLegs ? 'checked' : ''}><span>左右腿分開（走路動畫各自擺動）</span></label>` : ''}
          </div>
        </details>
      </div>
      <div class="slot-actions">
        <button type="button" class="btn" data-act="export">單獨匯出 GLB</button>
        <button type="button" class="btn" data-act="clear">清除此部位</button>
      </div>
    </div>
  </section>`;
}

function bindCard(id) {
  const card = $(`.card[data-slot="${id}"]`);
  const st = state.slots[id];
  $('[data-toggle]', card).addEventListener('click', () => {
    st.open = !st.open; card.classList.toggle('open', st.open);
    if (st.open) selectSlot(id, false);
  });
  for (const drop of $$('.drop', card)) {
    const vid = drop.dataset.view;
    const input = $('input', drop);
    input.addEventListener('change', () => { if (input.files[0]) setView(id, vid, input.files[0]); input.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('over');
      const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
      if (f) setView(id, vid, f);
    });
    $('.mini.x', drop).addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      st.views[vid] = null; updateCard(id); scheduleConvert(id, 0);
    });
    $('.mini.flip', drop).addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const v = st.views[vid]; if (!v) return;
      v.flip = !v.flip; updateCard(id); scheduleConvert(id, 0);
    });
  }
  for (const el of $$('[data-p]', card)) {
    const key = el.dataset.p;
    const ev = el.type === 'range' ? 'input' : 'change';
    el.addEventListener(ev, () => {
      const p = st.params;
      if (el.type === 'checkbox') p[key] = el.checked;
      else if (el.type === 'range') { p[key] = parseFloat(el.value); const o = el.parentElement.querySelector('output'); if (o) o.textContent = el.value; }
      else p[key] = el.value;
      // placement-only params don't need re-conversion
      if (['size', 'visible', 'splitLegs'].includes(key)) { if (st.part) st.part.params = p; assemble(); }
      else scheduleConvert(id, key === 'tolerance' ? 300 : 140);
    });
  }
  for (const el of $$('[data-vec]', card)) {
    el.addEventListener('input', () => {
      st.params[el.dataset.vec][+el.dataset.i] = parseFloat(el.value) || 0;
      assemble();
    });
  }
  $('[data-act="clear"]', card).addEventListener('click', () => {
    const open = st.open;
    disposePart(st.part);
    state.slots[id] = freshSlot(SLOT_BY_ID[id]); state.slots[id].open = open;
    card.outerHTML = cardHTML(SLOT_BY_ID[id]);
    bindCard(id); updateCard(id); assemble();
  });
  $('[data-act="export"]', card).addEventListener('click', () => exportSinglePart(id));
  updateCard(id);
}

function updateCard(id) {
  const card = $(`.card[data-slot="${id}"]`);
  if (!card) return;
  const st = state.slots[id], s = SLOT_BY_ID[id];
  const badge = $('.badge', card);
  const map = {
    empty: s.group === 'body' ? ['預設', ''] : ['未上傳', ''],
    busy: ['轉換中', 'busy'], ok: [MODES[st.part?.mode || 'inflate'].split(' ')[0], 'ok'], err: ['錯誤', 'err'],
  };
  const [txt, cls] = map[st.status];
  badge.textContent = txt; badge.className = 'badge ' + cls;
  const ico = $('.ico', card);
  if (st.views.front) ico.innerHTML = `<img src="${st.views.front.src}" alt="">`;
  else ico.innerHTML = icon(s.icon);
  for (const drop of $$('.drop', card)) {
    const v = st.views[drop.dataset.view];
    const img = $('img', drop);
    drop.classList.toggle('has', !!v);
    if (v) { img.src = v.src; img.hidden = false; img.style.transform = v.flip ? 'scaleX(-1)' : ''; }
    else { img.hidden = true; img.removeAttribute('src'); }
    $('.mini.flip', drop).setAttribute('aria-pressed', !!(v && v.flip));
  }
  const info = $('.info', card);
  let txt2 = st.info;
  if (st.status === 'ok') {
    const auto = st.params.mode === 'auto';
    const vs = st.views;
    if (auto && !vs.side && !vs.top) txt2 += ' · 提示：加入側面圖可啟用三視圖雕刻';
  }
  info.textContent = txt2;
  info.classList.toggle('err', st.status === 'err');
}

async function setView(id, vid, file) {
  try {
    const src = await fileToDataURL(file);
    state.slots[id].views[vid] = { src, flip: false };
    updateCard(id);
    scheduleConvert(id, 0);
  } catch (e) { toast('讀取圖片失敗：' + e.message); }
}

function selectSlot(id, fromViewport) {
  state.selected = id;
  $$('.card.slot').forEach((c) => c.classList.toggle('selected', c.dataset.slot === id));
  if (fromViewport) {
    const card = $(`.card[data-slot="${id}"]`);
    if (!card) return;
    state.slots[id].open = true; card.classList.add('open');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ============================================================== settings
function bindSettings() {
  const card = $('#settingsCard');
  $('[data-toggle]', card).addEventListener('click', () => card.classList.toggle('open'));
  $('#setName').addEventListener('input', (e) => { state.settings.name = e.target.value; $('#expName').value = e.target.value; });
  for (const [sel, key] of [['#setSkin', 'skin'], ['#setShirt', 'shirt'], ['#setPants', 'pants']]) {
    $(sel).addEventListener('input', (e) => { state.settings.colors[key] = e.target.value; assemble(); });
  }
  $('#setQuality').addEventListener('change', (e) => { state.settings.quality = e.target.value; reconvertAll(); });
  $('#setAtlas').addEventListener('change', (e) => { state.settings.atlas = +e.target.value; reconvertAll(); });
}
function syncSettingsUI() {
  $('#setName').value = state.settings.name; $('#expName').value = state.settings.name;
  $('#setSkin').value = state.settings.colors.skin; $('#setShirt').value = state.settings.colors.shirt; $('#setPants').value = state.settings.colors.pants;
  $('#setQuality').value = state.settings.quality; $('#setAtlas').value = state.settings.atlas;
}
function reconvertAll() {
  for (const s of activeSlots()) if (state.slots[s.id].views.front) scheduleConvert(s.id, 0);
}

// ============================================================== mode tabs
$$('.seg [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(mode) {
  state.mode = mode;
  $$('.seg [data-mode]').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === mode));
  state.anim = mode === 'object' ? 'Rest' : 'Idle';
  if (mode === 'object') state.slots.object.open = true;
  renderSlots();
  assemble({ keepCamera: false });
}

// ============================================================== samples / project
$('#btnSample').addEventListener('click', async () => {
  const set = state.mode === 'object' ? objectSample() : characterSamples();
  for (const [id, views] of Object.entries(set)) {
    for (const v of VIEWS) state.slots[id].views[v.id] = views[v.id] ? { src: views[v.id], flip: false } : null;
  }
  if (state.mode === 'character' && !state.settings.name) state.settings.name = 'MyHero';
  renderSlots();
  await Promise.all(Object.keys(set).map((id) => convertSlot(id)));
  frame();
  toast('已載入範例：試著換成你自己的圖片！');
});

function projectData() {
  const slots = {};
  for (const s of SLOTS) {
    const st = state.slots[s.id];
    const views = {};
    for (const v of VIEWS) if (st.views[v.id]) views[v.id] = { src: st.views[v.id].src, flip: !!st.views[v.id].flip };
    if (Object.keys(views).length || JSON.stringify(st.params) !== JSON.stringify(defaultParams(s))) slots[s.id] = { views, params: st.params };
  }
  return { format: 'char3d-project', version: 1, savedAt: new Date().toISOString(), mode: state.mode, settings: state.settings, slots };
}
$('#btnSave').addEventListener('click', () => {
  const json = JSON.stringify(projectData());
  EX.download(new Blob([json], { type: 'application/json' }), `${safeFile(state.settings.name)}.c3d.json`);
  toast('專案已儲存');
});
$('#btnOpen').addEventListener('click', () => $('#fileProject').click());
$('#fileProject').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { await loadProject(JSON.parse(await f.text())); toast('專案已開啟'); } catch (err) { toast('無法開啟專案：' + err.message); }
});
async function loadProject(data) {
  if (data.format !== 'char3d-project') throw new Error('不是 Char3D 專案檔');
  for (const s of SLOTS) { disposePart(state.slots[s.id].part); state.slots[s.id] = freshSlot(s); }
  state.settings = { ...state.settings, ...data.settings, colors: { ...state.settings.colors, ...(data.settings?.colors || {}) } };
  for (const [id, sd] of Object.entries(data.slots || {})) {
    if (!state.slots[id]) continue;
    const st = state.slots[id];
    st.params = { ...defaultParams(SLOT_BY_ID[id]), ...sd.params };
    for (const v of VIEWS) if (sd.views?.[v.id]) st.views[v.id] = { src: sd.views[v.id].src, flip: !!sd.views[v.id].flip };
  }
  syncSettingsUI();
  state.mode = data.mode === 'object' ? 'object' : 'character';
  $$('.seg [data-mode]').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === state.mode));
  renderSlots();
  assemble({ keepCamera: false });
  await Promise.all(SLOTS.filter((s) => state.slots[s.id].views.front).map((s) => convertSlot(s.id)));
  frame();
}
$('#btnReset').addEventListener('click', () => {
  if (!confirm('確定清除所有上傳的圖片與設定？')) return;
  for (const s of SLOTS) { disposePart(state.slots[s.id].part); state.slots[s.id] = freshSlot(s); }
  renderSlots(); assemble({ keepCamera: false });
});

// ============================================================== export
const safeFile = (n) => (n || 'character').trim().replace(/[\\/:*?"<>|\s]+/g, '_') || 'character';

function renderFormats() {
  const list = $('#formatList');
  list.innerHTML = EX.FORMATS.map((f, i) => `
    <label class="fmt">
      <input type="radio" name="fmt" value="${f.id}" ${i === 0 ? 'checked' : ''}>
      <div class="n">${f.name}${f.badge ? `<em>${f.badge}</em>` : ''}</div>
      <div class="e">.${f.ext}</div>
      <div class="d">${f.desc}</div>
    </label>`).join('');
}
renderFormats();
$('#btnExport').addEventListener('click', () => {
  $('#expHeightLabel').textContent = state.mode === 'object' ? '物件高度（公尺）' : '角色身高（公尺，不含帽子）';
  $('#expName').value = state.settings.name || (state.mode === 'object' ? 'MyProp' : 'MyHero');
  const converted = activeSlots().filter((s) => state.slots[s.id].part).length;
  $('#expInfo').textContent = state.mode === 'object'
    ? (converted ? '將匯出目前的物件。' : '尚未上傳物件圖片。')
    : `目前 ${converted} 個部位使用你的圖片，其餘身體部位使用預設形狀。座標：+Y 向上、正面朝 +Z、原點在腳底。`;
  $('#exportDlg').showModal();
});
$('#btnDoExport').addEventListener('click', async (e) => {
  e.preventDefault();
  const fmt = $('input[name="fmt"]:checked').value;
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '產生中…';
  try {
    await doExport(fmt);
    $('#exportDlg').close();
  } catch (err) {
    console.error(err);
    toast('匯出失敗：' + (err.message || err), 5000);
  } finally {
    btn.disabled = false; btn.textContent = '下載';
  }
});

function freshModel() {
  // rest pose, no wireframe
  const wire = view.wire; view.wire = false; applyWire();
  const built = buildCharacter(partsMap(), { ...state.settings, mode: state.mode, name: $('#expName').value || state.settings.name });
  return { built, restore: () => { view.wire = wire; applyWire(); } };
}

function previewCanvas() {
  const c = document.createElement('canvas');
  const src = renderer.domElement;
  const s = Math.min(src.width, src.height);
  c.width = c.height = 512;
  renderer.render(scene, camera);
  c.getContext('2d').drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, 512, 512);
  return c;
}

function manifestFor(built, heightM, scale, withAnim) {
  const isChar = state.mode === 'character';
  const box = new THREE.Box3().setFromObject(built.root);
  const sockDesc = {
    Socket_Hat: '頭頂（帽子）', Socket_Face: '臉部正前方（眼鏡/面具）', Socket_Back: '背部（翅膀/披風/背包）',
    Socket_Hand_R: '右手（武器）', Socket_Hand_L: '左手（盾牌/道具）', Socket_Waist: '腰部', Socket_Foot_R: '右腳底', Socket_Foot_L: '左腳底',
  };
  const parts = activeSlots().filter((s) => state.slots[s.id].part).map((s) => {
    const st = state.slots[s.id];
    return { slot: s.id, name: s.en, mode: st.part.mode, views: VIEWS.filter((v) => st.views[v.id]).map((v) => v.id) };
  });
  return {
    format: 'char3d-character', version: 1, generator: 'Char3D Converter',
    name: built.root.name, type: isChar ? 'character' : 'object',
    proportions: isChar ? '3-head-tall chibi (head : torso : legs = 1 : 1 : 1)' : undefined,
    units: 'meters', height: heightM, scale, up: '+Y', forward: '+Z', origin: 'feet / bottom-center',
    boundingBox: { min: box.min.clone().multiplyScalar(scale).toArray().map((v) => +v.toFixed(4)), max: box.max.clone().multiplyScalar(scale).toArray().map((v) => +v.toFixed(4)) },
    nodes: isChar ? ['Hips', 'Torso', 'Neck', 'Head', 'Shoulder_R', 'Arm_R', 'Shoulder_L', 'Arm_L', 'Leg_R', 'Leg_L'] : ['Prop'],
    sockets: isChar ? Object.values(built.sockets).map((s) => ({ name: s.name, parent: s.parent?.name, description: sockDesc[s.name] || '' })) : [],
    animations: withAnim ? built.clips.map((c) => ({ name: c.name, duration: +c.duration.toFixed(3), loop: true })) : [],
    parts,
  };
}

async function doExport(fmt) {
  const name = safeFile($('#expName').value);
  const heightM = Math.max(0.01, parseFloat($('#expHeight').value) || 1);
  const withAnim = $('#expAnim').checked;
  if (fmt === 'project') {
    EX.download(new Blob([JSON.stringify(projectData())], { type: 'application/json' }), `${name}.c3d.json`);
    return;
  }
  if (state.mode === 'object' && !state.slots.object.part) throw new Error('請先上傳物件的正面圖');
  const { built, restore } = freshModel();
  try {
    const scale = heightM / built.height;
    const clips = withAnim ? built.clips : [];
    switch (fmt) {
      case 'glb': EX.download(await EX.toGLB(EX.prepareExport(built.root, scale), clips, true), `${name}.glb`); break;
      case 'gltf': EX.download(await EX.toGLB(EX.prepareExport(built.root, scale), clips, false), `${name}.gltf`); break;
      case 'stl': EX.download(EX.toSTL(EX.prepareExport(built.root, scale)), `${name}.stl`); break;
      case 'usdz': EX.download(await EX.toUSDZ(EX.prepareExport(built.root, scale, { flipV: true })), `${name}.usdz`); break;
      case 'obj': {
        const files = await EX.toOBJ(EX.prepareExport(built.root, scale, { flipV: true }), name);
        EX.download(EX.zipFiles(files), `${name}_obj.zip`); break;
      }
      case 'sprites': {
        const isChar = state.mode === 'character';
        const { sheet, meta } = await EX.renderSprites(built.root, built.clips, { frames: isChar && withAnim ? 4 : 1, clipName: 'Walk' });
        const files = { 'spritesheet.png': await EX.canvasToPNG(sheet), 'spritesheet.json': EX.strToU8(JSON.stringify(meta, null, 2)) };
        EX.download(EX.zipFiles(files), `${name}_sprites.zip`); break;
      }
      case 'parts': {
        const list = activeSlots().filter((s) => state.slots[s.id].part).map((s) => ({
          slot: s.id, name: s.en.replace(/\W+/g, ''), geometry: state.slots[s.id].part.geometry, material: state.slots[s.id].part.material,
          socket: { hat: 'Socket_Hat', face: 'Socket_Face', back: 'Socket_Back', handR: 'Socket_Hand_R', handL: 'Socket_Hand_L', waist: 'Socket_Waist', shoes: 'Socket_Foot_R/L' }[s.id] || null,
        }));
        if (!list.length) throw new Error('還沒有任何已轉換的部位');
        EX.download(await EX.buildPartsZip(list, scale), `${name}_parts.zip`); break;
      }
      default: { // package
        const manifest = manifestFor(built, heightM, scale, withAnim);
        const sourceImages = {};
        for (const s of activeSlots()) for (const v of VIEWS) {
          const vv = state.slots[s.id].views[v.id];
          if (vv) sourceImages[`${s.id}_${v.id}`] = vv.src;
        }
        const blob = await EX.buildPackage({
          root: built.root, clips, scale, manifest, projectJSON: JSON.stringify(projectData()),
          previewCanvas: previewCanvas(), sourceImages,
        });
        EX.download(blob, `${name}_game.zip`);
      }
    }
    toast('匯出完成 ✓');
  } finally {
    restore();
  }
}

async function exportSinglePart(id) {
  const st = state.slots[id];
  if (!st.part) { toast('這個部位還沒有轉換結果'); return; }
  const g = new THREE.Group(); g.name = SLOT_BY_ID[id].en.replace(/\W+/g, '');
  const m = new THREE.Mesh(st.part.geometry, st.part.material); m.name = g.name + '_Mesh'; g.add(m);
  const blob = await EX.toGLB(EX.prepareExport(g, 0.35), [], true);
  EX.download(blob, `${safeFile(state.settings.name)}_${g.name}.glb`);
}

// ============================================================== global drag hint
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#dropOverlay').style.display = 'grid'; } });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropOverlay').style.display = 'none'; });
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#dropOverlay').style.display = 'none'; });
addEventListener('dragover', (e) => e.preventDefault());

// ============================================================== boot
bindSettings();
state.slots.head.open = true;
renderSlots();
assemble({ keepCamera: false });
window.__c3d = { state, scene, get current() { return current; }, convertSlot, loadProject, doExport, resolveMode };
