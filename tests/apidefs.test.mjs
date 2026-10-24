// Every API the personality answers for is defined once: a second definition replaced the first without a word.
// KERNEL32's GetpWin16Lock (ordinal 93) had two, and the later one handed back a null lock pointer in place of the
// real one; WOWGetVDMPointerFix (68) lost its real-mode case the same way.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) assert.doesNotThrow(() => new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))(), `${f} defines each API once`);
const { def } = window.W95Win32;
def('TESTDLL', 'Once', 0, () => 0);
assert.throws(() => def('TESTDLL', 'Once', 0, () => 1), /TESTDLL!Once defined twice/, 'a second definition stops the load');
console.log('apidefs: ok');
