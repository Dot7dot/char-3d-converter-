// Helpers shared by the library tests (drive the real UI, read storage directly to verify it).
const fs = require('fs');

/** Click 儲存; answers the "where to store" question with `where` ('browser' | 'folder') and the name prompt. */
async function saveAs(page, name, where = 'browser') {
  await page.click('#btnSave');
  const dlg = page.locator('.ask-dlg[open]');
  await dlg.first().waitFor();
  if (await dlg.locator('[data-v="browser"]').count() && await dlg.locator('[data-v="folder"]').count()) {
    await dlg.locator(`[data-v="${where}"]`).click();
    await page.waitForSelector('.ask-dlg[open] input', { timeout: 20000 });
  }
  await page.fill('.ask-dlg[open] input', name);
  await page.click('.ask-dlg[open] [data-v="ok"]');
  await waitLinked(page, name);
}
/** Poll an ASYNC condition in the page. (page.waitForFunction does not await a returned promise: it counts as true at once.) */
async function until(page, fn, arg, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await page.evaluate(fn, arg)) return; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('timed out waiting for: ' + fn.toString().slice(0, 120));
}
const waitLinked = (page, name) => page.waitForFunction((n) => window.__c3d.lib.linked && (!n || window.__c3d.lib.linked.name === n), name, { timeout: 60000 });
const waitStatus = (page, text) => page.waitForFunction((t) => document.querySelector('#libStatus').textContent.includes(t), text, { timeout: 60000 });
const list = (page) => page.evaluate(() => window.__c3d.library.list());
const linkedId = (page) => page.evaluate(() => window.__c3d.lib.linked && window.__c3d.lib.linked.id);
/** Set a head offset through the real number box (a normal user edit). */
async function editHead(page, value) {
  await page.click('.card[data-slot="head"] [data-tab="place"]');
  await page.fill('.card[data-slot="head"] input[type="number"][data-path="offset.1"]', String(value));
  await page.locator('.card[data-slot="head"] input[type="number"][data-path="offset.1"]').blur();
}
const headY = (page) => page.evaluate(() => window.__c3d.state.slots.head.params.offset[1]);
const openPanel = async (page) => { await page.click('#btnLibrary'); await page.waitForSelector('#libraryDlg[open]'); await page.waitForFunction(() => !!document.querySelector('#libBody .lib-grid, #libBody .lib-empty, #libBody .lib-alert')); };
const closePanel = async (page) => { await page.click('#libDone'); await page.waitForFunction(() => !document.querySelector('#libraryDlg[open]')); };
const cards = (page) => page.$$eval('#libBody .lib-card', (els) => els.map((e) => ({ id: e.dataset.id, name: e.querySelector('h3').textContent, current: e.classList.contains('current') })));
/** Click an action on the gallery card with this name. */
const cardAct = (page, name, act) => page.locator('#libBody .lib-card', { has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) }).locator(`[data-do="${act}"]`).click();
const answer = async (page, value, text) => {
  const d = page.locator('.ask-dlg[open]').last();
  await d.waitFor();
  if (text !== undefined) await d.locator('input').fill(text);
  await d.locator(`[data-v="${value}"]`).click();
};
/** Unzip a downloaded backup inside the page (fflate is already vendored there). */
async function unzipNames(page, path) {
  const b64 = fs.readFileSync(path).toString('base64');
  return page.evaluate(async (b) => {
    const { unzipSync, strFromU8 } = await import('/vendor/three/addons/libs/fflate.module.js');
    const z = unzipSync(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
    return Object.entries(z).map(([n, d]) => ({ name: n, project: JSON.parse(strFromU8(d)) }));
  }, b64).then((r) => r.map((x) => ({ name: x.name, lib: x.project.library, format: x.project.format })));
}
module.exports = { until, saveAs, waitLinked, waitStatus, list, linkedId, editHead, headY, openPanel, closePanel, cards, cardAct, answer, unzipNames };
