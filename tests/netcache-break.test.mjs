// trying to break netCache (win95.js)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const start = src.indexOf('function netCache(app, key) {'), end = src.indexOf('\n/** MPR', start);
const W95FS = { FSError: class extends Error { constructor(c, p) { super(p); this.code = c; } } };
let now = 0;
const netCache = new Function('fs', 'dirty', 'W95FS', 'performance', src.slice(start, end) + '\nreturn netCache;')({ version: 0 }, () => {}, W95FS, { now: () => now });
const tick = () => new Promise(r => setTimeout(r, 0));
const fails = [];
const t = async (name, fn) => { try { await fn(); } catch (e) { fails.push(name + ': ' + e.message); } };
const mk = (tree, o = {}) => { const calls = []; const app = { alive: o.alive !== false, cmd: (c, [k, op, args]) => { calls.push(op + ':' + args.join(',')); if (o.reject) return Promise.reject(new Error('gone')); return Promise.resolve(op === 'list' ? (args[0] in tree ? tree[args[0]] : null) : op === 'space' ? { total: 10, free: 5 } : null); } }; return { c: netCache(app, 'E'), calls, app }; };

await t('a file named before its folder is listed is a file once listed', async () => {
  const { c } = mk({ '': [{ name: 'a.txt', dir: false, size: 4 }] });
  c.stat('a.txt'); await tick(); const s = c.stat('a.txt'); assert.equal(s.dir, false); assert.equal(s.size, 4);
});
await t('a missing name in an unlisted folder is not reported missing forever', async () => {
  const { c } = mk({ '': [] }); c.stat('nope'); await tick(); assert.equal(c.stat('nope'), null);
});
await t('a folder whose listing fails (null) does not make everything below it exist', async () => {
  const { c } = mk({}); c.stat('x\\y'); await tick(); now += 5000; const s = c.stat('x\\y'); assert.notEqual(s && s.dir, true, 'still provisional dir after failed listing');
});
await t('a rejected call does not throw out of the cache', async () => {
  const { c } = mk({}, { reject: true }); c.list(''); await tick(); await tick(); assert.deepEqual(c.list(''), []);
});
await t('a mixed-case parent listed once is not listed again within 2 s', async () => {
  const { c, calls } = mk({ 'Dir': [] }); c.list('Dir'); c.list('DIR'); c.list('dir'); assert.equal(calls.filter(x => x.startsWith('list:')).length, 1);
});
await t('a listing is refreshed after 2 s (a file added on the host shows)', async () => {
  const tree = { '': [{ name: 'a', dir: false }] }; const { c } = mk(tree);
  c.list(''); await tick(); tree[''] = [{ name: 'a', dir: false }, { name: 'b', dir: false }]; now += 2500; c.list(''); await tick();
  assert.equal(c.stat('b') && c.stat('b').dir, false);
});
await t('a file deleted on the host stops being reported after a refresh', async () => {
  const tree = { '': [{ name: 'a', dir: false }] }; const { c } = mk(tree);
  c.list(''); await tick(); tree[''] = []; now += 2500; c.list(''); await tick(); assert.equal(c.stat('a'), null);
});
await t('unlink removes the entry and relists', async () => {
  const tree = { '': [{ name: 'a', dir: false }] }; const { c, calls } = mk(tree); c.list(''); await tick();
  tree[''] = []; c.unlink('a'); await tick(); await tick(); assert.equal(c.stat('a'), null); assert.ok(calls.includes('unlink:a'));
});
await t('a dead network machine answers nothing and does not throw', async () => {
  const { c } = mk({ '': [] }, { alive: false }); assert.doesNotThrow(() => c.list('')); assert.doesNotThrow(() => c.stat('q'));
});
await t('space answers', async () => { const { c } = mk({}); c.space(); await tick(); assert.equal(c.space().total, 10); });

console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'all pass');
process.exit(fails.length ? 1 : 0);
