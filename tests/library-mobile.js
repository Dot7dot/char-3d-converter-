// Phone: browser backend even if showDirectoryPicker exists; the panel fits 390 px.
const { open, ready, suite, main } = require('./_helpers');
const L = require('./_lib');

main('library-mobile', async (base) => {
  const t = suite('library-mobile');
  // Android Chrome can expose the picker: it must be ignored on a phone
  const { browser, page, errors } = await open(base, { device: 'iPhone 13', library: true, init: 'window.showDirectoryPicker = async () => { throw new Error("must not be called on a phone"); };' });
  const st = await page.evaluate(() => ({ ...window.__c3d.library.status(), w: innerWidth, hasPickerStub: typeof window.showDirectoryPicker }));
  t.ok(st.backend === 'browser' && st.ready && st.mobile && !st.canUseFolder && st.hasPickerStub === 'function' && st.w === 390, 'iPhone 13: browser backend although showDirectoryPicker exists', st);
  const noX = () => page.evaluate(() => {
    const over = [...document.querySelectorAll('.topbar *, #libraryDlg *, .ask-dlg *, #libBanner *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 0.5 || r.left < -0.5); }).map((e) => e.className || e.tagName);
    return { doc: document.documentElement.scrollWidth, win: innerWidth, over: [...new Set(over)].slice(0, 6) };
  });
  let m = await noX();
  t.ok(m.doc <= m.win && !m.over.length, 'top bar (6 buttons) fits 390 px', m);

  await page.click('#btnSample'); await ready(page);
  await page.click('#btnSave');
  await page.waitForSelector('.ask-dlg[open] input'); // straight to the name: no "where to store" question
  t.ok(!(await page.textContent('.ask-dlg[open]')).includes('資料夾'), 'no folder option is offered on a phone');
  m = await noX(); t.ok(m.doc <= m.win && !m.over.length, 'name prompt fits 390 px', m);
  await page.fill('.ask-dlg[open] input', '手機角色'); await page.click('.ask-dlg[open] [data-v="ok"]');
  await L.waitLinked(page, '手機角色');
  m = await noX(); t.ok(m.doc <= m.win && !m.over.length, 'top bar with the status chip fits 390 px', m);
  await page.click('#btnNew'); await page.waitForFunction(() => !window.__c3d.lib.linked);
  await page.click('#btnSample'); await ready(page);
  await L.saveAs(page, '另一個很長很長很長很長很長很長很長的名字');

  await L.openPanel(page);
  await page.waitForFunction(() => document.querySelectorAll('#libBody .lib-card').length === 2);
  const body = await page.textContent('#libBody');
  t.ok(body.includes('這個瀏覽器') && !body.includes('資料夾') && !body.includes('Chrome 或 Edge'), 'panel: "這個瀏覽器", no folder buttons, no desktop-only hint on a phone');
  m = await noX();
  t.ok(m.doc <= m.win && !m.over.length, 'library panel with 2 characters has no horizontal overflow at 390 px', m);
  const geo = await page.evaluate(() => {
    const d = document.querySelector('#libraryDlg').getBoundingClientRect();
    const cs = [...document.querySelectorAll('.lib-card')].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; });
    return { dlg: [Math.round(d.left), Math.round(d.right)], cs, bodyScroll: document.querySelector('#libBody').scrollWidth <= document.querySelector('#libBody').clientWidth };
  });
  t.ok(geo.bodyScroll && geo.cs.every(([l, r]) => l >= geo.dlg[0] && r <= geo.dlg[1]), 'cards stay inside the dialog', geo);
  t.eq(new Set(geo.cs.map((c) => c[0])).size, 2, 'two cards per row on a phone');
  const small = await page.$$eval('#libraryDlg button', (bs) => bs.filter((b) => b.getBoundingClientRect().height < 24).length);
  t.eq(small, 0, 'all panel buttons are at least 24 px tall');
  if (process.env.C3D_SHOTS) await page.screenshot({ path: require('path').join(process.env.C3D_SHOTS, 'mobile-panel.png') });
  // a quota dialog also fits
  await page.evaluate(() => { navigator.storage.estimate = async () => ({ usage: 0.96e9, quota: 1e9 }); });
  await L.closePanel(page);
  await page.click('#btnNew');
  await page.waitForFunction(() => !window.__c3d.lib.linked && !document.querySelector('.ask-dlg[open]'));
  await page.click('#btnSample'); await ready(page);
  await page.click('#btnSave'); await page.waitForSelector('.ask-dlg[open] input');
  await page.fill('.ask-dlg[open] input', 'x'); await page.click('.ask-dlg[open] [data-v="ok"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.ask-dlg[open] h2')].some((h) => h.textContent.includes('已滿')));
  m = await noX(); t.ok(m.doc <= m.win && !m.over.length, 'storage-full dialog fits 390 px', m);
  if (process.env.C3D_SHOTS) await page.screenshot({ path: require('path').join(process.env.C3D_SHOTS, 'mobile-quota.png') });
  t.eq(errors, [], 'no console / page errors');
  await browser.close();
  return t.done();
});
