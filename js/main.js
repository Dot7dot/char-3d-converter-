// ---------------------------------------------------------------------------
// main.js — application shell: state, UI, viewport, editing tools, export flow.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { SLOTS, SLOT_BY_ID, VIEWS, defaultParams, mergeParams, CONVERT_KEYS, icon } from './slots.js';
import { processView, fileToDataURL, alignView, isIdentityAlign, makeCanvas, mirrorCanvas } from './imageproc.js';
import { convertPart, MODES, QUALITY, BUDGETS, simplifyGeometry, simplifierReady, resolveMode } from './converter.js';
import { buildCharacter, makeMaterial, applyParamsToMesh, paramsFromMesh, releaseLegCache } from './character.js';
import { hasDeform, latticeActive, deformPart, latticeOffsets, latticePoint, latticeIndex, LATTICE_N } from './deform.js';
import * as SC from './sculpt.js';
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
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// ============================================================== state
const state = {
  mode: 'character',
  settings: { name: 'MyHero', colors: { skin: '#ffd9bf', shirt: '#6c8cff', pants: '#3a3f58' }, quality: 'medium', atlas: 1024, budget: 'game' },
  slots: {},
  anim: 'Idle',
  selected: null,
  edit: 'view', // view | translate | rotate | scale | lattice | sculpt
  latticeSel: null, // [i, j, k]
  brush: { type: 'grab', size: 0.2, strength: 0.5, sym: true },
  preset: 'persp', // persp | front | back | right | left | top
  ref: { on: true, opacity: 0.5 },
};
for (const s of SLOTS) state.slots[s.id] = freshSlot(s);

function freshSlot(slot, params = defaultParams(slot)) {
  return {
    views: { front: null, side: null, back: null, top: null }, params, snapshot: JSON.stringify(params),
    base: null, part: null, status: 'empty', info: '', open: false, tab: 'img', version: 0,
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
const dom = renderer.domElement;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
camera.position.set(3.2, 2.6, 7.2);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 400);
let cam = camera;
let orthoHalf = 2;
const controls = new OrbitControls(camera, dom);
controls.enableDamping = true;
controls.target.set(0, 1.5, 0);
controls.minDistance = 0.4; controls.maxDistance = 40;
const controlsO = new OrbitControls(ortho, dom);
controlsO.enableRotate = false; controlsO.enabled = false; controlsO.screenSpacePanning = true;
controlsO.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controlsO.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
const activeControls = () => (cam === camera ? controls : controlsO);

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
const tc = new TransformControls(camera, dom);
tc.setSize(0.8);
scene.add(tc.getHelper());
const brushCursor = SC.makeBrushCursor();
scene.add(brushCursor);

let current = null; // { root, clips, sockets, pickable, height }
let mixer = null;
const view = { wire: false, sockets: false, spin: false, solo: false };

function resize() {
  const w = vp.clientWidth, h = vp.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  setOrthoFrustum();
}
function setOrthoFrustum() {
  const a = (vp.clientWidth || 1) / (vp.clientHeight || 1);
  ortho.left = -orthoHalf * a; ortho.right = orthoHalf * a; ortho.top = orthoHalf; ortho.bottom = -orthoHalf;
  ortho.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(vp);
resize();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (mixer && state.edit === 'view') mixer.update(dt);
  if (view.spin && current && state.edit === 'view' && cam === camera) current.root.rotation.y += dt * 0.6;
  activeControls().update();
  if (!exporting) renderer.render(scene, cam); // keep the GPU free while encoding files
});
let exporting = false;

function modelBox(onlySlot) {
  const box = new THREE.Box3();
  if (!current) return box;
  current.root.updateMatrixWorld(true);
  current.root.traverse((o) => {
    if (!o.isMesh || o.userData.helper || !o.visible) return;
    if (onlySlot && o.userData.slot !== onlySlot) return;
    box.expandByObject(o);
  });
  return box;
}

/** Frame the whole model, or the selected part when `sel` is true. */
function frame(sel = false) {
  if (!current) return;
  let box = sel && state.selected ? modelBox(state.selected) : modelBox();
  if (box.isEmpty()) box = modelBox();
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  if (cam === camera) {
    const r = Math.max(size.y, size.x * 1.2, size.z) * 0.5;
    const dist = r / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.3 / Math.min(1, camera.aspect * 1.1);
    const dir = sel ? camera.position.clone().sub(controls.target).normalize() : new THREE.Vector3(0.38, 0.22, 1).normalize();
    controls.target.copy(c);
    camera.position.copy(c).add(dir.multiplyScalar(dist));
  } else placeOrtho(box);
}

const PRESET_DIR = { front: [0, 0, 1], back: [0, 0, -1], right: [-1, 0, 0], left: [1, 0, 0], top: [0, 1, 0] };
function placeOrtho(box) {
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const d = PRESET_DIR[state.preset];
  const a = (vp.clientWidth || 1) / (vp.clientHeight || 1);
  const horiz = state.preset === 'right' || state.preset === 'left' ? size.z : size.x;
  const vert = state.preset === 'top' ? size.z : size.y;
  orthoHalf = Math.max(vert, horiz / a, 0.2) * 0.62 + 0.05;
  ortho.zoom = 1;
  setOrthoFrustum();
  controlsO.target.copy(c);
  ortho.position.set(c.x + d[0] * 60, c.y + d[1] * 60, c.z + d[2] * 60);
  ortho.up.set(0, 1, 0);
  ortho.lookAt(c);
  controlsO.update();
}
function setPreset(name) {
  state.preset = name;
  $$('#viewBar [data-preset]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.preset === name));
  if (name === 'persp') {
    cam = camera; controls.enabled = true; controlsO.enabled = false;
  } else {
    cam = ortho; controls.enabled = false; controlsO.enabled = true;
    if (current) current.root.rotation.y = 0;
    view.spin = false; $('#tSpin').setAttribute('aria-pressed', false);
    let box = state.selected ? modelBox(state.selected) : modelBox();
    if (box.isEmpty()) box = modelBox();
    if (!box.isEmpty()) placeOrtho(box);
  }
  tc.camera = cam;
  grid.visible = name === 'persp';
  updateRefPlane();
  updateHint();
}
$('#viewBar').addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) setPreset(b.dataset.preset); });
$('#tRef').addEventListener('click', () => {
  state.ref.on = !state.ref.on; $('#tRef').setAttribute('aria-pressed', state.ref.on);
  if (state.ref.on && state.preset === 'persp') setPreset('front'); else updateRefPlane();
  updateHint();
});
$('#refOpacity').addEventListener('input', (e) => { state.ref.opacity = +e.target.value; if (refPlane) refPlane.material.opacity = state.ref.opacity; });

// ---------------------------------------------------------- reference overlay
let refPlane = null;
function removeRefPlane() {
  if (!refPlane) return;
  refPlane.parent && refPlane.parent.remove(refPlane);
  refPlane.material.map.dispose(); refPlane.material.dispose(); refPlane.geometry.dispose();
  refPlane = null;
}
const PRESET_VIEW = { front: 'front', back: 'back', right: 'side', left: 'side', top: 'top' };
/** Which uploaded image the current ortho view can be compared with (or null). */
function refViewFor(id) {
  const vid = PRESET_VIEW[state.preset];
  const st = id && state.slots[id];
  if (!vid || !st || !st.part) return null;
  const v = st.views[vid];
  return v && v.processed ? vid : null;
}
function updateRefPlane() {
  removeRefPlane();
  if (!state.ref.on || !current) return;
  const id = state.selected, vid = refViewFor(id);
  if (!vid) return;
  const mesh = editableMesh(id);
  if (!mesh) return;
  const st = state.slots[id], f = st.part.frame, [sx, sy, sz] = st.params.stretch;
  const tex = new THREE.CanvasTexture(st.views[vid].processed.alphaCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: state.ref.opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const W = f.w * sx, H = f.h * sy, D = f.d * sz, zc = f.zc * sz;
  let g;
  if (vid === 'front' || vid === 'back') {
    g = new THREE.PlaneGeometry(W, H);
    refPlane = new THREE.Mesh(g, mat);
    refPlane.position.set(0, H / 2, zc);
    if (vid === 'back') refPlane.rotation.y = Math.PI;
  } else if (vid === 'side') {
    g = new THREE.PlaneGeometry(D, H);
    refPlane = new THREE.Mesh(g, mat);
    refPlane.position.set(0, H / 2, zc);
    refPlane.rotation.y = -Math.PI / 2;
  } else {
    g = new THREE.PlaneGeometry(W, D);
    refPlane = new THREE.Mesh(g, mat);
    refPlane.position.set(0, H / 2, zc);
    refPlane.rotation.x = -Math.PI / 2;
  }
  refPlane.renderOrder = 15; refPlane.userData.helper = true; refPlane.name = 'ref';
  mesh.add(refPlane);
}

// ============================================================== status / toast
let busyCount = 0;
function setBusy(delta, text) {
  busyCount = Math.max(0, busyCount + delta);
  $('#statusPill').classList.toggle('busy', busyCount > 0);
  if (text) $('#statusText').textContent = text;
  else if (!busyCount) $('#statusText').textContent = statsText();
}
function totalTris() {
  let tris = 0, meshes = 0;
  if (current) current.root.traverse((o) => {
    if (!o.isMesh || o.userData.helper) return;
    meshes++;
    const g = o.geometry; tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return { tris: Math.round(tris), meshes };
}
function statsText() {
  if (!current) return '準備就緒';
  const { tris, meshes } = totalTris();
  const converted = activeSlots().filter((s) => state.slots[s.id].part).length;
  return `${converted} 個部位已轉換 · ${meshes} 網格 · ${tris.toLocaleString()} 三角形`;
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

/** How well the (mirrored) back silhouette covers the front one, 0…1. */
function silhouetteMatch(front, back) {
  const n = 48;
  const grab = (canvas) => {
    const c = makeCanvas(n, n), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, n, n);
    return ctx.getImageData(0, 0, n, n).data;
  };
  const a = grab(front.maskCanvas), b = grab(mirrorCanvas(back.maskCanvas));
  let inter = 0, uni = 0;
  for (let i = 3; i < a.length; i += 4) { const x = a[i] > 127, y = b[i] > 127; if (x && y) inter++; if (x || y) uni++; }
  return uni ? inter / uni : 1;
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
    updateCard(id); assemble(); touch();
    return;
  }
  st.status = 'busy'; updateCard(id);
  setBusy(+1, `轉換「${slot.name}」中…`);
  await new Promise((r) => setTimeout(r, 16)); // let the UI paint
  try {
    await simplifierReady;
    const views = await ensureProcessed(st);
    if (seq !== convertSeq[id]) return;
    const t0 = performance.now();
    const res = convertPart(views, st.params, {
      resolution: QUALITY[state.settings.quality], atlasSize: state.settings.atlas, slotDefault: slot.mode, sideDefault: slot.sideMode || 'hull',
    });
    res.name = slot.en.replace(/\W+/g, '');
    const material = makeMaterial(res);
    disposePart(st);
    st.base = { geometry: res.geometry, material, atlas: res.atlas, mode: res.mode, frame: res.frame, topo: null, info: res.info };
    st.match = views.back ? silhouetteMatch(views.front, views.back) : null;
    applyDeform(id);
    st.status = 'ok';
    st.ms = Math.round(performance.now() - t0);
  } catch (err) {
    console.error(err);
    st.status = 'err'; st.info = err.message || String(err);
  } finally {
    setBusy(-1);
  }
  if (seq !== convertSeq[id]) return;
  updateCard(id);
  assemble();
  touch();
}

const triCount = (g) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
const topoOf = (st) => (st.base.geometry.index ? (st.base.topo || (st.base.topo = SC.buildTopo(st.base.geometry))) : null);

/** base → stretch / lattice / sculpt → polygon budget → part geometry (no re-conversion needed). */
function applyDeform(id) {
  const st = state.slots[id];
  if (!st.base) { st.part = null; return; }
  disposeDerived(st);
  const p = st.params;
  let full = st.base.geometry, cageBox;
  if (hasDeform(p)) ({ geometry: full, cageBox } = deformPart(st.base.geometry, p, p.sculpt.length ? topoOf(st) : null));
  else { full.computeBoundingBox(); cageBox = full.boundingBox.clone(); }
  const geometry = simplifyGeometry(full, state.settings.budget);
  st.part = {
    geometry, full, material: st.base.material, atlas: st.base.atlas, mode: st.base.mode, frame: st.base.frame,
    cageBox, params: p, slot: SLOT_BY_ID[id],
  };
  st.version++;
  const a = triCount(geometry), b = triCount(st.base.geometry);
  st.info = `${st.base.info} · ${Math.round(a).toLocaleString()} 三角形${a < b ? `（原 ${Math.round(b).toLocaleString()}）` : ''}`;
}
function disposeDerived(st) {
  if (!st.part || !st.base) return;
  releaseLegCache(st.part.full);
  if (st.part.geometry !== st.part.full && st.part.geometry !== st.base.geometry) st.part.geometry.dispose();
  if (st.part.full !== st.base.geometry) st.part.full.dispose();
}
function disposePart(st) {
  disposeDerived(st);
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
const liveEditSlot = () => (state.edit === 'lattice' || state.edit === 'sculpt' ? state.selected : null);

function assemble({ keepCamera = true } = {}) {
  const first = !current;
  tc.detach(); removeLatticeUI(); removeRefPlane();
  const keep = new Set();
  for (const s of SLOTS) {
    const st = state.slots[s.id];
    if (st.base) { keep.add(st.base.geometry); keep.add(st.base.material); }
    if (st.part) { keep.add(st.part.geometry); keep.add(st.part.full); }
  }
  if (sc) keep.add(sc.geom);
  if (current) {
    scene.remove(current.root);
    current.root.traverse((o) => {
      if (!o.isMesh || o.userData.helper) return;
      if (!keep.has(o.geometry) && !o.geometry.userData.cached) o.geometry.dispose();
      if (!keep.has(o.material)) o.material.dispose();
    });
  }
  if (mixer) mixer.stopAllAction();
  current = buildCharacter(partsMap(), { ...state.settings, mode: state.mode, live: true, editSlot: liveEditSlot() });
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
function applySolo() {
  if (!current) return;
  const on = view.solo && state.selected && state.slots[state.selected].part;
  current.root.traverse((o) => { if (o.isMesh && !o.userData.helper) o.visible = !on || o.userData.slot === state.selected; });
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
toggleBtn('#tSolo', 'solo', applySolo);
toggleBtn('#tSockets', 'sockets', () => current && current.root.traverse((o) => { if (o.userData.helper && o.name === 'helper') o.visible = view.sockets; }));
toggleBtn('#tSpin', 'spin', () => { if (!view.spin && current) current.root.rotation.y = 0; if (view.spin && cam !== camera) setPreset('persp'); });
$('#tView').addEventListener('click', () => { if (current) current.root.rotation.y = 0; frame(!!state.selected); });

// ============================================================== editing (gizmo + lattice + sculpt)
const EDIT_HINT = {
  translate: '拖曳箭頭移動部位',
  rotate: '拖曳圓環旋轉部位',
  scale: '拖曳方塊調整寬 / 高 / 深',
  lattice: '點紅色控制點後拖曳箭頭，整體變形',
  sculpt: '在模型上按住拖曳來捏塑；在空白處拖曳轉動視角',
};
function setEdit(mode) {
  if (state.edit === 'sculpt' && mode !== 'sculpt') flushSculpt();
  state.edit = mode;
  $$('#editBar [data-edit]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.edit === mode));
  $('#sculptPanel').hidden = mode !== 'sculpt';
  vp.classList.toggle('sculpting', mode === 'sculpt');
  if (mode !== 'view') {
    if (current) current.root.rotation.y = 0;
    view.spin = false; $('#tSpin').setAttribute('aria-pressed', false);
    if (!state.selected || !state.slots[state.selected].part) {
      const first = activeSlots().find((s) => state.slots[s.id].part);
      if (first) state.selected = first.id;
      highlightCards();
    }
  }
  if (mode !== 'lattice') state.latticeSel = null;
  if (mode !== 'sculpt') brushCursor.visible = false;
  assemble(); // rest pose for editing, animation for viewing; rebuilds with the right edit slot
}
$('#editBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-edit]');
  if (b) setEdit(b.dataset.edit);
});

function slotMeshes(id) {
  const out = [];
  if (current && id) current.root.traverse((o) => { if (o.isMesh && o.userData.slot === id && o.userData.editable) out.push(o); });
  return out;
}
const editableMesh = (id) => slotMeshes(id).find((m) => m.userData.base.primary) || null;

let latticeUI = null; // { group, handles, lines, mesh, id }
function removeLatticeUI() {
  if (!latticeUI) return;
  latticeUI.group.parent && latticeUI.group.parent.remove(latticeUI.group);
  latticeUI.group.traverse((o) => { if (o.geometry && o.geometry !== HANDLE_GEO) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  latticeUI = null;
}

function updateHint() {
  const hint = $('#editHint');
  const parts = [];
  const id = state.selected;
  if (state.edit !== 'view') {
    if (!id) parts.push('點選模型上的部位開始編輯');
    else if (!state.slots[id].part) parts.push(`「${SLOT_BY_ID[id].name}」需要先上傳圖片才能編輯`);
    else parts.push(`${SLOT_BY_ID[id].name} · ${EDIT_HINT[state.edit]}`);
  }
  if (state.preset !== 'persp') {
    const names = { front: '正面', back: '背面', side: '側面', top: '頂部' };
    const want = PRESET_VIEW[state.preset];
    if (!state.ref.on) parts.push('正交視圖（左鍵拖曳平移、滾輪縮放）');
    else if (!id || !state.slots[id].part) parts.push('選一個部位即可疊上它的參考圖');
    else if (refViewFor(id)) parts.push(`已疊上「${names[want]}」參考圖`);
    else parts.push(`這個部位沒有上傳「${names[want]}」圖`);
  }
  hint.hidden = !parts.length;
  hint.textContent = parts.join(' ｜ ');
}

function refreshGizmo() {
  tc.detach();
  removeLatticeUI();
  applySolo();
  const id = state.selected;
  if (state.edit !== 'sculpt' || !id || sc?.id !== id) dropSculptSession();
  if (current && id && state.edit !== 'view') {
    const mesh = editableMesh(id);
    if (mesh) {
      if (state.edit === 'lattice') buildLatticeUI(id, mesh);
      else if (state.edit === 'sculpt') setupSculpt(id);
      else {
        tc.setMode(state.edit);
        tc.setSpace(state.edit === 'translate' ? 'world' : 'local');
        tc.attach(mesh);
      }
    }
  }
  updateRefPlane();
  updateHint();
}

const HANDLE_GEO = new THREE.SphereGeometry(1, 14, 10);
function buildLatticeUI(id, mesh) {
  const st = state.slots[id];
  const box = st.part.cageBox;
  const offs = latticeOffsets(st.params);
  const group = new THREE.Group(); group.userData.helper = true; group.name = 'lattice';
  const s = mesh.scale.y || 1;
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
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff3d71, depthTest: false, transparent: true, opacity: 0.55 }));
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
  activeControls().enabled = !e.value;
  if (!e.value) onDragEnd();
});
tc.addEventListener('objectChange', () => {
  const obj = tc.object;
  if (!obj) return;
  if (obj.userData.ijk) return onHandleMove(obj);
  const id = obj.userData.slot, st = state.slots[id];
  if (state.edit === 'translate' || state.edit === 'rotate') {
    paramsFromMesh(obj, st.params);
    for (const m of slotMeshes(id)) if (m !== obj) applyParamsToMesh(m, st.params);
    syncCardVectors(id);
  } else if (state.edit === 'scale') {
    for (const m of slotMeshes(id)) if (m !== obj) m.scale.set(obj.scale.x * (m.userData.base.flip ? -1 : 1), obj.scale.y, obj.scale.z);
  }
});

function onHandleMove(h) {
  const id = latticeUI.id, st = state.slots[id], p = st.params;
  const box = st.part.cageBox;
  const size = box.getSize(new THREE.Vector3());
  const [i, j, k] = h.userData.ijk;
  const taperOnly = latticeOffsets({ ...p, lattice: null });
  if (!p.lattice) p.lattice = new Array(LATTICE_N * 3).fill(0);
  const q = latticeIndex(i, j, k) * 3;
  p.lattice[q] = r4((h.position.x - box.min.x) / Math.max(size.x, 1e-6) - i / 2 - taperOnly[q]);
  p.lattice[q + 1] = r4((h.position.y - box.min.y) / Math.max(size.y, 1e-6) - j / 2 - taperOnly[q + 1]);
  p.lattice[q + 2] = r4((h.position.z - box.min.z) / Math.max(size.z, 1e-6) - k / 2 - taperOnly[q + 2]);
  if (p.latticeMirror && i !== 1) {
    const mq = latticeIndex(2 - i, j, k) * 3;
    p.lattice[mq] = -p.lattice[q]; p.lattice[mq + 1] = p.lattice[q + 1]; p.lattice[mq + 2] = p.lattice[q + 2];
  } else if (p.latticeMirror && i === 1) {
    p.lattice[q] = 0; // symmetric editing: centre column only moves up/down/front/back
  }
  const offs = latticeOffsets(p);
  for (const m of latticeUI.handles) {
    if (m === h && !(p.latticeMirror && i === 1)) continue;
    const [a, b, c] = m.userData.ijk;
    latticePoint(box, offs, a, b, c, m.position);
  }
  updateLatticeLines();
  // live preview (full resolution) on every mesh of this part
  const { geometry } = deformPart(st.base.geometry, p, p.sculpt.length ? topoOf(st) : null);
  for (const m of slotMeshes(id)) m.geometry = geometry;
  if (liveGeom) liveGeom.dispose();
  liveGeom = geometry;
}

function onDragEnd() {
  const obj = tc.object;
  if (!obj) return;
  if (obj.userData.ijk) {
    const id = latticeUI.id;
    applyDeform(id); commit(id); updateCard(id);
    assemble();
    if (liveGeom) { liveGeom.dispose(); liveGeom = null; }
    return;
  }
  const id = obj.userData.slot, st = state.slots[id];
  if (state.edit === 'scale') {
    const b = obj.userData.base.scale;
    st.params.stretch = st.params.stretch.map((v, i) => +Math.min(5, Math.max(0.1, v * Math.abs(obj.scale.getComponent(i)) / b)).toFixed(3));
    applyDeform(id);
  }
  commit(id); syncCardInputs(id);
  assemble();
}

// ---------------------------------------------------------------- sculpting
let sc = null; // { id, version, topo, geom, gp, gn, r, stroke }
function dropSculptSession() {
  if (!sc) return;
  const g = sc.geom; sc = null;
  // meshes still using it are replaced by the next assemble
  setTimeout(() => g.dispose(), 0);
}
/** Bake live strokes into the part (polygon budget etc.). Call before leaving sculpt mode / exporting. */
function flushSculpt() {
  if (!sc) return;
  const { id, dirty } = sc;
  dropSculptSession();
  if (dirty) { applyDeform(id); updateCard(id); }
}
/** Bake live strokes into the part but keep sculpting (used before exporting). */
function bakeSculpt() {
  if (!sc || !sc.dirty) return;
  applyDeform(sc.id); updateCard(sc.id);
  sc.dirty = false; sc.version = state.slots[sc.id].version;
}
function setupSculpt(id) {
  const st = state.slots[id];
  if (!st.base.geometry.index) { brushCursor.visible = false; $('#editHint').textContent = '平面卡片不支援雕刻，請改用其他轉換方式'; return; }
  if (!sc || sc.id !== id || sc.version !== st.version) {
    if (sc) dropSculptSession();
    const topo = topoOf(st);
    const geom = st.part.full.clone();
    const gp = SC.readGroups(topo, geom);
    sc = { id, version: st.version, topo, geom, gp, gn: SC.groupNormals(topo, gp), stroke: null, dirty: false };
    geom.computeBoundingBox();
    const s = geom.boundingBox.getSize(new THREE.Vector3());
    sc.dim = Math.max(s.x, s.y, s.z);
  }
  for (const m of slotMeshes(id)) m.geometry = sc.geom;
}
const brushRadius = () => r4(sc ? sc.dim * state.brush.size * 0.5 : 0.1);

const ray = new THREE.Raycaster();
function setRay(e) {
  const rect = dom.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), cam);
}
function sculptHit(e) {
  if (!sc) return null;
  setRay(e);
  return ray.intersectObjects(slotMeshes(sc.id), false)[0] || null;
}
function showBrush(hit) {
  if (!hit) { brushCursor.visible = false; return; }
  const m = hit.object;
  const n = hit.face.normal.clone().transformDirection(m.matrixWorld);
  brushCursor.position.copy(hit.point);
  brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  brushCursor.scale.setScalar(brushRadius() * Math.abs(m.getWorldScale(new THREE.Vector3()).y));
  brushCursor.visible = true;
}
function sculptWrite() {
  SC.groupNormals(sc.topo, sc.gp, sc.gn);
  SC.writeGroups(sc.topo, sc.geom, sc.gp, sc.gn);
}
function brushTypeFor(e) {
  let t = state.brush.type, s = state.brush.strength;
  if (e.shiftKey) return { t: 'smooth', s };
  if (t === 'deflate') return { t: 'inflate', s: e.ctrlKey || e.metaKey ? s : -s };
  if (t === 'inflate') return { t, s: e.ctrlKey || e.metaKey ? -s : s };
  return { t, s };
}
function sculptDab(local, st) {
  const c = [r4(local.x), r4(local.y), r4(local.z)];
  SC.applyDab(sc.topo, sc.gp, st.gn0, st.t, c, st.r, st.s);
  if (st.sym && Math.abs(c[0]) > st.r * 0.05) SC.applyDab(sc.topo, sc.gp, st.gn0, st.t, [-c[0], c[1], c[2]], st.r, st.s);
  st.dabs.push(c[0], c[1], c[2]);
  st.last = local.clone();
}

dom.addEventListener('pointerdown', (e) => {
  if (state.edit !== 'sculpt' || !sc || e.button !== 0) return;
  const hit = sculptHit(e);
  if (!hit) return;
  // start a stroke — keep the camera still
  activeControls().enabled = false;
  dom.setPointerCapture(e.pointerId);
  const mesh = hit.object;
  const local = mesh.worldToLocal(hit.point.clone());
  const { t, s } = brushTypeFor(e);
  const st = { t, s, r: brushRadius(), sym: state.brush.sym, mesh, dabs: [], gn0: sc.gn.slice() };
  if (t === 'grab') {
    st.from = sc.gp.slice();
    st.c = [r4(local.x), r4(local.y), r4(local.z)];
    st.d = [0, 0, 0];
    st.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(cam.getWorldDirection(new THREE.Vector3()), hit.point);
    st.local0 = local.clone();
  } else {
    sculptDab(local, st);
    sculptWrite();
  }
  sc.stroke = st;
}, { capture: true });

dom.addEventListener('pointermove', (e) => {
  if (state.edit !== 'sculpt' || !sc) return;
  const st = sc.stroke;
  if (!st) { showBrush(sculptHit(e)); return; }
  if (st.t === 'grab') {
    setRay(e);
    const p = ray.ray.intersectPlane(st.plane, new THREE.Vector3());
    if (!p) return;
    const l = st.mesh.worldToLocal(p.clone());
    st.d = [r4(l.x - st.local0.x), r4(l.y - st.local0.y), r4(l.z - st.local0.z)];
    SC.applyGrab(sc.topo, sc.gp, st.from, st.c, st.r, st.d);
    if (st.sym && Math.abs(st.c[0]) > st.r * 0.05) {
      const mid = sc.gp.slice();
      SC.applyGrab(sc.topo, sc.gp, mid, [-st.c[0], st.c[1], st.c[2]], st.r, [-st.d[0], st.d[1], st.d[2]]);
    }
    sculptWrite();
    brushCursor.position.copy(p);
  } else {
    const hit = sculptHit(e);
    if (!hit) return;
    showBrush(hit);
    // both meshes of a mirrored pair share one geometry, so local coordinates are interchangeable
    const local = hit.object.worldToLocal(hit.point.clone());
    if (local.distanceTo(st.last) < st.r * 0.3) return;
    sculptDab(local, st);
    sculptWrite();
  }
});

function endStroke(e) {
  if (!sc || !sc.stroke) return;
  const st = sc.stroke; sc.stroke = null;
  activeControls().enabled = true;
  try { dom.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
  let rec = null;
  if (st.t === 'grab') {
    if (Math.hypot(...st.d) > 1e-4) rec = { t: 'grab', r: st.r, sym: st.sym, c: st.c, d: st.d };
  } else if (st.dabs.length) rec = { t: st.t, r: st.r, s: st.s, sym: st.sym, dabs: st.dabs };
  if (!rec) return;
  const id = sc.id, S = state.slots[id];
  S.params.sculpt.push(rec);
  sc.dirty = true;
  commit(id);
  updateCard(id);
}
dom.addEventListener('pointerup', endStroke);
dom.addEventListener('pointercancel', endStroke);
dom.addEventListener('pointerleave', () => { if (!sc?.stroke) brushCursor.visible = false; });

// sculpt panel
function renderBrushPanel() {
  $('#brushList').innerHTML = Object.entries(SC.BRUSHES).map(([k, b]) => `<button type="button" data-brush="${k}" aria-pressed="${state.brush.type === k}" title="${b.tip} (${b.key})">${b.name}</button>`).join('');
  $('#brushSize').value = state.brush.size; $('#brushSizeOut').textContent = Math.round(state.brush.size * 100) + '%';
  $('#brushStr').value = state.brush.strength; $('#brushStrOut').textContent = Math.round(state.brush.strength * 100) + '%';
  $('#brushSym').checked = state.brush.sym;
  $('#brushTip').textContent = SC.BRUSHES[state.brush.type].tip;
}
$('#brushList').addEventListener('click', (e) => { const b = e.target.closest('[data-brush]'); if (b) { state.brush.type = b.dataset.brush; renderBrushPanel(); } });
$('#brushSize').addEventListener('input', (e) => { state.brush.size = +e.target.value; renderBrushPanel(); });
$('#brushStr').addEventListener('input', (e) => { state.brush.strength = +e.target.value; renderBrushPanel(); });
$('#brushSym').addEventListener('change', (e) => { state.brush.sym = e.target.checked; });
$('#sculptClear').addEventListener('click', () => {
  const id = state.selected; if (!id || !state.slots[id].part) return;
  if (!state.slots[id].params.sculpt.length) { toast('這個部位沒有雕刻'); return; }
  state.slots[id].params.sculpt = [];
  dropSculptSession(); applyDeform(id); commit(id); updateCard(id); assemble();
});
renderBrushPanel();

// picking: click on a part selects its card (and lattice points in lattice mode)
let downAt = null;
dom.addEventListener('pointerdown', (e) => { downAt = tc.axis || sc?.stroke ? null : [e.clientX, e.clientY]; });
dom.addEventListener('pointerup', (e) => {
  if (!downAt || !current || tc.dragging) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  setRay(e);
  if (state.edit === 'lattice' && latticeUI) {
    const h = ray.intersectObjects(latticeUI.handles, false)[0];
    if (h) { state.latticeSel = h.object.userData.ijk; refreshGizmo(); return; }
  }
  const hit = ray.intersectObjects(current.pickable.filter((o) => o.visible), false)[0];
  if (hit) { if (hit.object.userData.slot !== state.selected) selectSlot(hit.object.userData.slot, true); }
  else if (state.edit !== 'view' && state.edit !== 'sculpt') { state.latticeSel = null; refreshGizmo(); }
});
dom.addEventListener('dblclick', (e) => {
  setRay(e);
  const hit = current && ray.intersectObjects(current.pickable.filter((o) => o.visible), false)[0];
  if (hit) { selectSlot(hit.object.userData.slot, true); frame(true); }
});

// ============================================================== undo / redo
const history = { undo: [], redo: [] };
function commit(id) {
  const st = state.slots[id];
  const now = JSON.stringify(st.params);
  if (now === st.snapshot) return;
  history.undo.push({ id, before: st.snapshot, after: now });
  if (history.undo.length > 120) history.undo.shift();
  history.redo = [];
  st.snapshot = now;
  updateUndoButtons();
  touch();
}
function restoreParams(id, json) {
  const st = state.slots[id];
  const prev = st.params;
  st.params = JSON.parse(json);
  st.snapshot = json;
  const reconvert = CONVERT_KEYS.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(st.params[k]));
  rerenderCard(id);
  dropSculptSession();
  if (reconvert) scheduleConvert(id, 0);
  else { applyDeform(id); updateCard(id); assemble(); }
  touch();
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
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  const tools = { q: 'view', w: 'translate', e: 'rotate', r: 'scale', t: 'lattice', b: 'sculpt' };
  if (tools[k]) { setEdit(tools[k]); return; }
  const presets = { 0: 'persp', 1: 'front', 2: 'back', 3: 'right', 4: 'left', 5: 'top' };
  if (presets[k]) { setPreset(presets[k]); return; }
  if (k === 'f') { frame(!!state.selected); return; }
  if (k === 'h') { $('#tSolo').click(); return; }
  if (state.edit === 'sculpt') {
    const brush = Object.entries(SC.BRUSHES).find(([, b]) => b.key.toLowerCase() === k);
    if (brush) { state.brush.type = brush[0]; renderBrushPanel(); return; }
    if (k === '[' || k === ']') {
      state.brush.size = Math.min(0.6, Math.max(0.04, state.brush.size * (k === ']' ? 1.15 : 1 / 1.15)));
      renderBrushPanel(); return;
    }
  }
  if (e.key === 'Escape') { state.latticeSel = null; refreshGizmo(); }
});

// ============================================================== slot cards
const TABS = [['img', '圖片'], ['shape', '成形'], ['tune', '微調'], ['place', '擺放']];
const SHAPE_RANGES = [
  ['depth', '厚度 / 深度', 0.1, 3, 0.05],
  ['roundness', '圓潤度', 0, 1, 0.05],
  ['smooth', '表面平滑', 0, 6, 1],
];
const STRETCH_RANGES = [
  ['stretch.0', '寬', 0.3, 2.5, 0.05],
  ['stretch.1', '高', 0.3, 2.5, 0.05],
  ['stretch.2', '深', 0.3, 2.5, 0.05],
];
const TAPER_RANGES = [
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
const EYE_ON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.7 8.5 2 12 2 12s3.6 7 10 7c1.6 0 3-.4 4.3-1.1"/></svg>';

const rangeHTML = (p, [path, label, min, max, step], cls = '') => `
  <label class="field ${cls}"><span>${label}<output>${getPath(p, path)}</output></span>
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
  const autoName = (k) => MODES[k].split(' ')[0];
  const modeOpts = Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${p.mode === k ? 'selected' : ''}>${k === 'auto' ? `${v}（無側面：${autoName(s.mode)}／有側面：${autoName(s.sideMode || 'hull')}）` : v}</option>`).join('');
  const roleSel = (vid, name) => `<label class="field" data-role="${vid}"><span>${name}圖用途</span><select data-path="roles.${vid}">${ROLE_OPTS.map(([k, t]) => `<option value="${k}" ${p.roles[vid] === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
  const vec = (key, step) => `<div class="vec">${[0, 1, 2].map((i) => `<input type="number" step="${step}" data-path="${key}.${i}" value="${p[key][i]}" aria-label="${key} ${'XYZ'[i]}">`).join('')}</div>`;
  return `
  <section class="card slot ${st.open ? 'open' : ''}" data-slot="${s.id}">
    <div class="card-head slot-head">
      <button class="head-main" data-toggle>
        <span class="ico">${icon(s.icon)}</span>
        <span class="title">${s.name}<small>${s.en}</small></span>
        <span class="tune-dot" hidden title="已手動調整"></span>
        <span class="badge"></span>
        <span class="chev"></span>
      </button>
      <button class="eye" data-act="eye" title="顯示 / 隱藏" aria-pressed="${p.visible}">${p.visible ? EYE_ON : EYE_OFF}</button>
    </div>
    <div class="card-body">
      <div class="tabs" role="tablist">${TABS.map(([k, t], i) => `<button role="tab" data-tab="${k}" aria-selected="${st.tab === k}"><b>${i + 1}</b>${t}</button>`).join('')}</div>

      <div class="pane ${st.tab === 'img' ? 'on' : ''}" data-pane="img">
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
          <div class="match" hidden></div>
          ${roleSel('side', '側面')}
          ${roleSel('top', '頂部')}
        </div>
        <div class="ctrls">
          <label class="field check"><input type="checkbox" data-path="removeBg" ${p.removeBg ? 'checked' : ''}><span>自動去背</span></label>
          ${rangeHTML(p, ['tolerance', '去背容差', 0, 100, 1])}
        </div>
        <div class="info"></div>
      </div>

      <div class="pane ${st.tab === 'shape' ? 'on' : ''}" data-pane="shape">
        <div class="ctrls">
          <label class="field full"><span>轉換方式</span><select data-path="mode">${modeOpts}</select></label>
          ${SHAPE_RANGES.map((r) => rangeHTML(p, r)).join('')}
          <label class="field full"><span>背面（沒有背面圖時）</span>
            <select data-path="backFill">
              <option value="mirror" ${p.backFill === 'mirror' ? 'selected' : ''}>沿用正面圖案（對稱物件）</option>
              <option value="color" ${p.backFill === 'color' ? 'selected' : ''}>以頂部主色填補（頭髮、背面單色）</option>
            </select></label>
        </div>
        <div class="info"></div>
      </div>

      <div class="pane ${st.tab === 'tune' ? 'on' : ''}" data-pane="tune">
        <p class="tip-box">切到<b>正 / 側 / 頂</b>視圖並開啟<b>參考圖</b>，原圖會疊在模型上，邊看邊修最準。</p>
        <div class="tool-grid">
          <button type="button" data-goedit="sculpt" class="primary" title="用筆刷直接捏塑 (B)">雕刻</button>
          <button type="button" data-goedit="lattice" title="拖曳 27 個控制點整體變形 (T)">變形籠</button>
          <button type="button" data-goedit="scale" title="拉伸寬 / 高 / 深 (R)">縮放</button>
          <button type="button" data-goview="front" title="正視圖 + 參考圖">對照正面</button>
          <button type="button" data-goview="right" title="側視圖 + 參考圖">對照側面</button>
        </div>
        <div class="ctrls">
          <div class="full sep">整體拉伸</div>
          ${STRETCH_RANGES.map((r) => rangeHTML(p, r)).join('')}
          <details class="adv" ${st.taperOpen ? 'open' : ''} data-keep="taperOpen">
            <summary>分段寬深、彎曲、扭轉</summary>
            <div class="ctrls">
              ${TAPER_RANGES.map((r) => rangeHTML(p, r)).join('')}
              <label class="field check full"><input type="checkbox" data-path="latticeMirror" ${p.latticeMirror ? 'checked' : ''}><span>變形籠控制點左右對稱</span></label>
            </div>
          </details>
          <p class="note full tune-info"></p>
          <div class="full btn-row">
            <button type="button" class="btn small" data-act="reset-sculpt">清除雕刻</button>
            <button type="button" class="btn small" data-act="reset-points">清除控制點</button>
            <button type="button" class="btn small" data-act="reset-shape">全部重設</button>
          </div>
        </div>
      </div>

      <div class="pane ${st.tab === 'place' ? 'on' : ''}" data-pane="place">
        <div class="tool-grid" style="grid-template-columns:repeat(2,1fr)">
          <button type="button" data-goedit="translate" title="在 3D 中拖曳移動 (W)">在 3D 中移動</button>
          <button type="button" data-goedit="rotate" title="在 3D 中拖曳旋轉 (E)">在 3D 中旋轉</button>
        </div>
        <div class="ctrls">
          ${rangeHTML(p, ['size', '大小', 0.3, 2.5, 0.05], 'full')}
          <div class="field full"><span>位置偏移 X / Y / Z（頭身單位）</span>${vec('offset', 0.05)}</div>
          <div class="field full"><span>旋轉 X / Y / Z（度）</span>${vec('rotation', 5)}</div>
          ${s.id === 'legs' ? `<label class="field check full"><input type="checkbox" data-path="splitLegs" ${p.splitLegs ? 'checked' : ''}><span>左右腿分開（走路動畫各自擺動）</span></label>` : ''}
          <div class="full btn-row"><button type="button" class="btn small" data-act="reset-place">重設大小、位置與旋轉</button></div>
        </div>
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
    dropSculptSession(); applyDeform(id); updateCard(id); assembleSoon();
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
  $$('[data-tab]', card).forEach((b) => b.addEventListener('click', () => setTab(id, b.dataset.tab)));
  $$('details[data-keep]', card).forEach((d) => d.addEventListener('toggle', () => { S()[d.dataset.keep] = d.open; }));
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
  const needPart = () => { if (S().part) return true; toast('請先上傳正面圖並完成轉換'); return false; };
  $$('[data-goedit]', card).forEach((b) => b.addEventListener('click', () => {
    if (!needPart()) return;
    state.selected = id; highlightCards(); setEdit(b.dataset.goedit);
  }));
  $$('[data-goview]', card).forEach((b) => b.addEventListener('click', () => {
    if (!needPart()) return;
    state.selected = id; highlightCards();
    state.ref.on = true; $('#tRef').setAttribute('aria-pressed', true);
    view.solo = true; $('#tSolo').setAttribute('aria-pressed', true); // other parts would hide the comparison
    refreshGizmo(); setPreset(b.dataset.goview);
    if (!refViewFor(id)) toast(b.dataset.goview === 'right' ? '這個部位沒有上傳側面圖，無法疊圖比對' : '沒有可比對的圖');
  }));
  $('[data-act="eye"]', card).addEventListener('click', () => {
    S().params.visible = !S().params.visible; commit(id); updateCard(id); assemble();
  });
  $('[data-act="align"]', card).addEventListener('click', () => openAlign(id));
  const resetTune = (fn) => () => { fn(S().params); dropSculptSession(); applyDeform(id); commit(id); rerenderCard(id); assemble(); };
  $('[data-act="reset-sculpt"]', card).addEventListener('click', resetTune((p) => { p.sculpt = []; }));
  $('[data-act="reset-points"]', card).addEventListener('click', resetTune((p) => { p.lattice = null; }));
  $('[data-act="reset-shape"]', card).addEventListener('click', resetTune((p) => {
    const d = defaultParams(SLOT_BY_ID[id]);
    Object.assign(p, { stretch: d.stretch, taper: d.taper, lattice: null, sculpt: [] });
  }));
  $('[data-act="reset-place"]', card).addEventListener('click', () => {
    Object.assign(S().params, { offset: [0, 0, 0], rotation: [0, 0, 0], size: 1 });
    commit(id); syncCardInputs(id); assemble();
  });
  $('[data-act="clear"]', card).addEventListener('click', () => {
    const open = S().open;
    if (sc?.id === id) dropSculptSession();
    disposePart(S());
    state.slots[id] = freshSlot(SLOT_BY_ID[id]); state.slots[id].open = open;
    history.undo = history.undo.filter((h) => h.id !== id); history.redo = history.redo.filter((h) => h.id !== id); updateUndoButtons();
    rerenderCard(id); assemble(); touch();
  });
  $('[data-act="export"]', card).addEventListener('click', () => exportSinglePart(id));
  updateCard(id);
}

function setTab(id, tab) {
  const card = $(`.card[data-slot="${id}"]`);
  state.slots[id].tab = tab;
  if (!card) return;
  $$('[data-tab]', card).forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
  $$('[data-pane]', card).forEach((p) => p.classList.toggle('on', p.dataset.pane === tab));
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
  const st = state.slots[id], s = SLOT_BY_ID[id], p = st.params;
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
  const eye = $('.eye', card);
  eye.setAttribute('aria-pressed', p.visible); eye.innerHTML = p.visible ? EYE_ON : EYE_OFF;
  card.classList.toggle('hidden-part', !p.visible);
  $('.tune-dot', card).hidden = !hasDeform(p);
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
  $('[data-act="align"] .dot-mark', card).hidden = !extra.some((v) => !isIdentityAlign(p.align[v]));
  const match = $('.match', card);
  match.hidden = !(st.views.back && st.match != null);
  if (!match.hidden) {
    const pct = Math.round(st.match * 100);
    match.textContent = pct >= 85 ? `背面與正面輪廓吻合度 ${pct}%` : `背面與正面輪廓吻合度只有 ${pct}%，建議按上方「對齊三視圖」（可用自動對齊）`;
    match.classList.toggle('warn', pct < 85);
  }
  let info = st.info;
  if (st.status === 'ok' && !st.views.side && !st.views.top) info += ' · 加入側面圖可讓深度依照你的設計';
  for (const el of $$('.info', card)) { el.textContent = info; el.classList.toggle('err', st.status === 'err'); }
  const moved = p.lattice ? p.lattice.filter((v, i) => i % 3 === 0 && (Math.abs(v) + Math.abs(p.lattice[i + 1]) + Math.abs(p.lattice[i + 2])) > 1e-4).length : 0;
  const bits = [];
  if (p.sculpt.length) bits.push(`雕刻 ${p.sculpt.length} 筆`);
  if (moved) bits.push(`控制點 ${moved} 個`);
  $('.tune-info', card).textContent = bits.length ? `已套用：${bits.join('、')}。重新轉換時會自動保留。` : '';
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
  if (state.edit === 'sculpt' && sc && sc.id !== id) flushSculpt();
  const changed = state.selected !== id;
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
  // lattice / sculpt on legs needs the unsplit mesh → rebuild when the edited slot changes
  if (changed && (state.edit === 'lattice' || state.edit === 'sculpt')) assemble();
  else refreshGizmo();
}

// ============================================================== settings
function bindSettings() {
  const card = $('#settingsCard');
  $('[data-toggle]', card).addEventListener('click', () => card.classList.toggle('open'));
  $('#setName').addEventListener('input', (e) => { state.settings.name = e.target.value; $('#expName').value = e.target.value; touch(); });
  for (const [sel, key] of [['#setSkin', 'skin'], ['#setShirt', 'shirt'], ['#setPants', 'pants']]) {
    $(sel).addEventListener('input', (e) => { state.settings.colors[key] = e.target.value; assembleSoon(); touch(); });
  }
  $('#setQuality').addEventListener('change', (e) => { state.settings.quality = e.target.value; reconvertAll(); });
  $('#setAtlas').addEventListener('change', (e) => { state.settings.atlas = +e.target.value; reconvertAll(); });
  $('#setBudget').addEventListener('change', (e) => {
    state.settings.budget = e.target.value;
    dropSculptSession();
    for (const s of SLOTS) if (state.slots[s.id].base) { applyDeform(s.id); updateCard(s.id); }
    assemble(); touch();
    toast(`面數預算：${BUDGETS[e.target.value].name} · 共 ${totalTris().tris.toLocaleString()} 三角形`);
  });
}
function syncSettingsUI() {
  $('#setName').value = state.settings.name; $('#expName').value = state.settings.name;
  $('#setSkin').value = state.settings.colors.skin; $('#setShirt').value = state.settings.colors.shirt; $('#setPants').value = state.settings.colors.pants;
  $('#setQuality').value = state.settings.quality; $('#setAtlas').value = state.settings.atlas; $('#setBudget').value = state.settings.budget;
}
function reconvertAll() {
  for (const s of activeSlots()) if (state.slots[s.id].views.front) scheduleConvert(s.id, 0);
}

// ============================================================== mode tabs
$$('.seg [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(mode) {
  flushSculpt();
  state.mode = mode;
  $$('.seg [data-mode]').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === mode));
  state.anim = mode === 'object' ? 'Rest' : 'Idle';
  state.selected = mode === 'object' ? 'object' : null;
  if (mode === 'object') state.slots.object.open = true;
  renderSlots();
  assemble({ keepCamera: false });
  if (state.preset !== 'persp') setPreset(state.preset);
  touch();
}

// ============================================================== samples / project / autosave
$('#btnHelp').addEventListener('click', () => $('#helpDlg').showModal());
$('#btnSample').addEventListener('click', async () => {
  flushSculpt();
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
  return { format: 'char3d-project', version: 3, savedAt: new Date().toISOString(), mode: state.mode, settings: state.settings, slots };
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
  dropSculptSession();
  for (const s of SLOTS) { disposePart(state.slots[s.id]); state.slots[s.id] = freshSlot(s); }
  state.settings = { ...state.settings, ...data.settings, colors: { ...state.settings.colors, ...(data.settings?.colors || {}) } };
  if (!BUDGETS[state.settings.budget]) state.settings.budget = 'game';
  for (const [id, sd] of Object.entries(data.slots || {})) {
    if (!state.slots[id]) continue;
    const params = mergeParams(SLOT_BY_ID[id], sd.params);
    const st = state.slots[id] = freshSlot(SLOT_BY_ID[id], params);
    for (const v of VIEWS) if (sd.views?.[v.id]) st.views[v.id] = { src: sd.views[v.id].src, flip: !!sd.views[v.id].flip };
  }
  clearHistory();
  syncSettingsUI();
  state.mode = data.mode === 'object' ? 'object' : 'character';
  state.selected = null;
  $$('.seg [data-mode]').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === state.mode));
  const firstUsed = activeSlots().find((s) => state.slots[s.id].views.front);
  if (firstUsed) state.slots[firstUsed.id].open = true; else state.slots[state.mode === 'object' ? 'object' : 'head'].open = true;
  renderSlots();
  assemble({ keepCamera: false });
  await Promise.all(SLOTS.filter((s) => state.slots[s.id].views.front).map((s) => convertSlot(s.id)));
  frame();
}
$('#btnReset').addEventListener('click', () => {
  if (!confirm('確定清除所有上傳的圖片與設定？')) return;
  dropSculptSession();
  for (const s of SLOTS) { disposePart(state.slots[s.id]); state.slots[s.id] = freshSlot(s); }
  state.slots[state.mode === 'object' ? 'object' : 'head'].open = true;
  state.selected = null;
  clearHistory();
  renderSlots(); assemble({ keepCamera: false });
  autosaveClear();
});

// autosave to IndexedDB so a refresh never loses work
const idb = () => new Promise((res, rej) => {
  const rq = indexedDB.open('char3d', 1);
  rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
  rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', mode); const rq = fn(tx.objectStore('kv'));
    tx.oncomplete = () => { db.close(); res(rq.result); }; tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
let saveTimer = null, autosaveOn = false;
function touch() {
  if (!autosaveOn) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { idbOp('readwrite', (s) => s.put(projectData(), 'autosave')).catch(() => {}); }, 1200);
}
function autosaveClear() { clearTimeout(saveTimer); idbOp('readwrite', (s) => s.delete('autosave')).catch(() => {}); }

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
  bakeSculpt();
  $('#expHeightLabel').textContent = state.mode === 'object' ? '物件高度（公尺）' : '角色身高（公尺，不含帽子）';
  $('#expName').value = state.settings.name || (state.mode === 'object' ? 'MyProp' : 'MyHero');
  const converted = activeSlots().filter((s) => state.slots[s.id].part).length;
  const tri = `模型共 ${totalTris().tris.toLocaleString()} 三角形（面數預算：${BUDGETS[state.settings.budget].name}，可在「專案設定」調整）。`;
  $('#expInfo').textContent = state.mode === 'object'
    ? (converted ? `將匯出目前的物件，包含所有手動調整。${tri}` : '尚未上傳物件圖片。')
    : `目前 ${converted} 個部位使用你的圖片，其餘身體部位使用預設形狀。${tri}座標：+Y 向上、正面朝 +Z、原點在腳底。`;
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
  // rest pose, real mirrored geometry, no wireframe
  bakeSculpt();
  const wire = view.wire; view.wire = false; applyWire();
  const built = buildCharacter(partsMap(), { ...state.settings, mode: state.mode, name: $('#expName').value || state.settings.name });
  return { built, restore: () => { view.wire = wire; applyWire(); } };
}

function previewCanvas() {
  const c = document.createElement('canvas');
  const s = Math.min(dom.width, dom.height);
  c.width = c.height = 512;
  const hide = [tc.getHelper(), brushCursor, latticeUI?.group, refPlane].filter(Boolean);
  const vis = hide.map((o) => o.visible);
  hide.forEach((o) => { o.visible = false; });
  renderer.render(scene, cam);
  c.getContext('2d').drawImage(dom, (dom.width - s) / 2, (dom.height - s) / 2, s, s, 0, 0, 512, 512);
  hide.forEach((o, i) => { o.visible = vis[i]; });
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
    return {
      slot: s.id, name: s.en, mode: st.part.mode, views: VIEWS.filter((v) => st.views[v.id]).map((v) => v.id),
      triangles: Math.round(triCount(st.part.geometry)), adjusted: hasDeform(st.params),
    };
  });
  let triangles = 0;
  built.root.traverse((o) => { if (o.isMesh) triangles += triCount(o.geometry); });
  return {
    format: 'char3d-character', version: 1, generator: 'Char3D Converter',
    name: built.root.name, type: isChar ? 'character' : 'object',
    proportions: isChar ? '3-head-tall chibi (head : torso : legs = 1 : 1 : 1)' : undefined,
    units: 'meters', height: heightM, scale, up: '+Y', forward: '+Z', origin: 'feet / bottom-center',
    triangles: Math.round(triangles), polygonBudget: state.settings.budget,
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
  exporting = true;
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
    exporting = false;
    restore();
  }
}

async function exportSinglePart(id) {
  bakeSculpt();
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
syncSettingsUI();
state.slots.head.open = true;
renderSlots();
updateUndoButtons();
assemble({ keepCamera: false });
window.__c3d = {
  state, scene, tc, SC, get camera() { return cam; }, get current() { return current; }, get latticeUI() { return latticeUI; }, get sc() { return sc; },
  convertSlot, loadProject, doExport, resolveMode, setEdit, setPreset, selectSlot, undo, redo, commit, applyDeform, assemble, flushSculpt, slotMeshes, totalTris,
};
(async () => {
  try {
    const saved = new URLSearchParams(location.search).has('fresh') ? null : await idbOp('readonly', (s) => s.get('autosave'));
    if (saved && Object.values(saved.slots || {}).some((s) => s.views && s.views.front)) {
      await loadProject(saved);
      toast('已還原上次的編輯（按「清除」可重新開始）', 3600);
    }
  } catch (e) { console.warn('autosave restore failed', e); }
  autosaveOn = true;
})();
