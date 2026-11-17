#!/usr/bin/env node
// The Windows 95 app (electron/Windows 95.app) from a shell: quit it, choose its disk, build it, start it, and answer
// once the desktop is up.
//   node tools/app.mjs start [keep|fresh|<file>] [build]   keep: the disk as it is; fresh: no disk (a new Windows 95);
//                                                          <file>: a copy of that C.db. build: electron/build.sh first
//   node tools/app.mjs quit
//   node tools/app.mjs save <file>                         quit, and copy the disk to <file>
//   node tools/app.mjs eval '<expression>'                 a win95 API expression in the app's page, awaited
// The app's debugger is at 127.0.0.1:9334 (tools/devtools-mcp.mjs finds it there).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'electron', 'Windows 95.app');
const DATA = join(homedir(), 'Library', 'Application Support', 'local.win95');
const DISK = join(DATA, 'C.db');
const CDP = 'http://127.0.0.1:9334';
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const running = () => spawnSync('pgrep', ['-f', 'Windows 95.app/Contents/MacOS/Electron']).status === 0;

async function quit() {
  if (!running()) return;
  spawnSync('osascript', ['-e', 'tell application id "local.win95" to quit']);
  for (let i = 0; i < 60 && running(); i++) await sleep(500);
  if (running()) throw new Error('the app did not quit');
}
const clearDisk = () => { for (const s of ['', '-wal', '-shm']) rmSync(DISK + s, { force: true }); };

/** an expression in the app's page, awaited; null while the page is not there yet */
async function evaluate(expression, ms = 30000) {
  const pages = await fetch(`${CDP}/json`).then(r => r.json()).catch(() => []);
  const page = pages.find(p => p.type === 'page' && /\/app\/web\/index\.html/.test(p.url));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('the page\'s debugger did not open')); });
    const r = await new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms);
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(t); ok(m); } };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true } }));
    });
    if (r.error) throw new Error(r.error.message);
    if (r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text).split('\n')[0]);
    return r.result.result.value;
  } finally { ws.close(); }
}

async function start(disk = 'keep', build) {
  await quit();
  if (disk === 'fresh') clearDisk();
  else if (disk !== 'keep') { if (!existsSync(disk)) throw new Error(`no disk at ${disk}`); clearDisk(); copyFileSync(disk, DISK); }
  if (build) execFileSync('sh', ['build.sh'], { cwd: join(ROOT, 'electron'), stdio: ['ignore', 'ignore', 'inherit'] });
  execFileSync('open', ['-n', APP]);
  const t0 = Date.now();
  for (;;) {
    const up = await evaluate('typeof win95 === "object" && !!win95.sysApp && !!win95.window("Program Manager") && document.title').catch(() => null);
    if (up) return `desktop after ${Math.round((Date.now() - t0) / 1000)} s: ${up}`;
    if (Date.now() - t0 > 300000) throw new Error('no desktop in 300 s');
    await sleep(1000);
  }
}

const [verb, a, b] = process.argv.slice(2);
// (the answer is written whole before the process ends: a pipe takes a long one in pieces)
const out = [], console = { log: t => out.push(t), error: t => process.stderr.write(t + '\n') };
try {
  if (verb === 'start') console.log(await start(a === 'build' ? 'keep' : a, a === 'build' || b === 'build'));
  else if (verb === 'quit') { await quit(); console.log('quit'); }
  else if (verb === 'save') { if (!a) throw new Error('save <file>'); await quit(); copyFileSync(DISK, a); console.log(`the disk is at ${a}`); }
  else if (verb === 'eval') { const r = await evaluate(a, 600000);console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1)); }
  else { console.error('usage: app.mjs start [keep|fresh|<file>] [build] | quit | save <file> | eval <expression>'); process.exit(2); }
  process.stdout.write(out.join('\n') + '\n', () => process.exit(0));
} catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
