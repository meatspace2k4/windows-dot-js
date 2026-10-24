#!/usr/bin/env node
// Runs a recorded replay's steps with capture on and lists what went wrong during each step:
// page exceptions, console errors and warnings, keys nothing handled, menu items and buttons that do nothing,
// error and warning boxes, and guest programs that stopped with a reason.
//
//   node bench/gaps.mjs bench/replay-<stamp>.mjs [endpoint] [--skip step,step]
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2), skipAt = args.indexOf('--skip');
const skip = skipAt >= 0 ? args.splice(skipAt, 2)[1].split(',') : [];
const [replayPath, endpoint = 'http://127.0.0.1:9334'] = args;
if (!replayPath) { console.error('usage: gaps.mjs <replay script> [endpoint]'); process.exit(2); }

// the replay's own steps and runner, without the part that runs them
const src = readFileSync(resolve(replayPath), 'utf8');
const body = src.slice(0, src.indexOf('// ---- replay')) + '\nexport { PRELUDE, STEPS, runAll };\n';
const mod = join(mkdtempSync(join(tmpdir(), 'w95gaps-')), 'replay.mjs');
writeFileSync(mod, body.replace(/^#!.*\n/, ''));
const { PRELUDE, STEPS, runAll } = await import(pathToFileURL(mod).href);
const { connect, capture } = await import('./runner.mjs');

// a second connection that only listens
const cap = await connect(endpoint);
let step = 'setup';
const found = [];
const seen = new Map();   // how many shell events arrived per step, so an empty result can be told from a deaf one
await capture(cap, (kind, detail) => found.push({ step, kind, detail }), () => seen.set(step, (seen.get(step) || 0) + 1));

await runAll(endpoint, PRELUDE, STEPS.filter(s => !skip.includes(s.name)), m => { step = m.replace(/ \.\.\.$/, ''); process.stderr.write(m + '\n'); });
await new Promise(r => setTimeout(r, 500));
cap.close();

// the same finding repeated in a step counts once, with how many times
const groups = new Map();
for (const f of found) { const k = `${f.step}\u0000${f.kind}\u0000${f.detail}`; groups.set(k, { ...f, n: (groups.get(k)?.n || 0) + 1 }); }
console.log('shell events seen: ' + [...seen].map(([k, n]) => `${k} ${n}`).join(', '));
if (!groups.size) console.log('nothing went wrong');
for (const g of groups.values()) console.log(`${g.step}\t${g.kind}\t${g.detail}${g.n > 1 ? `\t(x${g.n})` : ''}`);
