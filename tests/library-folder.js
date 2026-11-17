// Folder backend: showDirectoryPicker is stubbed to hand out an OPFS directory (a real FileSystemDirectoryHandle).
const { open, ready, suite, main } = require('./_helpers');
const L = require('./_lib');

const DIR = 'char3d-test-lib';
const INIT = require('./_opfs')(DIR);
const files = (page) => page.evaluate(async (d) => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
  const out = [];
  for await (const h of dir.values()) out.push({ name: h.name, size: h.kind === 'file' ? (await h.getFile()).size : 0 });
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}, DIR);
const readJson = (page, name) => page.evaluate(async ([d, n]) => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
  return JSON.parse(await (await (await dir.getFileHandle(n)).getFile()).text());
}, [DIR, name]);
const projectFiles = async (page) => (await files(page)).filter((f) => f.name.endsWith('.c3d.json'));

main('library-folder', async (base) => {
  const t = suite('library-folder');
  const { browser, page, errors } = await open(base, { library: true, init: INIT });

  // ---- connect + first save
  await page.click('#btnSample'); await ready(page);
  await L.saveAs(page, '勇者', 'folder');
  const id1 = await L.linkedId(page);
  t.eq(await page.evaluate(() => window.__c3d.library.status().backend + '/' + window.__c3d.library.status().state + '/' + window.__c3d.library.status().folderName), `folder/ready/${DIR}`, 'folder connected and ready');
  let fl = await files(page);
  const id8 = id1.replace(/[^a-z0-9]/gi, '').slice(0, 8);
  t.eq(fl.map((f) => f.name).sort(), ['char3d-library.json', `勇者__${id8}.c3d.json`].sort(), 'folder holds <name>__<id8>.c3d.json and the index');
  const proj = await readJson(page, `勇者__${id8}.c3d.json`);
  t.ok(proj.format === 'char3d-project' && proj.library.id === id1 && proj.library.name === '勇者' && proj.library.createdAt && proj.library.updatedAt, 'file is a normal project with library { id, name, createdAt, updatedAt }');
  let idx = await readJson(page, 'char3d-library.json');
  const e = idx.entries[0];
  t.ok(idx.entries.length === 1 && e.id === id1 && e.name === '勇者' && e.mode === 'character' && e.size > 1000 && e.file === `勇者__${id8}.c3d.json` && e.createdAt && e.updatedAt && e.thumb.startsWith('data:image/'), 'index entry: id, name, mode, timestamps, size, file, thumbnail', e && { ...e, thumb: '…' });
  t.eq(e.size, fl.find((f) => f.name === e.file).size, 'index size equals the file size');

  // ---- auto-save writes into the same file
  await L.editHead(page, 0.4);
  await L.until(page, async ([d, n]) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
    return JSON.parse(await (await (await dir.getFileHandle(n)).getFile()).text()).slots.head.params.offset[1] === 0.4;
  }, [DIR, `勇者__${id8}.c3d.json`]);
  t.ok(true, 'auto-save updated the file');
  await L.waitStatus(page, '已儲存');

  // ---- rename renames the file
  await L.openPanel(page);
  await L.cardAct(page, '勇者', 'rename'); await L.answer(page, 'ok', '英雄');
  await page.waitForFunction(() => [...document.querySelectorAll('#libBody h3')].some((h) => h.textContent === '英雄'));
  t.eq((await projectFiles(page)).map((f) => f.name), [`英雄__${id8}.c3d.json`], 'rename renamed the file (old name gone)');
  t.eq((await readJson(page, `英雄__${id8}.c3d.json`)).library.name, '英雄', 'new name is inside the file too');
  t.ok((await page.textContent('#libStatus')).includes('英雄'), 'status chip shows the new name');

  // ---- duplicate, delete
  await L.cardAct(page, '英雄', 'dup');
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length === 2);
  t.eq((await projectFiles(page)).length, 2, 'duplicate = second file');
  await L.cardAct(page, '英雄 複製', 'del'); await L.answer(page, 'del');
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length === 1);
  t.eq((await projectFiles(page)).length, 1, 'delete removed the file');
  t.eq((await readJson(page, 'char3d-library.json')).entries.length, 1, 'delete updated the index');

  // ---- index deleted → rebuilt; thumbnails survive (they live in the files too)
  await L.closePanel(page);
  await page.evaluate(async (d) => { await (await (await navigator.storage.getDirectory()).getDirectoryHandle(d)).removeEntry('char3d-library.json'); }, DIR);
  const rebuilt = await L.list(page);
  t.ok(rebuilt.length === 1 && rebuilt[0].id === id1 && rebuilt[0].name === '英雄' && rebuilt[0].thumb && rebuilt[0].thumb.startsWith('data:image/'), 'index rebuilt from the files (id, name, thumbnail intact)');
  t.ok((await files(page)).some((f) => f.name === 'char3d-library.json'), 'the index file is written again');

  // ---- a file the user dropped into the folder by hand shows up (also one with no library block, and junk is ignored)
  await page.evaluate(async (d) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
    const src = JSON.parse(await (await (await dir.getFileHandle([...(await (async () => { const n = []; for await (const h of dir.values()) if (h.name.endsWith('.c3d.json')) n.push(h.name); return n; })())][0])).getFile()).text());
    delete src.library; src.settings = { ...src.settings, name: '手動放入' };
    const put = async (n, text) => { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(text); await w.close(); };
    await put('copied-by-hand.c3d.json', JSON.stringify(src));
    await put('broken.c3d.json', '{ not json');
    await put('notes.txt', 'hello');
  }, DIR);
  await L.openPanel(page);
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length === 2, null, { timeout: 15000 }).catch(() => {});
  t.eq((await L.cards(page)).map((c) => c.name).sort(), ['手動放入', '英雄'].sort(), 'hand-copied file appears in the gallery; broken file and notes.txt are ignored');
  t.eq((await readJson(page, 'char3d-library.json')).entries.length, 2, 'index now lists both');
  const handId = (await L.list(page)).find((m) => m.name === '手動放入').id;
  t.eq((await L.list(page)).find((m) => m.name === '手動放入').id, handId, 'the id of a hand-copied file is stable across scans');
  await L.closePanel(page);

  // ---- reload: remembered handle, same linked character
  await page.waitForTimeout(1600);
  await page.reload();
  await page.waitForFunction(() => window.__c3d && window.__c3d.lib);
  await L.waitLinked(page, '英雄');
  t.eq(await page.evaluate(() => window.__c3d.library.status().state), 'ready', 'after reload the folder is used again without asking');
  t.eq(await L.linkedId(page), id1, 'after reload the draft continues the same entry');

  // ---- permission has to be granted again → 重新連接資料夾 button
  await page.evaluate(() => sessionStorage.setItem('perm', 'prompt'));
  await page.reload();
  await page.waitForFunction(() => window.__c3d && window.__c3d.lib);
  await page.waitForTimeout(800);
  t.eq(await page.evaluate(() => window.__c3d.library.status().state), 'needs-permission', 'permission "prompt" is detected');
  await page.click('#btnSave'); // saving while disconnected explains instead of failing silently
  await page.waitForSelector('.ask-dlg[open]');
  t.ok((await page.textContent('.ask-dlg[open]')).includes('重新連接資料夾'), 'saving while disconnected asks to reconnect');
  await L.answer(page, 'cancel');
  await L.openPanel(page);
  const reconnectBtn = page.locator('#libBody [data-do="reconnect"]');
  t.eq(await reconnectBtn.textContent(), '重新連接資料夾', 'panel offers 「重新連接資料夾」');
  await reconnectBtn.click();
  await page.waitForFunction(() => window.__c3d.library.status().state === 'ready');
  await page.waitForSelector('#libBody .lib-grid');
  t.eq((await L.cards(page)).length, 2, 'after reconnecting the gallery is back');
  await L.closePanel(page);

  // ---- write failure (disk full) → blocking dialog, nothing half written
  // the link made while disconnected could not be verified, so it re-saves once after reconnecting: let that finish first
  await L.waitStatus(page, '已儲存'); await page.waitForTimeout(3500);
  const beforeFiles = await files(page);
  const beforeProj = JSON.stringify(await readJson(page, `英雄__${id8}.c3d.json`));
  await page.evaluate(() => {
    const w = FileSystemWritableFileStream.prototype.write;
    FileSystemWritableFileStream.prototype.write = function (...a) { if (window.__failWrite) return Promise.reject(new DOMException('disk full', 'QuotaExceededError')); return w.apply(this, a); };
  });
  await L.editHead(page, 0.9);
  await page.evaluate(() => { window.__failWrite = true; });
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.ask-dlg[open]');
  t.ok((await page.textContent('.ask-dlg[open]')).includes('沒有存進去'), 'disk-full write: blocking dialog says it did not save');
  await L.answer(page, 'close');
  t.eq(await files(page), beforeFiles, 'no file added, removed or truncated (no half-written leftovers)');
  t.ok(JSON.stringify(await readJson(page, `英雄__${id8}.c3d.json`)) === beforeProj, 'the old file content is untouched');
  t.eq(await L.headY(page), 0.9, 'the work on screen is still there');
  t.ok((await page.textContent('#libStatus')).includes('儲存失敗'), 'status chip says 儲存失敗');
  await page.evaluate(() => { window.__failWrite = false; });
  await page.keyboard.press('Control+s');
  await L.waitStatus(page, '已儲存');
  t.eq((await readJson(page, `英雄__${id8}.c3d.json`)).slots.head.params.offset[1], 0.9, 'once space is back, saving works again');

  // ---- folder deleted / moved → clear message, pick again
  await page.evaluate(async (d) => { await (await navigator.storage.getDirectory()).removeEntry(d, { recursive: true }); }, DIR);
  await page.reload();
  await page.waitForFunction(() => window.__c3d && window.__c3d.lib);
  await page.waitForTimeout(800);
  t.eq(await page.evaluate(() => window.__c3d.library.status().state), 'folder-missing', 'a deleted folder is detected');
  await L.openPanel(page);
  t.ok((await page.textContent('#libBody')).includes('找不到資料夾'), 'panel says the folder cannot be found');
  await page.click('#libBody [data-do="pick"]');
  await page.waitForFunction(() => window.__c3d.library.status().state === 'ready');
  await page.waitForSelector('#libBody .lib-empty');
  t.ok(true, 'picking a folder again works (new empty folder)');
  await L.closePanel(page);
  await L.until(page, async (d) => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
      let big = false;
      for await (const h of dir.values()) { if (h.name.endsWith('.crswap')) return false; /* a write is still running */ if (h.name.endsWith('.c3d.json') && (await h.getFile()).size > 1000) big = true; }
      return big;
    } catch (_) { return false; }
  }, DIR);
  t.ok(true, 'the character that was open is written into the new folder by auto-save');
  t.eq(errors.filter((x) => !/QuotaExceeded|disk full/i.test(x)), [], 'no console / page errors (folder session)');
  await browser.close();

  // ---- first-time folder connect with characters already in the browser → offer to copy
  const b2 = await open(base, { library: true, init: INIT });
  await b2.page.evaluate(() => window.__c3d.library.useBrowser());
  await b2.page.click('#btnSample'); await ready(b2.page);
  await L.saveAs(b2.page, '舊瀏覽器角色');
  await L.openPanel(b2.page);
  await b2.page.click('#libBody [data-do="use-folder"]');
  await b2.page.waitForSelector('.ask-dlg[open]');
  t.ok((await b2.page.textContent('.ask-dlg[open]')).includes('複製'), 'connecting a folder offers to copy the browser characters');
  await L.answer(b2.page, 'yes');
  await L.until(b2.page, async (d) => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
      let big = false;
      for await (const h of dir.values()) { if (h.name.endsWith('.crswap')) return false; /* a write is still running */ if (h.name.endsWith('.c3d.json') && (await h.getFile()).size > 1000) big = true; }
      return big;
    } catch (_) { return false; }
  }, DIR);
  t.eq((await projectFiles(b2.page)).length, 1, 'the character was copied into the folder as a file', JSON.stringify(await files(b2.page)));
  await b2.page.waitForFunction(() => window.__c3d.library.status().backend === 'folder' && document.querySelectorAll('#libBody .lib-card').length === 1);
  t.eq((await L.cards(b2.page)).map((c) => [c.name, c.current]), [['舊瀏覽器角色', true]], 'the open character is still the current one after the move');
  t.eq(b2.errors, [], 'no console / page errors (migration session)');
  await b2.browser.close();
  return t.done();
});
