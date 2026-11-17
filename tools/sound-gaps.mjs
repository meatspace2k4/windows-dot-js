#!/usr/bin/env node
// The machine's sound as the page's output gets it, over a start of the machine: reloads the app's page, records each
// batch of samples as it arrives (and each time a stream ran dry), and after `seconds` (default 40) prints, per
// stream, the samples' length against the wall time they came over, the gaps between batches over 120 ms, and the
// times the output ran dry.   node tools/sound-gaps.mjs [seconds]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const app = fileURLToPath(new URL('./app.mjs', import.meta.url));
const ev = x => { try { return execFileSync('node', [app, 'eval', x], { encoding: 'utf8' }).trim(); } catch (e) { return ''; } };
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const HOOK = `(() => { if (!window.W95Sound) return 'no'; if (window.__snd) return 'hooked';
  const log = window.__snd = [], play = W95Sound.play;
  W95Sound.play = (k, rate, L, R) => { const r = play(k, rate, L, R); log.push([Math.round(performance.now()), rate, L.length]);
    for (const a of (k.audioOuts || new Map()).values()) if (a.node && !a.__h) { a.__h = 1; a.node.port.addEventListener('message', () => log.push([Math.round(performance.now()), rate, 'dry'])); }
    return r; };
  return 'hooked'; })()`;
ev('(location.reload(), 1)');
for (let i = 0; i < 200 && ev(HOOK) !== 'hooked'; i++) await sleep(100);
await sleep(1000 * (Number(process.argv[2]) || 40));
const log = JSON.parse(ev('JSON.stringify(window.__snd || [])') || '[]');
const rates = [...new Set(log.map(e => e[1]))];
for (const rate of rates) {
  const b = log.filter(e => e[1] === rate && e[2] !== 'dry'), dry = log.filter(e => e[1] === rate && e[2] === 'dry').map(e => e[0] - b[0][0]);
  const n = b.reduce((s, e) => s + e[2], 0), gaps = [];
  for (let i = 1; i < b.length; i++) if (b[i][0] - b[i - 1][0] > 120) gaps.push(`${b[i][0] - b[i - 1][0]} ms at ${b[i - 1][0] - b[0][0]}`);
  console.log(`${rate} Hz: ${(n / rate).toFixed(2)} s of sound in ${b.length} batches over ${((b[b.length - 1][0] - b[0][0]) / 1000).toFixed(2)} s; gaps: ${gaps.join(', ') || 'none'}; ran dry at: ${dry.join(', ') || 'never'}`);
}
if (!rates.length) console.log('no sound');
