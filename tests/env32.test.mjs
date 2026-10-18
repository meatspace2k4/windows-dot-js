// the Win32 environment: the DOS side's variables (COMSPEC, PATH, TEMP, TMP, windir) in GetEnvironmentStrings and
// GetEnvironmentVariableA, changed per process by SetEnvironmentVariableA, expanded by ExpandEnvironmentStringsA
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype, API = W.API;
const u8 = new Uint8Array(0x10000); let top = 0x100;
const p = Object.create(P);
Object.defineProperty(p, 'u8', { value: u8 });
Object.assign(p, { alloc: n => { const a = top; top += (n + 15) & ~15; return a; }, lastError: 0 });
const str = s => { const a = p.alloc(s.length + 1); for (let i = 0; i < s.length; i++) u8[a + i] = s.charCodeAt(i); u8[a + s.length] = 0; return a; };
const call = (name, ...args) => API.KERNEL32[name][1].apply(p, args);
const read = a => { let s = ''; for (let i = a; u8[i]; i++) s += String.fromCharCode(u8[i]); return s; };
// the block: every variable, NUL-separated, ending with two NULs
{
  const b = call('GetEnvironmentStrings'); const vars = []; for (let a = b; u8[a]; a += read(a).length + 1) vars.push(read(a));
  assert.deepEqual(vars, ['COMSPEC=C:\\COMMAND.COM', 'PATH=C:\\WINDOWS;C:\\WINDOWS\\COMMAND', 'TEMP=C:\\WINDOWS\\TEMP', 'TMP=C:\\WINDOWS\\TEMP', 'windir=C:\\WINDOWS']);
}
// a variable: its length, into a buffer that holds it; the size needed into one that does not; 0 (ERROR_ENVVAR_NOT_FOUND) for none
{
  const buf = p.alloc(64);
  assert.equal(call('GetEnvironmentVariableA', str('path'), buf, 64), 29); assert.equal(read(buf), 'C:\\WINDOWS;C:\\WINDOWS\\COMMAND');
  assert.equal(call('GetEnvironmentVariableA', str('PATH'), buf, 10), 30);
  assert.equal(call('GetEnvironmentVariableA', str('NOPE'), buf, 64), 0); assert.equal(p.lastError, 203);
  assert.equal(call('SetEnvironmentVariableA', str('Foo'), str('bar')), 1);
  assert.equal(call('GetEnvironmentVariableA', str('FOO'), buf, 64), 3); assert.equal(read(buf), 'bar');
  assert.equal(call('SetEnvironmentVariableA', str('Foo'), 0), 1); assert.equal(call('GetEnvironmentVariableA', str('FOO'), buf, 64), 0);
  assert.equal(call('ExpandEnvironmentStringsA', str('%windir%\\x;%TEMP%;%NOPE%'), buf, 64), 'C:\\WINDOWS\\x;C:\\WINDOWS\\TEMP;%NOPE%'.length + 1);
  assert.equal(read(buf), 'C:\\WINDOWS\\x;C:\\WINDOWS\\TEMP;%NOPE%');
}
console.log('env32: ok');
