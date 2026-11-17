# Tests

Plain Node scripts that drive the real page with Playwright (Chromium). No test framework, no build step.

```bash
# Playwright must be resolvable (`require('playwright')`), e.g. NODE_PATH=/usr/local/lib/node_modules_global
node tests/run-all.js            # everything
node tests/library-browser.js    # or a single script
```

Each script starts its own tiny static server for the repo root (no need to run `python3 -m http.server`), launches
Chromium with software WebGL, prints `PASS` / `FAIL` lines and exits non-zero when anything failed. Console errors and
page errors count as failures.

| Script | Covers |
|---|---|
| `placement-sliders.js` | 「擺放」 tab: slider ↔ number sync, typing past the slider range, one undo entry per gesture, undo / redo, reset, gizmo write-back, project save / load, 390 px width |
| `library-browser.js` | Browser backend: save, auto-save, reload continues the same entry, new / open, rename, duplicate, delete, single export, backup ZIP, import (ZIP, plain project, junk, same id), no-picker desktop note |
| `library-folder.js` | Folder backend (picker stubbed with an OPFS directory): files + index, auto-save, rename = file rename, rebuild of a deleted index, hand-copied files, reload, permission re-grant, disk-full write, deleted folder, copy from browser storage |
| `library-folder-ascii.js` | Folder backend on a file system that rejects non-ASCII names (ASCII fallback) |
| `library-folder-dup.js` | Hand-placed files sharing a library id are never deleted or overwritten (both listing orders) |
| `library-minor.js` | Chip locked during restore, offline leave guard wording, refused / missing folder feedback, no reconnect state when no folder was chosen |
| `library-race.js` | Start-up restore race (新角色 / 範例 / open during restore, buttons locked and forced on), draft keeps the library link, 範例 guard, size clamp, object default name, switching storage |
| `library-upgrade.js` | Live version (`origin/main`) and this version on one origin: `char3d` stays v1, old and new tabs both keep saving the draft, rollback works |
| `library-quota.js` | 82 % warning (banner, panel, backup), 96 % blocking dialog, simulated `QuotaExceededError` (rollback, nothing half-written), no-`estimate()` fallback |
| `library-mobile.js` | iPhone 13 emulation: browser backend even though `showDirectoryPicker` exists, panel and dialogs fit 390 px |
| `regression.js` | Sample, GLB export, 專案檔 export, object mode, no console errors |

Notes

- `C3D_SHOTS=/some/dir node tests/library-mobile.js` also saves screenshots (they are slow under software rendering,
  so they are off by default).
- `C3D_CHANNEL=chromium` runs with the full Chromium build instead of the headless shell.
- Chromium maps file names through the system locale. The helpers start it with `LANG=C.UTF-8`; under the plain
  POSIX locale it refuses non-ASCII names such as `勇者__….c3d.json` (which is what `library-folder-ascii.js` exercises).
- The headless Chromium used here closes the page when a `FileSystemDirectoryHandle` is read back from IndexedDB, so
  `_opfs.js` stores the OPFS handle as a token and returns a wrapper around the real directory. Everything else the
  folder tests do goes to a real OPFS `FileSystemDirectoryHandle`.
