// A travel to a moment held in the system's machine, after that machine ended (MSGSRV32's fault: Windows ended, its
// worker terminated, every moment it held gone with it): refused, unless the moment is anchored on this computer, which
// comes back. It skipped the ended machine as 'gone', said it had arrived, and nothing ran.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
globalThis.fetch = async () => ({ text: async () => '' });   // (the build's signature: no files here)
globalThis.Worker = class {};
new Function(readFileSync(new URL('../braid.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../braid-page.js', import.meta.url), 'utf8'))();
globalThis.indexedDB = { open: () => { const r = {}; setTimeout(() => { r.error = new Error('no store here'); r.onerror && r.onerror(); }, 0); return r; } };
const travelled = [];
const sys = { system: true, alive: true, path: 'SYSTEM', cmd: async (c, a) => {
  if (c === 'mark') return { name: a[0], now: 5, bytes: 0 };
  if (c === 'now') return 5; if (c === 'lint') return [];
  if (c === 'travel') { travelled.push(a[0]); return { at: 5 }; }
  return null;
} };
const ui = { W95Win32: { regDump: () => ({}), regLoad() {} }, fs: { vols: new Map(), uncs: new Map() }, machines: () => [sys], sysApp: () => sys, emit() {}, shared: () => null, closeMenus() {}, shell: () => ({}), setShell() {}, dirty() {} };
const page = window.W95BraidPage(ui);
await page.mark('t1');
sys.alive = false;
await assert.rejects(page.travel('t1', { force: true }), /the moment t1 was in the system's machine, which ended/, 'refused, not arrived at');
assert.deepEqual(travelled, [], 'nothing asked of the ended machine');
console.log('braiddead: ok');
