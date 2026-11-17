// Storage warnings (browser backend): >=80 % warns, >=95 % or QuotaExceededError blocks without losing work.
const fs = require('fs'), os = require('os'), path = require('path');
const { open, ready, suite, main } = require('./_helpers');
const L = require('./_lib');

const INIT = `
  window.__est = null;      // { usage, quota } the stubbed navigator.storage.estimate returns (null = healthy 0.1 %)
  navigator.storage.estimate = async () => window.__est || { usage: 1e6, quota: 1e9 };
  window.__failPut = null;  // 'data' | 'meta': make that library store throw QuotaExceededError on put()
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (v, k) {
    if (window.__failPut && this.name === (window.__failPut === 'data' ? 'lib-data' : 'lib-meta')) throw new DOMException('simulated', 'QuotaExceededError');
    return put.call(this, v, k);
  };
`;
const pct = (p) => `window.__est = { usage: ${p} * 1e9, quota: 1e9 }`;
const counts = (page) => page.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('char3d-library'); r.onsuccess = () => res(r.result); });
  const n = (s) => new Promise((res) => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => res(r.result); });
  const out = [await n('lib-meta'), await n('lib-data')]; db.close(); return out;
});

main('library-quota', async (base) => {
  const t = suite('library-quota');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3d-'));
  const { browser, page, errors } = await open(base, { library: true, init: INIT });
  await page.evaluate(() => window.__c3d.library.useBrowser());
  await page.click('#btnSample'); await ready(page);

  // ---- 82 %: warning, save still succeeds
  await page.evaluate(pct(0.82));
  await L.saveAs(page, '甲');
  t.eq((await L.list(page)).map((m) => m.name), ['甲'], 'at 82 % the save succeeds');
  await page.waitForFunction(() => !document.querySelector('#libBanner').hidden, null, { timeout: 15000 });
  const bn = await page.textContent('#libBanner');
  t.ok(bn.includes('82%') && bn.includes('備份'), 'non-blocking banner while saving asks for a backup', bn);
  t.ok(await page.evaluate(() => !document.querySelector('dialog[open]')), 'banner does not block (no dialog open)');
  await L.openPanel(page);
  const warn = await page.textContent('#libBody .lib-usage.warn .lib-warn');
  t.ok(warn.includes('快滿了') && warn.includes('備份全部'), 'panel shows the warning with a 備份全部 button');
  t.ok(/已使用 .* \/ 可用約 .*82%/.test(await page.textContent('#libBody .lib-usage-text')), 'usage text shows used / available', await page.textContent('#libBody .lib-usage-text'));
  t.eq(await page.$eval('#libBody .lib-bar i', (e) => e.style.width), '82%', 'usage bar is 82 % wide');
  const [dlw] = await Promise.all([page.waitForEvent('download'), page.click('#libBody .lib-warn [data-do="backup"]')]);
  const zp = path.join(tmp, 'b.zip'); await dlw.saveAs(zp);
  t.eq((await L.unzipNames(page, zp)).map((n) => n.lib.name), ['甲'], 'the one-tap 備份全部 in the warning downloads the backup');
  await L.closePanel(page);
  await page.click('#libBanner [data-act="close"]');
  await L.editHead(page, 0.3);
  await page.keyboard.press('Control+s'); await L.waitStatus(page, '已儲存'); await page.waitForTimeout(300);
  t.ok(await page.evaluate(() => document.querySelector('#libBanner').hidden), 'the banner appears once per session (not again after being closed)');

  // ---- 96 %: blocking dialog, nothing saved, work kept
  const before = (await L.list(page))[0];
  await page.evaluate(pct(0.96));
  await L.editHead(page, 0.6);
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.ask-dlg[open]');
  const dtext = await page.textContent('.ask-dlg[open]');
  t.ok(dtext.includes('儲存空間已滿') && dtext.includes('沒有存進去') && dtext.includes('備份全部'), 'at 96 % a blocking dialog says the save did not happen and asks for backup + deleting', dtext.replace(/\s+/g, ' '));
  await L.answer(page, 'close');
  const after = (await L.list(page))[0];
  t.ok(after.updatedAt === before.updatedAt && after.size === before.size, 'the stored entry is unchanged');
  t.eq(await counts(page), [1, 1], 'no half-written entry (metadata and payload counts match)');
  t.eq(await L.headY(page), 0.6, 'the unsaved work is still on screen');
  t.ok((await page.textContent('#libStatus')).includes('儲存失敗'), 'status shows 儲存失敗');
  await L.openPanel(page);
  t.ok((await page.textContent('#libBody .lib-usage.block .lib-warn')).includes('已滿'), 'panel shows the "full" state');
  await L.closePanel(page);

  // new, never-saved character at 96 %
  await page.click('#btnNew'); await L.answer(page, 'leave'); // the unsaved last change of 甲 is given up on purpose
  await page.waitForFunction(() => !window.__c3d.lib.linked && !document.querySelector('.ask-dlg[open]'));
  await page.click('#btnSample'); await ready(page);
  await page.click('#btnSave'); await page.waitForSelector('.ask-dlg[open] input');
  await page.fill('.ask-dlg[open] input', '乙'); await page.click('.ask-dlg[open] [data-v="ok"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.ask-dlg[open] h2')].some((h) => h.textContent.includes('儲存空間已滿')));
  await L.answer(page, 'close');
  t.eq((await L.list(page)).map((m) => m.name), ['甲'], 'a new character is not stored at 96 %');
  t.eq(await counts(page), [1, 1], 'still no half-written entry');
  t.ok(await page.evaluate(() => !!window.__c3d.state.slots.head.views.front && !window.__c3d.lib.linked), 'the new character is still on screen (unlinked, not lost)');

  // deleting works at 96 % and frees the way to save again
  await L.openPanel(page);
  await L.cardAct(page, '甲', 'del'); await L.answer(page, 'del');
  await page.waitForFunction(() => document.querySelector('#libBody .lib-empty'));
  await L.closePanel(page);
  await page.evaluate(() => { window.__est = null; });
  await L.saveAs(page, '乙');
  t.eq((await L.list(page)).map((m) => m.name), ['乙'], 'after deleting / freeing space the save goes through');

  // ---- QuotaExceededError raised by the write itself
  for (const which of ['data', 'meta']) {
    const b4 = await L.list(page);
    await L.editHead(page, which === 'data' ? 0.11 : 0.12);
    await page.evaluate((w) => { window.__failPut = w; }, which);
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.ask-dlg[open]');
    t.ok((await page.textContent('.ask-dlg[open]')).includes('沒有存進去'), `QuotaExceededError on the ${which} write: blocking dialog`);
    await L.answer(page, 'close');
    const a4 = await L.list(page);
    t.ok(JSON.stringify(a4) === JSON.stringify(b4), `QuotaExceededError on the ${which} write: stored entry untouched`);
    t.eq(await counts(page), [1, 1], `QuotaExceededError on the ${which} write: transaction rolled back, no orphan`);
    await page.evaluate(() => { window.__failPut = null; });
  }
  await page.keyboard.press('Control+s'); await L.waitStatus(page, '已儲存');
  t.eq((await page.evaluate(() => window.__c3d.library.get(window.__c3d.lib.linked.id).then((g) => g.project.slots.head.params.offset[1]))), 0.12, 'after the error is gone the pending work saves');

  // ---- estimate() unavailable → fallback to the sum of stored sizes against an assumed limit
  const fb = await page.evaluate(async () => { navigator.storage.estimate = undefined; const u = await window.__c3d.library.usage(); return { estimated: u.estimated, quota: u.quota, used: u.used, size: (await window.__c3d.library.list())[0].size, level: u.level }; });
  t.ok(fb.estimated === false && fb.quota === 200 * 1024 * 1024 && fb.used === fb.size && fb.level === 'ok', 'without estimate(): used = sum of stored sizes, assumed limit 200 MB', fb);

  t.eq(errors, [], 'no console / page errors');
  await browser.close();
  return t.done();
});
