// the classes of a shared session's state and calls (osclass.js), and the causes the machine tags what it does with
// (ne16.js causeOf, effect): a program started for another machine's person makes no intent until this machine's
// person acts on it; what it would have made is logged as an echo passed over
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'osclass.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const C = window.W95OSClass, P = window.W95Win32.Process.prototype;
assert.equal(C.program('C:\\WINDOWS\\EXPLORER.EXE'), 'singleton'); assert.equal(C.program('GRPCONV.EXE'), 'derived'); assert.equal(C.program('NOTEPAD.EXE'), 'shared');
assert.equal(C.spi(17), 'ui'); assert.equal(C.spi(47), null, 'the work area: each machine\'s');
assert.equal(C.ini('C:\\WINDOWS\\SYSTEM.INI'), 'shared'); assert.equal(C.ini('NOTEPAD.INI'), 'local');
assert.equal(C.area('hklm\\network\\logon'), 'identity'); assert.equal(C.area('C:\\WINDOWS\\TEMP\\~X.TMP'), 'local');
assert.equal(C.api('GetTickCount'), 'hidden-input'); assert.equal(C.api('CreateMutexA'), 'singleton-probe'); assert.equal(C.api('lstrlenA'), null);
for (const cls of Object.keys(C.API)) assert.ok(C.API[cls].length);

// causes
const p = Object.create(P);
assert.equal(p.causeOf(), 'host');
p.thread16 = { id: 1 }; assert.equal(p.causeOf(), 'boot');
p.personActed = true; assert.equal(p.causeOf(), 'input');
p.thread16 = { remote: true }; assert.equal(p.causeOf(), 'remote');
const pc = { pid: 0x70, origin: 'remote' }; p.thread16 = { pc };
assert.equal(p.causeOf(), 'remote', 'started for another machine\'s person, not acted on here');
p.personOn = 0x70; assert.equal(p.causeOf(), 'input', 'this machine\'s person acted on it');
// effects: each kept with its cause; a classed call once a process
p.personOn = null; p.effect('exec', 'NOTEPAD.EXE'); p.effect('hidden-input', 'KERNEL32!GetTickCount'); p.effect('hidden-input', 'KERNEL32!GetTickCount');
assert.deepEqual(p.effects.map(e => [e.kind, e.what, e.cause, e.pid]), [['exec', 'NOTEPAD.EXE', 'remote', 0x70], ['hidden-input', 'KERNEL32!GetTickCount', 'remote', 0x70]]);
// a setting written by that program: passed over as an echo, until this machine's person acts on it
const got = []; p.onIntent = i => got.push(i.key); p.caller16 = () => null;
P.iniIntent.call(p, 'WIN.INI', 'Desktop', 'Pattern', '(None)', null);
assert.deepEqual(got, []); assert.equal(p.effects.at(-1).kind, 'echo');
p.personOn = 0x70; P.iniIntent.call(p, 'WIN.INI', 'Desktop', 'Pattern', '(None)', null);
assert.deepEqual(got, ['ini:WIN.INI:desktop:pattern']); assert.equal(p.effects.at(-1).kind, 'intent');
console.log('osclass: ok');
