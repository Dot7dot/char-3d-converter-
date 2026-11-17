// Regression: sample + GLB export still work, new top bar, no console / page errors.
const fs = require('fs');
const { open, ready, suite, main } = require('./_helpers');

main('regression', async (base) => {
  const t = suite('regression');
  const { browser, page, errors } = await open(base, { library: true });
  t.ok(await page.$('#btnOpen') === null && await page.$('#btnReset') === null, 'old 開啟 / 清除 buttons are gone');
  await page.click('#btnSample'); await ready(page);
  t.ok(/個部位已轉換/.test(await page.textContent('#statusText')), 'sample loads and converts');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.evaluate(() => window.__c3d.doExport('glb'))]);
  const buf = fs.readFileSync(await dl.path());
  t.ok(dl.suggestedFilename().endsWith('.glb') && buf.slice(0, 4).toString() === 'glTF' && buf.length > 10000, `GLB export (${dl.suggestedFilename()}, ${buf.length} bytes)`);
  // the export dialog's 專案檔 option still downloads a project file that the library can import
  await page.click('#btnExport'); await page.check('input[name="fmt"][value="project"]');
  const [dp] = await Promise.all([page.waitForEvent('download'), page.click('#btnDoExport')]);
  const proj = JSON.parse(fs.readFileSync(await dp.path(), 'utf8'));
  t.ok(proj.format === 'char3d-project' && proj.slots.head, 'export dialog 專案檔 still works');
  await page.waitForFunction(() => !document.querySelector('#exportDlg[open]'));
  await page.evaluate(() => window.__c3d.library.useBrowser());
  const res = await page.evaluate(async (p) => { const f = new File([JSON.stringify(p)], 'x.c3d.json'); return window.__c3d.library.importFiles([f]); }, proj);
  t.eq([res.added.length, res.failed.length], [1, 0], 'that project file imports into the library');
  // object mode
  await page.click('[data-mode="object"]'); await page.click('#btnSample');
  await page.waitForSelector('.ask-dlg[open]'); // 範例 now asks before replacing unsaved work
  await page.click('.ask-dlg[open] [data-v="discard"]'); await ready(page);
  const [dg] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.evaluate(() => window.__c3d.doExport('glb'))]);
  t.ok(fs.statSync(await dg.path()).size > 5000, 'object sample exports a GLB too');
  t.eq(errors, [], 'no console / page errors');
  await browser.close();
  return t.done();
});
