// bench/fork98.mjs: two builds' outcomes of one anchored case compared (same, regressed, fixed, changed, missing), a
// fault compared by its record (program, why, where) not by its wording or its time, and the first bad commit found by
// halving, asking as few commits as that takes
import assert from 'node:assert/strict';
const { outcome, compare, bisect } = await import('../bench/fork98.mjs');

const ok = { ok: true }, miss = { ok: false, missing: true };
const fault = (eip, why = 'page fault') => ({ ok: false, why: `fault after ${Math.random() * 1000 | 0} ms`, faults: [{ program: 'EXPLORER', why, eip }] });
assert.equal(compare(ok, ok), 'same');
assert.equal(compare(ok, fault(0x1234)), 'regressed');
assert.equal(compare(fault(0x1234), ok), 'fixed');
assert.equal(compare(fault(0x1234), fault(0x1234)), 'same', 'the same fault record, whatever the message or time');
assert.equal(compare(fault(0x1234), fault(0x5678)), 'changed');
assert.equal(compare(miss, ok), 'missing'); assert.equal(compare(ok, miss), 'missing');
assert.equal(compare({ ok: false, why: 'no screen in 600000 ms' }, { ok: false, why: 'no screen in 600000 ms' }), 'same');
assert.equal(outcome({ ok: false, why: 'held 120000 ms' }), outcome({ ok: false, why: 'held 5 ms' }));

// the first bad of eight commits (the fifth), asked of three
const commits = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], firstBad = 4;
let asked = 0;
const r = await bisect(commits, async c => { asked++; return commits.indexOf(c) >= firstBad; });
assert.equal(r.first, 'e'); assert.equal(asked, 3); assert.equal(r.asked.length, 3);
// every position, including the first commit and the last (the tree), and one commit alone
for (let k = 0; k < commits.length; k++) assert.equal((await bisect(commits, async c => commits.indexOf(c) >= k)).first, commits[k]);
assert.deepEqual(await bisect(['only'], async () => { throw new Error('nothing to ask'); }), { first: 'only', asked: [] });
assert.equal((await bisect(['x', null], async c => c === null)).first, null, 'the tree\'s edits as the last step');
console.log('fork98: ok');
