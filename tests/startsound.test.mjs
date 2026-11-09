// SystemStart at boot: the system's machine (MSGSRV32) starts with its sound heard at every start, as Windows 95's
// (a reload, a Restart, ?debug=1's), quiet only on a page asked to be silent (?mute=1); and its start owes nothing to
// Setup's Start menu pass (GRPCONV's RunOnce), which the boot no longer runs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };

function page(mute) {
  const started = [];
  class App { constructor(path, arg, o) { Object.assign(this, { path, arg, ...o }); } async start() { started.push(this); return true; } }
  const S = new Function('window', 'RemoteApp', 'NativeApp', 'join', 'WINDIR', `
    let sysApp = null, sysStarting = null; const bootLogoEnd = () => {}, emit = () => {};   // (the start-up screen: the page's drawing; the page's events)
    ${cut('function startSystem() {', 'sysStarting = null; }));\n}')}
    return { startSystem };`);
  const win = { W95SYSTEM: { ne: { MSGSRV32: {} }, programs: { 'EXPLORER.EXE': {} } }, W95MUTE: mute, SharedArrayBuffer: function () {} };
  return { ...S(win, App, App, (...a) => a.join('\\'), 'C:\\WINDOWS'), started };
}
for (const mute of [false, true]) {
  const p = page(mute);
  await p.startSystem();
  assert.equal(p.started.length, 1);
  const a = p.started[0];
  assert.ok(/MSGSRV32\.EXE$/.test(a.path) && a.system, 'the system machine is MSGSRV32');
  assert.equal(a.quiet, mute);
}
// (no record of a shutdown decides it, and ?debug=1 does not silence it)
assert.ok(!/w95\.shutdown|cleanStart/.test(w));

// the boot's Setup passes include the Start menu one, and it leaves GRPCONV to Setup's RunOnce (RunOnce\Setup), not
// to the shell's own RunOnce: the machine runs Setup's items under RUNONCE before its message server starts, so the
// shell, and SystemStart with it, come after Setup's screen
{
  // (each boot's passes, the user's profile among them on a shared session's, then the Start menu's)
  const lines = w.split('\n'), boots = lines.map((l, i) => [l, i]).filter(([l]) => /installPrograms\(\); setupFonts\(\);/.test(l));
  assert.equal(boots.length, 2);
  for (const [l, i] of boots) assert.ok(/\bsetupStartMenu\(\);/.test(lines.slice(i, i + 3).join('\n')), l);
  const body = cut('function setupStartMenu() {', "grpconv.exe') + ' -s'));\n}");
  assert.ok(/regSet\(ro \+ '\\\\setup', 'Programs on the Start menu'/.test(body));
  assert.ok(!/regSet\(ro, 'GrpConv'/.test(body) && !/'Wrapper'/.test(body));
}
// the machine: with Setup's items left, RUNONCE runs first and MSGSRV32 starts when it has ended; with none, MSGSRV32
// starts at once
{
  const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  const i = src.indexOf('  startSystemTask() {'), j = src.indexOf('  startMsgsrv() {'); assert.ok(i >= 0 && j > i);
  const M = new Function('W', 'self', 'fs', 'post', `return class {\n${src.slice(i, src.indexOf('\n  }\n', j) + 4)}\n}`);
  const run = (items, runonce) => {
    const started = [], spawned = [], exits = [];
    const W = { regVals: () => items, regGet: () => undefined }, self = { W95SYSTEM: { programs: runonce ? { 'RUNONCE.EXE': {} } : {} } }, fs = { exists: f => f === 'C:\\WINDOWS\\SYSTEM\\RUNONCE.EXE' || f === 'C:\\WINDOWS\\RUNONCE.EXE' };   // (a stray copy in the Windows folder is never the one run)
    const m = new (M(W, self, fs, () => {}))(); let pc = null;
    Object.assign(m, { alive: true, proc: { trapped: null, init16() { exits.push('init16'); }, startTask16(n) { started.push(n); return 0x1234; } }, spawnProgram(f) { spawned.push(f); return (pc = { onExit: c => exits.push(c) }); }, exited: (c, why) => exits.push(['exited', why]) });
    const r = m.startSystemTask();
    return { r, started, spawned, exits, pc, m };
  };
  const a = run([['programs on the start menu', {}]], true);
  assert.deepEqual([a.r, a.spawned, a.started, a.exits], [true, ['C:\\WINDOWS\\SYSTEM\\RUNONCE.EXE'], [], ['init16']]);
  a.pc.onExit(0); assert.deepEqual(a.exits, ['init16', 0]); assert.equal(a.m.sysPending, true); assert.deepEqual(a.started, []);   // (RUNONCE ended: MSGSRV32 starts from the step loop)
  assert.equal(a.m.startMsgsrv(), true); assert.deepEqual(a.started, ['MSGSRV32.EXE']);
  const b = run([], true); assert.deepEqual([b.r, b.spawned, b.started], [true, [], ['MSGSRV32.EXE']]);
  const c = run([['x', {}]], false); assert.deepEqual([c.r, c.spawned, c.started], [true, [], ['MSGSRV32.EXE']]);
}
// the system's start waits on nothing of the shell's: startSystem is called from the boot (systemBootLater), not from a
// RunOnce or GRPCONV
assert.ok(/function systemBootLater\(\) \{\n  bootLogoStart\(\);\n  const go = \(\) => setTimeout\(\(\) => startSystem\(\), 50\);/.test(w));
console.log('startsound: ok');
