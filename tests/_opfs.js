// Page init script for the folder-backend tests: stubs the folder picker with an OPFS directory.
//
// Known limit of the test browser: the headless Chromium used here closes the whole page when a
// FileSystemDirectoryHandle is READ BACK from IndexedDB (writing it is fine). Real Chrome / Edge do this
// routinely, but to be able to test the reload paths anyway the handle is stored as a small token and
// handed back as a lazy wrapper around the real OPFS directory. Everything the library actually calls
// (queryPermission, requestPermission, values, getFileHandle, removeEntry) is forwarded to the real thing.
module.exports = (dirName) => `
(() => {
  const DIR = ${JSON.stringify(dirName)};
  const real = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(DIR);
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
  // permission state is steered from sessionStorage so it survives a reload: 'prompt' | 'denied' | (unset = granted)
  const perm = () => sessionStorage.getItem('perm') || 'granted';
  FileSystemDirectoryHandle.prototype.queryPermission = async () => perm();
  FileSystemDirectoryHandle.prototype.requestPermission = async () => { if (sessionStorage.getItem('refuse')) return 'denied'; sessionStorage.removeItem('perm'); return 'granted'; };
  // every file write is logged (tests assert "no write happened")
  window.__w = []; const cw = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = function (...a) { window.__w.push(this.name); return cw.apply(this, a); };
  const wrapper = () => ({
    kind: 'directory', name: DIR,
    queryPermission: async () => perm(),
    requestPermission: async () => { if (sessionStorage.getItem('refuse')) return 'denied'; sessionStorage.removeItem('perm'); return 'granted'; },
    values: async function* () { yield* (await real()).values(); },
    getFileHandle: async (n, o) => (await real()).getFileHandle(n, o),
    removeEntry: async (n, o) => (await real()).removeEntry(n, o),
  });
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (v, k) { return put.call(this, v instanceof FileSystemDirectoryHandle ? { __opfsToken: DIR } : v, k); };
  const desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
  Object.defineProperty(IDBRequest.prototype, 'result', { configurable: true, get() { const v = desc.get.call(this); return v && v.__opfsToken ? wrapper() : v; } });
})();
`;
