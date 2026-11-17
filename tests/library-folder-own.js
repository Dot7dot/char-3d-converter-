// Round 3: the app may delete only a file it provably wrote itself (index entry `own`). Covers the lost-index flip
// (rename, user drops the old export back, index deleted, edit), the derived-id card (edit it repeatedly), and a
// taken ASCII fallback name. Directory listing order is varied (default / name order / reverse name order).
const { open, ready, suite, main } = require('./_helpers');
const L = require('./_lib');

const wrapper = (DIR, dir) => `(() => {
  const DIR = ${JSON.stringify(DIR)};
  const real = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
  const wrap = () => ({ __sorted: true, kind: 'directory', name: DIR, queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    values: async function* () { const a = []; for await (const h of (await real()).values()) a.push(h); a.sort((x, y) => (x.name < y.name ? ${dir} : ${-dir})); yield* a; },
    getFileHandle: async (n, o) => (await real()).getFileHandle(n, o), removeEntry: async (n, o) => (await real()).removeEntry(n, o) });
  window.showDirectoryPicker = async () => wrap();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (v, k) { return put.call(this, v && v.__sorted ? { __sortedToken: 1 } : v, k); };
  const d = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
  Object.defineProperty(IDBRequest.prototype, 'result', { configurable: true, get() { const v = d.get.call(this); return v && v.__sortedToken ? wrap() : v; } });
})();`;
const read = async (page, DIR) => { // [name, embedded id, y] — retried while the app is replacing a file
  for (let i = 0; i < 12; i++) {
    try {
      return await page.evaluate(async (d) => {
        const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
        const out = [];
        for await (const f of h.values()) { if (f.name.endsWith('.crswap')) throw new Error('writing'); if (f.name.endsWith('.c3d.json')) { const j = JSON.parse(await (await f.getFile()).text()); out.push([f.name, j.library.id, j.slots.head.params.offset[1]]); } }
        return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      }, DIR);
    } catch (_) { await page.waitForTimeout(400); }
  }
  throw new Error('folder never settled');
};
const quiet = async (page) => { for (let n = -1, i = 0; i < 20; i++) { const c = await page.evaluate(() => window.__w.length); if (c === n) return; n = c; await page.waitForTimeout(2500); } };
const edit = async (page, v) => { await L.editHead(page, v); };
const waitY = (page, DIR, v) => L.until(page, async ([d, y]) => { try { const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d); for await (const f of h.values()) { if (f.name.endsWith('.crswap')) return false; } for await (const f of h.values()) if (f.name.endsWith('.c3d.json') && JSON.parse(await (await f.getFile()).text()).slots.head.params.offset[1] === y) return true; } catch (_) { /* mid-write */ } return false; }, [DIR, v], 40000);
const cardsN = (page) => page.evaluate(() => window.__c3d.library.list().then((l) => l.length));
const dropCopy = (page, DIR, from, to, y, name) => page.evaluate(async ([d, o, n, yy, nm]) => {
  const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
  const j = JSON.parse(await (await (await h.getFileHandle(o)).getFile()).text());
  j.slots.head.params.offset[1] = yy; if (nm) j.library.name = nm;
  const w = await (await h.getFileHandle(n, { create: true })).createWritable(); await w.write(JSON.stringify(j)); await w.close();
}, [DIR, from, to, y, name]);

main('library-folder-own', async (base) => {
  const t = suite('library-folder-own');

  // ---- p11: rename, old export dropped back, index lost, edit — in three listing orders
  for (const [order, dir] of [['name order', 1], ['reverse order', -1], ['default order', 0]]) {
    const DIR = 'char3d-test-own-' + (dir + 1);
    const init = require('./_opfs')(DIR) + (dir ? wrapper(DIR, dir) : '');
    const { browser, page, errors } = await open(base, { library: true, init });
    await page.click('#btnSample'); await ready(page);
    await L.saveAs(page, '勇者', 'folder');
    const id = await L.linkedId(page); const id8 = id.replace(/[^a-z0-9]/gi, '').slice(0, 8);
    await waitY(page, DIR, 0); await quiet(page);
    const exported = `勇者__${id8}.c3d.json`;
    await L.openPanel(page);
    await page.locator(`#libBody .lib-card[data-id="${id}"] [data-do="rename"]`).click(); await L.answer(page, 'ok', '英雄');
    await L.until(page, () => [...document.querySelectorAll('#libBody h3')].some((h) => h.textContent === '英雄'), null, 20000);
    await L.closePanel(page); await quiet(page);
    t.eq((await read(page, DIR)).map((f) => f[0]), [`英雄__${id8}.c3d.json`], `${order}: after the rename there is one file`);
    // the user drops the old export (same id, older content) back, and the index is lost
    await dropCopy(page, DIR, `英雄__${id8}.c3d.json`, exported, 0.9, '勇者');
    await page.evaluate(async (d) => { await (await (await navigator.storage.getDirectory()).getDirectoryHandle(d)).removeEntry('char3d-library.json'); }, DIR);
    for (let i = 0; i < 2; i++) { await L.openPanel(page); await page.waitForTimeout(1200); await L.closePanel(page); }
    await edit(page, 0.2);
    await waitY(page, DIR, 0.2);
    await quiet(page);
    const f = await read(page, DIR);
    t.ok(f.some((x) => x[0] === exported && x[2] === 0.9), `${order}: the hand-placed export still exists, untouched`, f);
    t.ok(f.some((x) => x[0] === `英雄__${id8}.c3d.json`), `${order}: the app's earlier file still exists (a rebuilt index proves nothing, so nothing is deleted)`, f);
    t.ok(f.some((x) => x[2] === 0.2), `${order}: the edit was written`, f);
    const got = await page.evaluate((i) => window.__c3d.library.get(i).then((g) => g.project.slots.head.params.offset[1]), id);
    t.eq(got, 0.2, `${order}: the linked card now holds the linked content`);
    // more saves: no growth, still nothing lost
    const n1 = await cardsN(page);
    for (const v of [0.3, 0.4]) { await edit(page, v); await waitY(page, DIR, v); await quiet(page); }
    const f2 = await read(page, DIR);
    t.eq(await cardsN(page), n1, `${order}: repeated saves do not add cards`);
    t.ok(f2.some((x) => x[0] === exported && x[2] === 0.9) && f2.length === f.length, `${order}: and no file was added or lost`, f2.map((x) => x[0]));
    t.eq(errors, [], `${order}: no console / page errors`);
    await page.evaluate(async (d) => { await (await navigator.storage.getDirectory()).removeEntry(d, { recursive: true }); }, DIR).catch(() => {});
    await browser.close();
  }

  // ---- p12: edit a derived-id card (the user's same-id copy) repeatedly
  for (const [order, dir] of [['name order', 1], ['default order', 0]]) {
    const DIR = 'char3d-test-own12-' + dir;
    const init = require('./_opfs')(DIR) + (dir ? wrapper(DIR, dir) : '');
    const { browser, page, errors } = await open(base, { library: true, init });
    await page.click('#btnSample'); await ready(page);
    await L.saveAs(page, '勇者', 'folder');
    const id = await L.linkedId(page); const id8 = id.replace(/[^a-z0-9]/gi, '').slice(0, 8);
    await waitY(page, DIR, 0); await quiet(page);
    for (const n of ['0-old-version.c3d.json', 'zz-old-version.c3d.json']) await dropCopy(page, DIR, `勇者__${id8}.c3d.json`, n, 0.9);
    await L.openPanel(page);
    await L.until(page, () => window.__c3d.library.list().then((l) => l.length === 3), null, 15000);
    const d0 = await page.evaluate(() => window.__c3d.library.list().then((l) => l.find((m) => m.file === '0-old-version.c3d.json').id));
    await page.locator(`#libBody .lib-card[data-id="${d0}"] [data-do="open"]`).click();
    await L.until(page, (i) => window.__c3d.lib.linked && window.__c3d.lib.linked.id === i, d0, 60000);
    const counts = [];
    for (const v of [0.55, 0.56, 0.57]) { await edit(page, v); await waitY(page, DIR, v); await quiet(page); counts.push(await cardsN(page)); }
    const f = await read(page, DIR);
    t.ok(['0-old-version.c3d.json', 'zz-old-version.c3d.json', `勇者__${id8}.c3d.json`].every((n) => f.some((x) => x[0] === n)), `${order}: the user's originals and the first character all still exist after editing a derived card`, f.map((x) => x[0]));
    t.ok(f.filter((x) => x[0].endsWith('old-version.c3d.json')).every((x) => x[2] === 0.9), `${order}: the originals are untouched (head 0.9)`);
    t.ok(counts[0] === counts[1] && counts[1] === counts[2], `${order}: the number of cards is stable across 3 saves (${counts.join(',')})`);
    t.eq(f.filter((x) => x[2] >= 0.55 && x[2] < 0.6).length, 1, `${order}: the edits keep replacing one app file (no growth in files)`);
    t.eq(errors, [], `${order}: no console / page errors`);
    await page.evaluate(async (d) => { await (await navigator.storage.getDirectory()).removeEntry(d, { recursive: true }); }, DIR).catch(() => {});
    await browser.close();
  }

  // ---- ASCII fallback whose name is taken by another entry (plain POSIX locale: Chinese file names are refused)
  {
    const DIR = 'char3d-test-own-ascii';
    const { browser, page, errors } = await open(base, { library: true, init: require('./_opfs')(DIR), posix: true });
    await page.click('#btnSample'); await ready(page);
    await L.saveAs(page, '勇者', 'folder');
    const id = await L.linkedId(page); const id8 = id.replace(/[^a-z0-9]/gi, '').slice(0, 8);
    await waitY(page, DIR, 0); await quiet(page);
    // another character's file sits exactly where the fallback name of this one would go
    await page.evaluate(async ([d, n]) => {
      const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d);
      const j = JSON.parse(await (await (await h.getFileHandle(n)).getFile()).text());
      j.library.id = 'someone-else'; j.library.name = '別人'; j.slots.head.params.offset[1] = 0.8;
      const w = await (await h.getFileHandle(n)).createWritable(); await w.write(JSON.stringify(j)); await w.close();
      await h.removeEntry('char3d-library.json');
    }, [DIR, `character__${id8}.c3d.json`]);
    await page.evaluate(() => window.__c3d.library.list()); // a scan (e.g. the panel opened) sees the new situation
    // the linked entry has no file any more: its next save must pick a free name instead of overwriting the other one
    await edit(page, 0.3);
    await waitY(page, DIR, 0.3); await quiet(page);
    const f = await read(page, DIR);
    t.ok(f.some((x) => x[0] === `character__${id8}.c3d.json` && x[1] === 'someone-else' && x[2] === 0.8), 'ASCII fallback: the other entry\'s file is not overwritten', f);
    t.ok(f.some((x) => x[0] === `character__${id8}-2.c3d.json` && x[1] === id && x[2] === 0.3), 'ASCII fallback: the save went to a -2 name', f);
    t.eq(errors, [], 'ASCII fallback: no console / page errors');
    await page.evaluate(async (d) => { await (await navigator.storage.getDirectory()).removeEntry(d, { recursive: true }); }, DIR).catch(() => {});
    await browser.close();
  }
  return t.done();
});
