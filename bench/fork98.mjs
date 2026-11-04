#!/usr/bin/env node
// Two builds, one moment: each case of bench/anchor98.mjs lived from the same anchored moment by a base build and by
// the build under test, the line forking at the anchor once for each, and the two outcomes compared (Braid: a moment
// of another build arrived at, forced; braid.same's record-for-record comparison of faults, by build here instead of by
// generation). What changed between the branches is what changed the outcome; a case one build passes and the other
// fails is bisected over the commits between them, each step the same anchored case, Setup never run again.
//
//   node bench/fork98.mjs [endpoint] [--base <rev>] [--head <rev>|tree] [--no-bisect] [case ...]
//
// --base: default the merge base with main. --head: default `tree`, the checkout the server serves (uncommitted edits
// included); a rev is that commit. Each build is the page loaded on the same origin (its anchors and disk are the
// origin's, IndexedDB): the tree at /, a commit at /__ref/<sha>/ (tools/gitref.py). The checks are the tree's
// (/bench/anchor98.mjs) whichever build runs, so both builds are held to the same cases. The endpoint's page is
// navigated: give it a page of its own, not one with work in it. One line per case, `FORK98 {json}`, then for a
// regression `FORK98 first-bad {json}`; the exit code is the number of cases whose outcome differs (regressed or
// changed), fixed cases not counted.
import { connect, SHELL_READY } from './runner.mjs';
import { CASES } from './anchor98.mjs';

/** a result's outcome as a comparable thing: passed, missing, or the fault it failed on (program, why, where), the
 *  fault records' own fields where the machine reported them, else the reason the check gave */
export const outcome = r => {
  if (r.ok) return 'ok';
  if (r.missing) return 'missing';
  const f = (r.faults || [])[0];
  if (f) return ['fault', f.program || f.module || '', f.why || f.code || '', f.eip !== undefined ? f.eip : f.at || ''].join('|');
  return 'fail|' + String(r.why || '').replace(/\b\d+ ?ms\b/g, '').slice(0, 200);
};

/** base against head: `same` (both the same outcome), `regressed` (base passed, head did not), `fixed` (the reverse),
 *  `changed` (both failed, differently), `missing` (either has no anchor) */
export const compare = (base, head) => {
  const a = outcome(base), b = outcome(head);
  if (a === 'missing' || b === 'missing') return 'missing';
  if (a === b) return 'same';
  if (a === 'ok') return 'regressed';
  if (b === 'ok') return 'fixed';
  return 'changed';
};

/** the first commit of `commits` (oldest first; the last known bad, the one before them good) for which `bad(commit)`
 *  holds, by halving; `bad` is asked of as few commits as that takes. Returns { first, asked } */
export const bisect = async (commits, bad) => {
  let lo = -1, hi = commits.length - 1; const asked = [];   // (lo: good, the base; hi: bad)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1; const b = await bad(commits[mid]); asked.push([commits[mid], b]);
    if (b) hi = mid; else lo = mid;
  }
  return { first: commits[hi], asked };
};

if (typeof process === 'object' && import.meta.url === `file://${process.argv[1]}`) {
  const { execFileSync } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname, git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  const args = process.argv.slice(2);
  const endpoint = args[0] && /^https?:/.test(args[0]) ? args.shift() : (process.env.W95_DEVTOOLS || 'http://127.0.0.1:9334');
  const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = k => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
  const baseRev = git('rev-parse', opt('--base', null) || git('merge-base', 'HEAD', 'main'));
  const headArg = opt('--head', 'tree'), headRev = headArg === 'tree' ? null : git('rev-parse', headArg);
  const noBisect = flag('--no-bisect');
  const names = args.length ? args : Object.keys(CASES);
  for (const n of names) if (!CASES[n]) { console.error(`no case ${n}: ${Object.keys(CASES).join(', ')}`); process.exit(64); }

  const c = await connect(endpoint);
  const here = new URL(await c.evaluate('location.href')), search = here.search || '?debug=1&mute=1&shared=0';
  const urlOf = rev => `${here.origin}/${rev ? `__ref/${rev}/` : ''}index.html${search}`;
  const ready = async () => { for (let i = 0; i < 300 && !(await c.evaluate(SHELL_READY).catch(() => false)); i++) await new Promise(r => setTimeout(r, 1000)); };
  // one build lives one case: the page loaded as that build, the case from its anchor (the tree's checks)
  const live = async (rev, n) => {
    await c.call('Page.navigate', { url: urlOf(rev) }); await new Promise(r => setTimeout(r, 2000)); await ready();
    const build = await c.evaluate('win95.braid && win95.braid.line ? (window.__BUILD__ || {}).commit || null : null').catch(() => null);
    const r = await c.evaluate(`import('/bench/anchor98.mjs').then(m => m.pageCheck(${JSON.stringify(n)}))`, CASES[n].ms + (CASES[n].hold || 0) + 120000)
      .catch(e => ({ case: n, ok: false, why: e.message }));
    return { ...r, rev: rev || 'tree', build };
  };
  let differ = 0;
  for (const n of names) {
    const base = await live(baseRev, n), head = await live(headRev, n), verdict = compare(base, head);
    console.log('FORK98 ' + JSON.stringify({ case: n, verdict, base: { rev: baseRev, outcome: outcome(base), why: base.why || null }, head: { rev: headRev || 'tree', outcome: outcome(head), why: head.why || null } }));
    if (verdict === 'regressed' || verdict === 'changed') differ++;
    if (verdict !== 'regressed' || noBisect) continue;
    // the commits between, oldest first, then the tree's edits as the last step when the head is the tree
    const commits = git('rev-list', '--reverse', '--first-parent', `${baseRev}..${headRev || 'HEAD'}`).split('\n').filter(Boolean);
    if (!headRev) commits.push(null);
    const want = outcome(head);
    const { first, asked } = await bisect(commits, async rev => outcome(await live(rev, n)) !== 'ok');
    console.log('FORK98 first-bad ' + JSON.stringify({ case: n, first: first || 'tree (uncommitted)', subject: first ? git('log', '-1', '--format=%s', first).slice(0, 200) : null, head: want,
      asked: asked.map(([r, b]) => [r || 'tree', b ? 'bad' : 'good']) }));
  }
  await c.call('Page.navigate', { url: urlOf(null) });   // (the page left as the tree's build)
  c.close();
  process.exitCode = differ;
}
