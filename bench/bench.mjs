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
import { runAll, table, print } from './runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const endpoint = process.argv[2] || 'http://127.0.0.1:9334';

const run = await runAll(endpoint, PRELUDE, STEPS, m => process.stderr.write(m + '\n'));
print(table(run.results));

const stamp = run.at.replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', `${stamp}.json`), JSON.stringify(run, null, 2) + '\n');

// the replay: steps as source, the runner's code without its exports, the recorded run as the baseline
const runner = readFileSync(join(here, 'runner.mjs'), 'utf8').replace(/^export /gm, '');
const steps = STEPS.map(s => `  { name: ${JSON.stringify(s.name)}, about: ${JSON.stringify(s.about)},\n    run: ${s.run.toString()} },`).join('\n');
const replay = `#!/usr/bin/env node
// Replay of the Windows 95 shell benchmark recorded ${run.at}
// on ${run.env.browser} (${run.env.screen.width}x${run.env.screen.height}, ${run.env.store ? 'persistent store' : 'no store'}).
//
//   node ${`bench/replay-${stamp}.mjs`} [endpoint]     default http://127.0.0.1:9334 (the app's control port)
//
// Runs the recorded steps against a running shell and prints each metric next to the value recorded here.
// --record prints this run's results as JSON instead.

const PRELUDE = ${JSON.stringify(PRELUDE)};

const STEPS = [
${steps}
];

const RECORDED = ${JSON.stringify(run, null, 2)};

// ---- runner (bench/runner.mjs)
${runner}
// ---- replay
const endpoint = process.argv.slice(2).find(a => !a.startsWith('--')) || 'http://127.0.0.1:9334';
const now = await runAll(endpoint, PRELUDE, STEPS, m => process.stderr.write(m + '\\n'));
if (process.argv.includes('--record')) console.log(JSON.stringify(now, null, 2));
else { console.log(\`recorded \${RECORDED.at} on \${RECORDED.env.browser}; now \${now.at} on \${now.env.browser}\\n\`); print(table(now.results, RECORDED.results)); }
`;
const out = join(here, `replay-${stamp}.mjs`);
writeFileSync(out, replay, { mode: 0o755 });
process.stderr.write(`\nresults: bench/results/${stamp}.json\nreplay:  bench/replay-${stamp}.mjs\n`);
