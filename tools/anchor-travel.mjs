#!/usr/bin/env node
// The two systems' anchors taken again on the app as it is built now, and travel between them checked:
//   node tools/anchor-travel.mjs <Windows 98 C.db> [build]
// Windows 95 from a blank disk, started twice (a95 is taken on the second start), then the Windows 98 disk (a98),
// then a98 -> a95 -> a98. After each arrival: the title, the faults, the windows, what each part of the arrival took
// (the page's console line), and whether the screen shows anything (a picture, 2 s after: its share of black pixels).
// The app is left running at a98. A moment is of the build that took it: run this after a build changes the code.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = f => fileURLToPath(new URL(f, import.meta.url));
const [disk98, build] = process.argv.slice(2);
if (!disk98) { console.error('usage: anchor-travel.mjs <Windows 98 C.db> [build]'); process.exit(2); }
const app = (...a) => execFileSync('node', [here('./app.mjs'), ...a], { encoding: 'utf8' }).trim();
const ev = x => { try { return app('eval', x); } catch (e) { return `error: ${String(e.stderr || e.message).trim().split('\n').pop()}`; } };
const SETTLE = 'new Promise(r => setTimeout(r, 14000))';
const state = '[document.title, (await win95.report(4)).faults.map(f => f.why + " in " + f.program), win95.windows().map(w => w.title)]';
const flat = s => s.replace(/\s+/g, ' ');
// (the screen's share of black: the page's own canvases drawn into one, sampled)
const black = `(() => { const c = document.createElement('canvas'), W = 160, H = 120; c.width = W; c.height = H; const g = c.getContext('2d'); for (const s of document.querySelectorAll('canvas')) { try { g.drawImage(s, 0, 0, W, H); } catch (_) {} } const d = g.getImageData(0, 0, W, H).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 24) n++; return Math.round(100 * n / (W * H)) + '% black'; })()`;
const anchor = name => flat(ev(`(async () => { await ${SETTLE}; await win95.braid.forget('${name}').catch(() => 0); await win95.braid.anchor('${name}'); return ${state}; })()`));
const travel = name => flat(ev(`(async () => { const t = performance.now(), lines = [], was = console.info; console.info = (...a) => { if (/^\\[braid\\] arrival/.test(String(a[0]))) lines.push(String(a[0])); was.apply(console, a); };
  try { await win95.braid.travel('${name}'); } finally { console.info = was; }
  const took = Math.round((performance.now() - t) / 1000); await new Promise(r => setTimeout(r, 2000)); const shown = ${black};
  await ${SETTLE}; return { took: took + ' s', shown2s: shown, shown16s: ${black}, state: ${state}, parts: lines }; })()`));
console.log('Windows 95, first start:', app('start', 'fresh', ...(build ? ['build'] : [])));
console.log('Windows 95, second start:', app('start', 'keep'));
console.log('a95:', anchor('a95'));
console.log('Windows 98:', app('start', disk98));
console.log('a98:', anchor('a98'));
for (const to of ['a95', 'a98']) console.log(`travel ${to}:`, travel(to));
