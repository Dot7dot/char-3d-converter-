// ---------------------------------------------------------------------------
// library.js — the character library (儲存庫): storage backends and logic.
//
// No DOM access here: everything is a plain async API that the UI (library-ui.js) and the app shell call.
// One interface, two backends:
//   • folder   — File System Access API (desktop Chrome / Edge). One `.c3d.json` per character in a folder the
//                user picked, plus an index file so the gallery opens without reading every project.
//   • browser  — IndexedDB (phones, tablets, Firefox, Safari). Metadata and payloads live in separate stores so
//                listing never loads a payload; payloads are gzip-compressed Blobs, not strings.
// Errors that the UI has to react to are typed: QuotaError, PermissionError, NotFoundError.
// ---------------------------------------------------------------------------
import { zipSync, unzipSync, strToU8, strFromU8 } from 'three/addons/libs/fflate.module.js';

// ============================================================== constants
/** Fraction of the browser's quota at which the UI starts warning (non-blocking). */
export const WARN_RATIO = 0.8;
/** Fraction at which a save is refused (blocking dialog). */
export const BLOCK_RATIO = 0.95;
/** Quota assumed when `navigator.storage.estimate()` is missing: deliberately small, browsers differ a lot. */
export const FALLBACK_QUOTA_BYTES = 200 * 1024 * 1024;

export const INDEX_FILE = 'char3d-library.json';
export const FILE_SUFFIX = '.c3d.json';
// The library has its OWN database. `char3d` (v1, store `kv`: the draft autosave) stays exactly as the live site
// has it, so a tab or a rollback running the old code can never hit a VersionError on it.
export const DB_NAME = 'char3d-library';
export const DB_VERSION = 1;
const KV = 'kv', META = 'lib-meta', DATA = 'lib-data';

// ============================================================== errors
export class LibraryError extends Error {
  constructor(message, cause) { super(message); this.cause = cause; }
}
/** The storage is (nearly) full — the write did NOT happen. */
export class QuotaError extends LibraryError {
  constructor(message, cause) { super(message, cause); this.name = 'QuotaError'; this.code = 'quota'; }
}
/** Folder access is not granted (yet). `reason`: 'prompt' | 'denied' | 'unconfigured' | 'unknown'. */
export class PermissionError extends LibraryError {
  constructor(message, reason = 'unknown', cause) { super(message, cause); this.name = 'PermissionError'; this.code = 'permission'; this.reason = reason; }
}
/** The folder (reason 'folder') or a character (reason 'entry') does not exist (any more). */
export class NotFoundError extends LibraryError {
  constructor(message, reason = 'entry', cause) { super(message, cause); this.name = 'NotFoundError'; this.code = 'not-found'; this.reason = reason; }
}

export function mapError(e) {
  if (e instanceof LibraryError) return e;
  const n = e && e.name;
  if (n === 'QuotaExceededError' || (e && e.code === 22)) return new QuotaError('storage full', e);
  if (n === 'NotFoundError') return new NotFoundError('not found', 'entry', e);
  if (n === 'NotAllowedError' || n === 'SecurityError') return new PermissionError('permission needed', 'unknown', e);
  return e;
}

// ============================================================== small helpers
const newId = () => {
  try { if (globalThis.crypto?.randomUUID) return crypto.randomUUID(); } catch (_) { /* insecure context */ }
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0')).join('');
};
const idShort = (id) => String(id).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || '00000000';
/** File-system-safe version of a name (keeps Chinese, drops characters Windows / macOS reject). */
export function safeName(name) {
  const s = String(name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 60);
  return s || 'character';
}
export const fileNameFor = (meta, asciiOnly = false) => {
  const base = asciiOnly ? safeName(meta.name).replace(/[^\x20-\x7e]+/g, '').replace(/^[._]+|[._]+$/g, '') || 'character' : safeName(meta.name);
  return `${base}__${idShort(meta.id)}${FILE_SUFFIX}`;
};
const cleanName = (n) => String(n || '').trim().slice(0, 40) || '未命名';
/** Deterministic id for files that have no library block (hand-copied), so a rebuilt index keeps the same ids. */
function hashId(str) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < str.length; i++) { a = Math.imul(a ^ str.charCodeAt(i), 0x01000193) >>> 0; b = Math.imul(b + str.charCodeAt(i), 0x85ebca6b) >>> 0; }
  return 'f' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
/** Content identity of a project, ignoring the bookkeeping that changes on every save. */
const fingerprint = (p) => JSON.stringify({ ...p, library: undefined, savedAt: undefined });
const withLibrary = (project, m) => ({ ...project, library: { id: m.id, name: m.name, createdAt: m.createdAt, updatedAt: m.updatedAt, thumb: m.thumb || undefined } });
const validProject = (p) => p && typeof p === 'object' && p.format === 'char3d-project';
const byRecent = (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/** What kind of device is this? Android Chrome may expose the folder picker, but phones always use browser storage. */
export function detectEnv(g = globalThis) {
  const nav = g.navigator || {};
  const hasPicker = typeof g.showDirectoryPicker === 'function';
  let coarse = false;
  try { coarse = !!(g.matchMedia && g.matchMedia('(pointer: coarse)').matches && !g.matchMedia('(any-pointer: fine)').matches); } catch (_) { /* no matchMedia */ }
  const mobile = nav.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(nav.userAgent || '') || coarse;
  return { mobile, hasPicker, canUseFolder: hasPicker && !mobile };
}

// ============================================================== IndexedDB
/** Opens the library database (config + folder handle in `kv`, characters in `lib-meta` / `lib-data`). */
export function openDB(g = globalThis) {
  return new Promise((res, rej) => {
    const rq = g.indexedDB.open(DB_NAME, DB_VERSION);
    rq.onupgradeneeded = () => { // only creates what is missing, so the existing `kv` / autosave is untouched
      const db = rq.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
    };
    rq.onsuccess = () => { const db = rq.result; db.onversionchange = () => db.close(); res(db); };
    rq.onerror = () => rej(rq.error);
    rq.onblocked = () => console.warn('char3d-library upgrade is waiting for another tab to close its connection');
  });
}
/**
 * Run `fn(...stores)` in one transaction. If `fn` returns an IDBRequest its result is the result. Any failure
 * (including QuotaExceededError, thrown or raised later) aborts the whole transaction: nothing is half-written.
 */
async function withTx(stores, mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      let tx, out;
      try { tx = db.transaction(stores, mode); } catch (e) { reject(mapError(e)); return; }
      tx.oncomplete = () => resolve(typeof IDBRequest !== 'undefined' && out instanceof IDBRequest ? out.result : out);
      tx.onabort = () => reject(mapError(tx.error));
      tx.onerror = () => reject(mapError(tx.error));
      try { out = fn(...stores.map((s) => tx.objectStore(s))); } catch (e) { try { tx.abort(); } catch (_) { /* already finished */ } reject(mapError(e)); }
    });
  } finally { db.close(); }
}
export const kvGet = (key) => withTx([KV], 'readonly', (s) => s.get(key));
export const kvSet = (key, v) => withTx([KV], 'readwrite', (s) => s.put(v, key));

// ============================================================== browser backend
async function encode(text, compress) {
  const raw = new Blob([text]); // UTF-8
  if (compress && typeof CompressionStream === 'function') {
    try { return { blob: await new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob(), encoding: 'gzip' }; } catch (_) { /* fall through */ }
  }
  return { blob: raw, encoding: 'plain' };
}
async function decode(blob, encoding) {
  if (encoding === 'gzip') return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return blob.text();
}

const browserBackend = {
  list: () => withTx([META], 'readonly', (m) => m.getAll()),
  getMeta: (id) => withTx([META], 'readonly', (m) => m.get(id)),
  async read(id) {
    const rec = await withTx([DATA], 'readonly', (d) => d.get(id));
    if (!rec) throw new NotFoundError('character missing', 'entry');
    return JSON.parse(await decode(rec.blob, rec.encoding));
  },
  /** One transaction for payload + metadata: either both are stored or neither. */
  put(meta, enc) {
    const m = { ...meta, size: enc.blob.size, encoding: enc.encoding };
    return withTx([META, DATA], 'readwrite', (ms, ds) => { ds.put({ id: m.id, blob: enc.blob, encoding: enc.encoding }); ms.put(m); }).then(() => m);
  },
  remove: (id) => withTx([META, DATA], 'readwrite', (ms, ds) => { ms.delete(id); ds.delete(id); }),
};

// ============================================================== folder backend
class FolderBackend {
  constructor(dir) { this.dir = dir; this.metas = null; }

  async readIndexFile() {
    try {
      const fh = await this.dir.getFileHandle(INDEX_FILE);
      const j = JSON.parse(await (await fh.getFile()).text());
      if (j && j.format === 'char3d-library-index' && Array.isArray(j.entries)) return j.entries;
    } catch (_) { /* missing or damaged → rebuilt below */ }
    return [];
  }
  async writeFile(name, data) {
    const fh = await this.dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); // writes go to a swap file; nothing changes until close()
    try { await w.write(data); await w.close(); } catch (e) { try { await w.abort(); } catch (_) { /* gone */ } throw mapError(e); }
    return fh.getFile();
  }
  async writeIndex() {
    const body = { format: 'char3d-library-index', version: 1, updatedAt: new Date().toISOString(), entries: this.metas };
    try { await this.writeFile(INDEX_FILE, JSON.stringify(body)); } catch (e) { console.warn('library index not written (will be rebuilt)', e); }
  }
  async metaFromFile(name, file) {
    let p;
    try { p = JSON.parse(await file.text()); } catch (_) { return null; }
    if (!validProject(p)) return null;
    const lib = p.library || {};
    const iso = new Date(file.lastModified).toISOString();
    return {
      id: typeof lib.id === 'string' && lib.id ? lib.id : hashId(name),
      name: cleanName(lib.name || p.settings?.name || name.slice(0, -FILE_SUFFIX.length).replace(/__[0-9a-f]{8}$/, '')),
      mode: p.mode === 'object' ? 'object' : 'character',
      createdAt: lib.createdAt || iso, updatedAt: lib.updatedAt || iso,
      size: file.size, mtime: file.lastModified, file: name, thumb: lib.thumb || null,
    };
  }
  /** Gallery metadata: trust the index entry when file size and time still match, otherwise re-read that file. */
  async scan(retried = false) {
    const known = new Map((await this.readIndexFile()).map((e) => [e.file, e]));
    const out = [], ids = new Set();
    for await (const h of this.dir.values()) {
      if (h.kind !== 'file' || !h.name.endsWith(FILE_SUFFIX)) continue;
      const f = await h.getFile();
      let m = known.get(h.name);
      if (!(m && m.size === f.size && m.mtime === f.lastModified)) { m = await this.metaFromFile(h.name, f); if (!m) continue; }
      if (ids.has(m.id)) {
        // either a hand-copied duplicate, or another tab is in the middle of a rename (old + new file both there)
        if (!retried) { await new Promise((r) => setTimeout(r, 300)); return this.scan(true); }
        m = { ...m, id: hashId(m.id + h.name) };
      }
      ids.add(m.id); out.push(m);
    }
    const before = JSON.stringify([...known.values()].sort((a, b) => (a.file < b.file ? -1 : 1)));
    this.metas = out;
    if (before !== JSON.stringify([...out].sort((a, b) => (a.file < b.file ? -1 : 1)))) await this.writeIndex();
    return out;
  }
  async list(fresh = true) { return fresh || !this.metas ? this.scan() : this.metas; }
  async getMeta(id) { return (await this.list(false)).find((m) => m.id === id) || null; }
  /** Another tab may be renaming / rewriting the file right now: on a miss look at the folder again once. */
  async read(id) {
    for (let attempt = 0; ; attempt++) {
      const meta = attempt ? (await this.scan()).find((m) => m.id === id) : await this.getMeta(id);
      try {
        if (!meta) throw new NotFoundError('character missing', 'entry');
        return JSON.parse(await (await (await this.dir.getFileHandle(meta.file)).getFile()).text());
      } catch (e) {
        const m = mapError(e);
        if (m instanceof NotFoundError && attempt === 0) { await new Promise((r) => setTimeout(r, 200)); continue; }
        throw m;
      }
    }
  }
  async put(meta, project) {
    await this.list(false);
    const text = JSON.stringify(withLibrary(project, meta));
    let file = fileNameFor(meta), f;
    try { f = await this.writeFile(file, text); } catch (e) { // 1. the character …
      // a few file systems refuse non-ASCII names (TypeMismatchError / TypeError): keep the id part, drop the Chinese
      if (!e || (e.name !== 'TypeMismatchError' && e.name !== 'TypeError') || /^[\x20-\x7e]*$/.test(file)) throw e;
      file = fileNameFor(meta, true);
      f = await this.writeFile(file, text);
    }
    const m = { ...meta, file, size: f.size, mtime: f.lastModified };
    const prev = this.metas.find((e) => e.id === m.id);
    if (prev && prev.file !== file) { try { await this.dir.removeEntry(prev.file); } catch (_) { /* already gone */ } } // rename = new file name
    this.metas = [...this.metas.filter((e) => e.id !== m.id), m];
    await this.writeIndex(); // 2. … then the index (a stale index is repaired by the next scan)
    return m;
  }
  async remove(id) {
    const meta = await this.getMeta(id);
    if (!meta) return;
    try { await this.dir.removeEntry(meta.file); } catch (e) { if (!(mapError(e) instanceof NotFoundError)) throw mapError(e); }
    this.metas = this.metas.filter((e) => e.id !== id);
    await this.writeIndex();
  }
}

// ============================================================== the library
export function createLibrary(g = globalThis) {
  const env = detectEnv(g);
  let backend = 'browser';          // 'folder' | 'browser'
  let state = 'ready';              // ready | unconfigured | needs-permission | denied | folder-missing | error
  let handle = null;                // saved directory handle (folder backend)
  let folder = null;                // FolderBackend
  let persistAsked = false;
  let queue = Promise.resolve();

  /** All operations run one after another, so two saves can never interleave their writes. */
  const serial = (fn) => {
    const p = queue.then(async () => {
      try { return await fn(); } catch (e) {
        const err = mapError(e);
        // folder trouble: re-check, so status() tells the UI the real reason (moved / needs permission)
        if (backend === 'folder' && handle && (err instanceof NotFoundError || err instanceof PermissionError)) await checkFolder();
        throw err;
      }
    });
    queue = p.catch(() => {});
    return p;
  };

  async function checkFolder() {
    if (!handle) { state = 'unconfigured'; return; }
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') { state = perm === 'denied' ? 'denied' : 'needs-permission'; return; }
      for await (const _ of handle.values()) break; // throws NotFoundError when the folder was deleted / moved
      folder = new FolderBackend(handle);
      state = 'ready';
    } catch (e) { state = mapError(e) instanceof NotFoundError ? 'folder-missing' : 'error'; }
  }
  const be = () => (backend === 'folder' ? folder : browserBackend);
  function assertReady() {
    if (backend === 'browser' || state === 'ready') return;
    if (state === 'folder-missing') throw new NotFoundError('folder missing', 'folder');
    throw new PermissionError('folder not available', state === 'needs-permission' ? 'prompt' : state === 'denied' ? 'denied' : state === 'unconfigured' ? 'unconfigured' : 'unknown');
  }

  async function estimate() {
    try {
      const e = await g.navigator?.storage?.estimate?.();
      if (e && e.quota) return { used: e.usage || 0, quota: e.quota };
    } catch (_) { /* unavailable */ }
    return null;
  }
  async function usageNow() {
    const metas = await be().list(false);
    const sum = metas.reduce((n, m) => n + (m.size || 0), 0);
    if (backend === 'folder') return { backend, used: sum, quota: null, ratio: 0, level: 'ok', estimated: false, persistent: null, count: metas.length };
    const est = await estimate();
    const used = est ? est.used : sum, quota = est ? est.quota : FALLBACK_QUOTA_BYTES;
    const ratio = quota ? used / quota : 0;
    let persistent = null;
    try { persistent = (await g.navigator?.storage?.persisted?.()) ?? null; } catch (_) { /* unknown */ }
    return { backend, used, quota, ratio, level: ratio >= BLOCK_RATIO ? 'block' : ratio >= WARN_RATIO ? 'warn' : 'ok', estimated: !!est, persistent, libraryBytes: sum, count: metas.length };
  }

  /** The single write path: every save, rename, duplicate and import goes through here. */
  async function put(meta, project, { fast = false } = {}) {
    assertReady();
    if (backend === 'folder') return folder.put(meta, project);
    const prev = await browserBackend.getMeta(meta.id);
    // gzip for space; `fast` (page is closing) skips it so the write starts without waiting on a stream
    const enc = await encode(JSON.stringify(withLibrary(project, meta)), !fast);
    const u = await usageNow();
    if ((u.used + enc.blob.size - (prev?.size || 0)) / u.quota >= BLOCK_RATIO) throw new QuotaError('storage almost full');
    const saved = await browserBackend.put(meta, enc);
    if (!persistAsked) { persistAsked = true; askPersist(); }
    return saved;
  }
  /** Ask the browser to keep our data even when disk space is low — once, after the first successful save. */
  async function askPersist() {
    try {
      if (await kvGet('library-persist-asked')) return;
      await kvSet('library-persist-asked', true);
      if (g.navigator?.storage?.persist && !(await g.navigator.storage.persisted?.())) await g.navigator.storage.persist();
    } catch (_) { /* not supported */ }
  }

  const api = {
    env,
    /** Decide the backend from the saved configuration and the device. Call once at start-up. */
    init: () => serial(async () => {
      let cfg = null;
      try { cfg = await kvGet('library-config'); handle = (await kvGet('library-dir')) || null; } catch (_) { /* IndexedDB unavailable */ }
      if (!env.canUseFolder || cfg?.backend === 'browser') { backend = 'browser'; state = 'ready'; return api.status(); }
      backend = 'folder';
      if (cfg?.backend === 'folder' && handle) await checkFolder(); else state = 'unconfigured';
      return api.status();
    }),
    status: () => ({
      backend, state, folderName: handle?.name || null, hasSavedFolder: !!handle,
      canUseFolder: env.canUseFolder, hasPicker: env.hasPicker, mobile: env.mobile,
      ready: backend === 'browser' || state === 'ready',
    }),

    /** Must be called straight from a click (the picker needs a user gesture). Returns null when cancelled. */
    async connectFolder() {
      if (!env.canUseFolder) throw new PermissionError('folder storage not available here', 'unknown');
      let h;
      try { h = await g.showDirectoryPicker({ mode: 'readwrite', id: 'char3d-library' }); } catch (e) { if (e && e.name === 'AbortError') return null; throw mapError(e); }
      return serial(async () => {
        const firstTime = !handle;
        handle = h; backend = 'folder'; folder = null;
        await kvSet('library-dir', h); await kvSet('library-config', { backend: 'folder' });
        await checkFolder();
        return { status: api.status(), firstTime };
      });
    },
    /** Must be called straight from a click: asks the browser to re-grant access to the remembered folder. */
    async reconnectFolder() {
      if (!handle) throw new PermissionError('no folder remembered', 'unconfigured');
      try { await handle.requestPermission({ mode: 'readwrite' }); } catch (e) { throw mapError(e); }
      return serial(async () => { await checkFolder(); return api.status(); });
    },
    /** Switch to the remembered folder (desktop) — if there is none the UI calls connectFolder() instead. */
    useFolder: () => serial(async () => {
      if (!env.canUseFolder || !handle) return api.status();
      backend = 'folder'; await kvSet('library-config', { backend: 'folder' }); await checkFolder();
      return api.status();
    }),
    useBrowser: () => serial(async () => { backend = 'browser'; state = 'ready'; await kvSet('library-config', { backend: 'browser' }); return api.status(); }),
    browserCount: async () => (await browserBackend.list()).length,
    /** Copy everything stored in the browser into the connected folder (the browser copies stay). */
    copyBrowserToFolder: () => serial(async () => {
      if (backend !== 'folder') throw new PermissionError('no folder connected', 'unconfigured');
      assertReady();
      const have = new Set((await folder.list()).map((m) => m.id));
      let copied = 0;
      for (const m of await browserBackend.list()) {
        if (have.has(m.id)) continue;
        const { file, mtime, encoding, size, ...meta } = m; // eslint-disable-line no-unused-vars
        await folder.put(meta, await browserBackend.read(m.id)); copied++;
      }
      return copied;
    }),

    /** Gallery metadata, most recently edited first. Re-reads the storage every time. */
    list: () => serial(async () => { assertReady(); return (await be().list()).slice().sort(byRecent); }),
    get: (id) => serial(async () => {
      assertReady();
      const meta = await be().getMeta(id);
      if (!meta) throw new NotFoundError('character missing', 'entry');
      return { meta, project: await be().read(id) };
    }),
    /**
     * Create or update a character. `project` is the plain projectData() object; `thumb` a small data URL.
     * Returns the stored metadata. Throws QuotaError (nothing stored), PermissionError, NotFoundError.
     */
    save: ({ id, name, project, thumb, createdAt, updatedAt, fast } = {}) => serial(async () => {
      assertReady();
      if (!validProject(project)) throw new LibraryError('not a Char3D project');
      const now = new Date().toISOString();
      const prev = id ? await be().getMeta(id) : null;
      const meta = {
        id: id || newId(), name: cleanName(name || prev?.name || project.settings?.name),
        mode: project.mode === 'object' ? 'object' : 'character',
        createdAt: createdAt || prev?.createdAt || now, updatedAt: updatedAt || now,
        thumb: thumb === undefined ? prev?.thumb || null : thumb,
      };
      return put(meta, project, { fast });
    }),
    rename: (id, name) => serial(async () => {
      assertReady();
      const meta = await be().getMeta(id);
      if (!meta) throw new NotFoundError('character missing', 'entry');
      const { file, mtime, size, encoding, ...rest } = meta; // eslint-disable-line no-unused-vars
      return put({ ...rest, name: cleanName(name) }, await be().read(id)); // updatedAt stays: a rename is not an edit
    }),
    duplicate: (id, name) => serial(async () => {
      assertReady();
      const meta = await be().getMeta(id);
      if (!meta) throw new NotFoundError('character missing', 'entry');
      const now = new Date().toISOString();
      return put({ id: newId(), name: cleanName(name || meta.name), mode: meta.mode, createdAt: now, updatedAt: now, thumb: meta.thumb || null }, await be().read(id));
    }),
    remove: (id) => serial(async () => { assertReady(); await be().remove(id); }),

    usage: () => serial(async () => { if (backend === 'folder' && state !== 'ready') return { backend, used: 0, quota: null, ratio: 0, level: 'ok', estimated: false, persistent: null, count: 0 }; return usageNow(); }),

    /** { blob, filename, count } — a ZIP with every character as its own .c3d.json. */
    exportAll: () => serial(async () => {
      assertReady();
      const files = {};
      const metas = (await be().list()).slice().sort(byRecent);
      for (const m of metas) files[fileNameFor(m)] = strToU8(JSON.stringify(await be().read(m.id)));
      const d = new Date(), p = (n) => String(n).padStart(2, '0');
      return { blob: new Blob([zipSync(files, { level: 4 })], { type: 'application/zip' }), filename: `char3d-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.zip`, count: metas.length };
    }),
    exportOne: (id) => serial(async () => {
      assertReady();
      const meta = await be().getMeta(id);
      if (!meta) throw new NotFoundError('character missing', 'entry');
      return { blob: new Blob([JSON.stringify(await be().read(id))], { type: 'application/json' }), filename: fileNameFor(meta) };
    }),

    /**
     * Add characters from .c3d.json files and backup ZIPs. An id that already exists with different content gets
     * a new id (never overwrites); identical content is skipped.
     * → { added: [meta], same: n, failed: [{ name, reason }], quota: boolean }  reasons: 'not-project' | 'bad-file' | 'error'
     */
    importFiles: (files) => serial(async () => {
      assertReady();
      const res = { added: [], same: 0, failed: [], quota: false };
      const items = [];
      for (const f of files) {
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          if (buf[0] === 0x50 && buf[1] === 0x4b) { // "PK" → a backup ZIP
            const zip = unzipSync(buf);
            for (const [n, data] of Object.entries(zip)) if (n.endsWith('.json') && !n.endsWith(INDEX_FILE) && !n.startsWith('__MACOSX')) items.push({ name: n.split('/').pop(), text: strFromU8(data) });
          } else items.push({ name: f.name, text: strFromU8(buf) });
        } catch (_) { res.failed.push({ name: f.name, reason: 'bad-file' }); }
      }
      for (const it of items) {
        if (res.quota) { res.failed.push({ name: it.name, reason: 'quota' }); continue; }
        let p;
        try { p = JSON.parse(it.text); } catch (_) { res.failed.push({ name: it.name, reason: 'bad-file' }); continue; }
        if (!validProject(p)) { res.failed.push({ name: it.name, reason: 'not-project' }); continue; }
        try {
          const lib = p.library || {};
          let id = typeof lib.id === 'string' && lib.id ? lib.id : null;
          if (id && await be().getMeta(id)) {
            if (fingerprint(await be().read(id)) === fingerprint(p)) { res.same++; continue; }
            id = null; // same id, different content → keep both
          }
          const now = new Date().toISOString();
          const ok = (t) => (typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? t : null);
          const meta = {
            id: id || newId(), name: cleanName(lib.name || p.settings?.name || it.name.replace(/\.c3d\.json$|\.json$/, '').replace(/__[0-9a-f]{8}$/, '')),
            mode: p.mode === 'object' ? 'object' : 'character', createdAt: ok(lib.createdAt) || now, updatedAt: ok(lib.updatedAt) || now,
            thumb: typeof lib.thumb === 'string' ? lib.thumb : null,
          };
          res.added.push(await put(meta, p));
        } catch (e) {
          const err = mapError(e);
          if (err instanceof QuotaError) { res.quota = true; res.failed.push({ name: it.name, reason: 'quota' }); } else if (err instanceof PermissionError || err instanceof NotFoundError) throw err;
          else res.failed.push({ name: it.name, reason: 'error' });
        }
      }
      return res;
    }),
  };
  return api;
}
