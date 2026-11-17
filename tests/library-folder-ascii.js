// Folder backend on a file system that rejects non-ASCII names (the plain POSIX locale does, see _helpers.js):
// the character must still be saved, under an ASCII file name that keeps the id part.
const { open, ready, suite, main } = require('./_helpers');
const L = require('./_lib');
const DIR = 'char3d-test-ascii';
const INIT = require('./_opfs')(DIR);
const names = (page) => page.evaluate(async (d) => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(d); const o = []; for await (const h of dir.values()) o.push(h.name); return o.sort(); }, DIR);

main('library-folder-ascii', async (base) => {
  const t = suite('library-folder-ascii');
  const { browser, page, errors } = await open(base, { library: true, init: INIT, posix: true });
  // sanity: this browser really refuses a Chinese file name
  const refused = await page.evaluate(async (d) => { try { await (await (await navigator.storage.getDirectory()).getDirectoryHandle(d, { create: true })).getFileHandle('甲.json', { create: true }); return false; } catch (e) { return e.name; } }, DIR);
  t.ok(refused === 'TypeMismatchError', `precondition: Chinese file names are refused here (${refused})`);
  await page.click('#btnSample'); await ready(page);
  await L.saveAs(page, '勇者', 'folder');
  const id8 = (await L.linkedId(page)).replace(/[^a-z0-9]/gi, '').slice(0, 8);
  t.eq(await names(page), ['char3d-library.json', `character__${id8}.c3d.json`], 'saved under an ASCII name that keeps the id');
  t.eq((await L.list(page)).map((m) => m.name), ['勇者'], 'the character name itself is still 勇者 (it lives inside the file)');
  await L.openPanel(page);
  await L.cardAct(page, '勇者', 'rename'); await L.answer(page, 'ok', 'Hero');
  await page.waitForFunction(() => [...document.querySelectorAll('#libBody h3')].some((h) => h.textContent === 'Hero'));
  t.eq(await names(page), ['Hero__' + id8 + '.c3d.json', 'char3d-library.json'].sort(), 'renaming to an ASCII name renames the file');
  await L.cardAct(page, 'Hero', 'rename'); await L.answer(page, 'ok', '英雄');
  await page.waitForFunction(() => [...document.querySelectorAll('#libBody h3')].some((h) => h.textContent === '英雄'));
  t.eq(await names(page), [`character__${id8}.c3d.json`, 'char3d-library.json'].sort(), 'renaming back to Chinese falls back again, old file removed');
  t.eq(errors, [], 'no console / page errors');
  await browser.close();
  return t.done();
});
