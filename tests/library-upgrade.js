// F3: the live version (origin/main) and this version share one origin and one `char3d` database. Old and new tabs
// open at the same time must both keep saving their draft; going back to the old version must still work.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');
const { chromium, LAUNCH, suite, watch } = require('./_helpers');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const ready = (page) => page.waitForFunction(() => !document.querySelector('#statusPill').classList.contains('busy') && /^[1-9]\d* 個部位已轉換/.test(document.querySelector('#statusText').textContent), null, { timeout: 120000 });
const draft = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('char3d'); r.onsuccess = () => { const db = r.result; const q = db.transaction('kv').objectStore('kv').get('autosave'); q.onsuccess = () => { db.close(); const d = q.result; res(d ? { v: db.version, headY: d.slots.head && d.slots.head.params.offset[1] } : { v: db.version, none: true }); }; };
}));
const edit = (page, y) => page.evaluate((v) => { window.__c3d.state.slots.head.params.offset[1] = v; window.__c3d.commit('head'); }, y);

(async () => {
  const t = suite('library-upgrade');
  // /old/ = origin/main exactly as deployed, /new/ = the working tree (without .git / tests)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3d-site-'));
  fs.mkdirSync(path.join(tmp, 'old'));
  const tar = execFileSync('git', ['archive', 'origin/main'], { cwd: ROOT, maxBuffer: 1 << 29 });
  fs.writeFileSync(path.join(tmp, 'old.tar'), tar);
  execFileSync('tar', ['-xf', path.join(tmp, 'old.tar'), '-C', path.join(tmp, 'old')]);
  fs.mkdirSync(path.join(tmp, 'new'));
  for (const f of ['index.html', 'css', 'js', 'vendor']) fs.cpSync(path.join(ROOT, f), path.join(tmp, 'new', f), { recursive: true });
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    let f = path.join(tmp, u.endsWith('/') ? u + 'index.html' : u);
    if (!f.startsWith(tmp) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${srv.address().port}/`;
  let fail = 1;
  try {
    const browser = await chromium.launch(LAUNCH);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    const errors = [];
    const old = await ctx.newPage(); watch(old, errors);
    await old.goto(B + 'old/'); await old.waitForFunction(() => !!window.__c3d, null, { timeout: 120000 });
    await old.click('#btnSample'); await ready(old);
    await edit(old, 0.33); await old.waitForTimeout(2000);
    t.eq(await draft(old), { v: 1, headY: 0.33 }, 'old (live) version: draft stored in `char3d` v1');

    const nw = await ctx.newPage(); watch(nw, errors);
    await nw.goto(B + 'new/'); await nw.waitForFunction(() => !!window.__c3d && !!window.__c3d.lib, null, { timeout: 120000 });
    await ready(nw);
    t.eq(await nw.evaluate(() => window.__c3d.state.slots.head.params.offset[1]), 0.33, 'new version opened while the old tab stays open: restores the old draft');
    t.eq((await draft(nw)).v, 1, '`char3d` is still version 1 (the new code does not upgrade it)');

    // both tabs keep saving the draft
    await edit(old, 0.77); await old.waitForTimeout(2500);
    t.eq((await draft(nw)).headY, 0.77, 'old tab keeps saving its draft after the new tab opened');
    await edit(nw, 0.55); await nw.waitForTimeout(2500);
    t.eq((await draft(old)).headY, 0.55, 'new tab saves its draft while the old tab is open');
    await edit(old, 0.66); await old.waitForTimeout(2500);
    t.eq((await draft(old)).headY, 0.66, 'and the old tab again');

    // the library lives in its own database
    const dbs = await nw.evaluate(async () => (await indexedDB.databases()).map((d) => d.name + '@' + d.version).sort());
    t.ok(dbs.includes('char3d@1'), 'database list has char3d at version 1', dbs);
    await old.close(); await nw.close();

    // new version used, library database exists, then the owner rolls back to the old version
    const again = await ctx.newPage(); watch(again, errors);
    await again.goto(B + 'new/'); await again.waitForFunction(() => !!window.__c3d && !!window.__c3d.lib, null, { timeout: 120000 });
    await ready(again);
    await again.evaluate(() => window.__c3d.library.useBrowser());
    await again.click('#btnSave'); await again.waitForSelector('.ask-dlg[open] input');
    await again.click('.ask-dlg[open] [data-v="ok"]');
    await again.waitForFunction(() => window.__c3d.lib.linked, null, { timeout: 120000 });
    await edit(again, 0.44); await again.waitForTimeout(3000);
    await again.close();
    const rb = await ctx.newPage(); watch(rb, errors);
    await rb.goto(B + 'old/'); await rb.waitForFunction(() => !!window.__c3d, null, { timeout: 120000 });
    await ready(rb).catch(() => {});
    t.eq(await rb.evaluate(() => Object.keys(window.__c3d.state.slots).filter((k) => window.__c3d.state.slots[k].views.front).length > 3), true, 'rollback to the old version: the draft is restored');
    await edit(rb, 0.12); await rb.waitForTimeout(2500);
    t.eq(await draft(rb), { v: 1, headY: 0.12 }, 'rollback to the old version: it still saves its draft');
    t.eq(errors, [], 'no console / page errors (old and new code)');
    await browser.close();
    fail = t.done();
  } catch (e) { console.log('FAIL  uncaught: ' + (e.stack || e)); }
  srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
