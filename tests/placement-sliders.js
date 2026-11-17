// Task A: placement tab — sliders that also accept typed numbers.
const { open, ready, suite, main } = require('./_helpers');

main('placement-sliders', async (base) => {
  const t = suite('placement-sliders');
  const { browser, page, errors } = await open(base);
  await page.click('#btnSample'); await ready(page);
  await page.click('.card[data-slot="head"] [data-tab="place"]');
  const card = '.card[data-slot="head"]';
  const rng = (path) => page.locator(`${card} input[type="range"][data-path="${path}"]`);
  const num = (path) => page.locator(`${card} input[type="number"][data-path="${path}"]`);
  const off = () => page.evaluate(() => window.__c3d.state.slots.head.params.offset);
  const undoLen = () => page.evaluate(() => window.__c3d.history.undo.length);

  // all seven controls are present with the specified ranges
  const attrs = await page.evaluate((c) => ['offset.0', 'offset.1', 'offset.2', 'rotation.0', 'rotation.1', 'rotation.2', 'size'].map((p) => {
    const r = document.querySelector(`${c} input[type="range"][data-path="${p}"]`);
    return r && [r.min, r.max, r.step, !!document.querySelector(`${c} input[type="number"][data-path="${p}"]`)].join('|');
  }), card);
  t.eq(attrs, ['-1.5|1.5|0.01|true', '-1.5|1.5|0.01|true', '-1.5|1.5|0.01|true', '-180|180|1|true', '-180|180|1|true', '-180|180|1|true', '0.3|2.5|0.05|true'], 'six placement values + size each have slider and number');

  // slider -> number, and a drag is ONE undo entry (many input events, one change)
  const u0 = await undoLen();
  await rng('offset.0').evaluate((el) => {
    for (const v of [0.1, 0.2, 0.3, 0.4]) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  t.eq(await num('offset.0').inputValue(), '0.4', 'slider moves the number box');
  t.eq((await off())[0], 0.4, 'slider writes the param');
  t.eq(await undoLen() - u0, 1, 'a whole slider gesture is a single undo entry');

  // number -> slider, value outside slider range is kept, slider clamps visually
  await num('offset.0').fill('3');
  t.eq((await off())[0], 3, 'typed value beyond the slider range is stored');
  t.eq(await rng('offset.0').inputValue(), '1.5', 'slider is clamped to its end');
  await num('offset.0').press('Enter'); await num('offset.0').blur();
  t.eq(await undoLen() - u0, 2, 'typed value creates one more undo entry');

  // rotation
  await num('rotation.1').fill('270'); await num('rotation.1').blur();
  t.eq((await page.evaluate(() => window.__c3d.state.slots.head.params.rotation))[1], 270, 'rotation accepts 270 (outside -180..180)');
  t.eq(await rng('rotation.1').inputValue(), '180', 'rotation slider clamped');

  // undo restores both controls
  await page.evaluate(() => window.__c3d.undo()); // rotation back to 0
  t.eq(await num('rotation.1').inputValue(), '0', 'undo restores the number box');
  t.eq(await rng('rotation.1').inputValue(), '0', 'undo restores the slider');
  await page.evaluate(() => window.__c3d.undo()); // offset 3 -> 0.4
  t.eq(await num('offset.0').inputValue(), '0.4', 'undo of typed value -> 0.4');
  t.eq(await rng('offset.0').inputValue(), '0.4', 'undo of typed value moves slider too');
  await page.evaluate(() => window.__c3d.redo());
  t.eq(await num('offset.0').inputValue(), '3', 'redo -> 3');

  // size slider + number
  await num('size').fill('4'); await num('size').blur();
  t.eq(await page.evaluate(() => window.__c3d.state.slots.head.params.size), 4, 'size number accepts 4 (slider max 2.5)');
  t.eq(await rng('size').inputValue(), '2.5', 'size slider clamped');

  // reset
  await page.click(`${card} [data-act="reset-place"]`);
  t.eq(await page.evaluate(() => { const p = window.__c3d.state.slots.head.params; return [p.offset, p.rotation, p.size]; }), [[0, 0, 0], [0, 0, 0], 1], 'reset sets params');
  t.eq(await Promise.all([num('offset.0').inputValue(), rng('offset.0').inputValue(), num('size').inputValue(), rng('size').inputValue()]), ['0', '0', '1', '1'], 'reset updates sliders and numbers');

  // 3D gizmo move writes back into the sliders
  await page.evaluate(() => window.__c3d.setEdit('translate'));
  const moved = await page.evaluate(() => {
    const c = window.__c3d, tc = c.tc;
    if (!tc.object) return null;
    tc.object.position.y += 0.25;
    tc.dispatchEvent({ type: 'objectChange' });
    const r = { id: tc.object.userData.slot, y: c.state.slots[tc.object.userData.slot].params.offset[1] };
    tc.dispatchEvent({ type: 'dragging-changed', value: false });
    return r;
  });
  t.ok(moved && moved.y !== 0, 'gizmo objectChange updates params', moved);
  if (moved) {
    const id = moved.id;
    const v = await page.locator(`.card[data-slot="${id}"] input[type="range"][data-path="offset.1"]`).inputValue();
    t.ok(Math.abs(parseFloat(v) - moved.y) < 0.011, `gizmo move shows up on the slider (${v} vs ${moved.y})`);
    const nv = await page.locator(`.card[data-slot="${id}"] input[type="number"][data-path="offset.1"]`).inputValue();
    t.eq(parseFloat(nv), moved.y, 'gizmo move shows up in the number box');
  }
  await page.evaluate(() => window.__c3d.setEdit('view'));

  // project save / load keeps the values
  await num('offset.2').fill('0.7'); await num('rotation.0').fill('45'); await num('rotation.0').blur();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.__c3d.doExport('project'))]);
  const data = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
  t.eq([data.slots.head.params.offset[2], data.slots.head.params.rotation[0]], [0.7, 45], 'project file holds the values');
  await page.evaluate(() => { const p = window.__c3d.state.slots.head.params; p.offset = [0, 0, 0]; p.rotation = [0, 0, 0]; });
  await page.evaluate((d) => window.__c3d.loadProject(d), data);
  await page.click(`${card} [data-tab="place"]`);
  t.eq([await num('offset.2').inputValue(), await rng('offset.2').inputValue(), await num('rotation.0').inputValue()], ['0.7', '0.7', '45'], 'loading the project restores sliders / numbers');

  // phone width: nothing overflows horizontally
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const over = await page.evaluate((c) => {
    const pane = document.querySelector(`${c} [data-pane="place"]`);
    const bad = [...pane.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.className || e.tagName);
    return { doc: document.documentElement.scrollWidth, win: innerWidth, bad: bad.slice(0, 5) };
  }, card);
  t.ok(over.doc <= over.win && !over.bad.length, 'no horizontal overflow at 390px', over);

  t.eq(errors, [], 'no console / page errors');
  await browser.close();
  return t.done();
});
