#!/usr/bin/env node
// Benchmarks the whole shell in a running instance and records the run as a replay script.
//
//   node bench/bench.mjs [endpoint]     endpoint: a DevTools address, default the app's http://127.0.0.1:9334
//
// Writes bench/results/<stamp>.json and bench/replay-<stamp>.mjs. The replay script is self-contained: it carries
// the steps, the runner and this run's results, and `node bench/replay-<stamp>.mjs [endpoint]` runs the same steps
// again and prints each metric beside the recorded one.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRELUDE, STEPS } from './steps.mjs';
import { runAll, table, print, replaySource } from './runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const endpoint = process.argv[2] || 'http://127.0.0.1:9334';

const run = await runAll(endpoint, PRELUDE, STEPS, m => process.stderr.write(m + '\n'));
print(table(run.results));

const stamp = run.at.replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', `${stamp}.json`), JSON.stringify(run, null, 2) + '\n');

// the replay: steps as source, the runner's code without its exports, the recorded run as the baseline
const replay = replaySource({
  title: `Replay of the Windows 95 shell benchmark recorded ${run.at}\n// on ${run.env.browser} (${run.env.screen.width}x${run.env.screen.height}, ${run.env.store ? 'persistent store' : 'no store'}).`,
  usage: `bench/replay-${stamp}.mjs`, prelude: PRELUDE, steps: STEPS, recorded: run, runnerSrc: readFileSync(join(here, 'runner.mjs'), 'utf8'),
});
const out = join(here, `replay-${stamp}.mjs`);
writeFileSync(out, replay, { mode: 0o755 });
process.stderr.write(`\nresults: bench/results/${stamp}.json\nreplay:  bench/replay-${stamp}.mjs\n`);
