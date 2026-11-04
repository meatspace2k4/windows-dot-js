// bench/anchor98.mjs's cases against a page's API stood in for: the case travels to its anchor and passes on its event
// and check, fails on a fault met while it waits, on its check's answer, and reports a missing anchor as missing; the
// anchors are taken once each as their rungs are met
import assert from 'node:assert/strict';
const { pageCheck, armAnchors } = await import('../bench/anchor98.mjs');

const page = ({ moments = ['w98-desktop', 'exitwin-stuck'], menus = [['Windows Update', 'Programs']], files = ['C:\\WINDOWS\\SYSTEM\\RUNONCE.EXE'] } = {}) => {
  const subs = new Map(), on = (t, f) => { (subs.get(t) || subs.set(t, new Set()).get(t)).add(f); return () => subs.get(t).delete(f); };
  const emit = (t, e) => [...(subs.get(t) || [])].forEach(f => f({ type: t, ...e }));
  const w = {
    travelled: [], anchored: [], notes: [], keys: [], emit,
    braid: { moments: async () => moments.map(name => ({ name })), travel: async (n, o) => { w.travelled.push([n, o]); }, anchor: async n => { w.anchored.push(n); return { verdict: 'ok' }; } },
    on, next: (t, test, ms) => new Promise((ok, no) => { const off = on(t, e => { if (test(e)) { off(); ok(e); } }); setTimeout(() => { off(); no(new Error(`no ${t} in ${ms} ms`)); }, ms); }),
    key: k => w.keys.push(k), menus: () => menus, windows: () => [], note: s => w.notes.push(s),
    fs: { stat: f => { if (!files.includes(f)) throw new Error('none'); return {}; } },
    sysApp: { alive: true, cmd: async () => [] },
  };
  globalThis.win95 = w; globalThis.window = globalThis; return w;
};
const cases = {
  ok: { anchor: 'exitwin-stuck', type: 'screen', test: 'e => e.screen !== "desktop"', ms: 2000 },
  fault: { anchor: 'exitwin-stuck', type: 'screen', test: 'e => e.screen === "never"', ms: 5000 },
  hold: { anchor: 'w98-desktop', ms: 1000, hold: 600 },
};

{ // the event after the travel: passed, from the anchor, forced (another build's moment is this tree's to arrive at)
  const w = page(); const p = pageCheck('ok', cases); setTimeout(() => w.emit('screen', { screen: 'black' }), 50);
  const r = await p; assert.equal(r.ok, true, r.why); assert.deepEqual(w.travelled, [['exitwin-stuck', { force: true }]]);
}
{ // a fault while it waits: failed at once, with the fault
  const w = page(); const p = pageCheck('fault', cases); setTimeout(() => w.emit('braid.fault', { fault: { program: 'EXPLORER', why: 'page fault' } }), 50);
  const r = await p; assert.equal(r.ok, false); assert.match(r.why, /EXPLORER/); assert.ok(r.ms < 3000);
}
{ // a fault during the hold
  const w = page(); const p = pageCheck('hold', cases); setTimeout(() => w.emit('braid.broken', { findings: ['Win16Lock held'] }), 100);
  const r = await p; assert.equal(r.ok, false); assert.match(r.why, /Win16Lock/);
}
{ // no anchor: missing, not travelled
  const w = page({ moments: [] }); const r = await pageCheck('ok', cases); assert.equal(r.missing, true); assert.deepEqual(w.travelled, []);
}
{ // the post-upgrade checks: Windows 98's Start menu, RUNONCE in SYSTEM only
  let w = page(); let p = pageCheck('startmenu'); setTimeout(() => w.emit('menu.open', { menus: [['Programs']] }), 600);
  let r = await p; assert.equal(r.ok, true, r.why); assert.deepEqual(w.keys, ['ctrl+esc', 'esc']);
  w = page({ menus: [['Programs', 'Documents']] }); p = pageCheck('startmenu'); setTimeout(() => w.emit('menu.open', { menus: [['Programs']] }), 600);
  r = await p; assert.equal(r.ok, false); assert.match(r.why, /not Windows 98/);
  page(); r = await pageCheck('runonce'); assert.equal(r.ok, true, r.why);
  page({ files: ['C:\\WINDOWS\\RUNONCE.EXE', 'C:\\WINDOWS\\SYSTEM\\RUNONCE.EXE'] }); r = await pageCheck('runonce'); assert.equal(r.ok, false); assert.match(r.why, /Windows folder/);
}
{ // the anchors: each taken once, when its rung is met; the first boot's only after the restart
  const w = page(); delete globalThis.__w98rebooted;
  const off = armAnchors({ 'w98-reboot': { type: 'screen', test: 'e => e.screen !== "desktop"' }, 'w98-firstboot': { type: 'window.open', test: 'e => e.title === "Windows 98 Setup" && !!window.__w98rebooted' } });
  w.emit('window.open', { title: 'Windows 98 Setup' }); await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(w.anchored, [], 'Setup\'s own window before the restart is not the first boot');
  w.emit('screen', { screen: 'black' }); w.emit('screen', { screen: 'logow' }); await new Promise(r => setTimeout(r, 10));
  w.emit('window.open', { title: 'Windows 98 Setup' }); await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(w.anchored, ['w98-reboot', 'w98-firstboot']); off();
}
console.log('anchor98: ok');
process.exit(0);
