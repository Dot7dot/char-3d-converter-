// Runs every test script one after another (each starts its own static server and browser).
const { spawnSync } = require('child_process');
const scripts = ['placement-sliders', 'library-browser', 'library-folder', 'library-folder-ascii', 'library-folder-dup', 'library-minor', 'library-race', 'library-upgrade', 'library-quota', 'library-mobile', 'regression'];
let failed = 0;
for (const s of scripts) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync('node', [`${__dirname}/${s}.js`], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { failed++; console.log(`>>> ${s} FAILED (exit ${r.status})`); }
}
console.log(failed ? `\n${failed} script(s) failed` : '\nall scripts passed');
process.exit(failed ? 1 : 0);
