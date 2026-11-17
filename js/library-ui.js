// ---------------------------------------------------------------------------
// library-ui.js — the 儲存庫 panel, the save / open / new-character flow, auto-save and the prompts.
//
// The app has one "current" character. It is either linked to a library entry (changes are saved into it
// automatically) or unlinked (new, not saved yet). This file owns that link; main.js only wires it up.
// ---------------------------------------------------------------------------
import { QuotaError, PermissionError, NotFoundError } from './library.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Quiet time after the last change before a linked character is saved. */
export const AUTOSAVE_MS = 2500;
/** (tests can set window.__c3dAutosaveMs to make the debounce very long and prove the other save paths on their own) */
const autosaveMs = () => (typeof window !== 'undefined' && window.__c3dAutosaveMs) || AUTOSAVE_MS;

const fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }); };
const PLACEHOLDER = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><rect x="8" y="13" width="8" height="5" rx="1.5"/><path d="M9.5 19v2M14.5 19v2"/></svg>';

/** A small modal question. Resolves with the clicked button's `value` ({ value, text } when there is an input), null on Esc. */
function ask({ title, body = '', input = null, buttons }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog ask-dlg';
    dlg.innerHTML = `<form method="dialog" class="dlg-inner">
      <header class="dlg-head"><h2>${esc(title)}</h2></header>
      <div class="dlg-body">${body}${input ? `<label class="field"><span>${esc(input.label)}</span><input type="text" maxlength="40" value="${esc(input.value || '')}"></label>` : ''}</div>
      <footer class="dlg-foot">${buttons.map((b) => `<button type="button" class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}" data-v="${esc(b.value)}">${esc(b.label)}</button>`).join('')}</footer>
    </form>`;
    document.body.appendChild(dlg);
    let result = null;
    const field = $('input', dlg);
    const primary = $('.btn.primary', dlg) || $('.btn:last-child', dlg);
    dlg.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { result = input ? { value: b.dataset.v, text: field.value } : b.dataset.v; dlg.close(); }));
    $('form', dlg).addEventListener('submit', (e) => { e.preventDefault(); primary.click(); }); // Enter in the text box
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.showModal();
    if (field) { field.focus(); field.select(); } else primary.focus();
  });
}

/**
 * @param {object} o
 *  library       createLibrary() instance
 *  getProject()  → plain projectData() object
 *  openProject(data) → Promise  (loadProject)
 *  newProject()  blank character (no questions asked here)
 *  getThumb()    → canvas (previewCanvas)
 *  hasContent()  → boolean, is there anything worth saving
 *  getName() / setName(n)  project name in the settings card
 *  flushDraft()  write the single-slot draft right now
 *  toast(msg), download(blob, filename)
 */
export function initLibraryUI(o) {
  const { library } = o;
  let link = null;            // { id, name, gen } of the library entry being edited, or null. gen = project generation it belongs to
  let lastJson = null;        // serialized project at the last successful save / open (change detection)
  let saveTimer = 0, peekTimer = 0;
  let inflight = null;
  let status = 'idle';        // idle | saved | saving | failed | offline (folder must be reconnected)
  let quotaShown = false, connShown = false, warned = false;
  let view = { st: library.status(), metas: [], usage: null, err: null, msg: '' };
  let busy = false;

  const chip = $('#libStatus'), dlg = $('#libraryDlg'), body = $('#libBody'), banner = $('#libBanner'), fileIn = $('#libFile');

  // ------------------------------------------------------------ status chip
  const snap = () => { const project = o.getProject(); return { project, json: JSON.stringify({ ...project, savedAt: 0 }) }; };
  function setStatus(s) { status = s; paintChip(); }
  function paintChip() {
    if (!link) {
      const show = o.hasContent();
      chip.hidden = !show;
      chip.className = 'lib-chip';
      chip.textContent = '尚未儲存';
      chip.title = '按「儲存」把這個角色放進儲存庫';
      return;
    }
    chip.hidden = false;
    const t = { saved: '已儲存', saving: '儲存中…', failed: '儲存失敗', idle: '已儲存', offline: '需要重新連接資料夾' }[status];
    chip.className = 'lib-chip ' + (status === 'idle' ? 'saved' : status);
    chip.innerHTML = `<b>${esc(link.name)}</b> · ${t}`;
    chip.title = status === 'failed' ? '沒有存進去，按這裡開啟儲存庫查看原因' : status === 'offline' ? '按這裡開啟儲存庫，重新連接資料夾後才會繼續儲存' : '已連到儲存庫的角色，變更會自動儲存';
  }

  // ------------------------------------------------------------ errors → messages
  function showQuotaDialog() {
    const folder = library.status().backend === 'folder';
    ask({
      title: folder ? '電腦的磁碟空間不足' : '儲存空間已滿',
      body: `<p>這一次<b>沒有存進去</b>。你畫面上正在編輯的內容還在，沒有遺失。</p>
        <p>${folder ? '請先清出一些磁碟空間，再按「儲存」。' : '請先按「備份全部」把所有角色下載備份，再到儲存庫刪除用不到的舊角色，然後再按「儲存」。'}</p>`,
      buttons: [{ value: 'close', label: '關閉' }, { value: 'open', label: '開啟儲存庫' }, ...(folder ? [] : [{ value: 'backup', label: '備份全部', primary: true }])],
    }).then((r) => { if (r === 'backup') backupAll(); else if (r === 'open') openPanel(); });
  }
  /** Turn a failed save into a status + the right message. `force` = the user asked for this save (always tell them). */
  function reportError(e, force = false, silent = false) {
    setStatus('failed');
    if (silent) return; // the caller (leaving the character) explains the failure in its own dialog
    if (e instanceof QuotaError) { if (force || !quotaShown) { quotaShown = true; showQuotaDialog(); } return; }
    if (e instanceof PermissionError || e instanceof NotFoundError) {
      if (force || !connShown) { connShown = true; o.toast('沒有存進去：資料夾無法使用，請按上方的儲存狀態開啟儲存庫重新連接', 5000); }
      return;
    }
    console.error(e);
    o.toast('儲存失敗：' + (e && e.message ? e.message : e), 5000);
  }
  async function afterSave() {
    quotaShown = connShown = false;
    if (library.status().backend !== 'browser') return;
    try {
      const u = await library.usage();
      if (u.level === 'warn' && !warned) { warned = true; showBanner(u); }
      if (dlg.open) refresh();
    } catch (_) { /* usage is only informational */ }
  }
  function showBanner(u) {
    $('span', banner).textContent = `儲存空間快滿了（已用 ${Math.round(u.ratio * 100)}%）。建議先按「備份全部」下載備份，並刪除用不到的角色。`;
    banner.hidden = false;
  }
  banner.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="backup"]')) backupAll();
    if (e.target.closest('[data-act="close"]')) banner.hidden = true;
  });

  // ------------------------------------------------------------ saving
  function makeThumb() {
    try {
      const src = o.getThumb();
      const c = document.createElement('canvas'); c.width = c.height = 256;
      c.getContext('2d').drawImage(src, 0, 0, 256, 256);
      return c.toDataURL('image/webp', 0.8);
    } catch (_) { return undefined; } // keep the previous thumbnail
  }

  /** The folder is not usable (permission must be given again, or it is gone): we do not even try to save. */
  const offline = () => !library.status().ready;
  /**
   * Save the linked character now (no-op when nothing changed). Resolves true when the entry is up to date.
   * `expectId`: a debounced save only ever writes into the entry it was scheduled for.
   */
  async function flush({ fast = false, force = false, silent = false, expectId = null } = {}) {
    clearTimeout(saveTimer); clearTimeout(peekTimer);
    if (!link) return true;
    if (expectId && link.id !== expectId) return true; // the page moved to another character since this was scheduled
    while (inflight) await inflight; // let a running save finish, then look again
    const cur = link;
    if (!cur || (expectId && cur.id !== expectId)) return true;
    if (o.generation() !== cur.gen) { link = null; lastJson = null; setStatus('idle'); return true; } // project was replaced under the link: never write it
    if (offline()) { setStatus('offline'); return false; }
    const { project, json } = snap();
    if (json === lastJson) { if (status !== 'idle') setStatus('saved'); return true; }
    setStatus('saving');
    inflight = (async () => {
      try {
        const meta = await library.save({ id: cur.id, name: cur.name, project, thumb: fast ? undefined : makeThumb(), fast });
        if (link === cur) { lastJson = json; cur.name = meta.name; setStatus('saved'); }
        afterSave();
        return true;
      } catch (e) { reportError(e, force, silent); return false; } finally { inflight = null; }
    })();
    return inflight;
  }
  /** Called by main.js after every change (its touch()). Cheap: only timers. */
  function markDirty() {
    if (!link) { paintChip(); return; }
    clearTimeout(peekTimer); clearTimeout(saveTimer);
    if (offline()) { setStatus('offline'); return; } // no save attempts, no error toasts, until the folder is reconnected
    const id = link.id;
    peekTimer = setTimeout(() => { if (link && link.id === id && snap().json !== lastJson) setStatus('saving'); }, 400); // honest status while waiting
    saveTimer = setTimeout(() => flush({ expectId: id }), autosaveMs());
  }
  /** After the storage became usable again / changed: compare the screen with the stored copy and save only if it differs. */
  async function rebaseline() {
    if (!link) return;
    const cur = link, gen = o.generation();
    if (offline()) { setStatus('offline'); return; }
    let base = null;
    try { base = JSON.stringify({ ...(await library.get(cur.id)).project, library: undefined, savedAt: 0 }); } catch (_) { /* not stored there (yet) */ }
    if (link !== cur || o.generation() !== gen) return;
    lastJson = base;
    if (base !== null && snap().json === base) setStatus('saved'); else { setStatus('saving'); flush({ expectId: cur.id }); }
  }

  /** Make sure there is somewhere to save to. May ask the user (and run the folder picker straight from a click). */
  async function ensureReady() {
    let st = library.status();
    if (st.ready) return true;
    if (st.state === 'unconfigured') {
      const r = await ask({
        title: '要把角色存在哪裡？',
        body: '<p>可以存成你電腦上某個資料夾裡的檔案（方便自己備份、複製），或存在這個瀏覽器裡。之後隨時可以在儲存庫更換。</p>',
        buttons: [{ value: 'cancel', label: '取消' }, { value: 'browser', label: '存在這個瀏覽器' }, { value: 'folder', label: '選擇電腦資料夾', primary: true }],
      });
      if (r === 'browser') await switchToBrowser();
      else if (r === 'folder') await pickFolder();
    } else if (st.state === 'folder-missing') {
      const r = await ask({
        title: '找不到儲存資料夾',
        body: `<p>資料夾「${esc(st.folderName || '')}」可能已被刪除或移動，所以這次沒辦法存進去。</p>`,
        buttons: [{ value: 'cancel', label: '取消' }, { value: 'browser', label: '改存在瀏覽器' }, { value: 'folder', label: '重新選擇資料夾', primary: true }],
      });
      if (r === 'browser') await switchToBrowser(); else if (r === 'folder') await pickFolder();
    } else {
      const r = await ask({
        title: '需要重新連接資料夾',
        body: `<p>瀏覽器重新開啟後，需要你再同意一次，才能繼續使用資料夾「${esc(st.folderName || '')}」。</p>`,
        buttons: [{ value: 'cancel', label: '取消' }, { value: 'pick', label: '選別的資料夾' }, { value: 'reconnect', label: '重新連接資料夾', primary: true }],
      });
      if (r === 'reconnect') await reconnect(); else if (r === 'pick') await pickFolder();
    }
    return library.status().ready;
  }

  /** The 儲存 button / Ctrl+S. Resolves true when the character is saved. */
  async function saveNow() {
    if (!(await ensureReady())) return false;
    if (link) {
      const ok = await flush({ force: true });
      if (ok) o.toast('已儲存');
      return ok;
    }
    const name = await promptName('幫這個角色取個名字', o.getName() || '我的角色');
    if (name === null) return false;
    if (name !== o.getName()) o.setName(name); // the project name and the library name start out the same (before the snapshot below)
    const { project, json } = snap();
    const gen = o.generation();
    setStatus('saving');
    try {
      const meta = await library.save({ name, project, thumb: makeThumb() });
      if (o.generation() !== gen || link) { setStatus('idle'); paintChip(); o.toast(`已儲存「${meta.name}」到儲存庫（畫面上的角色在這段時間換了，沒有連到它）`); afterSave(); return true; }
      link = { id: meta.id, name: meta.name, gen }; lastJson = json;
      o.writeDraft(); // the draft must know the link right now (not only after the next edit)
      setStatus('saved');
      o.toast(`已儲存「${meta.name}」到儲存庫`);
      afterSave();
      return true;
    } catch (e) { setStatus('idle'); paintChip(); reportError(e, true); return false; }
  }
  async function promptName(title, def) {
    const r = await ask({ title, input: { label: '名稱', value: def }, buttons: [{ value: 'cancel', label: '取消' }, { value: 'ok', label: '確定', primary: true }] });
    if (!r || r.value !== 'ok') return null;
    return r.text.trim() || def;
  }

  // ------------------------------------------------------------ leaving the current character
  /** Is it fine to replace the current character? Saves a linked one first, asks about an unlinked one. */
  async function guard() {
    if (link) {
      if (offline()) {
        // nothing was attempted: do not claim there are unsaved changes unless we know there are
        const same = lastJson !== null && snap().json === lastJson;
        if (same) return true;
        const r = await ask({
          title: '資料夾目前沒有連接', body: `<p>所以沒辦法確認這個角色最新的樣子是否已經存好。要先重新連接資料夾嗎？</p>`,
          buttons: [{ value: 'cancel', label: '先不要離開' }, { value: 'leave', label: '直接離開', danger: true }, { value: 'reconnect', label: '重新連接資料夾', primary: true }],
        });
        if (r === 'reconnect') { await reconnect(); return library.status().ready ? guard() : false; }
        return r === 'leave';
      }
      if (await flush({ silent: true })) return true;
      const r = await ask({
        title: '最新的變更沒有存進去', body: '<p>可能是儲存空間已滿或資料夾無法使用（可以按上方的儲存狀態查看）。現在離開的話，最後這些變更會遺失。</p>',
        buttons: [{ value: 'cancel', label: '先不要離開', primary: true }, { value: 'leave', label: '直接離開', danger: true }],
      });
      return r === 'leave';
    }
    if (!o.hasContent()) return true;
    const r = await ask({
      title: '要先儲存目前的角色嗎？', body: '<p>目前這個角色還沒有存進儲存庫，離開後就找不回來了。</p>',
      buttons: [{ value: 'cancel', label: '取消' }, { value: 'discard', label: '不儲存', danger: true }, { value: 'save', label: '儲存', primary: true }],
    });
    if (r === 'save') return saveNow();
    return r === 'discard';
  }
  const unlink = () => { o.invalidate(); /* a slow step started earlier can no longer claim this project */ link = null; lastJson = null; clearTimeout(saveTimer); clearTimeout(peekTimer); setStatus('idle'); };

  async function newCharacter() {
    if (!(await guard())) return;
    unlink(); // first: nothing from the blank character may be written into the old entry
    o.newProject();
    paintChip();
  }
  /** Before something replaces the current content (the sample): the same questions as 新角色, then the link is dropped. */
  async function leaveLinked() {
    if (!(await guard())) return false;
    unlink();
    return true;
  }

  async function openEntry(id) {
    if (o.isRestoring()) return;
    if (link && link.id === id) { dlg.close(); o.toast('這個角色已經在編輯中'); return; }
    if (!(await guard())) return;
    let got;
    try { got = await library.get(id); } catch (e) { o.toast(e instanceof NotFoundError ? '找不到這個角色，可能已被刪除' : '無法開啟：' + (e.message || e), 4000); refresh(); return; }
    unlink(); // while loading, edits must not be saved into the previous entry
    o.toast('開啟中…', 8000);
    let gen;
    try {
      gen = await o.openProject(got.project); // the generation this load created
    } catch (e) { o.toast('無法開啟這個角色：' + (e.message || e), 5000); paintChip(); return; }
    if (o.generation() !== gen || link) return; // something else replaced the project meanwhile: do not link it to this entry
    link = { id: got.meta.id, name: got.meta.name, gen };
    lastJson = snap().json; // baseline = what we just loaded, so merely opening never rewrites the entry
    o.writeDraft();
    setStatus('saved');
    if (dlg.open) dlg.close();
    o.toast(`已開啟「${link.name}」`);
  }

  /** After a reload: continue the library entry the draft belonged to. `gen` = the generation the restore created. */
  async function restoreLink({ id, name, gen } = {}) {
    if (!id) return false;
    let baseline = null;
    const st = library.status();
    if (st.ready) {
      try { baseline = (await library.get(id)).project; } catch (_) { return false; } // entry is gone → plain unlinked draft
      if (o.generation() !== gen || link) return false;
    } else if (st.backend !== 'folder') return false;
    link = { id, name: name || o.getName(), gen };
    if (!st.ready) { lastJson = null; setStatus('offline'); o.writeDraft(); return true; } // cannot compare until the folder is reconnected
    // the draft can be newer than the entry: only treat them as equal when the content really is
    lastJson = JSON.stringify({ ...baseline, library: undefined, savedAt: 0 });
    o.writeDraft();
    if (snap().json === lastJson) setStatus('saved'); else { setStatus('saving'); markDirty(); }
    return true;
  }
  /** Main calls this when the start-up restore is over (buttons are enabled again). */
  function afterRestore() { paintChip(); }

  // ------------------------------------------------------------ location (folder / browser)
  async function pickFolder() {
    let r;
    // pending changes go to the OLD location: the save is queued before the picker even opens (the picker needs the click's gesture, so it is not awaited first)
    const pending = link ? flush({ silent: true }) : null;
    try { r = await library.connectFolder(); } catch (e) { await pending; o.toast('無法選擇資料夾：' + (e.message || e), 5000); return false; }
    await pending;
    if (!r) return false; // cancelled
    if (r.status.ready && r.firstTime) {
      let n = 0;
      try { n = await library.browserCount(); } catch (_) { /* nothing to offer */ }
      if (n > 0) {
        const a = await ask({
          title: '要把瀏覽器裡的角色複製過來嗎？', body: `<p>這個瀏覽器裡已經存了 <b>${n}</b> 個角色。要複製一份到剛選的資料夾嗎？（瀏覽器裡的原件不會被刪除。）</p>`,
          buttons: [{ value: 'no', label: '不用' }, { value: 'yes', label: '複製過來', primary: true }],
        });
        if (a === 'yes') { try { const c = await library.copyBrowserToFolder(); o.toast(`已複製 ${c} 個角色到資料夾`); } catch (e) { o.toast('複製失敗：' + (e.message || e), 5000); } }
      }
    }
    await locationChanged();
    return library.status().ready;
  }
  async function reconnect() {
    try { await library.reconnectFolder(); } catch (e) { o.toast('無法連接資料夾：' + (e.message || e), 5000); }
    await locationChanged();
    return library.status().ready;
  }
  async function switchToBrowser() { if (link) await flush({ silent: true }); await library.useBrowser(); await locationChanged(); }
  async function switchToFolder() {
    if (library.status().hasSavedFolder) { if (link) await flush({ silent: true }); await library.useFolder(); await locationChanged(); } else await pickFolder();
  }
  /** The storage moved or came back: forget the old baseline, compare with the copy in the new place, save only if it differs. */
  async function locationChanged() {
    quotaShown = connShown = false;
    if (link) { lastJson = null; clearTimeout(saveTimer); await rebaseline(); o.writeDraft(); }
    if (dlg.open) await refresh();
  }

  // ------------------------------------------------------------ actions on entries
  async function backupAll() {
    if (!(await ensureReady())) return;
    try {
      if (link) await flush();
      const r = await library.exportAll();
      if (!r.count) { o.toast('儲存庫還是空的，沒有東西可以備份'); return; }
      o.download(r.blob, r.filename);
      o.toast(`已下載備份（${r.count} 個角色）`);
    } catch (e) { o.toast('備份失敗：' + (e.message || e), 5000); }
  }
  async function importFiles(files) {
    if (!files.length || !(await ensureReady())) return;
    try {
      const r = await library.importFiles(files);
      const bits = [];
      if (r.added.length) bits.push(`已匯入 ${r.added.length} 個角色`);
      if (r.same) bits.push(`${r.same} 個已經在儲存庫裡`);
      const why = { 'not-project': '不是 Char3D 角色檔', 'bad-file': '無法讀取', quota: '空間不足', error: '發生錯誤' };
      if (r.failed.length) bits.push(`${r.failed.length} 個沒有匯入（${[...new Set(r.failed.map((f) => why[f.reason] || f.reason))].join('、')}）`);
      if (!bits.length) bits.push('沒有找到可以匯入的角色');
      view.msg = bits.join('，') + '。';
      o.toast(view.msg, 4500);
      if (r.quota) showQuotaDialog();
    } catch (e) { view.msg = ''; o.toast('匯入失敗：' + (e.message || e), 5000); }
    await refresh();
  }
  async function renameEntry(id) {
    const m = view.metas.find((x) => x.id === id); if (!m) return;
    const name = await promptName('重新命名', m.name);
    if (name === null || name === m.name) return;
    try {
      if (link && link.id === id) await flush();
      const meta = await library.rename(id, name);
      if (link && link.id === id) { link.name = meta.name; o.setName(meta.name); paintChip(); }
    } catch (e) { o.toast('重新命名失敗：' + (e.message || e), 5000); }
    await refresh();
  }
  async function duplicateEntry(id) {
    const m = view.metas.find((x) => x.id === id); if (!m) return;
    try {
      if (link && link.id === id) await flush();
      const meta = await library.duplicate(id, `${m.name} 複製`);
      o.toast(`已複製為「${meta.name}」`);
      afterSave();
    } catch (e) { if (e instanceof QuotaError) showQuotaDialog(); else o.toast('複製失敗：' + (e.message || e), 5000); }
    await refresh();
  }
  async function exportEntry(id) {
    try {
      if (link && link.id === id) await flush();
      const r = await library.exportOne(id);
      o.download(r.blob, r.filename);
    } catch (e) { o.toast('匯出失敗：' + (e.message || e), 5000); }
  }
  async function deleteEntry(id) {
    const m = view.metas.find((x) => x.id === id); if (!m) return;
    const isCurrent = link && link.id === id;
    const r = await ask({
      title: `要刪除「${m.name}」嗎？`,
      body: `<p>刪除後就找不回來了。${isCurrent ? '這個角色目前正在編輯，刪除後畫面上的內容會保留，但不再自動儲存。' : ''}</p>`,
      buttons: [{ value: 'cancel', label: '取消', primary: true }, { value: 'del', label: '刪除', danger: true }],
    });
    if (r !== 'del') return;
    try {
      if (isCurrent) { unlink(); o.writeDraft(); }
      await library.remove(id);
      o.toast(`已刪除「${m.name}」`);
    } catch (e) { o.toast('刪除失敗：' + (e.message || e), 5000); }
    await refresh();
  }

  // ------------------------------------------------------------ panel
  async function refresh() {
    const st = library.status();
    let metas = [], usage = null, err = null;
    if (st.ready) {
      try { metas = await library.list(); usage = await library.usage(); } catch (e) { err = e; }
    }
    view = { ...view, st: library.status(), metas, usage, err };
    render();
  }
  function locationHTML(st) {
    const bits = [];
    if (st.backend === 'folder') {
      bits.push(`<div class="lib-loc"><span class="lib-k">儲存位置</span><b>📁 ${esc(st.folderName || '（尚未選擇）')}</b>
        ${st.ready ? '<button type="button" class="btn small" data-do="pick">更換資料夾</button><button type="button" class="btn small" data-do="use-browser">改用瀏覽器儲存</button>' : ''}</div>`);
      if (st.state === 'unconfigured') bits.push(`<div class="lib-alert"><p>選一個你電腦上的資料夾，每個角色會變成裡面的一個檔案（<code>.c3d.json</code>），你可以自己備份或搬移。</p>
        <div class="btn-row"><button type="button" class="btn primary" data-do="pick">選擇資料夾</button><button type="button" class="btn" data-do="use-browser">改存在瀏覽器</button></div></div>`);
      else if (st.state === 'needs-permission' || st.state === 'denied') bits.push(`<div class="lib-alert"><p>瀏覽器需要你再同意一次，才能繼續使用資料夾「${esc(st.folderName || '')}」。</p>
        <div class="btn-row"><button type="button" class="btn primary" data-do="reconnect">重新連接資料夾</button><button type="button" class="btn" data-do="pick">選別的資料夾</button><button type="button" class="btn" data-do="use-browser">改用瀏覽器儲存</button></div></div>`);
      else if (st.state === 'folder-missing') bits.push(`<div class="lib-alert"><p>找不到資料夾「${esc(st.folderName || '')}」，可能已被刪除或移動。</p>
        <div class="btn-row"><button type="button" class="btn primary" data-do="pick">重新選擇資料夾</button><button type="button" class="btn" data-do="use-browser">改用瀏覽器儲存</button></div></div>`);
      else if (st.state === 'error') bits.push('<div class="lib-alert"><p>無法讀取這個資料夾，請重新選擇。</p><div class="btn-row"><button type="button" class="btn primary" data-do="pick">重新選擇資料夾</button></div></div>');
    } else {
      bits.push(`<div class="lib-loc"><span class="lib-k">儲存位置</span><b>這個瀏覽器</b>
        ${st.canUseFolder ? '<button type="button" class="btn small" data-do="use-folder">改存到電腦資料夾</button>' : ''}</div>`);
      if (!st.hasPicker && !st.mobile) bits.push('<p class="note">想把角色直接存成電腦資料夾裡的檔案？請改用 Chrome 或 Edge 瀏覽器。</p>');
    }
    return bits.join('');
  }
  function usageHTML(st, u) {
    if (!u || !st.ready) return '';
    if (u.backend === 'folder') return `<p class="note">共 ${u.count} 個角色，約 ${fmtBytes(u.used)}。</p>`;
    const pct = Math.min(100, u.ratio * 100);
    const level = u.level;
    const msg = u.level === 'block' ? `儲存空間已滿（已用 ${Math.round(u.ratio * 100)}%），暫時無法再儲存。請先備份，再刪除用不到的角色。`
      : u.level === 'warn' ? `儲存空間快滿了（已用 ${Math.round(u.ratio * 100)}%）。建議現在先備份，並刪除用不到的角色。` : '';
    return `<div class="lib-usage ${level}">
      <div class="lib-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="儲存空間使用量"><i style="width:${pct.toFixed(1)}%"></i></div>
      <p class="lib-usage-text">已使用 ${fmtBytes(u.used)} / 可用約 ${fmtBytes(u.quota)}（${pct < 1 && u.used ? '<1' : Math.round(pct)}%）${u.estimated ? '' : ' · 估計值'}</p>
      ${msg ? `<div class="lib-warn" role="alert"><span>${msg}</span><button type="button" class="btn small" data-do="backup">備份全部</button></div>` : ''}
      <p class="note">${u.persistent === true ? '瀏覽器已承諾保留這些資料。' : u.persistent === false ? '瀏覽器可能在裝置空間不足時自動清除這些資料，請定期按「備份全部」。' : ''}</p>
    </div>`;
  }
  function cardHTML(m) {
    const cur = link && link.id === m.id;
    const img = typeof m.thumb === 'string' && m.thumb.startsWith('data:image/') ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : PLACEHOLDER;
    return `<article class="lib-card${cur ? ' current' : ''}" data-id="${esc(m.id)}">
      <div class="lib-thumb">${img}</div>
      <div class="lib-info">
        <h3 title="${esc(m.name)}">${esc(m.name)}</h3>
        <p><span class="badge">${m.mode === 'object' ? '物件' : '角色'}</span>${cur ? '<span class="badge ok">編輯中</span>' : ''}</p>
        <p class="lib-sub">${esc(fmtDate(m.updatedAt))} · ${fmtBytes(m.size || 0)}</p>
      </div>
      <div class="lib-acts">
        <button type="button" class="btn primary small" data-do="open">${cur ? '回到編輯' : '開啟'}</button>
        <button type="button" class="btn small" data-do="rename">重新命名</button>
        <button type="button" class="btn small" data-do="dup">複製</button>
        <button type="button" class="btn small" data-do="export">匯出檔案</button>
        <button type="button" class="btn small danger" data-do="del">刪除</button>
      </div>
    </article>`;
  }
  function render() {
    const { st, metas, usage, err } = view;
    const parts = [locationHTML(st), usageHTML(st, usage)];
    if (err) parts.push(`<div class="lib-alert"><p>讀取儲存庫時發生問題：${esc(err.message || err)}</p></div>`);
    if (view.msg) parts.push(`<p class="lib-msg" role="status">${esc(view.msg)}</p>`);
    if (st.ready && !err) {
      parts.push(metas.length
        ? `<div class="lib-grid">${metas.map(cardHTML).join('')}</div>`
        : `<div class="lib-empty"><div class="lib-empty-ico">${PLACEHOLDER}</div><h3>儲存庫還是空的</h3>
            <p>儲存庫是你的角色收納箱：把做到一半的角色或物件存在這裡，之後隨時打開繼續編輯。</p>
            <p>按上方的「儲存」就會放進來；也可以按下面的「匯入」放入之前備份的檔案。</p></div>`);
    }
    body.innerHTML = parts.join('');
    const noStore = !st.ready;
    $('#libImport').disabled = noStore; $('#libBackup').disabled = noStore;
  }
  const guardBusy = (fn) => async (...a) => { if (busy) return; busy = true; try { await fn(...a); } finally { busy = false; } };
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-do]'); if (!b) return;
    const id = b.closest('.lib-card')?.dataset.id;
    const act = b.dataset.do;
    // picker / permission prompts need the click's user gesture → call them before anything is awaited
    if (act === 'pick') return void guardBusy(pickFolder)();
    if (act === 'reconnect') return void guardBusy(reconnect)();
    const run = { 'use-browser': switchToBrowser, 'use-folder': switchToFolder, backup: backupAll, open: () => openEntry(id), rename: () => renameEntry(id), dup: () => duplicateEntry(id), export: () => exportEntry(id), del: () => deleteEntry(id) }[act];
    if (run) guardBusy(run)();
  });
  $('#libImport').addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { const files = [...fileIn.files]; fileIn.value = ''; importFiles(files); });
  $('#libBackup').addEventListener('click', guardBusy(backupAll));
  $('#libClose').addEventListener('click', () => dlg.close());
  $('#libDone').addEventListener('click', () => dlg.close());

  async function openPanel() {
    view.msg = '';
    if (!dlg.open) dlg.showModal();
    render();
    await refresh(); // the gallery is re-read every time the panel opens (another tab may have changed it)
  }

  // ------------------------------------------------------------ top bar + shortcuts + page lifecycle
  $('#btnLibrary').addEventListener('click', openPanel);
  $('#btnSave').addEventListener('click', guardBusy(saveNow));
  $('#btnNew').addEventListener('click', guardBusy(newCharacter));
  chip.addEventListener('click', () => (link ? openPanel() : saveNow()));
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault(); // never let the browser's "save page" dialog open
      if (!document.querySelector('dialog[open]') && !busy && !o.isRestoring()) guardBusy(saveNow)();
    }
  });
  // a closing tab: save what is pending (fast = no compression, so the write starts immediately)
  const onHide = () => { o.flushDraft(); if (link) flush({ fast: true }); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onHide(); });
  addEventListener('pagehide', onHide);

  const ready = library.init().then(() => { view.st = library.status(); paintChip(); }).catch((e) => console.warn('library init failed', e));
  return {
    ready, markDirty, flush, saveNow, guard, leaveLinked, restoreLink, afterRestore, openEntry, openPanel, refresh,
    get linked() { return link && o.generation() === link.gen ? { ...link } : null; }, get status() { return status; },
  };
}
