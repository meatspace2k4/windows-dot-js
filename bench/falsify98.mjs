#!/usr/bin/env node
// The anchored checks falsified: each mutation of tests/mutations.json that names a case is made a commit (the fix's
// bug back in HEAD, tools/mutant.py, refs/mutants/<id>), and bench/fork98.mjs lives that case on HEAD and on the
// mutant from the same anchored moment. The case must regress on the mutant; a case that passes both, or fails both
// alike, cannot see the bug it stands for, and the check is not falsifiable.
//
//   node bench/falsify98.mjs [endpoint] [id ...]
//
// One line each, `FALSIFY98 {json}`; the exit code is how many mutants the anchored cases did not catch.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const endpoint = args[0] && /^https?:/.test(args[0]) ? args.shift() : (process.env.W95_DEVTOOLS || 'http://127.0.0.1:9334');
const all = JSON.parse(readFileSync(root + 'tests/mutations.json', 'utf8')).mutations.filter(m => m.case);
const list = args.length ? all.filter(m => args.includes(m.id)) : all;
for (const id of args) if (!all.some(m => m.id === id)) { console.error(`no mutation with a case: ${id}`); process.exit(64); }

let missed = 0;
for (const m of list) {
  const out = { id: m.id, fix: m.fix, case: m.case };
  let commit;
  try { commit = execFileSync('python3', ['tools/mutant.py', m.id], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { console.log('FALSIFY98 ' + JSON.stringify({ ...out, result: 'stale', why: String(e.stderr || e.message).trim() })); missed++; continue; }
  const r = spawnSync('node', ['bench/fork98.mjs', endpoint, '--base', 'HEAD', '--head', commit, '--no-bisect', m.case], { cwd: root, encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('FORK98 {'));
  const f = line ? JSON.parse(line.slice(7)) : null;
  const result = !f ? 'error' : f.verdict === 'regressed' ? 'caught' : f.verdict === 'missing' ? 'missing' : 'not-caught';
  if (result !== 'caught') missed++;
  console.log('FALSIFY98 ' + JSON.stringify({ ...out, mutant: commit, result, verdict: f && f.verdict, base: f && f.base, head: f && f.head, error: f ? undefined : (r.stderr || '').trim().split('\n').pop() }));
}
process.exitCode = missed;
