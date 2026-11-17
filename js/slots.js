// ---------------------------------------------------------------------------
// slots.js — the upload slots: body parts (3-head-tall chibi) and accessories.
// ---------------------------------------------------------------------------

export const VIEWS = [
  { id: 'front', name: '正面', en: 'Front', required: true, tip: '必填。角色面向你。' },
  { id: 'side', name: '側面', en: 'Side', tip: '角色面朝畫面「右側」（右側視圖）。提供後啟用三視圖雕刻，深度最準確。' },
  { id: 'back', name: '背面', en: 'Back', tip: '從背後看。沒有時會用正面鏡像或主色填補。' },
  { id: 'top', name: '頂部', en: 'Top', tip: '從上往下看，角色正面朝畫面下方。可修正帽子、盾牌等的寬深。' },
];

export const SLOTS = [
  // ---- body (三頭身: head = 1, torso = 1, legs = 1 head-unit)
  { id: 'head', sideMode: 'profile', group: 'body', name: '頭部', en: 'Head', icon: 'head', mode: 'inflate', depth: 0.92, backFill: 'color', size: 1,
    hint: '正面畫臉與頭髮輪廓；背面畫後腦勺。沒有背面時會用頭頂顏色（髮色）填補。' },
  { id: 'torso', sideMode: 'profile', group: 'body', name: '胸部 / 軀幹', en: 'Torso', icon: 'torso', mode: 'inflate', depth: 0.62, backFill: 'mirror', size: 0.95,
    hint: '只畫軀幹（不含手臂），從脖子到腰部。' },
  { id: 'arms', sideMode: 'profile', group: 'body', name: '手臂', en: 'Arms', icon: 'arm', mode: 'inflate', depth: 1, backFill: 'mirror', size: 0.8, pair: true,
    hint: '畫「角色右手臂」（畫面左邊那隻）從肩膀到手掌，左手會自動鏡像。' },
  { id: 'legs', sideMode: 'profile', group: 'body', name: '腳 / 下半身', en: 'Legs', icon: 'legs', mode: 'inflate', depth: 0.85, backFill: 'mirror', size: 1,
    hint: '從腰部到腳底，兩條腿中間留空隙（去背）就能各自擺動。' },
  // ---- accessories
  { id: 'hat', group: 'acc', name: '帽子', en: 'Hat', icon: 'hat', mode: 'revolve', depth: 1, backFill: 'mirror', size: 1.06,
    hint: '預設以旋轉體成形（圓帽、尖帽最準）。非對稱帽子請提供側面圖。' },
  { id: 'face', group: 'acc', name: '臉部配件', en: 'Face', icon: 'glasses', mode: 'extrude', depth: 0.45, backFill: 'mirror', size: 0.85,
    hint: '眼鏡、面具、鬍子等，貼在臉的正前方。' },
  { id: 'back', group: 'acc', name: '背部配件', en: 'Back', icon: 'wings', mode: 'extrude', depth: 0.7, backFill: 'mirror', size: 1.25,
    hint: '翅膀、披風、背包。畫「從正面看到」的樣子。' },
  { id: 'handR', group: 'acc', name: '右手持物', en: 'Right hand', icon: 'sword', mode: 'extrude', depth: 0.6, backFill: 'mirror', size: 1.0, grip: 0.28,
    hint: '武器/道具直立畫，握把在下方。' },
  { id: 'handL', group: 'acc', name: '左手持物', en: 'Left hand', icon: 'shield', mode: 'extrude', depth: 1.0, backFill: 'mirror', size: 0.7, grip: 0.5,
    hint: '盾牌、書本、燈籠等。' },
  { id: 'waist', sideMode: 'profile', group: 'acc', name: '腰部配件', en: 'Waist', icon: 'belt', mode: 'inflate', depth: 0.75, backFill: 'mirror', size: 1.12,
    hint: '腰帶、裙子、腰包。物件上緣會對齊腰部。' },
  { id: 'shoes', sideMode: 'profile', group: 'acc', name: '鞋子', en: 'Shoes', icon: 'shoe', mode: 'inflate', depth: 1.0, backFill: 'mirror', size: 1.1, pair: true,
    hint: '畫「右腳鞋子」正面，左腳自動鏡像。提供側面可得到正確鞋長。' },
  // ---- standalone prop (object mode)
  { id: 'object', group: 'prop', name: '物件', en: 'Prop', icon: 'box', mode: 'inflate', depth: 1, backFill: 'mirror', size: 1,
    hint: '任何物件：道具、家具、寶箱、植物… 提供三視圖可得到最準確的形狀。' },
];

export const SLOT_BY_ID = Object.fromEntries(SLOTS.map((s) => [s.id, s]));

export function defaultParams(slot) {
  return {
    mode: 'auto',
    depth: slot.depth,
    roundness: 0.5,
    smooth: 2,
    backFill: slot.backFill,
    removeBg: true,
    tolerance: 30,
    size: 1,
    offset: [0, 0, 0],
    rotation: [0, 0, 0],
    visible: true,
    splitLegs: true,
    // --- view alignment (per optional view, in the view's own frame) & roles
    align: {
      back: { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 },
      side: { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 },
      top: { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 },
    },
    roles: { side: 'both', top: 'both' }, // 'both' | 'shape' | 'texture'
    // --- per-view touch-ups (eraser strokes, outline-point warps), see imgedit.js
    edits: { front: [], back: [], side: [], top: [] },
    // --- manual 3D adjustment
    stretch: [1, 1, 1],
    taper: { w: [1, 1, 1], d: [1, 1, 1], bend: [0, 0], twist: 0 },
    lattice: null, // Array(81) of free cage-point offsets
    latticeMirror: true,
    sculpt: [], // brush strokes, replayed after every re-conversion
  };
}

/** Merge saved params over defaults (older project files lack the newer keys). */
export function mergeParams(slot, saved = {}) {
  const d = defaultParams(slot);
  const out = { ...d, ...saved };
  out.align = { ...d.align };
  for (const k of Object.keys(d.align)) out.align[k] = { ...d.align[k], ...(saved.align?.[k] || {}) };
  out.roles = { ...d.roles, ...(saved.roles || {}) };
  out.edits = { front: [], back: [], side: [], top: [] };
  for (const k of Object.keys(out.edits)) if (Array.isArray(saved.edits?.[k])) out.edits[k] = saved.edits[k];
  out.taper = { ...d.taper, ...(saved.taper || {}) };
  out.sculpt = Array.isArray(saved.sculpt) ? saved.sculpt : [];
  return out;
}

/** Params that change the conversion itself (others only re-deform / re-place). */
export const CONVERT_KEYS = ['mode', 'depth', 'roundness', 'smooth', 'backFill', 'removeBg', 'tolerance', 'align', 'roles', 'edits'];

// simple inline SVG icons (stroke = currentColor)
export const ICONS = {
  head: '<circle cx="12" cy="11" r="7"/><circle cx="9.5" cy="11" r=".8" fill="currentColor"/><circle cx="14.5" cy="11" r=".8" fill="currentColor"/><path d="M9.5 14.2c1.4 1 3.6 1 5 0"/>',
  torso: '<path d="M7 5h10l2 4-2 1v9H7v-9L5 9z"/>',
  arm: '<path d="M10 3h4v11l1 3a3 3 0 0 1-6 0l1-3z"/>',
  legs: '<path d="M7 4h10v5l-1 11h-3l-1-9-1 9H8L7 9z"/>',
  hat: '<path d="M12 3l4 12H8z"/><ellipse cx="12" cy="16" rx="9" ry="2.5"/>',
  glasses: '<circle cx="7" cy="13" r="3.2"/><circle cx="17" cy="13" r="3.2"/><path d="M10.2 13h3.6M3.8 12 2 9M20.2 12 22 9"/>',
  wings: '<path d="M12 8C9 4 4 4 2 6c2 1 3 4 3 7 2 0 5-1 7-5zM12 8c3-4 8-4 10-2-2 1-3 4-3 7-2 0-5-1-7-5z"/>',
  sword: '<path d="M12 2l2 3v10h-4V5zM7 15h10M12 15v4M10.5 21h3"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/>',
  belt: '<rect x="3" y="9" width="18" height="6" rx="1"/><rect x="10" y="8" width="4" height="8" rx="1"/>',
  shoe: '<path d="M4 9h6l2 4 7 2c1.5.5 2 1.5 2 3H4z"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8"/>',
};

export function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
