#!/usr/bin/env node
// Runs a recorded replay's steps with capture on and lists what went wrong during each step:
// page exceptions, console errors and warnings, keys nothing handled, menu items and buttons that do nothing,
// error and warning boxes, and guest programs that stopped with a reason.
//
//   node bench/gaps.mjs bench/replay-<stamp>.mjs [endpoint]
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [replayPath, endpoint = 'http://127.0.0.1:9334'] = process.argv.slice(2);
if (!replayPath) { console.error('usage: gaps.mjs <replay script> [endpoint]'); process.exit(2); }

// the replay's own steps and runner, without the part that runs them
const src = readFileSync(resolve(replayPath), 'utf8');
const body = src.slice(0, src.indexOf('// ---- replay')) + '\nexport { PRELUDE, STEPS, RECORDED, connect, runAll };\n';
const mod = join(mkdtempSync(join(tmpdir(), 'w95gaps-')), 'replay.mjs');
writeFileSync(mod, body.replace(/^#!.*\n/, ''));
const { PRELUDE, STEPS, connect, runAll } = await import(pathToFileURL(mod).href);

// a second connection that only listens
const cap = await connect(endpoint);
let step = 'setup';
const found = [];
const add = (kind, detail) => found.push({ step, kind, detail });
cap.onEvent = d => {
  if (d.method === 'Runtime.exceptionThrown') add('exception', d.params.exceptionDetails.exception?.description?.split('\n').slice(0, 2).join(' ') || d.params.exceptionDetails.text);
  else if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning'))
    add('console.' + d.params.type, d.params.args.map(a => a.value ?? a.description ?? '').join(' ').split('\n')[0]);
  else if (d.method === 'Runtime.bindingCalled' && d.params.name === '__w95event') {
    const e = JSON.parse(d.params.payload);
    if (e.type === 'key.unhandled') add('key unhandled', `${e.key} in ${e.target}`);
    else if (e.type === 'menu.noop') add('menu item does nothing', e.label);
    else if (e.type === 'button.noop') add('button does nothing', e.label);
    else if (e.type === 'program.exit' && e.why) add('program failed', `${e.path}: ${e.why}`);
    else if (e.type === 'window.open' && e.message && /error|warning/.test(e.message.type || '')) add(`${e.message.type} box`, `${e.title}: ${e.message.text.replace(/\s+/g, ' ')}`);
  }
};
await cap.call('Runtime.enable');
await cap.call('Runtime.addBinding', { name: '__w95event' });

await runAll(endpoint, PRELUDE, STEPS, m => { step = m.replace(/ \.\.\.$/, ''); process.stderr.write(m + '\n'); });
await new Promise(r => setTimeout(r, 500));
cap.close();

// the same finding repeated in a step counts once, with how many times
const groups = new Map();
for (const f of found) { const k = `${f.step}\u0000${f.kind}\u0000${f.detail}`; groups.set(k, { ...f, n: (groups.get(k)?.n || 0) + 1 }); }
if (!groups.size) console.log('nothing went wrong');
for (const g of groups.values()) console.log(`${g.step}\t${g.kind}\t${g.detail}${g.n > 1 ? `\t(x${g.n})` : ''}`);
