// ---------------------------------------------------------------------------
// main.js — application shell: state, UI, viewport, editing tools, export flow.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { SLOTS, SLOT_BY_ID, VIEWS, defaultParams, mergeParams, CONVERT_KEYS, icon } from './slots.js';
import { processView, fileToDataURL, alignView, isIdentityAlign } from './imageproc.js';
import { convertPart, MODES, QUALITY, resolveMode } from './converter.js';
import { buildCharacter, makeMaterial, applyParamsToMesh, paramsFromMesh } from './character.js';
import { hasDeform, deformPart, latticeOffsets, latticePoint, latticeIndex, LATTICE_N } from './deform.js';
import { openAlignEditor } from './align.js';
import * as EX from './exporter.js';
import { characterSamples, objectSample } from './samples.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, path, v) {
  const ks = path.split('.'); let a = o;
  for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]];
  a[ks[ks.length - 1]] = v;
}

// ============================================================== state
const state = {
  mode: 'character',
  settings: { name: 'MyHero', colors: { skin: '#ffd9bf', shirt: '#6c8cff', pants: '#3a3f58' }, quality: 'medium', atlas: 1024 },
  slots: {},
  anim: 'Idle',
  selected: null,
  edit: 'view', // view | translate | rotate | scale | lattice
  latticeSel: null, // [i, j, k]
};
for (const s of SLOTS) state.slots[s.id] = freshSlot(s);

function freshSlot(slot, params = defaultParams(slot)) {
  return {
    views: { front: null, side: null, back: null, top: null }, params, snapshot: JSON.stringify(params),
    base: null, part: null, status: 'empty', info: '', open: false,
  };
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

// gizmo for moving / rotating / scaling parts and lattice points
const tc = new TransformControls(camera, renderer.domElement);
tc.setSize(0.8);
scene.add(tc.getHelper());

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
  if (mixer && state.edit === 'view') mixer.update(dt);
  if (view.spin && current && state.edit === 'view') current.root.rotation.y += dt * 0.6;
  controls.update();
  renderer.render(scene, camera);
});

function frame() {
  if (!current) return;
  const box = new THREE.Box3();
  current.root.traverse((o) => { if (o.isMesh && !o.userData.helper) box.expandByObject(o); });
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.y, size.x * 1.2, size.z) * 0.5;
  const dist = r / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.3 / Math.min(1, camera.aspect * 1.1);
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0.38, 0.22, 1).normalize().multiplyScalar(dist));
  camera.updateProjectionMatrix();
}

// picking: click on a part selects its card (and its lattice points in lattice mode)
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = tc.axis ? null : [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || !current || tc.dragging) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(p, camera);
  if (state.edit === 'lattice' && latticeUI) {
    const h = ray.intersectObjects(latticeUI.handles, false)[0];
    if (h) { state.latticeSel = h.object.userData.ijk; refreshGizmo(); return; }
  }
  const hit = ray.intersectObjects(current.pickable, false)[0];
  if (hit) selectSlot(hit.object.userData.slot, true);
  else if (state.edit !== 'view') { state.selected = null; state.latticeSel = null; highlightCards(); refreshGizmo(); }
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

/** Raw (unaligned) processed views. */
async function ensureRaw(st) {
  const p = st.params;
  const out = {};
  for (const v of VIEWS) {
    const view = st.views[v.id];
    if (!view) continue;
    const key = `${view.flip ? 1 : 0}|${p.removeBg ? 1 : 0}|${p.tolerance}`;
    if (!view.raw || view.rawKey !== key) {
      view.raw = await processView(view.src, { removeBg: p.removeBg, tolerance: p.tolerance, flipX: !!view.flip });
      view.rawKey = key; view.processed = null;
    }
    out[v.id] = view.raw;
  }
  return out;
}
/** Processed views with the per-view alignment applied. */
async function ensureProcessed(st) {
  const raw = await ensureRaw(st);
  const out = {};
  for (const [id, r] of Object.entries(raw)) {
    const view = st.views[id];
    const a = id === 'front' ? null : st.params.align[id];
    const key = view.rawKey + '|' + JSON.stringify(a);
    if (!view.processed || view.key !== key) { view.processed = alignView(r, a); view.key = key; }
    out[id] = view.processed;
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
    disposePart(st); st.status = 'empty';
    st.info = st.views.side || st.views.back || st.views.top ? '請先上傳「正面」圖' : '';
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
    disposePart(st);
    st.base = { geometry: res.geometry, material, atlas: res.atlas, mode: res.mode };
    applyDeform(id);
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

/** base geometry → stretch / lattice → part geometry (no re-conversion needed). */
function applyDeform(id) {
  const st = state.slots[id];
  if (!st.base) { st.part = null; return; }
  if (st.part && st.part.geometry !== st.base.geometry) st.part.geometry.dispose();
  let geometry = st.base.geometry, cageBox;
  if (hasDeform(st.params)) ({ geometry, cageBox } = deformPart(st.base.geometry, st.params));
  else { st.base.geometry.computeBoundingBox(); cageBox = st.base.geometry.boundingBox.clone(); }
  st.part = { geometry, material: st.base.material, atlas: st.base.atlas, mode: st.base.mode, cageBox, params: st.params, slot: SLOT_BY_ID[id] };
}

function disposePart(st) {
  if (st.part && st.base && st.part.geometry !== st.base.geometry) st.part.geometry.dispose();
  if (st.base) {
    st.base.geometry.dispose();
    if (st.base.material.map) st.base.material.map.dispose();
    st.base.material.dispose();
  }
  st.base = null; st.part = null;
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
  tc.detach(); removeLatticeUI();
  const keep = new Set();
  for (const s of SLOTS) {
    const st = state.slots[s.id];
    if (st.base) { keep.add(st.base.geometry); keep.add(st.base.material); }
    if (st.part) keep.add(st.part.geometry);
  }
  if (current) {
    scene.remove(current.root);
    current.root.traverse((o) => {
      if (!o.isMesh || o.userData.helper) return;
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
  refreshGizmo();
}

let assembleQueued = false;
function assembleSoon() {
  if (assembleQueued) return;
  assembleQueued = true;
  requestAnimationFrame(() => { assembleQueued = false; assemble(); });
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
  if (state.edit !== 'view') setEdit('view');
  playAnim(b.dataset.anim);
  renderAnimBar();
});
function playAnim(name) {
  state.anim = name;
  if (!mixer || !current) return;
  mixer.stopAllAction();
  const clip = state.edit === 'view' && current.clips.find((c) => c.name === name);
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
toggleBtn('#tSockets', 'sockets', () => current && current.root.traverse((o) => { if (o.userData.helper && o.name === 'helper') o.visible = view.sockets; }));
toggleBtn('#tSpin', 'spin', () => { if (!view.spin && current) current.root.rotation.y = 0; });
$('#tView').addEventListener('click', () => { if (current) current.root.rotation.y = 0; frame(); });

// ============================================================== editing (gizmo + lattice)
const EDIT_HINT = {
  view: '',
  translate: '拖曳箭頭移動部位',
  rotate: '拖曳圓環旋轉部位',
  scale: '拖曳方塊調整寬 / 高 / 深',
  lattice: '點選紅色控制點後拖曳，自由變形（左右對稱可在卡片中關閉）',
};
function setEdit(mode) {
  state.edit = mode;
  $$('#editBar [data-edit]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.edit === mode));
  if (mode !== 'view') {
    if (current) current.root.rotation.y = 0;
    view.spin = false; $('#tSpin').setAttribute('aria-pressed', false);
    if (!state.selected) {
      const first = activeSlots().find((s) => state.slots[s.id].part);
      if (first) state.selected = first.id;
      highlightCards();
    }
  }
  if (mode !== 'lattice') state.latticeSel = null;
  playAnim(state.anim);
  if (mode !== 'view' && mixer) { mixer.stopAllAction(); assemble(); } // rest pose for editing
  else refreshGizmo();
}
$('#editBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-edit]');
  if (b) setEdit(b.dataset.edit);
});

function editableMesh(id, primaryOnly = true) {
  if (!current || !id) return null;
  let found = null;
  current.root.traverse((o) => {
    if (found || !o.isMesh || o.userData.slot !== id || !o.userData.editable) return;
    if (!primaryOnly || o.userData.base.primary) found = o;
  });
  return found;
}
function siblings(id, except) {
  const out = [];
  current.root.traverse((o) => { if (o.isMesh && o.userData.slot === id && o.userData.editable && o !== except) out.push(o); });
  return out;
}

let latticeUI = null; // { group, handles, lines, mesh, id }
function removeLatticeUI() {
  if (!latticeUI) return;
  latticeUI.group.parent && latticeUI.group.parent.remove(latticeUI.group);
  latticeUI.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  latticeUI = null;
}

function refreshGizmo() {
  tc.detach();
  removeLatticeUI();
  const hint = $('#editHint');
  if (state.edit === 'view' || !current) { hint.hidden = true; return; }
  hint.hidden = false;
  const id = state.selected;
  const mesh = editableMesh(id);
  if (!id) { hint.textContent = '點選模型上的部位開始編輯'; return; }
  if (!mesh) { hint.textContent = `「${SLOT_BY_ID[id].name}」需要先上傳圖片才能編輯`; return; }
  hint.textContent = `${SLOT_BY_ID[id].name} · ${EDIT_HINT[state.edit]}`;
  if (state.edit === 'lattice') { buildLatticeUI(id, mesh); return; }
  tc.setMode(state.edit);
  tc.setSpace(state.edit === 'translate' ? 'world' : 'local');
  tc.attach(mesh);
}

const HANDLE_GEO = new THREE.SphereGeometry(1, 14, 10);
function buildLatticeUI(id, mesh) {
  const st = state.slots[id];
  const box = st.part.cageBox;
  const offs = latticeOffsets(st.params);
  const group = new THREE.Group(); group.userData.helper = true; group.name = 'lattice';
  const s = mesh.scale.x || 1;
  const r = 0.035 / s;
  const handles = [];
  for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const sel = state.latticeSel && state.latticeSel.join() === [i, j, k].join();
    const m = new THREE.Mesh(HANDLE_GEO, new THREE.MeshBasicMaterial({ color: sel ? 0xffc93c : 0xff3d71, depthTest: false, transparent: true, opacity: 0.95 }));
    m.scale.setScalar(sel ? r * 1.4 : r);
    m.renderOrder = 20;
    m.userData.helper = true; m.userData.ijk = [i, j, k];
    latticePoint(box, offs, i, j, k, m.position);
    group.add(m); handles.push(m);
  }
  const lineGeo = new THREE.BufferGeometry();
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xff3d71, depthTest: false, transparent: true, opacity: 0.55 }));
  lines.renderOrder = 19; lines.userData.helper = true;
  group.add(lines);
  mesh.add(group);
  latticeUI = { group, handles, lines, mesh, id };
  updateLatticeLines();
  if (state.latticeSel) {
    const h = handles.find((x) => x.userData.ijk.join() === state.latticeSel.join());
    if (h) { tc.setMode('translate'); tc.setSpace('local'); tc.attach(h); }
  }
}
function updateLatticeLines() {
  const H = (i, j, k) => latticeUI.handles[latticeIndex(i, j, k)].position;
  const pts = [];
  for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    if (i < 2) pts.push(H(i, j, k), H(i + 1, j, k));
    if (j < 2) pts.push(H(i, j, k), H(i, j + 1, k));
    if (k < 2) pts.push(H(i, j, k), H(i, j, k + 1));
  }
  latticeUI.lines.geometry.setFromPoints(pts);
}

let liveGeom = null;
tc.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (!e.value) onDragEnd();
});
tc.addEventListener('objectChange', () => {
  const obj = tc.object;
  if (!obj) return;
  if (obj.userData.ijk) return onHandleMove(obj);
  const id = obj.userData.slot, st = state.slots[id];
  if (state.edit === 'translate' || state.edit === 'rotate') {
    paramsFromMesh(obj, st.params);
    for (const m of siblings(id, obj)) applyParamsToMesh(m, st.params);
    syncCardVectors(id);
  } else if (state.edit === 'scale') {
    for (const m of siblings(id, obj)) m.scale.copy(obj.scale);
  }
});

function onHandleMove(h) {
  const id = latticeUI.id, st = state.slots[id], p = st.params;
  const box = st.part.cageBox;
  const size = box.getSize(new THREE.Vector3());
  const [i, j, k] = h.userData.ijk;
  const taperOnly = latticeOffsets({ ...p, lattice: null });
  if (!p.lattice) p.lattice = new Array(LATTICE_N * 3).fill(0);
  const set = (ii, jj, kk, ox, oy, oz) => {
    const q = latticeIndex(ii, jj, kk) * 3;
    p.lattice[q] = +(ox - taperOnly[q]).toFixed(4);
    p.lattice[q + 1] = +(oy - taperOnly[q + 1]).toFixed(4);
    p.lattice[q + 2] = +(oz - taperOnly[q + 2]).toFixed(4);
  };
  const ox = (h.position.x - box.min.x) / Math.max(size.x, 1e-6) - i / 2;
  const oy = (h.position.y - box.min.y) / Math.max(size.y, 1e-6) - j / 2;
  const oz = (h.position.z - box.min.z) / Math.max(size.z, 1e-6) - k / 2;
  set(i, j, k, ox, oy, oz);
  if (p.latticeMirror && i !== 1) {
    const q = latticeIndex(i, j, k) * 3;
    const mq = latticeIndex(2 - i, j, k) * 3;
    p.lattice[mq] = -p.lattice[q]; p.lattice[mq + 1] = p.lattice[q + 1]; p.lattice[mq + 2] = p.lattice[q + 2];
  } else if (p.latticeMirror && i === 1) {
    p.lattice[latticeIndex(i, j, k) * 3] = 0; // symmetric editing: centre column only moves up/down/front/back
  }
  // move the other handles to their new spots
  const offs = latticeOffsets(p);
  for (const m of latticeUI.handles) {
    if (m === h) continue;
    const [a, b, c] = m.userData.ijk;
    latticePoint(box, offs, a, b, c, m.position);
  }
  if (p.latticeMirror && i === 1) latticePoint(box, offs, i, j, k, h.position);
  updateLatticeLines();
  // live preview on the edited mesh
  const mesh = latticeUI.mesh;
  if (mesh.userData.base.live) {
    const { geometry } = deformPart(st.base.geometry, p);
    if (liveGeom) liveGeom.dispose();
    liveGeom = geometry; mesh.geometry = geometry;
  }
}

function onDragEnd() {
  const obj = tc.object;
  if (!obj) return;
  if (obj.userData.ijk) {
    const id = latticeUI.id;
    liveGeom = null;
    applyDeform(id); commit(id); updateCard(id); syncCardInputs(id);
    assemble();
    return;
  }
  const id = obj.userData.slot, st = state.slots[id];
  if (state.edit === 'scale') {
    const b = obj.userData.base.scale;
    st.params.stretch = st.params.stretch.map((v, i) => +Math.min(5, Math.max(0.1, v * obj.scale.getComponent(i) / b)).toFixed(3));
    applyDeform(id);
  }
  commit(id); syncCardInputs(id);
  assemble();
}

// ============================================================== undo / redo
const history = { undo: [], redo: [] };
function commit(id) {
  const st = state.slots[id];
  const now = JSON.stringify(st.params);
  if (now === st.snapshot) return;
  history.undo.push({ id, before: st.snapshot, after: now });
  if (history.undo.length > 200) history.undo.shift();
  history.redo = [];
  st.snapshot = now;
  updateUndoButtons();
}
function restoreParams(id, json) {
  const st = state.slots[id];
  const prev = st.params;
  st.params = JSON.parse(json);
  st.snapshot = json;
  const reconvert = CONVERT_KEYS.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(st.params[k]));
  rerenderCard(id);
  if (reconvert) scheduleConvert(id, 0);
  else { applyDeform(id); assemble(); }
}
function undo() {
  const e = history.undo.pop(); if (!e) return;
  history.redo.push(e); restoreParams(e.id, e.before); updateUndoButtons();
  toast(`復原：${SLOT_BY_ID[e.id].name}`, 1200);
}
function redo() {
  const e = history.redo.pop(); if (!e) return;
  history.undo.push(e); restoreParams(e.id, e.after); updateUndoButtons();
  toast(`重做：${SLOT_BY_ID[e.id].name}`, 1200);
}
function updateUndoButtons() {
  $('#tUndo').disabled = !history.undo.length;
  $('#tRedo').disabled = !history.redo.length;
}
$('#tUndo').addEventListener('click', undo);
$('#tRedo').addEventListener('click', redo);
function clearHistory() { history.undo = []; history.redo = []; updateUndoButtons(); }

addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  const keys = { q: 'view', w: 'translate', e: 'rotate', r: 'scale', t: 'lattice' };
  const m = keys[e.key.toLowerCase()];
  if (m) { setEdit(m); return; }
  if (e.key === 'Escape') { state.latticeSel = null; refreshGizmo(); }
});

// ============================================================== slot cards
const RANGES = [
  ['depth', '厚度 / 深度', 0.1, 3, 0.05],
  ['roundness', '圓潤度', 0, 1, 0.05],
  ['smooth', '表面平滑', 0, 6, 1],
  ['size', '大小', 0.3, 2.5, 0.05],
];
const SHAPE_RANGES = [
  ['stretch.0', '寬度拉伸', 0.3, 2.5, 0.05],
  ['stretch.1', '高度拉伸', 0.3, 2.5, 0.05],
  ['stretch.2', '深度拉伸', 0.3, 2.5, 0.05],
  null,
  ['taper.w.2', '上段寬', 0.2, 2.5, 0.05],
  ['taper.d.2', '上段深', 0.2, 2.5, 0.05],
  ['taper.w.1', '中段寬', 0.2, 2.5, 0.05],
  ['taper.d.1', '中段深', 0.2, 2.5, 0.05],
  ['taper.w.0', '下段寬', 0.2, 2.5, 0.05],
  ['taper.d.0', '下段深', 0.2, 2.5, 0.05],
  ['taper.bend.0', '前後彎曲', -0.6, 0.6, 0.02],
  ['taper.bend.1', '左右彎曲', -0.6, 0.6, 0.02],
  ['taper.twist', '扭轉（度）', -90, 90, 1],
];
const ROLE_OPTS = [['both', '形狀＋貼圖'], ['shape', '只用來塑形'], ['texture', '只當貼圖']];

const rangeHTML = (p, [path, label, min, max, step]) => `
  <label class="field"><span>${label}<output>${getPath(p, path)}</output></span>
  <input type="range" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${getPath(p, path)}"></label>`;

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
  highlightCards();
}

function cardHTML(s) {
  const st = state.slots[s.id], p = st.params;
  const modeOpts = Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${p.mode === k ? 'selected' : ''}>${k === 'auto' ? `${v}（預設：${MODES[s.mode].split(' ')[0]}）` : v}</option>`).join('');
  const roleSel = (vid, name) => `<label class="field" data-role="${vid}"><span>${name}用途</span><select data-path="roles.${vid}">${ROLE_OPTS.map(([k, t]) => `<option value="${k}" ${p.roles[vid] === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
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
      <div class="view-tools">
        <button type="button" class="btn" data-act="align">對齊三視圖…<span class="dot-mark" hidden></span></button>
        ${roleSel('side', '側面')}
        ${roleSel('top', '頂部')}
      </div>
      <div class="info"></div>
      <div class="ctrls">
        <label class="field full"><span>轉換方式</span><select data-path="mode">${modeOpts}</select></label>
        ${RANGES.map((r) => rangeHTML(p, r)).join('')}
        <label class="field full"><span>背面（沒有背面圖時）</span>
          <select data-path="backFill">
            <option value="mirror" ${p.backFill === 'mirror' ? 'selected' : ''}>沿用正面圖案（對稱物件）</option>
            <option value="color" ${p.backFill === 'color' ? 'selected' : ''}>以頂部主色填補（頭髮、背面單色）</option>
          </select></label>
        <details class="adv shape" ${st.shapeOpen ? 'open' : ''}>
          <summary>立體結構調整（拉伸、變形籠、控制點）</summary>
          <div class="edit-row">
            <button type="button" class="tbtn" data-goedit="translate">移動</button>
            <button type="button" class="tbtn" data-goedit="rotate">旋轉</button>
            <button type="button" class="tbtn" data-goedit="scale">縮放</button>
            <button type="button" class="tbtn" data-goedit="lattice">控制點變形</button>
          </div>
          <div class="ctrls">
            ${SHAPE_RANGES.map((r) => (r ? rangeHTML(p, r) : '<div class="full sep">變形籠（上 / 中 / 下 三段）</div>')).join('')}
            <label class="field check full"><input type="checkbox" data-path="latticeMirror" ${p.latticeMirror ? 'checked' : ''}><span>控制點左右對稱編輯</span></label>
            <p class="note full lattice-info"></p>
            <div class="full slot-actions" style="margin-top:0">
              <button type="button" class="btn" data-act="reset-points">清除控制點</button>
              <button type="button" class="btn" data-act="reset-shape">重設立體調整</button>
            </div>
          </div>
        </details>
        <details class="adv">
          <summary>進階：去背、位置、旋轉</summary>
          <div class="ctrls">
            <label class="field check"><input type="checkbox" data-path="removeBg" ${p.removeBg ? 'checked' : ''}><span>自動去背</span></label>
            <label class="field check"><input type="checkbox" data-path="visible" ${p.visible ? 'checked' : ''}><span>顯示此部位</span></label>
            ${rangeHTML(p, ['tolerance', '去背容差', 0, 100, 1]).replace('class="field"', 'class="field full"')}
            <div class="field full"><span>位置偏移 X / Y / Z（頭身單位）</span>
              <div class="vec">${[0, 1, 2].map((i) => `<input type="number" step="0.05" data-path="offset.${i}" value="${p.offset[i]}">`).join('')}</div></div>
            <div class="field full"><span>旋轉 X / Y / Z（度）</span>
              <div class="vec">${[0, 1, 2].map((i) => `<input type="number" step="5" data-path="rotation.${i}" value="${p.rotation[i]}">`).join('')}</div></div>
            ${s.id === 'legs' ? `<label class="field check full"><input type="checkbox" data-path="splitLegs" ${p.splitLegs ? 'checked' : ''}><span>左右腿分開（走路動畫各自擺動）</span></label>` : ''}
            <div class="full slot-actions" style="margin-top:0"><button type="button" class="btn" data-act="reset-place">重設位置與旋轉</button></div>
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

function onParamInput(id, path, el, final) {
  const st = state.slots[id], p = st.params;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.type === 'range' || el.type === 'number') { v = parseFloat(el.value); if (!Number.isFinite(v)) return; }
  else v = el.value;
  setPath(p, path, v);
  const o = el.parentElement.querySelector('output'); if (o) o.textContent = el.value;
  const key = path.split('.')[0];
  if (CONVERT_KEYS.includes(key)) {
    if (final || el.type !== 'range') scheduleConvert(id, key === 'tolerance' ? 250 : 120);
    else scheduleConvert(id, 220);
  } else if (['stretch', 'taper', 'lattice'].includes(key)) {
    applyDeform(id); assembleSoon();
  } else if (key !== 'latticeMirror') {
    assembleSoon();
  }
  if (final) commit(id);
}

function bindCard(id) {
  const card = $(`.card[data-slot="${id}"]`);
  const S = () => state.slots[id];
  $('[data-toggle]', card).addEventListener('click', () => {
    S().open = !S().open; card.classList.toggle('open', S().open);
    if (S().open) selectSlot(id, false);
  });
  $('details.shape', card).addEventListener('toggle', (e) => { S().shapeOpen = e.target.open; });
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
      S().views[vid] = null; updateCard(id); scheduleConvert(id, 0);
    });
    $('.mini.flip', drop).addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const v = S().views[vid]; if (!v) return;
      v.flip = !v.flip; updateCard(id); scheduleConvert(id, 0);
    });
  }
  for (const el of $$('[data-path]', card)) {
    const path = el.dataset.path;
    if (el.type === 'range' || el.type === 'number') {
      el.addEventListener('input', () => onParamInput(id, path, el, false));
      el.addEventListener('change', () => onParamInput(id, path, el, true));
    } else {
      el.addEventListener('change', () => onParamInput(id, path, el, true));
    }
  }
  $$('[data-goedit]', card).forEach((b) => b.addEventListener('click', () => {
    if (!S().part) { toast('請先上傳正面圖並完成轉換'); return; }
    state.selected = id; highlightCards(); setEdit(b.dataset.goedit);
  }));
  $('[data-act="align"]', card).addEventListener('click', () => openAlign(id));
  $('[data-act="reset-points"]', card).addEventListener('click', () => {
    S().params.lattice = null; applyDeform(id); commit(id); updateCard(id); assemble();
  });
  $('[data-act="reset-shape"]', card).addEventListener('click', () => {
    const d = defaultParams(SLOT_BY_ID[id]);
    Object.assign(S().params, { stretch: d.stretch, taper: d.taper, lattice: null });
    applyDeform(id); commit(id); rerenderCard(id); assemble();
  });
  $('[data-act="reset-place"]', card).addEventListener('click', () => {
    Object.assign(S().params, { offset: [0, 0, 0], rotation: [0, 0, 0] });
    commit(id); syncCardInputs(id); assemble();
  });
  $('[data-act="clear"]', card).addEventListener('click', () => {
    const open = S().open;
    disposePart(S());
    state.slots[id] = freshSlot(SLOT_BY_ID[id]); state.slots[id].open = open;
    history.undo = history.undo.filter((h) => h.id !== id); history.redo = history.redo.filter((h) => h.id !== id); updateUndoButtons();
    rerenderCard(id); assemble();
  });
  $('[data-act="export"]', card).addEventListener('click', () => exportSinglePart(id));
  updateCard(id);
}

function rerenderCard(id) {
  const card = $(`.card[data-slot="${id}"]`);
  if (!card) return;
  card.outerHTML = cardHTML(SLOT_BY_ID[id]);
  bindCard(id);
  highlightCards();
}

/** Push current param values into the card inputs (after gizmo edits / resets). */
function syncCardInputs(id) {
  const card = $(`.card[data-slot="${id}"]`);
  if (!card) return;
  const p = state.slots[id].params;
  for (const el of $$('[data-path]', card)) {
    const v = getPath(p, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
    const o = el.parentElement.querySelector('output'); if (o) o.textContent = v;
  }
  updateCard(id);
}
function syncCardVectors(id) {
  const card = $(`.card[data-slot="${id}"]`);
  if (!card) return;
  const p = state.slots[id].params;
  for (const el of $$('[data-path^="offset."], [data-path^="rotation."]', card)) el.value = getPath(p, el.dataset.path);
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
  // view tools: alignment + roles only make sense with extra views
  const extra = ['back', 'side', 'top'].filter((v) => st.views[v]);
  $('.view-tools', card).hidden = !(st.views.front && extra.length);
  $('[data-role="side"]', card).hidden = !st.views.side;
  $('[data-role="top"]', card).hidden = !st.views.top;
  $('[data-act="align"] .dot-mark', card).hidden = !extra.some((v) => !isIdentityAlign(st.params.align[v]));
  const info = $('.info', card);
  let txt2 = st.info;
  if (st.status === 'ok' && st.params.mode === 'auto' && !st.views.side && !st.views.top) txt2 += ' · 提示：加入側面圖可啟用三視圖雕刻';
  info.textContent = txt2;
  info.classList.toggle('err', st.status === 'err');
  const moved = st.params.lattice ? st.params.lattice.filter((v, i) => i % 3 === 0 && (Math.abs(v) + Math.abs(st.params.lattice[i + 1]) + Math.abs(st.params.lattice[i + 2])) > 1e-4).length : 0;
  $('.lattice-info', card).textContent = moved ? `已手動移動 ${moved} 個控制點。` : '在 3D 視窗按「控制點變形」(T) 可直接拖曳 27 個控制點。';
}

async function setView(id, vid, file) {
  try {
    const src = await fileToDataURL(file);
    state.slots[id].views[vid] = { src, flip: false };
    updateCard(id);
    scheduleConvert(id, 0);
  } catch (e) { toast('讀取圖片失敗：' + e.message); }
}

async function openAlign(id) {
  const st = state.slots[id];
  if (!st.views.front) { toast('請先上傳正面圖'); return; }
  setBusy(+1, '準備對齊工具…');
  let raw;
  try { raw = await ensureRaw(st); } finally { setBusy(-1); }
  openAlignEditor({
    name: SLOT_BY_ID[id].name, front: raw.front,
    views: { back: raw.back, side: raw.side, top: raw.top },
    align: st.params.align,
    onApply: (al) => {
      const p = state.slots[id].params;
      p.align = { ...p.align, ...al };
      commit(id); updateCard(id); scheduleConvert(id, 0);
      toast('已套用對齊，重新轉換中');
    },
  });
}

function highlightCards() {
  $$('.card.slot').forEach((c) => c.classList.toggle('selected', c.dataset.slot === state.selected));
}
function selectSlot(id, fromViewport) {
  state.selected = id;
  state.latticeSel = null;
  highlightCards();
  if (fromViewport) {
    const card = $(`.card[data-slot="${id}"]`);
    if (card) {
      state.slots[id].open = true; card.classList.add('open');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  refreshGizmo();
}

// ============================================================== settings
function bindSettings() {
  const card = $('#settingsCard');
  $('[data-toggle]', card).addEventListener('click', () => card.classList.toggle('open'));
  $('#setName').addEventListener('input', (e) => { state.settings.name = e.target.value; $('#expName').value = e.target.value; });
  for (const [sel, key] of [['#setSkin', 'skin'], ['#setShirt', 'shirt'], ['#setPants', 'pants']]) {
    $(sel).addEventListener('input', (e) => { state.settings.colors[key] = e.target.value; assembleSoon(); });
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
  state.selected = mode === 'object' ? 'object' : null;
  if (mode === 'object') state.slots.object.open = true;
  renderSlots();
  assemble({ keepCamera: false });
}

// ============================================================== samples / project
$('#btnSample').addEventListener('click', async () => {
  const set = state.mode === 'object' ? objectSample() : characterSamples();
  for (const [id, views] of Object.entries(set)) {
    disposePart(state.slots[id]);
    const open = state.slots[id].open;
    state.slots[id] = freshSlot(SLOT_BY_ID[id]);
    state.slots[id].open = open;
    for (const v of VIEWS) state.slots[id].views[v.id] = views[v.id] ? { src: views[v.id], flip: false } : null;
  }
  clearHistory();
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
  return { format: 'char3d-project', version: 2, savedAt: new Date().toISOString(), mode: state.mode, settings: state.settings, slots };
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
  for (const s of SLOTS) { disposePart(state.slots[s.id]); state.slots[s.id] = freshSlot(s); }
  state.settings = { ...state.settings, ...data.settings, colors: { ...state.settings.colors, ...(data.settings?.colors || {}) } };
  for (const [id, sd] of Object.entries(data.slots || {})) {
    if (!state.slots[id]) continue;
    const params = mergeParams(SLOT_BY_ID[id], sd.params);
    const st = state.slots[id] = freshSlot(SLOT_BY_ID[id], params);
    for (const v of VIEWS) if (sd.views?.[v.id]) st.views[v.id] = { src: sd.views[v.id].src, flip: !!sd.views[v.id].flip };
  }
  clearHistory();
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
  for (const s of SLOTS) { disposePart(state.slots[s.id]); state.slots[s.id] = freshSlot(s); }
  clearHistory();
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
    ? (converted ? '將匯出目前的物件（包含所有立體調整）。' : '尚未上傳物件圖片。')
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
  const vis = tc.getHelper().visible; tc.getHelper().visible = false;
  const lat = latticeUI && latticeUI.group.visible; if (latticeUI) latticeUI.group.visible = false;
  renderer.render(scene, camera);
  c.getContext('2d').drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, 512, 512);
  tc.getHelper().visible = vis; if (latticeUI) latticeUI.group.visible = lat;
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
    return { slot: s.id, name: s.en, mode: st.part.mode, views: VIEWS.filter((v) => st.views[v.id]).map((v) => v.id), adjusted: hasDeform(st.params) };
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
updateUndoButtons();
assemble({ keepCamera: false });
window.__c3d = {
  state, scene, camera, tc, get current() { return current; }, get latticeUI() { return latticeUI; },
  convertSlot, loadProject, doExport, resolveMode, setEdit, selectSlot, undo, redo, onHandleMove, onDragEnd, commit, applyDeform, assemble,
};
