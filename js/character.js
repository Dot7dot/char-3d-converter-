// ---------------------------------------------------------------------------
// character.js — assembles converted parts into a rigged 3-head-tall chibi,
// with named sockets (attachment points) and baked animation clips.
//
// Units: 1 = one head height. The root's scale converts to metres on export.
// Front faces +Z, Y up (glTF convention). Character's right hand = -X.
//
// Hierarchy (node names are stable — games can rely on them):
//   <Name>
//    └ Hips
//       ├ Torso ─┬ Neck ─ Head ─┬ Socket_Hat
//       │        │              └ Socket_Face
//       │        ├ Shoulder_R ─ Arm_R ─ Socket_Hand_R
//       │        ├ Shoulder_L ─ Arm_L ─ Socket_Hand_L
//       │        └ Socket_Back
//       ├ Socket_Waist
//       ├ Leg_R ─ Socket_Foot_R
//       └ Leg_L ─ Socket_Foot_L
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const D2R = Math.PI / 180;

export function makeMaterial(part) {
  const tex = new THREE.CanvasTexture(part.atlas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.name = part.name || 'texture';
  const mat = new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.82, metalness: 0,
    alphaTest: part.alpha ? 0.5 : 0, transparent: false,
    side: part.alpha ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.name = part.name || 'material';
  return mat;
}

function colorMat(color, name) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0 });
  m.name = name;
  return m;
}

export function mirrorGeometry(src) {
  const g = src.clone();
  const p = g.getAttribute('position'), n = g.getAttribute('normal');
  for (let i = 0; i < p.count; i++) { p.setX(i, -p.getX(i)); if (n) n.setX(i, -n.getX(i)); }
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
  }
  return g;
}

/** Split an (indexed) geometry by triangle-centroid X sign → [right(-x), left(+x)] */
function splitByX(src) {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const out = [[], []];
  const attrs = ['position', 'normal', 'uv'];
  const pos = g.getAttribute('position');
  for (let t = 0; t < pos.count / 3; t++) {
    const cx = pos.getX(t * 3) + pos.getX(t * 3 + 1) + pos.getX(t * 3 + 2);
    out[cx < 0 ? 0 : 1].push(t);
  }
  return out.map((tris) => {
    if (!tris.length) return null;
    const ng = new THREE.BufferGeometry();
    for (const name of attrs) {
      const a = g.getAttribute(name); if (!a) continue;
      const arr = new Float32Array(tris.length * 3 * a.itemSize);
      tris.forEach((t, k) => arr.set(a.array.subarray(t * 3 * a.itemSize, (t + 1) * 3 * a.itemSize), k * 3 * a.itemSize));
      ng.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
    }
    return mergeVertices(ng, 1e-5);
  });
}

function dims(geom, s = 1) {
  geom.computeBoundingBox();
  const b = geom.boundingBox;
  return { w: (b.max.x - b.min.x) * s, h: (b.max.y - b.min.y) * s, d: (b.max.z - b.min.z) * s, box: b.clone() };
}

function node(name, parent, x = 0, y = 0, z = 0) {
  const o = new THREE.Group();
  o.name = name; o.position.set(x, y, z);
  if (parent) parent.add(o);
  return o;
}

function mesh(name, geom, mat, parent) {
  const m = new THREE.Mesh(geom, mat);
  m.name = name; m.castShadow = true; m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

/**
 * Remember the layout transform of a user-editable mesh, then apply the slot's
 * manual offset / rotation on top. The viewport gizmo edits these same params.
 */
function setBase(m, p, { mirror = false, primary = true, live = true } = {}) {
  m.userData.base = { pos: m.position.toArray(), scale: m.scale.x, mirror, primary, live };
  m.userData.editable = true;
  applyParamsToMesh(m, p);
}

export function applyParamsToMesh(m, p) {
  const b = m.userData.base;
  if (!b) return;
  const sx = b.mirror ? -1 : 1;
  m.position.set(b.pos[0] + p.offset[0] * sx, b.pos[1] + p.offset[1], b.pos[2] + p.offset[2]);
  m.rotation.set(p.rotation[0] * D2R, p.rotation[1] * D2R * sx, p.rotation[2] * D2R * sx);
  m.scale.setScalar(b.scale);
}

/** Inverse of applyParamsToMesh: read offset / rotation back from a moved mesh. */
export function paramsFromMesh(m, p) {
  const b = m.userData.base;
  const sx = b.mirror ? -1 : 1;
  const r = (v) => Math.round(v * 1000) / 1000;
  p.offset = [r((m.position.x - b.pos[0]) * sx), r(m.position.y - b.pos[1]), r(m.position.z - b.pos[2])];
  p.rotation = [r(m.rotation.x / D2R), r(m.rotation.y / D2R * sx), r(m.rotation.z / D2R * sx)];
}

// ----------------------------------------------------------- defaults
function defaultParts(colors) {
  const skin = colorMat(colors.skin, 'Skin'), shirt = colorMat(colors.shirt, 'Shirt'), pants = colorMat(colors.pants, 'Pants'), dark = colorMat('#2b2b33', 'Eyes');
  const head = new THREE.SphereGeometry(0.5, 40, 28); head.scale(1, 0.95, 0.9); head.translate(0, 0.475, 0);
  const eye = new THREE.SphereGeometry(0.065, 16, 12);
  const torso = new RoundedBoxGeometry(0.72, 0.92, 0.48, 4, 0.2); torso.translate(0, 0.46, 0);
  const arm = new THREE.CapsuleGeometry(0.11, 0.56, 6, 14); arm.translate(0, 0.39, 0);
  const hand = new THREE.SphereGeometry(0.13, 18, 14); hand.translate(0, 0.08, 0);
  const leg = new THREE.CapsuleGeometry(0.16, 0.66, 6, 16); leg.translate(0, 0.49, 0);
  return { skin, shirt, pants, dark, head, eye, torso, arm, hand, leg };
}

/**
 * @param parts   map slotId → { geometry, material, params, slot } (converted) — missing = default/none
 * @param settings { name, colors: {skin, shirt, pants}, mode: 'character'|'object' }
 */
export function buildCharacter(parts, settings) {
  const safeName = (settings.name || 'Character').replace(/[^\w-]+/g, '_') || 'Character';
  const root = new THREE.Group();
  root.name = safeName;
  const sockets = {};
  const pickable = [];
  const tag = (m, slot) => { m.userData.slot = slot; pickable.push(m); return m; };
  const P = (id) => parts[id] && parts[id].params.visible ? parts[id] : null;

  if (settings.mode === 'object') {
    const prop = node('Prop', root);
    const part = P('object');
    if (part) {
      const s = part.params.size;
      const m = tag(mesh('Prop_Mesh', part.geometry, part.material, prop), 'object');
      m.scale.setScalar(s);
      setBase(m, part.params);
    }
    return { root, sockets, pickable, clips: makePropClips(), height: part ? dims(part.geometry, part.params.size).h : 1 };
  }

  const D = defaultParts(settings.colors);

  // ---------------- legs
  const legsP = P('legs');
  let legH, legParts, legW, legCenters;
  if (legsP) {
    const s = legsP.params.size;
    const d = dims(legsP.geometry, s);
    legH = d.h; legW = d.w;
    if (legsP.params.splitLegs) {
      const [r, l] = splitByX(legsP.geometry);
      legParts = [r, l];
      legCenters = [r, l].map((g, i) => {
        if (!g) return (i ? 1 : -1) * d.w / 4;
        const dd = dims(g, s); return (dd.box.min.x + dd.box.max.x) / 2 * s;
      });
    } else { legParts = null; legCenters = [-d.w / 4, d.w / 4]; }
  } else { legH = 1.0 * 0.98; legW = 0.66; legCenters = [-0.17, 0.17]; }

  const hipsY = legH * 0.96;
  const hips = node('Hips', root, 0, hipsY, 0);
  const legNodes = [node('Leg_R', hips, legCenters[0], 0, 0), node('Leg_L', hips, legCenters[1], 0, 0)];
  if (legsP) {
    const s = legsP.params.size;
    if (legParts) {
      legParts.forEach((g, i) => {
        if (!g) return;
        const m = tag(mesh(i ? 'Leg_L_Mesh' : 'Leg_R_Mesh', g, legsP.material, legNodes[i]), 'legs');
        m.scale.setScalar(s); m.position.set(-legCenters[i], -hipsY, 0);
        setBase(m, legsP.params, { primary: i === 0, live: false });
      });
    } else {
      const m = tag(mesh('Legs_Mesh', legsP.geometry, legsP.material, hips), 'legs');
      m.scale.setScalar(s); m.position.set(0, -hipsY, 0);
      setBase(m, legsP.params);
    }
  } else {
    legNodes.forEach((n, i) => {
      const m = tag(mesh(i ? 'Leg_L_Mesh' : 'Leg_R_Mesh', D.leg, D.pants, n), 'legs');
      m.position.set(0, -hipsY, 0);
    });
  }
  const eachLegW = legsP ? legW / 2.2 : 0.32;

  // ---------------- torso
  const torsoP = P('torso');
  const torso = node('Torso', hips, 0, 0, 0);
  let T;
  if (torsoP) {
    const s = torsoP.params.size * torsoP.slot.size;
    T = dims(torsoP.geometry, s);
    const m = tag(mesh('Torso_Mesh', torsoP.geometry, torsoP.material, torso), 'torso');
    m.scale.setScalar(s); m.position.y = -0.06;
    setBase(m, torsoP.params);
  } else {
    T = dims(D.torso);
    const m = tag(mesh('Torso_Mesh', D.torso, D.shirt, torso), 'torso');
    m.position.y = -0.06;
  }
  const torsoTop = T.h - 0.06;

  // ---------------- head
  const neck = node('Neck', torso, 0, torsoTop - 0.05, 0);
  const head = node('Head', neck);
  const headP = P('head');
  let Hd;
  if (headP) {
    const s = headP.params.size;
    Hd = dims(headP.geometry, s);
    const m = tag(mesh('Head_Mesh', headP.geometry, headP.material, head), 'head');
    m.scale.setScalar(s); m.position.y = -0.04;
    setBase(m, headP.params);
  } else {
    Hd = dims(D.head);
    const m = tag(mesh('Head_Mesh', D.head, D.skin, head), 'head');
    m.position.y = -0.04;
    for (const sx of [-1, 1]) {
      const e = mesh(sx < 0 ? 'Eye_R' : 'Eye_L', D.eye, D.dark, head);
      e.position.set(0.17 * sx, 0.45, 0.4); e.scale.set(1, 1.4, 0.6);
      tag(e, 'head');
    }
  }
  sockets.hat = node('Socket_Hat', head, 0, Hd.h - 0.04, 0);
  sockets.face = node('Socket_Face', head, 0, Hd.h * 0.46 - 0.04, Hd.box.max.z * (headP ? headP.params.size : 1) - 0.02);

  // ---------------- arms
  const armsP = P('arms');
  let A;
  let armGeoms, armMat;
  if (armsP) {
    const s = armsP.params.size * armsP.slot.size;
    A = dims(armsP.geometry, s);
    armGeoms = [armsP.geometry, mirrorGeometry(armsP.geometry)];
    armMat = armsP.material;
  } else {
    A = { w: 0.26, h: 0.82, d: 0.26 };
  }
  const shoulderY = torsoTop - Math.min(0.16, T.h * 0.16);
  const shoulderX = T.w / 2 * 0.9 + A.w * 0.32;
  const armSign = [-1, 1];
  const shoulders = [node('Shoulder_R', torso, -shoulderX, shoulderY, 0), node('Shoulder_L', torso, shoulderX, shoulderY, 0)];
  const armNodes = shoulders.map((sh, i) => {
    const a = node(i ? 'Arm_L' : 'Arm_R', sh);
    a.rotation.z = 0.12 * armSign[i];
    if (armsP) {
      const m = tag(mesh(i ? 'Arm_L_Mesh' : 'Arm_R_Mesh', armGeoms[i], armMat, a), 'arms');
      m.scale.setScalar(armsP.params.size * armsP.slot.size); m.position.y = -A.h * 0.94;
      setBase(m, armsP.params, { mirror: i === 1, primary: i === 0 });
    } else {
      const m = tag(mesh(i ? 'Arm_L_Mesh' : 'Arm_R_Mesh', D.arm, D.shirt, a), 'arms');
      m.position.y = -0.8;
      const h = tag(mesh(i ? 'Hand_L_Mesh' : 'Hand_R_Mesh', D.hand, D.skin, a), 'arms');
      h.position.y = -0.92;
    }
    return a;
  });
  sockets.handR = node('Socket_Hand_R', armNodes[0], 0, -A.h * 0.86, 0.02);
  sockets.handL = node('Socket_Hand_L', armNodes[1], 0, -A.h * 0.86, 0.02);
  sockets.back = node('Socket_Back', torso, 0, T.h * 0.55 - 0.06, T.box.min.z * (torsoP ? torsoP.params.size * torsoP.slot.size : 1));
  sockets.waist = node('Socket_Waist', hips, 0, 0.02, 0);
  sockets.footR = node('Socket_Foot_R', legNodes[0], 0, -hipsY, 0);
  sockets.footL = node('Socket_Foot_L', legNodes[1], 0, -hipsY, 0);

  // ---------------- accessories
  const fit = (part, target, by = 'w') => {
    const d = dims(part.geometry);
    const ref = Math.max(1e-3, by === 'w' ? d.w : d.h);
    return { s: (target / ref) * part.params.size, d };
  };
  const hat = P('hat');
  if (hat) {
    const { s, d } = fit(hat, Hd.w * hat.slot.size);
    const m = tag(mesh('Hat_Mesh', hat.geometry, hat.material, sockets.hat), 'hat');
    m.scale.setScalar(s); m.position.y = -d.h * s * 0.3;
    setBase(m, hat.params);
  }
  const face = P('face');
  if (face) {
    const { s, d } = fit(face, Hd.w * face.slot.size);
    const m = tag(mesh('Face_Mesh', face.geometry, face.material, sockets.face), 'face');
    m.scale.setScalar(s); m.position.set(0, -d.h * s / 2, d.d * s * 0.35);
    setBase(m, face.params);
  }
  const back = P('back');
  if (back) {
    const { s, d } = fit(back, T.h * back.slot.size, 'h');
    const m = tag(mesh('Back_Mesh', back.geometry, back.material, sockets.back), 'back');
    m.scale.setScalar(s); m.position.set(0, -d.h * s * 0.55, d.box.min.z * s * 0.6);
    setBase(m, back.params);
  }
  for (const [id, sock, nm] of [['handR', sockets.handR, 'HandItem_R'], ['handL', sockets.handL, 'HandItem_L']]) {
    const it = P(id);
    if (!it) continue;
    const { s, d } = fit(it, it.slot.size, 'h');
    const m = tag(mesh(nm + '_Mesh', it.geometry, it.material, sock), id);
    m.scale.setScalar(s);
    m.position.set(0, -d.h * s * it.slot.grip, id === 'handL' ? 0.1 + d.d * s * 0.4 : 0.06);
    setBase(m, it.params, { mirror: id === 'handL' });
  }
  const waist = P('waist');
  if (waist) {
    const { s, d } = fit(waist, T.w * waist.slot.size);
    const m = tag(mesh('Waist_Mesh', waist.geometry, waist.material, sockets.waist), 'waist');
    m.scale.setScalar(s); m.position.y = 0.12 - d.h * s;
    setBase(m, waist.params);
  }
  const shoes = P('shoes');
  if (shoes) {
    const { s, d } = fit(shoes, eachLegW * shoes.slot.size);
    const geoms = [shoes.geometry, mirrorGeometry(shoes.geometry)];
    [sockets.footR, sockets.footL].forEach((sock, i) => {
      const m = tag(mesh(i ? 'Shoe_L_Mesh' : 'Shoe_R_Mesh', geoms[i], shoes.material, sock), 'shoes');
      m.scale.setScalar(s); m.position.set(0, 0, d.d * s * 0.12);
      setBase(m, shoes.params, { mirror: i === 1, primary: i === 0 });
    });
  }

  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  head.traverse((o) => { if (o.isMesh && o.userData.slot === 'head') box.expandByObject(o); });
  const height = Math.max(box.max.y, 1);

  return { root, sockets, pickable, height, clips: makeClips(hipsY) };
}

// ----------------------------------------------------------- animation
const q = new THREE.Quaternion(), e = new THREE.Euler();
function rot(name, times, eulers) {
  const values = [];
  for (const [x, y, z] of eulers) { q.setFromEuler(e.set(x, y, z)); values.push(q.x, q.y, q.z, q.w); }
  return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values);
}
function posY(name, times, ys, base) {
  const values = [];
  for (const y of ys) values.push(0, base + y, 0);
  return new THREE.VectorKeyframeTrack(`${name}.position`, times, values);
}

function makeClips(hipsY) {
  const clips = [];
  {
    const t = [0, 1, 2];
    clips.push(new THREE.AnimationClip('Idle', 2, [
      posY('Hips', t, [0, -0.025, 0], hipsY),
      rot('Neck', [0, 1, 2], [[0, 0, 0.03], [0.03, 0, -0.03], [0, 0, 0.03]]),
      rot('Shoulder_R', t, [[0, 0, 0], [0, 0, -0.06], [0, 0, 0]]),
      rot('Shoulder_L', t, [[0, 0, 0], [0, 0, 0.06], [0, 0, 0]]),
    ]));
  }
  {
    const t = [0, 0.25, 0.5, 0.75, 1];
    const a = 0.55;
    clips.push(new THREE.AnimationClip('Walk', 1, [
      posY('Hips', t, [0, 0.04, 0, 0.04, 0], hipsY),
      rot('Leg_R', t, [[a, 0, 0], [0, 0, 0], [-a, 0, 0], [0, 0, 0], [a, 0, 0]]),
      rot('Leg_L', t, [[-a, 0, 0], [0, 0, 0], [a, 0, 0], [0, 0, 0], [-a, 0, 0]]),
      rot('Shoulder_R', t, [[-a * 0.8, 0, 0], [0, 0, 0], [a * 0.8, 0, 0], [0, 0, 0], [-a * 0.8, 0, 0]]),
      rot('Shoulder_L', t, [[a * 0.8, 0, 0], [0, 0, 0], [-a * 0.8, 0, 0], [0, 0, 0], [a * 0.8, 0, 0]]),
      rot('Torso', t, [[0, 0.06, 0], [0, 0, 0], [0, -0.06, 0], [0, 0, 0], [0, 0.06, 0]]),
    ]));
  }
  {
    const t = [0, 0.15, 0.3, 0.45, 0.6];
    const a = 0.95;
    clips.push(new THREE.AnimationClip('Run', 0.6, [
      posY('Hips', t, [0, 0.08, 0, 0.08, 0], hipsY),
      rot('Torso', t, [[0.18, 0.1, 0], [0.18, 0, 0], [0.18, -0.1, 0], [0.18, 0, 0], [0.18, 0.1, 0]]),
      rot('Leg_R', t, [[a, 0, 0], [0, 0, 0], [-a, 0, 0], [0, 0, 0], [a, 0, 0]]),
      rot('Leg_L', t, [[-a, 0, 0], [0, 0, 0], [a, 0, 0], [0, 0, 0], [-a, 0, 0]]),
      rot('Shoulder_R', t, [[-a, 0, 0], [0, 0, 0], [a, 0, 0], [0, 0, 0], [-a, 0, 0]]),
      rot('Shoulder_L', t, [[a, 0, 0], [0, 0, 0], [-a, 0, 0], [0, 0, 0], [a, 0, 0]]),
    ]));
  }
  {
    const t = [0, 0.2, 0.5, 0.8, 1];
    clips.push(new THREE.AnimationClip('Jump', 1, [
      posY('Hips', t, [0, -0.12, 0.7, 0, 0], hipsY),
      rot('Leg_R', t, [[0, 0, 0], [0.5, 0, 0], [-0.3, 0, 0], [0.4, 0, 0], [0, 0, 0]]),
      rot('Leg_L', t, [[0, 0, 0], [0.5, 0, 0], [0.2, 0, 0], [0.4, 0, 0], [0, 0, 0]]),
      rot('Shoulder_R', t, [[0, 0, 0], [0.4, 0, 0], [0, 0, -2.4], [0.3, 0, 0], [0, 0, 0]]),
      rot('Shoulder_L', t, [[0, 0, 0], [0.4, 0, 0], [0, 0, 2.4], [0.3, 0, 0], [0, 0, 0]]),
    ]));
  }
  {
    const t = [0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8];
    clips.push(new THREE.AnimationClip('Wave', 1.8, [
      rot('Shoulder_R', t, [[0, 0, 0], [0, 0, -2.5], [0, 0, -2.1], [0, 0, -2.6], [0, 0, -2.1], [0, 0, -2.5], [0, 0, 0]]),
      rot('Neck', [0, 0.9, 1.8], [[0, 0, 0], [0, 0, -0.1], [0, 0, 0]]),
    ]));
  }
  return clips;
}

function makePropClips() {
  const t = [0, 1, 2, 3, 4];
  const ys = [0, Math.PI / 2, Math.PI, Math.PI * 1.5, Math.PI * 2];
  return [new THREE.AnimationClip('Spin', 4, [rot('Prop', t, ys.map((y) => [0, y, 0]))])];
}
