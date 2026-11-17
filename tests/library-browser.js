// Browser backend (IndexedDB): save, auto-save, reload, open, rename, duplicate, delete, backup, import.
const fs = require('fs'), os = require('os'), path = require('path');
const { open, ready, suite, main } = require('./_helpers');
const L = require('./_lib');

main('library-browser', async (base) => {
  const t = suite('library-browser');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3d-'));
  const { browser, ctx, page, errors } = await open(base, { library: true });

  // ---- start state
  t.ok(await page.evaluate(() => window.__c3d.library.status().canUseFolder), 'headless Chromium counts as a desktop with the folder picker');
  t.eq(await page.$$eval('.actions .btn', (b) => b.map((x) => x.textContent)), ['說明', '範例', '儲存庫', '儲存', '新角色', '匯出'], 'top bar buttons');
  await L.openPanel(page);
  t.ok((await page.textContent('#libBody')).includes('選擇資料夾'), 'desktop with no choice yet: panel offers to pick a folder');
  await L.closePanel(page);

  // ---- save new (choose browser storage)
  await page.click('#btnSample'); await ready(page);
  await L.saveAs(page, '勇者', 'browser');
  let items = await L.list(page);
  t.eq(items.map((m) => [m.name, m.mode]), [['勇者', 'character']], 'new character saved into the library');
  t.ok(items[0].thumb && items[0].thumb.startsWith('data:image/'), 'thumbnail stored');
  t.ok(items[0].size > 1000 && items[0].encoding === 'gzip', `payload stored gzip-compressed (${items[0].size} bytes)`);
  t.ok((await page.textContent('#libStatus')).includes('勇者') && (await page.textContent('#libStatus')).includes('已儲存'), 'status chip: name + 已儲存');
  const idb = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('char3d'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const stores = [...db.objectStoreNames], ver = db.version;
    const rec = await new Promise((res) => { const r = db.transaction('lib-data').objectStore('lib-data').getAll(); r.onsuccess = () => res(r.result); });
    const draft = await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get('autosave'); r.onsuccess = () => res(r.result); });
    db.close();
    return { stores, ver, types: rec.map((x) => [x.blob instanceof Blob, typeof x.blob, x.encoding]), hasDraft: !!draft };
  });
  t.eq(idb.stores.sort(), ['kv', 'lib-data', 'lib-meta'], 'db has kv + two library stores');
  t.eq(idb.types, [[true, 'object', 'gzip']], 'payload is a Blob, not a string');
  t.ok(idb.ver >= 2, 'db version bumped');
  const id1 = await L.linkedId(page);
  const firstSaved = items[0].updatedAt;
  await page.waitForTimeout(3600);
  t.eq((await L.list(page))[0].updatedAt, firstSaved, 'right after the first save nothing is saved again (no phantom changes)');

  // ---- auto-save after an edit (debounced), without pressing anything
  const before = (await L.list(page))[0].updatedAt;
  await L.editHead(page, 0.4);
  await page.waitForFunction(() => document.querySelector('#libStatus').textContent.includes('儲存中'), null, { timeout: 5000 }).catch(() => {});
  await L.waitStatus(page, '已儲存');
  await L.until(page, (b) => window.__c3d.library.list().then((l) => l[0].updatedAt !== b), before);
  const saved = await page.evaluate((id) => window.__c3d.library.get(id).then((g) => g.project.slots.head.params.offset), id1);
  t.eq(saved[1], 0.4, 'auto-save wrote the edit into the entry');

  // ---- reload → same linked character (draft remembers the entry)
  await page.waitForTimeout(1600); // let the draft write finish
  await page.reload();
  await page.waitForFunction(() => window.__c3d && window.__c3d.lib);
  await L.waitLinked(page, '勇者');
  t.eq(await L.linkedId(page), id1, 'after reload the draft continues the same library entry');
  t.eq(await L.headY(page), 0.4, 'after reload the edit is still there');
  await L.waitStatus(page, '已儲存');
  const upd = (await L.list(page))[0].updatedAt;
  await page.waitForTimeout(3500);
  t.eq((await L.list(page))[0].updatedAt, upd, 'merely reloading does not re-save the entry');

  // ---- Ctrl+S on a linked character, and the hidden-tab flush
  await L.editHead(page, 0.3);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await L.until(page, (id) => window.__c3d.library.get(id).then((g) => g.project.slots.head.params.offset[1] === 0.3), id1, 15000);
  t.ok(true, 'switching away from the tab flushes the pending save right away (no 2.5 s wait)');
  await page.evaluate(() => { delete document.visibilityState; });
  await L.editHead(page, 0.2);
  await page.keyboard.press('Control+s');
  await L.until(page, (id) => window.__c3d.library.get(id).then((g) => g.project.slots.head.params.offset[1] === 0.2), id1, 15000);
  t.ok(true, 'Ctrl+S saves immediately');

  // ---- new character: linked → saved first, blank, unlinked
  await page.click('#btnNew');
  await page.waitForFunction(() => !window.__c3d.lib.linked && !document.querySelector('.ask-dlg[open]'));
  t.eq(await page.evaluate(() => Object.keys(window.__c3d.state.slots).filter((k) => window.__c3d.state.slots[k].views.front)), [], '新角色 gives a blank character');
  t.eq((await L.list(page)).length, 1, 'the earlier character is still in the library');

  // ---- unlinked with content: ask 儲存 / 不儲存 / 取消
  await page.click('#btnSample'); await ready(page);
  await page.click('#btnNew');
  t.eq(await page.$$eval('.ask-dlg[open] .btn', (b) => b.map((x) => x.textContent)), ['取消', '不儲存', '儲存'], 'unsaved character: 取消 / 不儲存 / 儲存');
  await L.answer(page, 'cancel');
  t.ok(await page.evaluate(() => !!window.__c3d.state.slots.head.views.front), '取消 keeps the work');
  await page.click('#btnNew'); await L.answer(page, 'save'); await L.answer(page, 'ok', '第二個');
  await L.until(page, () => !document.querySelector('.ask-dlg[open]') && !window.__c3d.lib.linked ? window.__c3d.library.list().then((l) => l.length === 2) : false);
  t.eq((await L.list(page)).map((m) => m.name).sort(), ['勇者', '第二個'].sort(), '儲存 in the prompt saved it, then started a new character');

  // ---- gallery: open the first one
  await L.openPanel(page);
  t.eq((await L.cards(page)).map((c) => c.name), ['第二個', '勇者'], 'gallery shows both, most recent first');
  await L.cardAct(page, '勇者', 'open');
  await L.waitLinked(page, '勇者');
  t.eq(await page.evaluate(() => !!document.querySelector('#libraryDlg[open]')), false, 'opening closes the panel');
  t.eq(await L.headY(page), 0.2, 'opened character has its saved values');
  await L.openPanel(page);
  t.eq((await L.cards(page)).filter((c) => c.current).map((c) => c.name), ['勇者'], 'current character is marked');

  // ---- rename / duplicate / delete
  await L.cardAct(page, '第二個', 'rename'); await L.answer(page, 'ok', '第二隻');
  await page.waitForFunction(() => [...document.querySelectorAll('#libBody h3')].some((h) => h.textContent === '第二隻'));
  t.eq((await L.list(page)).map((m) => m.name).sort(), ['勇者', '第二隻'].sort(), 'rename');
  await L.cardAct(page, '第二隻', 'dup');
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length === 3);
  const all = await L.list(page);
  t.ok(new Set(all.map((m) => m.id)).size === 3 && all.some((m) => m.name === '第二隻 複製'), 'duplicate has its own id');
  await L.cardAct(page, '第二隻 複製', 'del');
  t.ok((await page.textContent('.ask-dlg[open]')).includes('刪除'), 'delete asks for confirmation');
  await L.answer(page, 'cancel');
  t.eq((await L.list(page)).length, 3, 'cancelling the confirmation keeps it');
  await L.cardAct(page, '第二隻 複製', 'del'); await L.answer(page, 'del');
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length === 2);
  t.eq((await L.list(page)).length, 2, 'delete');
  const orphan = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('char3d'); r.onsuccess = () => res(r.result); });
    const n = (s) => new Promise((res) => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => res(r.result); });
    const out = [await n('lib-meta'), await n('lib-data')]; db.close(); return out;
  });
  t.eq(orphan, [2, 2], 'metadata and payload stores stay in step');

  // ---- export one file, backup all
  // (Playwright reports non-ASCII download names as "download", so the name is read from the <a download> the app clicks)
  await page.evaluate(() => { const o = HTMLAnchorElement.prototype.click; window.__dl = []; HTMLAnchorElement.prototype.click = function () { window.__dl.push(this.download); return o.call(this); }; });
  const [dl1] = await Promise.all([page.waitForEvent('download'), L.cardAct(page, '第二隻', 'export')]);
  const dlName = await page.evaluate(() => window.__dl[0]);
  t.ok(/^第二隻__[0-9a-f]{8}\.c3d\.json$/.test(dlName), `single export file name (${dlName})`);
  const one = JSON.parse(fs.readFileSync(await dl1.path(), 'utf8'));
  t.ok(one.format === 'char3d-project' && one.library && one.library.name === '第二隻', 'single export is a normal project file with a library block');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#libBackup')]);
  const zipPath = path.join(tmp, dl2.suggestedFilename()); await dl2.saveAs(zipPath);
  const names = await L.unzipNames(page, zipPath);
  t.eq(names.map((n) => n.lib.name).sort(), ['勇者', '第二隻'].sort(), `backup ZIP holds every character (${dl2.suggestedFilename()})`);
  t.ok(names.every((n) => n.name.endsWith('.c3d.json') && n.format === 'char3d-project'), 'ZIP entries are .c3d.json project files');
  // hand-made old-style project (no library block), for the import test below
  const plain = Object.assign({}, one); delete plain.library; plain.settings = { ...plain.settings, name: '舊檔案' };
  fs.writeFileSync(path.join(tmp, 'old.c3d.json'), JSON.stringify(plain));
  fs.writeFileSync(path.join(tmp, 'junk.json'), '{"hello":1}');

  // ---- delete the current one → unlinked
  await L.cardAct(page, '勇者', 'del'); await L.answer(page, 'del');
  await page.waitForFunction(() => !window.__c3d.lib.linked);
  t.ok(await page.evaluate(() => !!window.__c3d.state.slots.head.views.front), 'deleting the open character keeps what is on screen');
  await L.closePanel(page);
  await browser.close();

  // ---- import the backup into an EMPTY library (new browser profile)
  const b2 = await open(base, { library: true });
  await b2.page.evaluate(() => window.__c3d.library.useBrowser());
  await L.openPanel(b2.page);
  t.ok((await b2.page.textContent('#libBody')).includes('儲存庫還是空的'), 'empty state explains the library');
  await b2.page.setInputFiles('#libFile', [zipPath, path.join(tmp, 'old.c3d.json'), path.join(tmp, 'junk.json')]);
  await b2.page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length === 3);
  const imp = await L.list(b2.page);
  t.eq(imp.map((m) => m.name).sort(), ['勇者', '第二隻', '舊檔案'].sort(), 'ZIP + plain project imported, junk skipped');
  t.ok((await b2.page.textContent('#libBody .lib-msg')).includes('沒有匯入'), 'the skipped file is reported');
  const idsBefore = imp.map((m) => m.id).sort();
  t.ok(imp.find((m) => m.name === '勇者').id === (names.find((n) => n.lib.name === '勇者').lib.id), 'ids from the backup are kept when free');
  // importing the same ZIP again: identical content is not duplicated
  await b2.page.setInputFiles('#libFile', [zipPath]);
  await b2.page.waitForFunction(() => document.querySelector('#libBody .lib-msg')?.textContent.includes('已經在儲存庫'));
  t.eq((await L.list(b2.page)).map((m) => m.id).sort(), idsBefore, 'same file again: nothing duplicated');
  // same id but different content → both kept, new id
  const changed = JSON.parse(JSON.stringify(one)); changed.settings.colors.skin = '#123456';
  fs.writeFileSync(path.join(tmp, 'changed.c3d.json'), JSON.stringify(changed));
  await b2.page.setInputFiles('#libFile', [path.join(tmp, 'changed.c3d.json')]);
  await b2.page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length === 4);
  const after = await L.list(b2.page);
  t.ok(after.filter((m) => m.name === '第二隻').length === 2 && new Set(after.map((m) => m.id)).size === 4, 'same id, different content: imported under a new id, original untouched');
  // an imported character really opens
  await L.cardAct(b2.page, '舊檔案', 'open'); await L.waitLinked(b2.page, '舊檔案');
  await b2.page.waitForFunction(() => document.querySelector('#statusText').textContent.includes('已轉換'), null, { timeout: 120000 });
  t.ok(true, 'an imported character opens and converts');
  t.eq(b2.errors, [], 'no console / page errors (import session)');
  await b2.browser.close();

  // ---- Firefox / Safari style desktop: no picker → browser backend + note
  const b3 = await open(base, { library: true, init: 'try { delete window.showDirectoryPicker; } catch (e) {}' });
  const st3 = await b3.page.evaluate(() => window.__c3d.library.status());
  t.ok(st3.backend === 'browser' && st3.ready && !st3.canUseFolder, 'no folder API: browser backend, no question asked');
  await L.openPanel(b3.page);
  t.ok((await b3.page.textContent('#libBody')).includes('Chrome 或 Edge'), 'note: Chrome or Edge needed to store on the computer');
  t.eq(b3.errors, [], 'no console / page errors (no-picker session)');
  await b3.browser.close();

  t.eq(errors, [], 'no console / page errors (main session)');
  return t.done();
});
