// ---------------------------------------------------------------------------
// exporter.js — every output format.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { makeCanvas } from './imageproc.js';

export const FORMATS = [
  { id: 'package', name: '遊戲套件 ZIP', ext: 'zip', badge: '推薦',
    desc: 'GLB 模型 + 貼圖 + 角色描述 JSON + 載入器 JS + 示範網頁 + 可再編輯的專案檔。直接丟進 Web Game 或遊戲 ZIP 檔。' },
  { id: 'glb', name: 'GLB', ext: 'glb', desc: 'glTF 二進位單一檔案（含貼圖、骨架節點、動畫）。Three.js / Babylon.js / PlayCanvas / Godot / Unity 通用。' },
  { id: 'gltf', name: 'glTF (.gltf)', ext: 'gltf', desc: 'JSON 文字格式，貼圖內嵌 base64，方便除錯或手動修改。' },
  { id: 'obj', name: 'OBJ + MTL', ext: 'zip', desc: '最通用的靜態模型格式（無動畫），附 PNG 貼圖。適合 Blender、建模軟體。' },
  { id: 'stl', name: 'STL', ext: 'stl', desc: '只有形狀、沒有顏色，可用於 3D 列印。' },
  { id: 'usdz', name: 'USDZ', ext: 'usdz', desc: 'Apple AR Quick Look 格式（iPhone / iPad 直接 AR 檢視）。' },
  { id: 'sprites', name: '2D 精靈圖 Sprite Sheet', ext: 'zip', desc: '把 3D 角色渲染成 8 方向 × 走路動畫格的 PNG，給 2D / 俯視角遊戲使用。' },
  { id: 'parts', name: '各部件分開 GLB', ext: 'zip', desc: '每個部件 / 配件各自一個 GLB（原點在底部中央），可當作獨立遊戲物件或換裝零件。' },
  { id: 'project', name: '專案檔 .c3d.json', ext: 'c3d.json', desc: '保存所有上傳圖片與參數，之後可再開啟繼續編輯。' },
];

// ---------------------------------------------------------------- helpers
export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function canvasToPNG(canvas) {
  return new Promise((res) => canvas.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
}

/** Clone for export: strip helpers, apply metre scale; optionally convert UVs to bottom-left origin. */
export function prepareExport(root, scale, { flipV = false } = {}) {
  const clone = root.clone(true);
  const remove = [];
  clone.traverse((o) => { if (o.userData.helper) remove.push(o); });
  remove.forEach((o) => o.parent.remove(o));
  clone.scale.setScalar(scale);
  clone.position.set(0, 0, 0);
  clone.rotation.set(0, 0, 0);
  if (flipV) {
    const texCache = new Map(), matCache = new Map();
    clone.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      const uv = g.getAttribute('uv');
      if (uv) for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      o.geometry = g;
      const m = o.material;
      if (!matCache.has(m)) {
        const nm = m.clone();
        if (m.map) {
          if (!texCache.has(m.map)) {
            const t = new THREE.CanvasTexture(m.map.image);
            t.flipY = true; t.colorSpace = THREE.SRGBColorSpace; t.name = m.map.name;
            texCache.set(m.map, t);
          }
          nm.map = texCache.get(m.map);
        }
        matCache.set(m, nm);
      }
      o.material = matCache.get(m);
    });
  }
  clone.updateMatrixWorld(true);
  return clone;
}

export async function toGLB(obj, clips, binary = true) {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(obj, { binary, animations: clips || [], onlyVisible: true, maxTextureSize: 4096 });
  return binary ? new Blob([result], { type: 'model/gltf-binary' })
    : new Blob([JSON.stringify(result, null, 1)], { type: 'model/gltf+json' });
}

function collectMaterials(obj) {
  const mats = new Map();
  obj.traverse((o) => { if (o.isMesh && !mats.has(o.material)) mats.set(o.material, null); });
  let i = 0;
  const used = new Set();
  for (const m of mats.keys()) {
    let n = (m.name || 'mat' + i).replace(/[^\w-]+/g, '_');
    while (used.has(n)) n += '_' + i;
    used.add(n); mats.set(m, n); i++;
  }
  return mats;
}

export async function toOBJ(obj, baseName) {
  const mats = collectMaterials(obj);
  let out = `# Char3D Converter OBJ\nmtllib ${baseName}.mtl\n`;
  let mtl = '# Char3D Converter MTL\n';
  const files = {};
  let vOff = 1;
  const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = g.getAttribute('uv');
    nm.getNormalMatrix(o.matrixWorld);
    out += `o ${o.name}\nusemtl ${mats.get(o.material)}\n`;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); out += `v ${v.x.toFixed(5)} ${v.y.toFixed(5)} ${v.z.toFixed(5)}\n`; }
    for (let i = 0; i < pos.count; i++) { const u = uv ? uv.getX(i) : 0, w = uv ? uv.getY(i) : 0; out += `vt ${u.toFixed(5)} ${w.toFixed(5)}\n`; }
    for (let i = 0; i < pos.count; i++) { n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); out += `vn ${n.x.toFixed(4)} ${n.y.toFixed(4)} ${n.z.toFixed(4)}\n`; }
    const idx = g.index ? g.index.array : null;
    const tc = idx ? idx.length : pos.count;
    for (let t = 0; t < tc; t += 3) {
      const a = (idx ? idx[t] : t) + vOff, b = (idx ? idx[t + 1] : t + 1) + vOff, c = (idx ? idx[t + 2] : t + 2) + vOff;
      out += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
    }
    vOff += pos.count;
  });
  for (const [m, name] of mats) {
    const col = m.color || new THREE.Color(1, 1, 1);
    mtl += `\nnewmtl ${name}\nKa 0 0 0\nKd ${col.r.toFixed(4)} ${col.g.toFixed(4)} ${col.b.toFixed(4)}\nKs 0 0 0\nd 1\nillum 1\n`;
    if (m.map && m.map.image) {
      mtl += `map_Kd textures/${name}.png\n`;
      if (m.alphaTest > 0) mtl += `map_d textures/${name}.png\n`;
      files[`textures/${name}.png`] = await canvasToPNG(m.map.image);
    }
  }
  files[`${baseName}.obj`] = strToU8(out);
  files[`${baseName}.mtl`] = strToU8(mtl);
  return files;
}

export function toSTL(obj) {
  const data = new STLExporter().parse(obj, { binary: true });
  return new Blob([data], { type: 'model/stl' });
}

export async function toUSDZ(obj) {
  const data = await new USDZExporter().parseAsync(obj);
  return new Blob([data], { type: 'model/vnd.usdz+zip' });
}

// ---------------------------------------------------------------- sprites
export async function renderSprites(root, clips, { cell = 256, frames = 4, dirs = 8, clipName = 'Walk', heightUnits = 3 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(cell, cell, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(3, 6, 5); scene.add(dl);
  const model = prepareExport(root, 1);
  const pivot = new THREE.Group(); pivot.add(model); scene.add(pivot);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.y, size.x, size.z) * 0.62 + 0.2;
  const cam = new THREE.OrthographicCamera(-span, span, span, -span, 0.1, 100);
  const cy = box.min.y + size.y / 2;
  cam.position.set(0, cy + 4, 10); cam.lookAt(0, cy, 0); // ~22° top-down — typical for 2D games
  const mixer = new THREE.AnimationMixer(model);
  const clip = clips.find((c) => c.name === clipName);
  const action = clip ? mixer.clipAction(clip) : null;
  if (action) action.play();
  const sheet = makeCanvas(cell * frames, cell * dirs);
  const ctx = sheet.getContext('2d');
  const dirNames = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'];
  for (let d = 0; d < dirs; d++) {
    pivot.rotation.y = (d / dirs) * Math.PI * 2;
    for (let f = 0; f < frames; f++) {
      if (action) { mixer.setTime((f / frames) * clip.duration); }
      renderer.render(scene, cam);
      ctx.drawImage(renderer.domElement, f * cell, d * cell);
    }
  }
  renderer.dispose();
  const meta = {
    format: 'char3d-spritesheet', version: 1, image: 'spritesheet.png',
    frameWidth: cell, frameHeight: cell, columns: frames, rows: dirs, animation: clip ? clipName : 'static',
    frameDuration: clip ? +(clip.duration / frames).toFixed(4) : 0,
    rows_direction: dirNames.slice(0, dirs).map((n, i) => ({ row: i, facing: n, degrees: i * (360 / dirs) })),
    note: 'Row 0 faces the camera (south). Each following row turns the character 45° counter-clockwise (seen from above).',
  };
  return { sheet, meta };
}

// ---------------------------------------------------------------- package
function loaderJS() {
  return `// c3d-loader.js — tiny runtime helper for Char3D Converter characters (three.js)
// Usage:
//   import { loadCharacter } from './c3d-loader.js';
//   const hero = await loadCharacter('./character.glb');
//   scene.add(hero.object);
//   hero.play('Walk');                 // Idle | Walk | Run | Jump | Wave
//   hero.attach('Socket_Hand_R', sword);
//   // in your loop: hero.update(deltaSeconds);
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadCharacter(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const object = gltf.scene;
  object.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const mixer = new THREE.AnimationMixer(object);
  const actions = Object.fromEntries(gltf.animations.map((c) => [c.name, mixer.clipAction(c)]));
  let current = null;
  const sockets = {};
  object.traverse((o) => { if (o.name.startsWith('Socket_')) sockets[o.name] = o; });
  return {
    object, mixer, actions, sockets,
    animations: Object.keys(actions),
    play(name, fade = 0.2) {
      const next = actions[name];
      if (!next || next === current) return;
      next.reset().fadeIn(fade).play();
      if (current) current.fadeOut(fade);
      current = next;
    },
    stop() { if (current) current.fadeOut(0.2); current = null; },
    attach(socketName, obj) { const s = sockets[socketName]; if (s) s.add(obj); return !!s; },
    getNode(name) { return object.getObjectByName(name); },
    update(dt) { mixer.update(dt); },
  };
}
`;
}

function demoHTML(modelFile, manifest) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${manifest.name} — Char3D demo</title>
<style>
  html,body{margin:0;height:100%;background:#20232b;color:#eee;font:14px system-ui,sans-serif;overflow:hidden}
  #hud{position:fixed;left:12px;top:12px;background:#0008;padding:10px 12px;border-radius:8px;line-height:1.6}
  kbd{background:#fff2;border-radius:4px;padding:0 5px}
</style>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
} }
</script>
</head>
<body>
<div id="hud"><b>${manifest.name}</b><br><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移動 · <kbd>Shift</kbd> 跑 · <kbd>Space</kbd> 跳 · <kbd>E</kbd> 揮手</div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadCharacter } from './c3d-loader.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio); renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x20232b);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 200);
camera.position.set(2.2, 1.8, 3.2);
const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 0.5, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(4, 8, 5); sun.castShadow = true; scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x3a4050 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(40, 40, 0x556070, 0x464c5c); grid.position.y = 0.003; scene.add(grid);

const hero = await loadCharacter('./${modelFile}');
scene.add(hero.object);
hero.play('Idle');
const keys = {};
addEventListener('keydown', (e) => { keys[e.code] = true; if (e.code === 'Space') { hero.play('Jump'); setTimeout(() => hero.play('Idle'), 900); } if (e.code === 'KeyE') hero.play('Wave'); });
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const dir = new THREE.Vector3((keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), 0, (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0));
  if (dir.lengthSq() > 0) {
    dir.normalize();
    const speed = keys.ShiftLeft ? 2.4 : 1.1;
    hero.object.position.addScaledVector(dir, speed * dt * ${manifest.height});
    hero.object.rotation.y = Math.atan2(dir.x, dir.z);
    hero.play(keys.ShiftLeft ? 'Run' : 'Walk');
  } else if (!keys.Space) hero.play('Idle');
  hero.update(dt);
  controls.target.lerp(hero.object.position.clone().add(new THREE.Vector3(0, 0.5, 0)), 0.1);
  controls.update();
  renderer.render(scene, camera);
});
</script>
</body>
</html>
`;
}

function readme(manifest, modelFile) {
  const isChar = manifest.type === 'character';
  return `# ${manifest.name}

由 **Char3D Converter** 產生的${isChar ? '角色' : '物件'}套件。

| 檔案 | 用途 |
|---|---|
| \`${modelFile}\` | 3D 模型（glTF 2.0 Binary，含貼圖${isChar ? '、骨架節點、動畫' : ''}） |
| \`character.json\` | 描述檔：尺寸、節點、插槽、動畫清單、部件資訊 |
| \`c3d-loader.js\` | three.js 載入輔助程式（播放動畫、掛載配件） |
| \`index.html\` | 示範網頁（需以 HTTP 伺服器開啟，例如 \`npx serve .\`） |
| \`textures/\` | 各部件烘焙後的 PNG 貼圖（已內嵌在 GLB 中，這裡另附一份方便修改） |
| \`preview.png\` | 預覽縮圖 |
| \`project.c3d.json\` | 可在 Char3D Converter 重新開啟編輯的專案檔 |

## 座標規格
- 單位：公尺，高度約 **${manifest.height} m**
- +Y 朝上、角色正面朝 **+Z**、原點在腳底中央
${isChar ? `
## 節點與插槽（Sockets）
${manifest.sockets.map((s) => `- \`${s.name}\` — ${s.description}`).join('\n')}

## 動畫
${manifest.animations.map((a) => `- \`${a.name}\` (${a.duration}s, loop)`).join('\n')}
` : ''}
## 匯入方式
- **three.js**：\`import { loadCharacter } from './c3d-loader.js'\`（見 index.html）
- **Babylon.js**：\`BABYLON.SceneLoader.ImportMeshAsync('', './', '${modelFile}', scene)\`
- **PlayCanvas / Godot / Unity (glTFast) / Blender**：直接匯入 \`${modelFile}\`
`;
}

export async function buildPackage({ root, clips, scale, manifest, projectJSON, previewCanvas, sourceImages }) {
  const files = {};
  const obj = prepareExport(root, scale);
  const glb = await toGLB(obj, clips, true);
  const modelFile = manifest.type === 'character' ? 'character.glb' : 'object.glb';
  manifest.files = { model: modelFile, loader: 'c3d-loader.js', demo: 'index.html', preview: 'preview.png', project: 'project.c3d.json', textures: [] };
  files[modelFile] = new Uint8Array(await glb.arrayBuffer());
  const mats = collectMaterials(obj);
  for (const [m, name] of mats) {
    if (m.map && m.map.image) {
      files[`textures/${name}.png`] = await canvasToPNG(m.map.image);
      manifest.files.textures.push(`textures/${name}.png`);
    }
  }
  if (previewCanvas) files['preview.png'] = await canvasToPNG(previewCanvas);
  for (const [path, dataURL] of Object.entries(sourceImages || {})) {
    const bin = atob(dataURL.split(',')[1]);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    files[`source/${path}.png`] = u8;
  }
  files['character.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['c3d-loader.js'] = strToU8(loaderJS());
  files['index.html'] = strToU8(demoHTML(modelFile, manifest));
  files['README.md'] = strToU8(readme(manifest, modelFile));
  files['project.c3d.json'] = strToU8(projectJSON);
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' });
}

export async function buildPartsZip(partsList, scale) {
  const files = {};
  const index = [];
  for (const p of partsList) {
    const g = new THREE.Group(); g.name = p.name;
    const m = new THREE.Mesh(p.geometry, p.material); m.name = p.name + '_Mesh';
    g.add(m);
    const obj = prepareExport(g, scale);
    const glb = await toGLB(obj, [], true);
    files[`${p.name}.glb`] = new Uint8Array(await glb.arrayBuffer());
    const b = new THREE.Box3().setFromObject(obj);
    index.push({ slot: p.slot, file: `${p.name}.glb`, socket: p.socket, size: b.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(4)) });
  }
  files['parts.json'] = strToU8(JSON.stringify({ format: 'char3d-parts', version: 1, units: 'meters', up: '+Y', forward: '+Z', origin: 'bottom-center', parts: index }, null, 2));
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' });
}

export function zipFiles(files) {
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' });
}
export { canvasToPNG, strToU8 };
