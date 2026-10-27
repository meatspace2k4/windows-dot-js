// A person's own folders in a shared session (win95.js setupProfile): C:\WINDOWS\Profiles\<user> made from the
// machine's Desktop and Start Menu the first time (Recent and NetHood empty), the shell's folders theirs from then on,
// and HKCU's Shell Folders naming them, set again when HKCU came from someone else's profile; a second logon copies
// nothing over what the person changed
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis;
new Function(readFileSync(new URL('../fs.js', import.meta.url), 'utf8'))();
const { FileSystem, join } = window.W95FS;
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const i = w.indexOf('function setupProfile(user) {'), src = w.slice(i, w.indexOf('\n}\n', i) + 3);

const run = (fs, reg, user) => {
  const R = { regGet: (k, n) => (reg.get(k) || new Map()).get(n.toLowerCase()), regSet: (k, n, v) => { if (!reg.has(k)) reg.set(k, new Map()); reg.get(k).set(n.toLowerCase(), v); reg.sets = (reg.sets || 0) + 1; } };
  const vars = { DESKTOP_DIR: 'C:\\WINDOWS\\Desktop', RECENT: 'C:\\WINDOWS\\Recent', PROGRAMS: 'C:\\WINDOWS\\Start Menu\\Programs', START_MENU: 'C:\\WINDOWS\\Start Menu' };
  new Function('fs', 'join', 'W95Win32', 'W95FS', 'WINDIR', 'V', `let { DESKTOP_DIR, RECENT, PROGRAMS, START_MENU } = V;\n${src}\nsetupProfile(${JSON.stringify(user)}); Object.assign(V, { DESKTOP_DIR, RECENT, PROGRAMS, START_MENU });`)(
    fs, join, R, window.W95FS, 'C:\\WINDOWS', vars);
  return vars;
};
const text = v => new TextDecoder().decode(v.data).replace(/\0.*$/, '');
const fs = new FileSystem(); fs.mount('C', { kind: 'fixed', total: 1 << 24 });
for (const d of ['WINDOWS\\Desktop', 'WINDOWS\\Recent', 'WINDOWS\\Start Menu\\Programs\\Accessories']) fs.mkdir('C:\\' + d, { recursive: true });
fs.writeFile('C:\\WINDOWS\\Desktop\\Readme.txt', new TextEncoder().encode('hi'));
fs.writeFile('C:\\WINDOWS\\Start Menu\\Programs\\Accessories\\Notepad.lnk', new Uint8Array(4));
fs.writeFile('C:\\WINDOWS\\Recent\\old.lnk', new Uint8Array(4));

const reg = new Map(), ex = 'hkcu\\software\\microsoft\\windows\\currentversion\\explorer\\';
const v = run(fs, reg, 'Ann');
const home = 'C:\\WINDOWS\\Profiles\\Ann';
assert.deepEqual(v, { DESKTOP_DIR: home + '\\Desktop', RECENT: home + '\\Recent', PROGRAMS: home + '\\Start Menu\\Programs', START_MENU: home + '\\Start Menu' });
assert.ok(fs.exists(home + '\\Desktop\\Readme.txt'), 'the machine\'s desktop, copied');
assert.ok(fs.exists(home + '\\Start Menu\\Programs\\Accessories\\Notepad.lnk'), 'the machine\'s Start menu, copied');
assert.ok(fs.exists(home + '\\Start Menu\\Programs\\StartUp')); assert.ok(fs.exists(home + '\\NetHood'));
assert.equal(fs.readdir(home + '\\Recent').length, 0, 'Recent: their own, empty');
for (const k of ['shell folders', 'user shell folders']) {
  assert.equal(text(reg.get(ex + k).get('desktop')), home + '\\Desktop');
  assert.equal(text(reg.get(ex + k).get('programs')), home + '\\Start Menu\\Programs');
  assert.equal(text(reg.get(ex + k).get('startup')), home + '\\Start Menu\\Programs\\StartUp');
}
assert.equal(text(reg.get('hklm\\software\\microsoft\\windows\\currentversion\\profilelist\\ann').get('profileimagepath')), home);

// the second logon: what they changed kept, nothing written again
fs.unlink(home + '\\Desktop\\Readme.txt'); reg.sets = 0;
run(fs, reg, 'Ann');
assert.equal(fs.exists(home + '\\Desktop\\Readme.txt'), false); assert.equal(reg.sets, 0);

// HKCU copied from Ann's profile for Bob: his own folders named
const v2 = run(fs, reg, 'Bob');
assert.equal(text(reg.get(ex + 'shell folders').get('desktop')), 'C:\\WINDOWS\\Profiles\\Bob\\Desktop'); assert.equal(v2.RECENT, 'C:\\WINDOWS\\Profiles\\Bob\\Recent');
assert.ok(fs.exists('C:\\WINDOWS\\Profiles\\Bob\\Desktop\\Readme.txt'));
console.log('profile: ok');
