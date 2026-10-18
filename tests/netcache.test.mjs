// netCache (win95.js): the shell's view of a network drive the network's machine answers for, asynchronously
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const start = src.indexOf('function netCache(app, key) {'), end = src.indexOf('\n/** MPR', start);
assert.ok(start > 0 && end > start, 'netCache found');
const fsStub = { version: 0 };
const W95FS = { FSError: class extends Error { constructor(c, p) { super(p); this.code = c; } } };
const make = new Function('fs', 'dirty', 'W95FS', 'performance', src.slice(start, end) + '\nreturn netCache;');
const netCache = make(fsStub, () => {}, W95FS, { now: () => Date.now() });
const tree = { '': [{ name: 'Win95', dir: true }, { name: 'readme.txt', dir: false, size: 3 }], 'Win95': [{ name: 'index.html', dir: false, size: 9 }, { name: 'Tools', dir: true }] };
const calls = [];
const app = { alive: true, cmd: (c, [k, op, args]) => { calls.push(op + ':' + args[0]); return Promise.resolve(op === 'list' ? tree[args[0]] || [] : null); } };
const c = netCache(app, 'E');
const tick = () => new Promise(r => setTimeout(r, 0));

// the root is a folder at once
assert.equal(c.stat('').dir, true);
// a subfolder not yet listed is taken as a folder, and its parent is asked for
assert.equal(c.stat('Win95\\Tools').dir, true);
assert.ok(calls.includes('list:Win95'));
await tick();
// once listed, entries are found whatever the case they are asked in
assert.equal(c.stat('WIN95\\INDEX.HTML').size, 9);
assert.equal(c.stat('win95\\tools').dir, true);
// a name the listing does not have is not there
assert.equal(c.stat('Win95\\missing.txt'), null);
// a listing comes back under any case once fetched
c.list('');
await tick();
assert.deepEqual(c.list('').map(e => e.name), ['Win95', 'readme.txt']);
assert.equal(c.stat('README.TXT').size, 3);
console.log('netcache: ok');
