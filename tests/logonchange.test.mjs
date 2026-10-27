// Logging off in a shared session (win95.js logonChanged): this machine's Windows Logon recording another user under
// Network\Logon sends the page to that person's session (shared.js logOff); the same user again, another value, another
// key, or a page on its own store is nothing
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const i = w.indexOf('function logonChanged(o) {'), src = w.slice(i, w.indexOf('\n}\n', i) + 3);
const run = (o, shared = true) => {
  const offs = [], window = { W95HOST: shared ? { shared: {} } : {}, W95Shared: { logon: { user: 'Guest' }, logOff: u => offs.push(u) } };
  const W95FS = { decode: b => new TextDecoder().decode(b) };
  const r = new Function('window', 'W95FS', `${src}\nreturn logonChanged;`)(window, W95FS)(o);
  return { r, offs };
};
const set = (name, v, path = 'hklm\\network\\logon') => ({ op: 'set', path, name, value: { type: 1, data: new TextEncoder().encode(v + '\0') } });
assert.deepEqual(run(set('username', 'Carol')).offs, ['Carol']);
assert.deepEqual(run(set('UserName', 'Carol')).offs, ['Carol'], 'the value\'s name in any case');
assert.deepEqual(run(set('username', 'GUEST')).offs, [], 'the same user');
assert.deepEqual(run(set('PrimaryProvider', 'Windows Logon')).offs, []);
assert.deepEqual(run(set('username', 'Carol', 'hklm\\network\\other')).offs, []);
assert.deepEqual(run(set('username', 'Carol'), false).offs, [], 'a page on its own store');
assert.deepEqual(run({ op: 'del', path: 'hklm\\network\\logon', name: 'username' }).offs, []);
console.log('logonchange: ok');
