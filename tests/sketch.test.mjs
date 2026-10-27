// tools/sketch.mjs, the parts with no page: a path's commands tokenised, its curves flattened within a flatness (a
// cubic, a quadratic, an arc, relative commands, Z back to the start), and a polyline resampled a step apart with
// its corners kept
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis;
new Function(readFileSync(new URL('../tools/sketch.mjs', import.meta.url), 'utf8'))();
const S = globalThis.W95Sketch;

assert.deepEqual(S.tokens('M10,20 l-5.5 3e1Z'), ['M', 10, 20, 'l', -5.5, 30, 'Z']);
const line = S.flatten('M0,0 L10,0 10,10');
assert.deepEqual(line, [[[0, 0], [10, 0], [10, 10]]]);
// a cubic from (0,0) to (30,0) bulging to y=15: many points, all on or near the curve, ending at its end
const [cub] = S.flatten('M0,0 C10,20 20,20 30,0', 0.05);
assert.ok(cub.length > 10 && cub[cub.length - 1][0] === 30 && cub[cub.length - 1][1] === 0, cub.length);
assert.ok(Math.max(...cub.map(p => p[1])) > 14 && Math.max(...cub.map(p => p[1])) <= 15.01, 'the curve reaches its bulge');
// relative commands and a closed subpath: back to its start; a second subpath after Z
const polys = S.flatten('m5,5 h10 v10 z m20,0 l1,1');
assert.deepEqual(polys[0], [[5, 5], [15, 5], [15, 15], [5, 5]]);
assert.deepEqual(polys[1], [[25, 5], [26, 6]]);
// an arc: a half circle of radius 10 from (0,0) to (20,0) passes near (10,10) or (10,-10)
const [arc] = S.flatten('M0,0 A10,10 0 0 1 20,0', 0.05);
assert.ok(arc.some(p => Math.abs(p[0] - 10) < 1 && Math.abs(Math.abs(p[1]) - 10) < 0.5), 'the arc reaches its middle');
// a quadratic
const [q] = S.flatten('M0,0 Q10,10 20,0', 0.05);
assert.ok(q.length > 4 && Math.abs(Math.max(...q.map(p => p[1])) - 5) < 0.3, 'the quadratic peaks at 5');
// resampling: points a step apart along a long segment, the corner of an L kept, the end kept
const r = S.resample([[0, 0], [30, 0], [30, 30]], 10);
assert.deepEqual(r.map(p => p.map(Math.round)), [[0, 0], [10, 0], [20, 0], [30, 0], [30, 10], [30, 20], [30, 30]]);
const r2 = S.resample([[0, 0], [7, 0]], 3);
assert.deepEqual(r2.map(p => p.map(Math.round)), [[0, 0], [3, 0], [6, 0], [7, 0]]);
console.log('sketch: ok');
