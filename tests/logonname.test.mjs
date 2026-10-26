// The boot's logon offers a user name on every host: the Electron app's is the Mac account; a browser page has none,
// and the logon offered an empty name there, so OK was refused and Cancel left the network client logged off
// (Entire Network: "Unable to browse the network")
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const i = w.indexOf('function setupNetwork() {'), line = w.slice(i, w.indexOf('\n', w.indexOf('const user = ', i)));
const userOf = new Function('window', `${line.slice(line.indexOf('const user = '))}; return user;`);
assert.equal(userOf({}), 'User', 'a page with no host account');
assert.equal(userOf({ W95HOST: {} }), 'User');
assert.equal(userOf({ W95HOST: { userName: 'johusha' } }), 'johusha', 'the host account');
assert.equal(userOf({ W95HOST: { userName: '  ' } }), 'User', 'a name with nothing legal in it');
console.log('logonname: ok');
