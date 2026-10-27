// Random walks of a shared session's model (model.mjs), past what the model checker explores: three machines (one
// joining late), two objects, a dozen people's actions, and the posts and deliveries in random order; then everything
// in flight is let through and every machine checked against the session. A failing walk is shrunk to the fewest
// steps that still fail and printed, to be kept as a test.
//
//    node tools/convolution/fuzz.mjs [seeds=20000] [actions=12]
import { model } from './model.mjs';

const seeds = +(process.argv[2] || 20000), actions = +(process.argv[3] || 12);
const M = model({ machines: ['A', 'B', 'C'], late: ['C'], ids: ['W', 'X'] });
const rng = seed => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

/** a walk: random moves until the people have done `actions`, then the rest let through; the steps' names */
function walk(seed) {
  const r = rng(seed), s = M.start(actions), path = [];
  for (;;) {
    let next = M.moves(s);
    if (s.budget <= 0) next = next.filter(([n]) => / (posts|gets|catches up)/.test(n));
    if (!next.length) break;
    const [name, f] = next[Math.floor(r() * next.length)]; f(s); path.push(name);
  }
  return path;
}
/** the steps replayed by name (one no longer possible passed over): the failure's message, or null */
function replay(path) {
  const s = M.start(actions), done = [];
  for (const name of path) { const m = M.moves(s).find(([n]) => n === name); if (m) { m[1](s); done.push(name); } }
  for (let more = M.moves(s).filter(([n]) => / (posts|gets|catches up)/.test(n)); more.length; more = M.moves(s).filter(([n]) => / (posts|gets|catches up)/.test(n))) { more[0][1](s); done.push(more[0][0]); }
  try { M.check(s, done); return null; } catch (e) { return e.message; }
}
function shrink(path) {
  let best = path;
  for (let i = 0; i < best.length;) { const t = [...best.slice(0, i), ...best.slice(i + 1)]; if (replay(t)) best = t; else i++; }
  return best;
}
let failed = 0;
for (let seed = 1; seed <= seeds; seed++) {
  const path = walk(seed), why = replay(path);
  if (!why) continue;
  failed++;
  const small = shrink(path);
  console.log(`seed ${seed}: the machines disagree after ${path.length} steps; shrunk to ${small.length}:\n  ${small.join('\n  ')}\n${replay(small)}\n`);
  if (failed >= 3) break;
}
console.log(failed ? `fuzz: ${failed} failing walk(s)` : `fuzz: ok (${seeds} walks of ${actions} actions)`);
process.exitCode = failed ? 1 : 0;
