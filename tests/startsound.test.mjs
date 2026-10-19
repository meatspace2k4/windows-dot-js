// SystemStart at boot: the system's machine (MSGSRV32) starts with its sound heard after a shutdown or restart and on
// the first run, quiet after a reload with Windows running; and its start owes nothing to Setup's Start menu pass
// (GRPCONV's RunOnce), which the boot no longer runs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };

// the page's start: heard (quiet false) with no record, after Shut Down ('clean') and after Restart; not after a
// reload with Windows running ('running'), unless Setup built C: as the page started
function page(record, { firstRun = false, rebooted = false } = {}) {
  const store = new Map(); if (record !== null) store.set('w95.shutdown', record);
  const started = [];
  class App { constructor(path, arg, o) { Object.assign(this, { path, arg, ...o }); } async start() { started.push(this); return true; } }
  const S = new Function('localStorage', 'window', 'RemoteApp', 'NativeApp', 'join', 'WINDIR', 'firstRun', 'rebooted', `
    let sysApp = null, sysStarting = null;
    ${cut('const SHUTDOWN = ', '\n')}
    ${cut('const cleanStart = ', '\n')}
    ${cut('function shutDownCleanly() {', '\n')}
    ${cut('function startSystem() {', 'sysStarting = null; }));\n}')}
    return { startSystem, shutDownCleanly, cleanStart, record: () => localStorage.getItem('w95.shutdown') };`);
  const ls = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const win = { W95SYSTEM: { ne: { MSGSRV32: {} }, programs: { 'EXPLORER.EXE': {} } }, SharedArrayBuffer: function () {} };
  return { ...S(ls, win, App, App, (...a) => a.join('\\'), 'C:\\WINDOWS', firstRun, rebooted), started };
}
for (const [record, opts, heard] of [
  [null, {}, true], ['clean', {}, true], ['running', {}, false], ['running', { rebooted: true }, true], ['running', { firstRun: true }, true],
]) {
  const p = page(record, opts);
  assert.equal(p.record(), 'running');   // (the page is running from here: a reload now is no shutdown)
  await p.startSystem();
  assert.equal(p.started.length, 1, JSON.stringify([record, opts]));
  const a = p.started[0];
  assert.ok(/MSGSRV32\.EXE$/.test(a.path) && a.system, 'the system machine is MSGSRV32');
  assert.equal(a.quiet, !heard, JSON.stringify([record, opts]));
}
// Shut Down leaves the record a clean one: the next start is heard
{ const p = page('running'); p.shutDownCleanly(); assert.equal(p.record(), 'clean'); }

// the boot's Setup passes include the Start menu one: GRPCONV under Setup's RunOnce (RunOnce\Setup) with the wrapper
// Setup leaves under the shell's RunOnce, so the shell runs RUNONCE as it starts (GRPCONV makes the Start menu
// through the shell, which must be up); SystemStart comes after, as WinExec gives the shell back once idle
{
  const boots = w.split('\n').filter(l => /installPrograms\(\); setupFonts\(\);/.test(l));
  assert.equal(boots.length, 2);
  for (const l of boots) assert.ok(/\bsetupStartMenu\(\);/.test(l), l);
  const body = cut('function setupStartMenu() {', "regSet(ro, 'Wrapper', str('runonce.exe'));\n}");
  assert.ok(/regSet\(ro \+ '\\\\setup', 'Programs on the Start menu'/.test(body));
  assert.ok(!/regSet\(ro, 'GrpConv'/.test(body) && /regSet\(ro, 'Wrapper', str\('runonce\.exe'\)\)/.test(body));
}
// the machine: MSGSRV32 starts at once, Setup's items or not (the shell runs them)
{
  const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  const i = src.indexOf('  startSystemTask() {'), j = src.indexOf('  startMsgsrv() {'); assert.ok(i >= 0 && j > i);
  const M = new Function('W', 'self', 'fs', `return class {\n${src.slice(i, src.indexOf('\n  }\n', j) + 4)}\n}`);
  const run = items => {
    const started = [], spawned = [];
    const W = { regVals: () => items, regGet: () => undefined }, self = { W95SYSTEM: { programs: { 'RUNONCE.EXE': {} } } }, fs = { exists: () => true };
    const m = new (M(W, self, fs))();
    Object.assign(m, { alive: true, proc: { trapped: null, init16() {}, startTask16(n) { started.push(n); return 0x1234; } }, spawnProgram(f) { spawned.push(f); return {}; }, exited: () => {} });
    return { r: m.startSystemTask(), started, spawned };
  };
  const a = run([['programs on the start menu', {}]]); assert.deepEqual([a.r, a.spawned, a.started], [true, [], ['MSGSRV32.EXE']]);
  const b = run([]); assert.deepEqual([b.r, b.spawned, b.started], [true, [], ['MSGSRV32.EXE']]);
}
// the system's start waits on nothing of the shell's: startSystem is called from the boot (systemBootLater), not from a
// RunOnce or GRPCONV
assert.ok(/function systemBootLater\(\) \{\n  const go = \(\) => setTimeout\(\(\) => startSystem\(\), 50\);/.test(w));
console.log('startsound: ok');
