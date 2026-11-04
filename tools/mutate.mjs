#!/usr/bin/env node
// The checks falsified: each fix's bug put back (tests/mutations.json) in a copy of the tree, and the check that holds
// the fix run on it, which must fail; the same check run on the unchanged copy first, which must pass (a check that
// fails either way proves nothing). A mutation whose `from` is not found exactly once is stale: the fix moved and its
// check is no longer known to see it, which fails as well.
//
//   node tools/mutate.mjs [id ...]
//
// One line each, `MUTATE {json}` (killed, survived, stale, control-failed); the exit code is how many were not killed.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const { mutations } = JSON.parse(readFileSync(join(root, 'tests/mutations.json'), 'utf8'));
const want = process.argv.slice(2), list = want.length ? mutations.filter(m => want.includes(m.id)) : mutations;
for (const id of want) if (!mutations.some(m => m.id === id)) { console.error(`no mutation ${id}`); process.exit(64); }

// the copy: the sources and the tests, not the bundles generated from the CD (no check here reads them) nor .git
const copy = () => {
  const d = mkdtempSync(join(tmpdir(), 'w95-mutate-'));
  cpSync(root, d, { recursive: true, filter: s => {
    const rel = s.slice(root.length); if (!rel) return true;
    if (/^(\.git|\.claude|node_modules|electron|deploy|findings|\.sessions|mac)(\/|$)/.test(rel)) return false;
    return !(/^[^/]+\.(js|iso|bin)$/.test(rel) && statSync(s).size > 4 << 20);
  } });
  return d;
};
// (a failure's reason: the assertion's or error's own line, so a mutant killed by an unrelated breakage shows as such)
const reason = s => { const ls = String(s).split('\n').map(l => l.trim()).filter(Boolean); return (ls.find(l => /^(AssertionError|[A-Z]\w*Error)\b/.test(l)) || ls.find(l => /message:|^\+|^-/.test(l)) || ls[ls.length - 1] || '').slice(0, 240); };
// (the copy has no .git: its checks that ask git (tools/gitref.py's) are given this checkout's, read-only use)
const gitDir = execSync('git rev-parse --absolute-git-dir', { cwd: root, encoding: 'utf8' }).trim();
const run = (d, cmd) => { try { execSync(cmd, { cwd: d, stdio: 'pipe', timeout: 300000, env: { ...process.env, GIT_DIR: gitDir } }); return { ok: true }; } catch (e) { return { ok: false, tail: reason(`${e.stderr || ''}\n${e.stdout || ''}` || e.message) }; } };

let notKilled = 0;
const clean = copy(), controls = new Map();
try {
  for (const m of list) {
    const out = { id: m.id, fix: m.fix, file: m.file, killedBy: m.killedBy };
    const src = readFileSync(join(clean, m.file), 'utf8'), n = src.split(m.from).length - 1;
    if (n !== 1) { console.log('MUTATE ' + JSON.stringify({ ...out, result: 'stale', found: n })); notKilled++; continue; }
    // (the check passes on the tree as it is: else its failure on the mutant says nothing)
    const ctl = m.killedBy.map(c => { if (!controls.has(c)) controls.set(c, run(clean, c)); return [c, controls.get(c)]; }).filter(([, r]) => !r.ok);
    if (ctl.length) { console.log('MUTATE ' + JSON.stringify({ ...out, result: 'control-failed', failing: ctl.map(([c, r]) => `${c}: ${r.tail}`) })); notKilled++; continue; }
    writeFileSync(join(clean, m.file), src.replace(m.from, () => m.to));
    try {
      // (killed by an assertion of the check; a crash of the check (a TypeError, a missing file) is a kill by accident,
      // which says the check broke, not that it saw the bug: counted as not killed)
      const rs = m.killedBy.map(c => [c, run(clean, c)]), killers = rs.filter(([, r]) => !r.ok);
      const result = !killers.length ? 'survived' : killers.some(([, r]) => /^AssertionError/.test(r.tail)) ? 'killed' : 'killed-incidentally';
      if (result !== 'killed') notKilled++;
      console.log('MUTATE ' + JSON.stringify({ ...out, result, by: killers.map(([c, r]) => `${c}: ${r.tail}`) }));
    } finally { writeFileSync(join(clean, m.file), src); }
  }
} finally { rmSync(clean, { recursive: true, force: true }); }
process.exitCode = notKilled;
