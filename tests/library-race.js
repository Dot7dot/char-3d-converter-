// Start-up restore race (reviewer finding F1), draft keeps the library link (F2), 範例 goes through the guard (F5),
// size clamp and object default name (F8), pending save goes to the OLD storage when switching (F7).
const { open, ready, suite, main } = require('./_helpers');
const L = require('./_lib');

// While the boot-time draft restore is still converting, perform `race` (new | sample | open) from inside the page the
// moment the restored images are in state. bypass=1 also re-enables the (disabled) buttons, to test the second line of defence.
const RACE = `
  if (sessionStorage.getItem('race')) {
    const kind = sessionStorage.getItem('race'), bypass = sessionStorage.getItem('bypass') === '1';
    const iv = setInterval(() => {
      const c = window.__c3d;
      if (!c || !c.lib || !Object.values(c.state.slots).some((s) => s.views.front)) return;
      clearInterval(iv);
      window.__raceLocked = ['btnNew', 'btnSample', 'btnLibrary', 'btnSave'].map((i) => document.getElementById(i).disabled);
      if (bypass) for (const i of ['btnNew', 'btnSample', 'btnLibrary', 'btnSave']) document.getElementById(i).disabled = false;
      const iv2 = setInterval(() => { const b = document.querySelector('.ask-dlg[open] [data-v="discard"]'); if (b) { b.click(); } }, 5);
      setTimeout(() => clearInterval(iv2), 20000);
      if (kind === 'new') document.getElementById('btnNew').click();
      else if (kind === 'sample') document.getElementById('btnSample').click();
      else if (kind === 'open') c.lib.openEntry(sessionStorage.getItem('raceId'));
    }, 2);
  }`;
const fp = (page, id) => page.evaluate(async (i) => { const g = await window.__c3d.library.get(i); return JSON.stringify({ ...g.project, library: undefined, savedAt: 0 }); }, id);

main('library-race', async (base) => {
  const t = suite('library-race');
  const { browser, page, errors } = await open(base, { library: true, init: RACE });
  await page.evaluate(() => window.__c3d.library.useBrowser());
  await page.click('#btnSample'); await ready(page);
  await L.saveAs(page, '寶貝角色');
  const A = await L.linkedId(page);
  await L.editHead(page, 0.21);
  await L.waitStatus(page, '已儲存');
  await page.click('#btnNew'); await page.waitForFunction(() => !window.__c3d.lib.linked);
  await page.click('#btnSample'); await ready(page);
  await L.saveAs(page, '另一個');
  const B = await L.linkedId(page);
  await page.waitForTimeout(1500);
  const goA = async () => { await page.evaluate(() => { sessionStorage.removeItem('race'); sessionStorage.removeItem('bypass'); }); await page.evaluate((i) => window.__c3d.lib.openEntry(i), A); await L.waitLinked(page, '寶貝角色'); await page.waitForTimeout(2200); };
  await goA();
  const before = await fp(page, A);
  const slotsBefore = JSON.parse(before).slots;
  t.ok(Object.keys(slotsBefore).length > 3 && slotsBefore.head.params.offset[1] === 0.21, 'precondition: entry A has the whole character');

  for (const bypass of ['0', '1']) {
    for (const kind of ['new', 'sample', 'open']) {
      await page.evaluate(([k, b, id]) => { sessionStorage.setItem('race', k); sessionStorage.setItem('bypass', b); sessionStorage.setItem('raceId', id); }, [kind, bypass, B]);
      await page.waitForTimeout(2500); // let the draft (with libraryId = A) reach the disk
      await page.reload();
      await page.waitForFunction(() => window.__raceLocked !== undefined, null, { timeout: 60000 });
      await page.waitForTimeout(14000);
      const r = await page.evaluate(() => ({ locked: window.__raceLocked, linked: window.__c3d.lib.linked && window.__c3d.lib.linked.name, fronts: Object.values(window.__c3d.state.slots).filter((s) => s.views.front).length, headY: window.__c3d.state.slots.head.params.offset[1] }));
      const after = await fp(page, A);
      const label = `restore race, ${kind}${bypass === '1' ? ' with the buttons forced on' : ''}`;
      t.ok(after === before, `${label}: the saved entry is byte-for-byte unchanged`, { slots: Object.keys(JSON.parse(after).slots).length });
      if (bypass === '0') t.ok(r.locked.every(Boolean) && r.linked === '寶貝角色' && r.fronts > 3, `${label}: buttons were disabled, restore finished and linked to the right entry`, r);
      else t.ok(r.linked !== '寶貝角色' || r.headY === 0.21, `${label}: either the project was replaced and is NOT linked to the restored entry, or the action was refused and the restored character is still on screen`, r);
      const stillB = await fp(page, B);
      t.ok(stillB.length > 1000, `${label}: other entry intact`);
      await goA();
      t.ok(await fp(page, A) === before, `${label}: and still unchanged after going back to it`);
    }
  }
  await page.evaluate(() => { sessionStorage.removeItem('race'); sessionStorage.removeItem('bypass'); });
  t.ok(await page.evaluate(() => ['btnNew', 'btnSample', 'btnLibrary', 'btnSave'].every((i) => !document.getElementById(i).disabled)), 'buttons are enabled once the restore is over');

  // ---- F5: 範例 asks / saves first
  await page.evaluate(() => window.__c3d.lib.flush());
  await page.click('#btnSample'); await ready(page);
  t.ok(await page.evaluate(() => !window.__c3d.lib.linked) && !(await page.$('.ask-dlg[open]')), '範例 on a linked character: saves it silently, the sample is a new unlinked character');
  await page.waitForTimeout(3000);
  t.eq(await fp(page, A), before, 'the sample did not touch the saved entry (auto-save stays off it)');
  await page.click('#btnSample');
  await page.waitForSelector('.ask-dlg[open]');
  t.eq(await page.$$eval('.ask-dlg[open] .btn', (b) => b.map((x) => x.textContent)), ['取消', '不儲存', '儲存'], '範例 on unsaved work asks 取消 / 不儲存 / 儲存');
  await L.answer(page, 'cancel');
  await page.waitForTimeout(500);
  t.ok(await page.evaluate(() => Object.values(window.__c3d.state.slots).some((s) => s.views.front)), '取消 keeps the current work');

  // ---- F8
  await L.openPanel(page); await L.closePanel(page);
  await page.click('.card[data-slot="head"] [data-tab="place"]');
  const sz = page.locator('.card[data-slot="head"] input[type="number"][data-path="size"]');
  await sz.fill('0'); await sz.blur();
  t.eq([await page.evaluate(() => window.__c3d.state.slots.head.params.size), await sz.inputValue()], [0.05, '0.05'], '大小 is clamped to at least 0.05');
  await page.click('[data-mode="object"]');
  await page.click('#btnNew'); await L.answer(page, 'discard');
  await page.waitForFunction(() => window.__c3d.state.settings.name === 'MyProp');
  t.eq(await page.inputValue('#setName'), 'MyProp', '新角色 in 物件 mode uses the object default name');
  await page.click('[data-mode="character"]');
  t.eq(errors, [], 'no console / page errors');
  await browser.close();

  // ---- F2: the draft knows the link right after the first save (default name, and a changed name), no edit needed
  for (const nm of ['MyHero', '改過的名字']) {
    const b = await open(base, { library: true });
    await b.page.evaluate(() => window.__c3d.library.useBrowser());
    await b.page.click('#btnSample'); await ready(b.page);
    await L.saveAs(b.page, nm);
    const id = await L.linkedId(b.page);
    await L.until(b.page, (i) => new Promise((res) => { const r = indexedDB.open('char3d'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('autosave'); q.onsuccess = () => { r.result.close(); res(!!q.result && q.result.libraryId === i); }; }; }), id, 3000);
    t.ok(true, `first save as "${nm}": the draft carries the library id immediately`);
    await b.page.reload();
    await b.page.waitForFunction(() => window.__c3d && window.__c3d.lib);
    await L.waitLinked(b.page, nm);
    await L.waitStatus(b.page, '已儲存');
    t.eq(await L.linkedId(b.page), id, `reload with no further edit: linked to the same entry ("${nm}"), chip 已儲存`);
    t.eq(b.errors, [], 'no console / page errors');
    await b.browser.close();
  }

  // ---- F7: switching storage — the pending edit lands in the OLD place, the copy in the new place is compared, no extra write
  const OP = require('./_opfs')('char3d-test-race');
  const c = await open(base, { library: true, init: OP + `
    window.__w = []; const cw = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (...a) { window.__w.push(this.name); return cw.apply(this, a); };` });
  await c.page.evaluate(() => window.__c3d.library.useBrowser());
  await c.page.click('#btnSample'); await ready(c.page);
  await L.saveAs(c.page, '搬家');
  const cid = await L.linkedId(c.page);
  const oldUpd = (await L.list(c.page))[0].updatedAt;
  await c.page.evaluate(() => { window.__c3dAutosaveMs = 600000; });
  await L.editHead(c.page, 0.45);
  await L.openPanel(c.page);
  await c.page.click('#libBody [data-do="use-folder"]');
  await c.page.waitForSelector('.ask-dlg[open]');
  await L.answer(c.page, 'yes');
  await L.until(c.page, async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('char3d-test-race'); for await (const h of d.values()) if (h.name.endsWith('.crswap')) return false; return true; }, null, 15000);
  await c.page.waitForTimeout(2500);
  const inFolder = await c.page.evaluate(async (i) => (await window.__c3d.library.get(i)).project.slots.head.params.offset[1], cid);
  t.eq(inFolder, 0.45, 'the edit made just before switching reached the new folder (flushed to the old place first, then copied)');
  await c.page.evaluate(() => window.__c3d.library.useBrowser());
  const oldMeta = (await L.list(c.page)).find((m) => m.id === cid);
  t.ok(oldMeta.updatedAt !== oldUpd, 'and the old (browser) copy was saved too');
  await c.page.evaluate(() => window.__c3d.library.useFolder());
  const writes = await c.page.evaluate(() => window.__w.length);
  await c.page.waitForTimeout(3000);
  t.eq(await c.page.evaluate(() => window.__w.length), writes, 'no further writes happen by themselves after the switch');
  t.eq(c.errors, [], 'no console / page errors');
  await c.browser.close();
  return t.done();
});
