// MAJOR-1: a hand-placed file with the SAME library id as the character being edited must never be deleted or
// overwritten, whatever order the folder lists its files in (default OPFS order, and name order like NTFS).
const { open, ready, suite, main } = require('./_helpers');
const L = require('./_lib');
const DIR = 'char3d-test-dup';

const SORTED = `(() => {
  const DIR = ${JSON.stringify(DIR)};
  const real = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
  const wrap = () => ({ __sorted: true, kind: 'directory', name: DIR, queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    values: async function* () { const a = []; for await (const h of (await real()).values()) a.push(h); a.sort((x, y) => (x.name < y.name ? -1 : 1)); yield* a; },
    getFileHandle: async (n, o) => (await real()).getFileHandle(n, o), removeEntry: async (n, o) => (await real()).removeEntry(n, o) });
  window.showDirectoryPicker = async () => wrap();
  const put = IDBObjectStore.prototype.put; // the wrapper cannot be cloned into IndexedDB: store a token, hand the wrapper back
  IDBObjectStore.prototype.put = function (v, k) { return put.call(this, v && v.__sorted ? { __sortedToken: 1 } : v, k); };
  const d = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
  Object.defineProperty(IDBRequest.prototype, 'result', { configurable: true, get() { const v = d.get.call(this); return v && v.__sortedToken ? wrap() : v; } });
})();`;
const files = (page) => L.until && page.evaluate(async (d) => {
  const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
  const out = [];
  for await (const f of h.values()) if (f.name.endsWith('.c3d.json')) { try { const j = JSON.parse(await (await f.getFile()).text()); out.push({ name: f.name, id: j.library && j.library.id, y: j.slots.head.params.offset[1] }); } catch (_) { out.push({ name: f.name, id: null, y: null }); } }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}, DIR);
const stable = async (page) => { for (let i = 0; i < 20; i++) { try { const f = await files(page); if (f.every((x) => x.id)) return f; } catch (_) { /* mid-write */ } await page.waitForTimeout(300); } throw new Error('folder never settled'); };

main('library-folder-dup', async (base) => {
  const t = suite('library-folder-dup');
  for (const order of ['default order', 'name order']) {
    const { browser, page, errors } = await open(base, { library: true, init: require('./_opfs')(DIR) + (order === 'name order' ? SORTED : '') });
    await page.click('#btnSample'); await ready(page);
    await L.saveAs(page, '勇者', 'folder');
    await L.waitStatus(page, '已儲存');
    const id = await L.linkedId(page);
    await page.waitForTimeout(1200);
    const orig = (await stable(page))[0];
    // the user drops older exports of the same character into the folder (same library block, different content)
    for (const n of ['0-old-version.c3d.json', 'zz-old-version.c3d.json']) {
      await page.evaluate(async ([d, o, nn]) => {
        const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
        const j = JSON.parse(await (await (await h.getFileHandle(o)).getFile()).text());
        j.slots.head.params.offset[1] = 0.9;
        const w = await (await h.getFileHandle(nn, { create: true })).createWritable(); await w.write(JSON.stringify(j)); await w.close();
      }, [DIR, orig.name, n]);
    }
    const names = ['0-old-version.c3d.json', 'zz-old-version.c3d.json', orig.name].sort();
    await L.openPanel(page);
    await L.until(page, () => window.__c3d.library.list().then((l) => l.length === 3), null, 15000);
    let cards = await page.evaluate(() => window.__c3d.library.list().then((l) => l.map((m) => [m.id, m.file])));
    t.eq(cards.length, 3, `${order}: the gallery shows all three characters`);
    t.eq(cards.find(([i]) => i === id)[1], orig.name, `${order}: the linked id belongs to the file the app wrote, not to a copy`);
    await L.closePanel(page);
    // edit the linked character → auto-save
    await L.editHead(page, 0.2);
    await L.until(page, async ([d, n]) => { try { const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d); for await (const f of h.values()) if (f.name.endsWith('.crswap')) return false; return JSON.parse(await (await (await h.getFileHandle(n)).getFile()).text()).slots.head.params.offset[1] === 0.2; } catch (_) { return false; } }, [DIR, orig.name], 30000);
    let f = await stable(page);
    t.eq(f.map((x) => x.name), names, `${order}: after the auto-save every file still exists`);
    t.eq(f.map((x) => [x.name, x.y]).filter(([n]) => n.includes('old-version')), [['0-old-version.c3d.json', 0.9], ['zz-old-version.c3d.json', 0.9]], `${order}: the hand-placed files are untouched`);
    t.eq(f.find((x) => x.name === orig.name).y, 0.2, `${order}: the linked file got the edit`);
    // rename the linked character: its own file is renamed, the copies stay
    await L.openPanel(page);
    await page.locator(`#libBody .lib-card[data-id="${id}"] [data-do="rename"]`).click(); await L.answer(page, 'ok', '英雄');
    await L.until(page, () => [...document.querySelectorAll('#libBody h3')].some((h) => h.textContent === '英雄'), null, 15000);
    f = await stable(page);
    t.ok(f.length === 3 && f.filter((x) => x.name.includes('old-version')).length === 2 && f.some((x) => x.name.startsWith('英雄__')) && !f.some((x) => x.name === orig.name), `${order}: rename moved only its own file`, f.map((x) => x.name));
    // gallery + opening: the linked card opens the right content, a copy opens its own content
    await L.until(page, () => document.querySelectorAll('#libBody .lib-card').length === 3, null, 15000);
    t.eq((await L.cards(page)).length, 3, `${order}: the gallery still shows three cards`);
    const other = (await L.cards(page)).find((c) => c.id !== id);
    await page.locator(`#libBody .lib-card[data-id="${other.id}"] [data-do="open"]`).click();
    await L.until(page, () => window.__c3d.lib.linked && window.__c3d.state.slots.head.params.offset[1] === 0.9, null, 60000);
    t.ok(true, `${order}: a copy opens with its own content (head 0.9)`);
    await L.openPanel(page);
    await page.locator(`#libBody .lib-card[data-id="${id}"] [data-do="open"]`).click();
    await L.until(page, () => window.__c3d.lib.linked && window.__c3d.lib.linked.name === '英雄' && window.__c3d.state.slots.head.params.offset[1] === 0.2, null, 60000);
    t.ok(true, `${order}: the linked card opens the right content (head 0.2)`);
    await page.waitForTimeout(3500);
    t.eq((await stable(page)).length, 3, `${order}: still three files after opening and settling`);
    t.eq(errors, [], `${order}: no console / page errors`);
    await page.evaluate(async (d) => { await (await navigator.storage.getDirectory()).removeEntry(d, { recursive: true }); }, DIR).catch(() => {});
    await browser.close();
  }
  return t.done();
});
