// Shared helpers for the Playwright test scripts (plain Node, no test framework).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

/** Tiny static file server for the repo root (so the tests do not need python or a build). */
function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      let f = path.join(ROOT, url === '/' ? 'index.html' : url);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

// LANG: Chromium maps file names through the system locale; under the plain POSIX locale (many CI containers)
// non-ASCII names such as 勇者__….c3d.json are rejected, which real desktops do not do. `posix` tests that case.
const UTF8 = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
const POSIX = { ...process.env, LANG: 'C', LC_ALL: 'C' };
const LAUNCH = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], env: UTF8 };

/** Browser + page that records console errors / page errors; `ctx` is a fresh (empty-storage) context. */
async function open(base, { device, viewport = { width: 1400, height: 860 }, init, query = '', library = false, posix = false } = {}) {
  const browser = await chromium.launch(process.env.C3D_CHANNEL ? { ...LAUNCH, channel: process.env.C3D_CHANNEL } : posix ? { ...LAUNCH, env: POSIX } : LAUNCH);
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  if (init) await page.addInitScript(init);
  await page.goto(base + query);
  await page.waitForFunction((lib) => !!window.__c3d && (!lib || !!window.__c3d.library), library);
  return { browser, ctx, page, errors };
}
function watch(page, errors) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
}

const ready = (page) => page.waitForFunction(
  () => !document.querySelector('#statusPill').classList.contains('busy') && /^[1-9]\d* 個部位已轉換/.test(document.querySelector('#statusText').textContent),
  null, { timeout: 120000 });

/** Minimal assertion collector: prints PASS / FAIL lines and sets the exit code. */
function suite(name) {
  const results = [];
  const t = {
    ok(cond, msg, extra) {
      results.push(!!cond);
      console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${!cond && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`);
    },
    eq(a, b, msg, extra) { t.ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, extra); },
    done() {
      const fail = results.filter((r) => !r).length;
      console.log(`\n${name}: ${results.length - fail}/${results.length} passed${fail ? `, ${fail} FAILED` : ''}`);
      return fail;
    },
  };
  return t;
}

async function main(name, fn) {
  const { srv, base } = await startServer();
  let fail = 1;
  try { fail = await fn(base); } catch (e) { console.log('FAIL  uncaught: ' + (e.stack || e)); fail = 1; }
  srv.close();
  process.exit(fail ? 1 : 0);
}

module.exports = { startServer, open, watch, ready, suite, main, LAUNCH, chromium, devices };
