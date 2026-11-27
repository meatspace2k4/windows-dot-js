// Braid in a shared session (braid-page.js viaLine, remote): a mark, anchor, travel, scrub or forget asked for here is
// the session's intent, and nothing is made here until it comes back in the session's op order, as on every other
// machine; the call then resolves with what was made here, or fails with why. The line marking and anchoring itself
// (every) is this machine's own and goes to no one. Outside a session, each is made here at once.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../braid.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../braid-page.js', import.meta.url), 'utf8'))();

const make = shared => {
  const sent = [];
  const S = shared ? { intent: i => sent.push(i), people: () => [] } : null;
  const ui = { W95Win32: { regDump: () => ({}) }, fs: { vols: new Map(), uncs: new Map() }, machines: () => [], sysApp: () => null, emit() {}, shared: () => S, closeMenus() {}, shell: () => ({}) };
  const page = window.W95BraidPage(ui), made = [];
  // (what each would make here, stood in for: the machines' side is braid.test's and arrive.test's)
  for (const op of ['mark', 'anchor', 'travel', 'forget']) {
    const real = page[op].bind(page);
    page[op] = (a, o = {}) => (o.local || !S ? (made.push([op, typeof a === 'object' ? a : String(a), !!o.force]), a === 'nowhere' ? Promise.reject(new Error('no moment nowhere')) : Promise.resolve({ op, name: a })) : real(a, o));
  }
  return { page, sent, made };
};
const tick = () => new Promise(r => setImmediate(r));

{ // in a session: the intent first, the moment when it comes back
  const { page, sent, made } = make(true);
  let done = null, err = null; const p = page.mark('m1').then(r => { done = r; }, e => { err = e; });
  await tick();
  assert.deepEqual(sent.map(i => [i.kind, i.op, i.name, i.key]), [['braid', 'mark', 'm1', 'braid:mark:m1']], `the mark asked of the session${err ? ` (made here instead: ${err.message})` : ''}`);
  assert.deepEqual(made, [], 'nothing made before the session\'s order reaches it');
  await page.remote(sent[0]); await p;
  assert.deepEqual(made, [['mark', 'm1', false]]); assert.deepEqual(done, { op: 'mark', name: 'm1' });
  // another person's: made here, nothing waiting
  await page.remote({ kind: 'braid', op: 'anchor', name: 'a1' }); assert.deepEqual(made.at(-1), ['anchor', 'a1', false]);
  // travel, forced, and its failure here to the one who asked
  const t = page.travel('nowhere', { force: true }); await tick();
  assert.deepEqual([sent.at(-1).op, sent.at(-1).name, sent.at(-1).force], ['travel', 'nowhere', true]);
  await page.remote(sent.at(-1)); await assert.rejects(t, /no moment nowhere/);
  assert.deepEqual(made.at(-1), ['travel', 'nowhere', true]);
  // a scrub: by its time
  const sc = page.travel({ t: 1234 }); await tick(); assert.deepEqual([sent.at(-1).op, sent.at(-1).t], ['scrub', 1234]);
  assert.equal(made.filter(m => m[0] === 'travel').length, 1, 'not made before it comes back');
}
{ // every(): this machine's own, to no one
  const { page, sent, made } = make(true);
  page.every(15, 3, { anchorEvery: 25 });
  await new Promise(r => setTimeout(r, 120)); page.every(0);
  assert.ok(made.some(m => m[0] === 'mark') && made.some(m => m[0] === 'anchor'), 'it marked and anchored itself');
  assert.deepEqual(sent, [], 'and told the session nothing');
}
{ // outside a session: made here at once
  const { page, sent, made } = make(false);
  await page.mark('solo'); assert.deepEqual(made, [['mark', 'solo', false]]); assert.deepEqual(sent, []);
}
console.log('braidsession: ok');
process.exit(0);
