// Review round 2: status chip is locked during the boot restore (MINOR-1), the offline leave guard is explicit and a
// refused / failed reconnect gives feedback (MINOR-2), "needs reconnecting" never shows when no folder was ever chosen (MINOR-3).
const { open, ready, suite, main } = require('./_helpers');
const L = require('./_lib');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CHIP = `
  if (sessionStorage.getItem('chiprace')) {
    const iv = setInterval(() => {
      const chip = document.getElementById('libStatus'), save = document.getElementById('btnSave');
      if (!chip || chip.hidden || !save || !save.disabled) return;
      clearInterval(iv);
      window.__chipAtClick = chip.textContent; chip.click();
      setTimeout(() => { window.__dlgAfterClick = !!document.querySelector('.ask-dlg, #libraryDlg[open]'); }, 600);
    }, 2);
  }`;
const fp = (page, id) => page.evaluate((i) => window.__c3d.library.get(i).then((g) => JSON.stringify({ ...g.project, library: undefined, savedAt: 0 })), id);
const setDraft = (page, d) => page.evaluate((d) => new Promise((res, rej) => { const q = indexedDB.open('char3d', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => { const tx = q.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(d, 'autosave'); tx.oncomplete = () => { q.result.close(); res(); }; tx.onerror = () => rej(tx.error); }; }), d);
const unlocked = (page) => page.waitForFunction(() => window.__c3d && window.__c3d.lib && ['btnNew', 'btnSample', 'btnLibrary', 'btnSave'].every((i) => !document.getElementById(i).disabled), null, { timeout: 120000 });

main('library-minor', async (base) => {
  const t = suite('library-minor');

  // ---- MINOR-1
  {
    const { browser, page, errors } = await open(base, { library: true, init: CHIP });
    await page.evaluate(() => window.__c3d.library.useBrowser());
    await page.click('#btnSample'); await ready(page);
    await L.saveAs(page, '寶貝角色');
    const id = await L.linkedId(page);
    await page.waitForTimeout(3000);
    const before = await fp(page, id);
    await page.evaluate(() => sessionStorage.setItem('chiprace', '1'));
    await page.reload();
    await page.waitForFunction(() => window.__chipAtClick !== undefined, null, { timeout: 60000 });
    await unlocked(page); await page.waitForTimeout(2500);
    t.ok(await page.evaluate(() => window.__dlgAfterClick === false), 'chip clicked during the restore: no name prompt and no panel opened');
    t.ok(await fp(page, id) === before, 'chip clicked during the restore: the saved entry is unchanged');
    t.eq(await page.evaluate(() => window.__c3d.lib.linked && window.__c3d.lib.linked.name), '寶貝角色', 'the restore still links the right entry');
    await page.evaluate(() => sessionStorage.removeItem('chiprace'));
    t.eq(errors, [], 'no console / page errors');
    await browser.close();
  }

  // ---- MINOR-3: no folder was ever chosen (desktop), the draft says it belonged to a library entry
  {
    const { browser, page, errors } = await open(base, { library: true, query: '?fresh' });
    await unlocked(page);
    const draft = { format: 'char3d-project', version: 3, mode: 'character', settings: {}, slots: { head: { views: { front: { src: PNG } } } }, libraryId: 'does-not-exist', libraryName: 'x' };
    for (const variant of ['gone id', 'library database unusable']) {
      await setDraft(page, draft);
      if (variant !== 'gone id') await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('char3d-library', 5); q.onsuccess = () => { q.result.close(); res(); }; q.onerror = () => res(); }));
      await page.goto(base);
      await unlocked(page); await page.waitForTimeout(800);
      const r = await page.evaluate(() => ({ linked: window.__c3d.lib.linked, chip: document.querySelector('#libStatus').hidden ? '' : document.querySelector('#libStatus').textContent, toast: document.querySelector('#toast').textContent, state: window.__c3d.library.status().state }));
      t.ok(r.state === 'unconfigured' && !r.linked && !r.chip.includes('重新連接'), `${variant}: no storage chosen → unlinked, chip does not ask to reconnect a folder (chip "${r.chip}")`, r);
      t.ok(r.toast.includes('還沒選儲存位置'), `${variant}: the restore toast says why it is not linked`, r.toast);
    }
    t.eq(errors.filter((e) => !/char3d-library|VersionError|version/i.test(e)), [], 'no unexpected console / page errors');
    await browser.close();
  }

  // ---- MINOR-2 (folder)
  {
    const DIR = 'char3d-test-minor';
    const { browser, page, errors } = await open(base, { library: true, init: require('./_opfs')(DIR) });
    await page.click('#btnSample'); await ready(page);
    await L.saveAs(page, '勇者', 'folder');
    await L.editHead(page, 0.4);
    await L.until(page, async (d) => { try { const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d); for await (const f of h.values()) { if (f.name.endsWith('.crswap')) return false; if (f.name.endsWith('.c3d.json') && JSON.parse(await (await f.getFile()).text()).slots.head.params.offset[1] === 0.4) return true; } } catch (_) { /* mid-write */ } return false; }, DIR, 30000);
    await page.evaluate(() => sessionStorage.setItem('perm', 'prompt'));
    await page.reload(); await unlocked(page); await ready(page);
    await L.editHead(page, 0.66); // edit while disconnected
    await page.waitForTimeout(3500);
    t.eq(await page.evaluate(() => window.__w.length), 0, 'disconnected edit: nothing written');
    await page.click('#btnNew'); await page.waitForSelector('.ask-dlg[open]');
    const dlgText = await page.textContent('.ask-dlg[open]');
    t.ok(dlgText.includes('沒有存進去') && dlgText.includes('遺失') && dlgText.includes('直接離開（遺失這些修改）'), 'leave guard says plainly that the changes made since the disconnect will be lost', dlgText.replace(/\s+/g, ' '));
    // reconnect refused by the browser
    await page.evaluate(() => sessionStorage.setItem('refuse', '1'));
    await page.click('.ask-dlg[open] [data-v="reconnect"]');
    await page.waitForFunction(() => document.querySelector('#toast').classList.contains('show') && document.querySelector('#toast').textContent.includes('還是沒有連接'), null, { timeout: 15000 });
    t.ok(true, 'reconnect refused: a toast says the folder is still not connected');
    t.ok(await page.evaluate(() => !!window.__c3d.lib.linked) && (await page.textContent('#libStatus')).includes('需要重新連接資料夾'), 'reconnect refused: still linked, chip still says to reconnect, nothing was lost');
    t.eq(await page.evaluate(() => window.__c3d.state.slots.head.params.offset[1]), 0.66, 'reconnect refused: the edit is still on screen');
    // the folder is gone
    await page.evaluate(async (d) => { sessionStorage.removeItem('refuse'); sessionStorage.removeItem('perm'); await (await navigator.storage.getDirectory()).removeEntry(d, { recursive: true }); }, DIR);
    await page.click('#btnNew'); await page.waitForSelector('.ask-dlg[open]');
    await page.click('.ask-dlg[open] [data-v="reconnect"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.ask-dlg[open] h2')].some((h) => h.textContent.includes('找不到儲存資料夾')), null, { timeout: 15000 });
    t.ok(true, 'folder moved / deleted: the existing "找不到儲存資料夾 → pick again" question is shown');
    t.eq(errors, [], 'no console / page errors');
    await browser.close();
  }
  return t.done();
});
