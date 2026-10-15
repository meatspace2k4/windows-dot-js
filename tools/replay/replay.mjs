#!/usr/bin/env node
// Replays the recorded interactions of one commit against that commit's code, deterministically, in a sandbox.
//
//   node replay.mjs COMMIT [--steps steps.json] [--repo ~/Win95] [--out DIR] [--cd ~/Win95-tmp-backup] [--from N] [--to N]
//
// The run gets its own directory (--out, fresh): the commit's files from `git archive`, the CD-derived files from
// prebuild.py and a static server; the page runs in the replay browser (browser.mjs), which stays open between
// runs and reloads for each one. Every process it starts runs under sandbox-exec
// with writes allowed only inside that directory and network only to 127.0.0.1. The page runs on vclock.js:
// virtual time that moves only while a step runs, seeded random, no saved state. Each step's value and every
// screenshot go to OUT/results.jsonl; two runs of one commit should match line for line.
import { spawn, execFileSync } from 'node:child_process';
import { ensureBrowser, ensureServer, serve } from './browser.mjs';
import { asyncBody } from './wrap.mjs';
import { blackShare, cropPixels } from './png.mjs';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto'; import net from 'node:net';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const commit = process.argv[2]; if (!commit || commit.startsWith('--')) { console.error('usage: replay.mjs COMMIT [...]'); process.exit(2); }
const repo = arg('--repo', path.join(os.homedir(), 'Win95')), cdRoot = arg('--cd', path.join(os.homedir(), 'Win95-tmp-backup'));
// --resume DIR: carry on a stopped run in its own directory, after the last step it recorded (the page itself starts
// fresh: its state cannot be carried over)
const RESUME = arg('--resume') && path.resolve(arg('--resume'));
const out = RESUME || path.resolve(arg('--out', path.join(HERE, 'runs', commit.slice(0, 8) + '-' + Date.now())));
if (!RESUME && fs.existsSync(out)) { console.error(`${out} exists; a run needs a fresh directory`); process.exit(2); }
const doneTo = RESUME ? Math.max(-1, ...fs.readFileSync(path.join(out, 'results.jsonl'), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l).n ?? -1; } catch (_) { return -1; } })) : -1;
const MAX_GAP = 5000, STEP_REAL_MS = 45000;   // the session's own limit on a page call (javascript_tool gave up after 45 s)
const sha = execFileSync('git', ['-C', repo, 'rev-parse', commit], { encoding: 'utf8' }).trim();
// the steps recorded while this commit was the newest one: from its date to the next commit's
const dates = execFileSync('git', ['-C', repo, 'log', '--all', '--format=%H %aI'], { encoding: 'utf8' }).trim().split('\n').map(l => l.split(' ')).map(([h, d]) => [h, new Date(d).getTime()]).sort((a, b) => a[1] - b[1]);
const at = dates.findIndex(([h]) => h === sha), from = dates[at][1];
// --until TIME: one continuous run from COMMIT to TIME, checking the tree against every commit passed on the way;
// otherwise the run covers COMMIT up to the next commit
const UNTIL = arg('--until'), to = UNTIL ? new Date(UNTIL).getTime() : at + 1 < dates.length ? dates[at + 1][1] : Infinity;
// the commits checked on the way: this repo's, or another history's (--verify-repo, e.g. a rebuilt one)
const VREPO = arg('--verify-repo', repo);
const vdates = VREPO === repo ? dates : execFileSync('git', ['-C', VREPO, 'log', '--all', '--format=%H %aI'], { encoding: 'utf8' }).trim().split('\n').map(l => l.split(' ')).map(([h, d]) => [h, new Date(d).getTime()]).sort((a, b) => a[1] - b[1]);
const passed = vdates.filter(([, d]) => d > from && d < to).map(([h, d]) => ({ kind: 'commit', sha: h, t: new Date(d).toISOString() }));
let steps = JSON.parse(fs.readFileSync(arg('--steps', path.join(HERE, 'steps.json')), 'utf8')).filter(s => { const t = new Date(s.t).getTime(); return t >= from && t < to; });
const edits = JSON.parse(fs.readFileSync(path.join(HERE, 'edits.json'), 'utf8')).filter(e => { const t = new Date(e.t).getTime(); return t >= from && t < to; }).map(e => ({ ...e, kind: 'edit' }));
// one timeline: the session's file edits and its interactions with the shell, in the order they happened
// what the history rebuild put into the tree beyond the edits (pins.json): saved copies at their times, before
// what happened at that moment, and files from steps the replay cannot run, right after those steps
const pins = JSON.parse(fs.readFileSync(path.join(HERE, 'pins.json'), 'utf8')).filter(p => { const t = new Date(p.t).getTime(); return t >= from && t < to; });
const ORDER = { pin: 0, inject: 2, commit: 3 };
steps = [...steps, ...edits, ...passed, ...pins].sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : (ORDER[a.kind] ?? 1) - (ORDER[b.kind] ?? 1));
steps = steps.slice(+arg('--from', 0), +arg('--to', steps.length));
const next = UNTIL ? null : at + 1 < dates.length ? dates[at + 1][0] : null;
fs.mkdirSync(out, { recursive: true });
if (!RESUME) for (const d of ['tree', 'tmp', 'shots', 'bin', 't']) fs.mkdirSync(path.join(out, d));
const SB = path.join(out, 'sandbox.sb');
fs.writeFileSync(SB, `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "${fs.realpathSync(out)}") (subpath "${out}") (subpath "${path.join(HERE, 'cache')}") (subpath "/dev") (subpath "/private/var/folders"))\n(deny file-read* (subpath "${os.homedir()}/.claude"))\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*") (literal "/private/var/run/mDNSResponder"))\n(deny signal (target others))\n`);
const sandboxed = (cmd, args, opts = {}) => spawn('/usr/bin/sandbox-exec', ['-f', SB, cmd, ...args], { env: { ...process.env, TMPDIR: path.join(out, 'tmp') }, ...opts });
const run = (cmd, args) => new Promise((ok, no) => { const p = sandboxed(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let s = ''; p.stdout.on('data', d => s += d); p.stderr.on('data', d => s += d); p.on('exit', c => c ? no(new Error(`${cmd} ${c}: ${s.slice(-2000)}`)) : ok(s)); });
const freePort = () => new Promise(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const log = (...a) => console.log(...a);
const results = fs.createWriteStream(path.join(out, 'results.jsonl'), { flags: RESUME ? 'a' : 'w' });
const procs = [];
const cleanup = () => { for (const p of procs) try { process.kill(-p.pid); } catch (_) { try { p.kill('SIGKILL'); } catch (_) {} } };
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));

log(`commit ${sha.slice(0, 8)}: ${steps.length} steps (${edits.length} file edits, ${pins.length} pinned or injected files) -> ${out}`);
if (!RESUME) execFileSync('/bin/sh', ['-c', `git -C "${repo}" archive ${sha} | tar -x -C "${out}/tree"`]);
fs.mkdirSync(path.join(HERE, 'cache'), { recursive: true });
const PY = execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
log(await run(PY, [path.join(HERE, 'prebuild.py'), path.join(out, 'tree'), path.join(HERE, 'cache'), cdRoot]).catch(e => e.message));

// the shell commands' PATH: regular-file wrappers around ordinary tools; python3 runs the CD build tools for real
// (cached); app control, network and process commands answer nothing
for (const c of ['bash', 'sh', 'cat', 'sed', 'cp', 'mv', 'rm', 'mkdir', 'ls', 'grep', 'head', 'tail', 'cut', 'sort', 'uniq', 'awk', 'touch', 'find', 'wc', 'tr', 'chmod', 'ln', 'basename', 'dirname', 'diff', 'xargs', 'tee', 'env', 'base64', 'stat', 'mktemp', 'perl', 'cmp', 'seq', 'printf', 'echo', 'test', 'true', 'false']) {
  let p = ''; try { p = execFileSync('/usr/bin/which', [c], { encoding: 'utf8' }).trim(); } catch (_) {}
  fs.writeFileSync(path.join(out, 'bin', c), p ? `#!/bin/sh\nexec ${p} "$@"\n` : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}
const REALPY = '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11';
fs.writeFileSync(path.join(out, 'bin', 'python3'), `#!/bin/sh\nW95_REAL_PYTHON=${REALPY} exec ${REALPY} ${path.join(HERE, 'pybuild.py')} "$@"\n`, { mode: 0o755 });
for (const c of ['node', 'npm', 'npx', 'timeout', 'sleep', 'curl', 'osascript', 'pkill', 'kill', 'pgrep', 'open', 'plutil', 'codesign', 'sips', 'iconutil', 'swiftc', 'lsof', 'ps', 'git', 'gh', 'du', 'which', 'say', 'screencapture', 'defaults', 'launchctl', 'killall', 'python', 'rsync', 'cabextract', '7z', '7zz', 'hdiutil'])
  fs.writeFileSync(path.join(out, 'bin', c), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
if (!RESUME) for (const d of fs.readdirSync(cdRoot)) {
  const sp = path.join(cdRoot, d, 'scratchpad'); if (!fs.existsSync(sp)) continue;
  const dst = path.join(out, 't', d, 'scratchpad'); fs.mkdirSync(dst, { recursive: true });
  for (const x of ['sys', 'sys95', 'scr', 'fonts', 'raw', 'tb', 'cab', 'cab2', 'infs', 'out', 'out2']) if (fs.existsSync(path.join(sp, x))) fs.cpSync(path.join(sp, x), path.join(dst, x), { recursive: true });
  if (fs.existsSync(path.join(sp, 'cab3'))) fs.symlinkSync(path.join(sp, 'cab3'), path.join(dst, 'cab3'));   // 3 GB, read only
}
serve(path.join(out, 'tree')); const httpPort = await ensureServer();
let pageScale = 1;
const MAX_INNER = [1400, 760];   // the largest page area that fits on this screen inside the window frame
const VIEW = { preview: [800, 494], electron: [640, 480] };
// the page's size: the session's pane as recorded (frame steps), from the first one on; clicks were recorded in the
// screenshot's coordinate frame and are scaled to the page
const firstFrame = steps.find(s => s.kind === 'frame');
let view = firstFrame ? [firstFrame.cw, firstFrame.ch] : VIEW.preview, frame = firstFrame ? [firstFrame.fw, firstFrame.fh] : [800, 494];
// one replay at a time drives the replay browser
const LOCK = path.join(HERE, 'browser', 'replay.lock');
try { const other = +fs.readFileSync(LOCK, 'utf8'); if (other && other !== process.pid) { try { process.kill(other, 0); console.error(`another replay (pid ${other}) is running`); process.exit(3); } catch (_) {} } } catch (_) {}
fs.mkdirSync(path.dirname(LOCK), { recursive: true }); fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { if (+fs.readFileSync(LOCK, 'utf8') === process.pid) fs.unlinkSync(LOCK); } catch (_) {} });
const cdpPort = await ensureBrowser();
// one connection to the browser; each page is a flattened session on it. `cur` is the tab steps run in.
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
let id = 0; const pend = new Map(), waiters = [];
const cur = { sid: null, targetId: null };
let started = 0, loads = 0;   // navigations a step set off, and loads finished, in the current tab
let onLoad = null; const nextLoad = () => new Promise(ok => { onLoad = ok; });
let reloadTo = null, onReload = null;   // a load the showing page started: done in a fresh window instead
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.sessionId && d.sessionId === cur.sid) {
    if (d.method === 'Page.frameStartedLoading') started++;
    if (d.method === 'Page.loadEventFired') { loads++; if (onLoad) { const f = onLoad; onLoad = null; f(); } }
    if (d.method === 'Runtime.bindingCalled' && d.params.name === '__replayReload') reloadTo = d.params.payload;
    // the showing page loading a new document (a reload or a navigation): cancel it, so this page stays on screen,
    // and load the document in a fresh window behind (openPage) instead
    if (d.method === 'Fetch.requestPaused') {
      if (d.params.resourceType === 'Document' && !d.params.frameId?.startsWith('x')) { send('Fetch.failRequest', { requestId: d.params.requestId, errorReason: 'Aborted' }, d.sessionId); reloadTo = d.params.request.url; if (onReload) { const f = onReload; onReload = null; f(); } }
      else send('Fetch.continueRequest', { requestId: d.params.requestId }, d.sessionId);
    }
  }
  for (const w of [...waiters]) w(d);
};
await new Promise(r => ws.onopen = r);
// every DevTools call has a deadline: a call that never answers (a renderer that stopped drawing) comes back as an error
const CALL_MS = 120000;
const send = (method, params = {}, sessionId) => new Promise(ok => {
  const n = ++id, t = setTimeout(() => { pend.delete(n); ok({ error: { message: `${method}: no answer in ${CALL_MS / 1000} s` }, timedOut: true }); }, method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn' ? STEP_REAL_MS + 30000 : CALL_MS);
  pend.set(n, d => { clearTimeout(t); ok(d); }); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const call = (method, params = {}) => send(method, params, cur.sid);
const event = (name, ms, sid = cur.sid) => new Promise(ok => { const t = setTimeout(() => { waiters.splice(waiters.indexOf(f), 1); ok(null); }, ms); const f = d => { if (d.method === name && d.sessionId === sid) { clearTimeout(t); waiters.splice(waiters.indexOf(f), 1); ok(d); } }; waiters.push(f); });
// the window resized by whoever is watching: the page is re-fitted to it (its own size, the recorded one, stays).
// Checked as frames come in, so it follows the window without polling.
let fitBounds = '', fitting = false;
waiters.push(async d => {
  if (d.method !== 'Page.screencastFrame' || d.sessionId !== cur.sid || fitting || !cur.targetId) return;
  fitting = true;
  try {
    const w = (await send('Browser.getWindowForTarget', { targetId: cur.targetId })).result?.windowId;
    const b = w && (await send('Browser.getWindowBounds', { windowId: w })).result?.bounds, key = b ? `${b.width}x${b.height}` : '';
    if (key && key !== fitBounds) { fitBounds = key; }   // the window is sized to the page (emulate); nothing to follow
  } finally { fitting = false; }
});
// every frame the window shows: a mostly black one is logged with the step it came during
let curStep = -1; const blank = [];
if (process.env.REPLAY_DEBUG) waiters.push(d => { if (d.method === 'Runtime.exceptionThrown') log('  EXC', d.sessionId === cur.sid ? 'cur' : 'other', (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || '').split('\n').slice(0, 4).join(' | ')); else if (d.method === 'Runtime.consoleAPICalled' && /error|warn/.test(d.params.type)) log('  CONSOLE', d.params.type, JSON.stringify(d.params.args.map(x => x.value ?? x.description)).slice(0, 400)); else if (d.method === 'Runtime.executionContextCreated' || d.method === 'Runtime.executionContextsCleared') log('  ctx', d.sessionId === cur.sid ? 'cur' : 'other', d.method, d.params.context?.origin || '', d.params.context?.auxData?.isDefault); });
if (process.env.REPLAY_DEBUG) waiters.push(d => { if (d.sessionId === cur.sid && /lifecycleEvent|frameNavigated|frameStartedLoading|screencastFrame/.test(d.method)) log('  ev', (Date.now() % 100000), d.method, d.params.name || '', d.method === 'Page.screencastFrame' ? 'frame' : ''); });
waiters.push(d => {
  if (d.method !== 'Page.screencastFrame' || d.sessionId !== cur.sid) return;
  send('Page.screencastFrameAck', { sessionId: d.params.sessionId }, d.sessionId);
  // only the page's own area: the window around a scaled page is margin
  if (Date.now() - (globalThis.__lastCheck || 0) < 250) return;   // a check at most every 250 ms
  globalThis.__lastCheck = Date.now();
  try { const b = Buffer.from(d.params.data, 'base64'), px = b.readUInt32BE(16) / (d.params.metadata.deviceWidth || b.readUInt32BE(16)), k = blackShare(b, Math.round(view[0] * pageScale * px), Math.round(view[1] * pageScale * px)); if (k > 0.5) { if (process.env.REPLAY_DEBUG) log('  BLANK', Date.now() % 100000); blank.push({ step: curStep, black: +k.toFixed(2), at: d.params.metadata.timestamp }); if (blank.length <= 5) fs.writeFileSync(path.join(out, 'shots', `blank-${blank.length}.png`), b); } } catch (_) {}
});
const VCLOCK = fs.readFileSync(path.join(HERE, 'vclock.js'), 'utf8');
// load `url` in a new background tab of the replay window; once its first frame is painted, bring it forward and
// close the tab it replaces. The window never shows a page that is still loading.
// load `url` in the run's tab. One tab for the whole run, attached once: nothing is opened, raised, focused or resized
// (the page is scaled to the window as it is). A reload or navigation stays in that tab; the page holds its last
// frame across it (vclock.js), so the window never shows an empty page.
// one page per recorded browser tab (and one for the Electron app): the first is the run's visible tab; the others
// open in the background of the same window (nothing is raised or focused) and run unseen
const pages = new Map(); let curKey = null;
async function attachPage(targetId, size = view) {
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Page.setLifecycleEventsEnabled', { enabled: true }); await S('Runtime.enable');
  await S('Network.enable'); await S('Network.setCacheDisabled', { cacheDisabled: true });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: VCLOCK });
  await S('Runtime.evaluate', { expression: 'window.__replay && __replay.freeze && __replay.freeze()' });   // a page left from before keeps its picture through the resize
  const scale = await emulate(S, targetId, size, size === view);
  await S('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 480, maxHeight: 480 });   // small frames: cheap to check
  return { sid: sessionId, targetId, scale, fit: null };
}
// a page fitted to the window for its size (the recorded pane's for the browser page, 640x480 for the Electron
// app's); done again whenever either changed since its last fit
async function fitPage(p, key) {
  const size = key === 'electron' ? VIEW.electron : view;
  const w = (await send('Browser.getWindowForTarget', { targetId: p.targetId })).result?.windowId;
  const b = w && (await send('Browser.getWindowBounds', { windowId: w })).result?.bounds;
  const want = `${size}`;
  if (p.fit !== want) { p.scale = await emulate((m, q) => send(m, q, p.sid), p.targetId, size, key !== 'electron'); p.fit = want; }
  if (p.sid === cur.sid) pageScale = p.scale;
}
async function usePage(key) {
  key = key || curKey || 'main';
  if (key === curKey && cur.sid) return;
  let p = pages.get(key);
  if (!p) {
    const first = pages.size === 0;
    const targetId = first && leftover.length ? leftover.shift() : (await send('Target.createTarget', { url: 'about:blank', background: true })).result.targetId;
    p = await attachPage(targetId, key === 'electron' ? VIEW.electron : view);
    if (first) for (const t of leftover.splice(0)) await send('Target.closeTarget', { targetId: t });
    pages.set(key, p);
    // the Electron app had the shell loaded already (its page load is not in the transcript): load it
    if (key === 'electron') {
      const nav = await send('Page.navigate', { url: ORIGIN + '/index.html' }, p.sid);
      await new Promise(ok => { const w = d => { if (d.sessionId === p.sid && d.method === 'Page.lifecycleEvent' && d.params.name === 'load') { waiters.splice(waiters.indexOf(w), 1); ok(); } }; waiters.push(w); setTimeout(ok, 60000); });
      await send('Runtime.evaluate', { expression: 'window.__replay ? __replay.ready() : true', awaitPromise: true }, p.sid);
    }
  }
  Object.assign(cur, { sid: p.sid, targetId: p.targetId }); curKey = key;
  await fitPage(p, key);
}
async function openPage(url) {
  await fillGenerated();
  await usePage(curKey);
  const S = (m, p) => send(m, p, cur.sid);
  // from a page of this origin, the page itself navigates (Chrome then keeps showing it until the new one paints);
  // otherwise DevTools does
  const here = (await S('Runtime.evaluate', { expression: 'location.origin', returnByValue: true })).result?.result?.value;
  if (here === ORIGIN) { lastLoad = null; await S('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(local(url))}` }); await waitLoad(null); }
  else { const nav = await S('Page.navigate', { url: local(url) }); await waitLoad(nav.result && nav.result.loaderId); }
  started = loads = 0; reloadTo = null;
}
// after the page's clock ran (a step, or idle time between steps): if the page started leaving (a reload, perhaps
// from a timer it set), wait for the new page's load and first frame before anything else runs in it
async function settleLoads() {
  const q = await ev('window.__replay ? __replay.leaving : true');
  if (started > loads || !q || q.value !== false) { await waitLoad(null); started = loads = 0; }
}
// the load of a navigation (by its loader, when known), then the page's first frame
let lastLoad = null; const loadWaiters = new Set();
waiters.push(d => { if (d.sessionId === cur.sid && d.method === 'Page.lifecycleEvent' && d.params.name === 'load') { lastLoad = d.params.loaderId; for (const w of [...loadWaiters]) w(d.params.loaderId); } });
async function waitLoad(loaderId) {
  // already loaded since the navigation started (lastLoad is cleared before it): nothing to wait for
  if (!(loaderId ? lastLoad === loaderId : lastLoad !== null)) await Promise.race([new Promise(ok => { const w = l => { if (!loaderId || l === loaderId) { loadWaiters.delete(w); ok(); } }; loadWaiters.add(w); }), new Promise(ok => setTimeout(ok, 60000))]);
  await send('Runtime.evaluate', { expression: 'window.__replay ? __replay.ready() : true', awaitPromise: true }, cur.sid);
}
// tabs left from earlier runs: the first new page replaces them
const leftover = (await send('Target.getTargets')).result.targetInfos.filter(t => t.type === 'page').map(t => t.targetId);
const ORIGIN = `http://127.0.0.1:${httpPort}`;
const local = s => s.replace(/https?:\/\/(localhost|127\.0\.0\.1):(8095|9334)/g, ORIGIN).replace(/file:\/\/\/Users\/johusha\/Win95(?=\/)/g, ORIGIN);   // the session's own server, or the project folder opened as a file
const ev = async (expression, repl = false) => {
  const r = await Promise.race([call('Runtime.evaluate', { expression, replMode: repl, awaitPromise: true, returnByValue: true, userGesture: true }), new Promise(ok => setTimeout(() => ok('TIMEOUT'), STEP_REAL_MS))]);
  if (r === 'TIMEOUT') { await call('Runtime.terminateExecution'); return { hang: true }; }
  if (r.error) return { error: r.error.message };
  if (r.result.exceptionDetails) return { exception: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').split('\n')[0] };
  return { value: r.result.result.value ?? (r.result.result.type === 'undefined' ? undefined : r.result.result.description) };
};
// a recorded expression: evaluated without waiting (the clock is stopped), then driven to completion by the page's
// clock, which stops when it settles
async function step(code, ms = STEP_REAL_MS) {
  const body = asyncBody(code); if (body === null) return { skipped: 'does not parse' };
  // the snippet starts and the clock drives it in one task: nothing runs between the two
  const d = await Promise.race([call('Runtime.evaluate', { expression: `window.__replay ? __replay.ready().then(() => __replay.drive((async () => {\n${body}\n})())) : (async () => {\n${body}\n})().then(v => ({ value: v }), e => ({ exception: String(e) }))`, awaitPromise: true, returnByValue: true, userGesture: true }),
    new Promise(ok => setTimeout(() => ok('TIMEOUT'), ms))]);
  if (d === 'TIMEOUT') { await call('Runtime.terminateExecution'); return { hang: true }; }
  if (d.error) return { error: d.error.message };
  if (d.result.exceptionDetails) return { exception: (d.result.exceptionDetails.exception?.description || d.result.exceptionDetails.text || '').split('\n')[0] };
  return d.result.result.value || {};
}
async function stepRepl(code) {
  const r = await call('Runtime.evaluate', { expression: code, replMode: true, awaitPromise: false, userGesture: true });
  if (r.error) return { error: r.error.message };
  if (r.result.exceptionDetails) return { exception: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').split('\n')[0] };
  const o = r.result.result;
  if (!o.objectId) return { value: o.value };
  const d = await Promise.race([call('Runtime.callFunctionOn', { objectId: o.objectId, functionDeclaration: 'function () { return window.__replay ? __replay.drive(this) : Promise.resolve(this).then(v => ({ value: v })); }', awaitPromise: true, returnByValue: true }),
    new Promise(ok => setTimeout(() => ok('TIMEOUT'), STEP_REAL_MS))]);
  if (d === 'TIMEOUT') { await call('Runtime.terminateExecution'); return { hang: true }; }
  if (d.error) return { error: d.error.message };
  if (d.result.exceptionDetails) return { exception: (d.result.exceptionDetails.exception?.description || '').split('\n')[0] };
  return d.result.result.value || {};
}
const clock = fn => fn();
const advance = ms => ev(`window.__replay ? __replay.advance(${ms}) : 0`);
// a screenshot is the next frame Chrome draws for the window (no separate capture, which re-renders the page and
// flickers); its hash covers the page's own area, leaving out the progress overlay (it shows real time)
let lastFrame = null, frameTick = null;
waiters.push(d => { if (d.method === 'Page.screencastFrame' && d.sessionId === cur.sid) { lastFrame = d; if (frameTick) frameTick(); } });
// the frame showing now: frames still arriving are older paints catching up, so wait until 150 ms pass without one
// (no frame at all within 1.5 s, as when the window is covered or nothing changes: null, and the caller captures)
const settledFrame = () => new Promise(ok => {
  let t, got = false; lastFrame = null;
  const quiet = () => { got = true; clearTimeout(t); t = setTimeout(() => { frameTick = null; ok(lastFrame); }, 150); };
  frameTick = quiet; setTimeout(() => { if (!got) { frameTick = null; ok(null); } }, 1500);
});
const shot = async n => {
  const o = (await ev("(r => r && [r.left, r.top, r.right, r.bottom])(document.getElementById('__replay_status')?.getBoundingClientRect())")).value;
  await ev("(e => e && (e.style.outlineOffset = e.style.outlineOffset === '1px' ? '0px' : '1px'))(document.getElementById('__replay_status'))");   // a change, so Chrome draws a frame
  let d = await settledFrame();
  if (!d) { const r = await call('Page.captureScreenshot', { format: 'png' }); if (!r.result) return 'none: ' + (r.error?.message || 'no frame'); d = { params: { data: r.result.data, metadata: { deviceWidth: 0 } } }; }
  const b = Buffer.from(d.params.data, 'base64'), px = b.readUInt32BE(16) / (d.params.metadata.deviceWidth || b.readUInt32BE(16)), k = pageScale * px;
  fs.writeFileSync(path.join(out, 'shots', `${String(n).padStart(4, '0')}.png`), b);
  const mask = o && o.map((v, i) => Math.round(v * k) + (i < 2 ? -2 : 2));
  return crypto.createHash('sha256').update(cropPixels(b, Math.round(view[0] * k), Math.round(view[1] * k), mask)).digest('hex').slice(0, 16);
};
const mouse = (type, [x, y], button = 'left', clickCount = 1, modifiers = 0) => call('Input.dispatchMouseEvent', { type, x: x * pageScale, y: y * pageScale, button, clickCount, modifiers });
// a US keyboard: printable characters with their key code, DOM code and shift; named keys
const US = {}; { const rows = [['`~', 'Backquote', 192], ['1!', 'Digit1', 49], ['2@', 'Digit2', 50], ['3#', 'Digit3', 51], ['4$', 'Digit4', 52], ['5%', 'Digit5', 53], ['6^', 'Digit6', 54], ['7&', 'Digit7', 55], ['8*', 'Digit8', 56], ['9(', 'Digit9', 57], ['0)', 'Digit0', 48], ['-_', 'Minus', 189], ['=+', 'Equal', 187], ['[{', 'BracketLeft', 219], [']}', 'BracketRight', 221], ['\\|', 'Backslash', 220], [';:', 'Semicolon', 186], ["'\"", 'Quote', 222], [',<', 'Comma', 188], ['.>', 'Period', 190], ['/?', 'Slash', 191], [' ', 'Space', 32]];
  for (const [ch, code, vk] of rows) { US[ch[0]] = { code, vk, shift: false }; if (ch[1]) US[ch[1]] = { code, vk, shift: true }; }
  for (let c = 65; c <= 90; c++) { const l = String.fromCharCode(c); US[l.toLowerCase()] = { code: 'Key' + l, vk: c, shift: false }; US[l] = { code: 'Key' + l, vk: c, shift: true }; } }
const KEYS = { Return: ['Enter', 13], Enter: ['Enter', 13], Escape: ['Escape', 27], esc: ['Escape', 27], Tab: ['Tab', 9], BackSpace: ['Backspace', 8], Backspace: ['Backspace', 8], Delete: ['Delete', 46], Up: ['ArrowUp', 38], Down: ['ArrowDown', 40], Left: ['ArrowLeft', 37], Right: ['ArrowRight', 39], space: [' ', 32], F1: ['F1', 112], F3: ['F3', 114], F4: ['F4', 115], F5: ['F5', 116], F10: ['F10', 121], F12: ['F12', 123], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Next: ['PageDown', 34], Prior: ['PageUp', 33] };
const MOD = { alt: 1, ctrl: 2, cmd: 4, meta: 4, shift: 8 };
async function key(combo) {
  const parts = combo.length > 1 ? combo.split('+') : [combo], k = parts.pop() || '+';
  let mods = parts.reduce((m, p) => m | (MOD[p.toLowerCase()] || 0), 0);
  const u = k.length === 1 ? US[k] : null;
  const [keyName, vk] = KEYS[k] || (u ? [k, u.vk] : [k, 0]);
  if (u && u.shift) mods |= 8;
  const text = u && !(mods & 6) ? k : k === 'Return' || k === 'Enter' ? '\r' : undefined;
  const code = u ? u.code : (KEYS[k] ? KEYS[k][0] : k);
  await call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods, text, unmodifiedText: text });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
}
async function input(s, n) {
  const scale = c => c && [Math.round(c[0] * view[0] / frame[0]), Math.round(c[1] * view[1] / frame[1])];   // recorded in the screenshot's frame
  const mods = (s.modifiers || '').split('+').reduce((m, p) => m | (MOD[p] || 0), 0);
  switch (s.action) {
    case 'screenshot': return { shot: await shot(n) };
    case 'left_click': case 'right_click': case 'double_click': case 'triple_click': {
      const c = scale(s.coordinate); if (!c) return { skipped: 'click by ref' };
      const b = s.action === 'right_click' ? 'right' : 'left', k = { double_click: 2, triple_click: 3 }[s.action] || 1;
      await mouse('mouseMoved', c); for (let i = 1; i <= k; i++) { await mouse('mousePressed', c, b, i, mods); await mouse('mouseReleased', c, b, i, mods); } return {};
    }
    case 'hover': { const c = scale(s.coordinate); if (c) await mouse('mouseMoved', c); return {}; }
    case 'left_click_drag': { const a = scale(s.start_coordinate), b = scale(s.coordinate); await mouse('mouseMoved', a); await mouse('mousePressed', a); for (let i = 1; i <= 8; i++) await mouse('mouseMoved', [a[0] + (b[0] - a[0]) * i / 8, a[1] + (b[1] - a[1]) * i / 8], 'left'); await mouse('mouseReleased', b); return {}; }
    case 'scroll': { const c = scale(s.coordinate) || [view[0] / 2, view[1] / 2], d = (s.scroll_amount || 3) * 100, dir = s.scroll_direction; await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c[0] * pageScale, y: c[1] * pageScale, deltaX: dir === 'left' ? -d : dir === 'right' ? d : 0, deltaY: dir === 'up' ? -d : dir === 'down' ? d : 0 }); return {}; }
    case 'type': for (const ch of s.text || '') await key(ch === '\n' ? 'Return' : ch); return {};
    case 'key': for (let r = 0; r < (s.repeat || 1); r++) for (const c of (s.text || '').split(' ')) if (c) await key(c); return {};
    case 'wait': await advance(Math.round((s.duration || 1) * 1000)); return {};   // the recorded wait, in the page's time
  }
  return { skipped: s.action };
}
const navigate = url => openPage(url);
if (!RESUME) await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'indexeddb,local_storage,cache_storage,service_workers' });   // a fresh disk and registry for the run
curKey = 'preview';
await navigate(ORIGIN + '/index.html');
let prevT = steps.length ? new Date(steps[Math.min(doneTo + 1, steps.length - 1)].t).getTime() : 0;
if (RESUME) log(`resuming after step ${doneTo}`);
const T0 = Date.now(), describe = s => s.kind === 'edit' ? `edit ${s.name}${s.input.file_path ? ' ' + path.basename(s.input.file_path) : ''}` : s.kind === 'input' ? `input ${s.action}` : s.kind === 'eval' ? `eval ${(s.code || '').replace(/\s+/g, ' ').slice(0, 70)}` : s.kind;
for (let n = doneTo + 1; n < steps.length; n++) {
  const s = steps[n], t = new Date(s.t).getTime(); curStep = n; lastLoad = null;   // a load from here on belongs to this step
  // the browser pane's tabs share the visible page (the session moved between them in turn); the Electron app is a page of its own
  if (['eval', 'input', 'navigate', 'history', 'node', 'bench-steps', 'viewport'].includes(s.kind)) await usePage(s.target === 'electron' ? 'electron' : 'preview');
  await ev(`try { sessionStorage.setItem('__replayEpoch', '${t}') } catch (_) {}`);   // a page loading during this step starts its clock at the recorded time
  { const sec = Math.round((Date.now() - T0) / 1000);
    await ev(`window.__replay && __replay.status(${JSON.stringify(`replay ${sha.slice(0, 7)}  step ${n + 1}/${steps.length}  ${Math.round(100 * (n + 1) / steps.length)}%\nrecorded ${s.t.slice(11, 19)}Z   running ${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s\n${describe(s)}`)})`); }
  if (s.kind === 'commit') { verify(s.sha); continue; }
  if (s.kind === 'pin' && (s.missing || !fs.existsSync(s.from))) { results.write(JSON.stringify({ n, kind: 'pin-missing', t: s.t, rel: s.rel }) + '\n'); continue; }   // a saved copy Claude Code has since pruned
  if (s.kind === 'pin' || s.kind === 'inject') {
    const dst = path.join(out, 'tree', s.rel); fs.mkdirSync(path.dirname(dst), { recursive: true });
    const b = s.kind === 'pin' ? fs.readFileSync(s.from) : execFileSync('git', ['-C', repo, 'show', `${s.commit}:${s.rel}`]);
    if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(b)) { fs.writeFileSync(dst, b); results.write(JSON.stringify({ n, kind: s.kind, t: s.t, rel: s.rel }) + '\n'); }
    continue;
  }
  // the page runs on between recorded interactions; a file edit is not one (stretches with no shell use go straight through)
  if (n && s.kind !== 'frame') { lastLoad = null; await advance(Math.min(s.kind === 'edit' ? 1000 : MAX_GAP, Math.max(0, t - prevT))); await settleLoads(); lastLoad = null; }   // between file edits the page idles: 1 s at most   // the page ran on between the recorded steps
  prevT = t;
  let r;
  try {
    if (s.kind === 'eval' && process.env.REPLAY_DEBUG) log('  before', n, cur.targetId.slice(0, 6), JSON.stringify((await ev('JSON.stringify([document.readyState, typeof win95, typeof W95Win32, window.__replay && __replay.now, window.__replay && __replay.pending])')).value));
    // a call that hung in the session (the page spun until javascript_tool gave up): the same hang, compressed like a long pause
    if (s.kind === 'eval') r = await step(local(s.code), /timed out after \d+s/.test(s.recorded || '') ? MAX_GAP : STEP_REAL_MS);
    else if (s.kind === 'input') { await ev('window.__replay && __replay.allow(1)'); try { r = await input(s, n); } finally { await ev('window.__replay && __replay.allow(0)'); } if (s.action !== 'wait' && s.action !== 'screenshot') await advance(8); }   // the pane ran batched actions a few ms apart (less than a frame)
    else if (s.kind === 'navigate') { await navigate(s.url); r = {}; }
    else if (s.kind === 'history') { await ev(`history.${s.go}()`); await event('Page.loadEventFired', 30000); r = {}; }
    else if (s.kind === 'viewport') { view = s.preset === 'mobile' ? [375, 812] : s.preset === 'tablet' ? [768, 1024] : s.width ? [s.width, s.height] : VIEW.preview; await resizeLive(view); r = {}; }
    else if (s.kind === 'frame') {
      frame = [s.fw, s.fh];
      if (Math.abs(s.cw - view[0]) > 3 || Math.abs(s.ch - view[1]) > 3) {
        view = [s.cw, s.ch]; const pv = pages.get('preview');
        if (pv) { const back = curKey; await usePage('preview'); await resizeLive(view); if (back !== 'preview') await usePage(back); }
        r = { view };
      } else r = {};
    }
    else if (s.kind === 'edit') r = await applyEdit(s);
    else if ((s.kind === 'node' || s.kind === 'bench-steps') && !process.env.REPLAY_NODE_STEPS) r = { skipped: 'benchmark/crawl script against the Electron app: measures real time, reloads and waits in real time' };
    else if (s.kind === 'node' || s.kind === 'bench-steps') { await ev('window.__replay && (__replay.free = __replay.drive(new Promise(ok => __replay.stopFree = ok)))'); try { r = await nodeStep(s); } finally { await ev('window.__replay && __replay.stopFree && __replay.stopFree()'); } }
    else r = { skipped: s.kind };
  } catch (e) { r = { error: String(e.message || e) }; }
  if (r && (r.hang || /no answer in/.test(r.error || ''))) { log(`  step ${n} did not finish: reloading the page`); try { await openPage(ORIGIN + '/index.html'); } catch (e) { log('  reload failed: ' + e.message); } }
  // a step that reloaded or navigated the page: wait for the new page to load before going on. The page says
  // so itself (DevTools may not have reported the navigation yet); a page that no longer answers is leaving too
  // a reload the step asked for happens in a fresh tab that replaces this one once it has painted
  await settleLoads();   // the step reloaded or navigated the page: wait for the new page
  started = loads = 0;
  const line = { n, t: s.t, kind: s.kind, action: s.action, vnow: (await ev('window.__replay ? __replay.now : null')).value, ...r };
  results.write(JSON.stringify(line) + '\n');
  log(`${String(n).padStart(4)} ${s.kind}${s.action ? ':' + s.action : ''} ${JSON.stringify(r).slice(0, 140)}`);
}
// the run's tree against a commit's files (what git keeps; the CD-derived files are not compared)
function verify(c) {
  const want = path.join(out, 'commits', c.slice(0, 8)); fs.mkdirSync(want, { recursive: true });
  execFileSync('/bin/sh', ['-c', `git -C "${VREPO}" archive ${c} | tar -x -C "${want}"`]);
  const files = execFileSync('/bin/sh', ['-c', `cd "${want}" && find . -type f | sort`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const differ = files.filter(f => { const a = path.join(out, 'tree', f); return !fs.existsSync(a) || !fs.readFileSync(a).equals(fs.readFileSync(path.join(want, f))); });
  const v = { kind: 'verify', commit: c.slice(0, 8), files: files.length, differ };
  results.write(JSON.stringify(v) + '\n'); log(`tree vs commit ${c.slice(0, 8)}: ${differ.length ? differ.length + ' of ' + files.length + ' differ: ' + differ.slice(0, 8).join(' ') : 'identical'}`);
  return v;
}
// CD-derived files the page loads that the tree does not have yet: built with the tree's own tools (cached)
function fillGenerated() { return run(PY, [path.join(HERE, 'prebuild.py'), path.join(out, 'tree'), path.join(HERE, 'cache'), cdRoot]).then(o => o.trim() && log(o.trim().replace(/\n/g, '; ')), e => log('prebuild: ' + e.message.slice(0, 300))); }
// the page's viewport at the recorded pane size, whatever the window's: drawn scaled down when it does not fit
// (the window is then sized to the scaled page, so nothing else shows around it); input is dispatched in the
// window's coordinates, so clicks are multiplied by the same scale (pageScale)
async function emulate(S, targetId, [w, h], sizeWindow = true) {
  // the page at the recorded size, scaled to the largest size that fits on screen; the window is sized to exactly
  // that (from where it is: it is not moved, raised or focused), so the page fills it with no margins
  const scale = +Math.min(1, MAX_INNER[0] / w, MAX_INNER[1] / h).toFixed(3);   // Chrome shrinks the view but does not enlarge it
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false, scale });
  const windowId = (await send('Browser.getWindowForTarget', { targetId })).result?.windowId;
  if (windowId && sizeWindow) {
    const { result: { bounds: b } } = await send('Browser.getWindowBounds', { windowId });
    const chrome = [0, 88];   // the window frame around the page: tab strip and toolbar
    const want = { width: Math.round(w * scale) + chrome[0], height: Math.round(h * scale) + chrome[1] };
    if (b.windowState !== 'normal') await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    if (b.width !== want.width || b.height !== want.height) await send('Browser.setWindowBounds', { windowId, bounds: want });
  }
  return scale;
}
// the session's pane was resized here: so is the page; wait for its resize event, then let it draw one frame
async function resizeLive(v) {
  const resized = ev('new Promise(ok => addEventListener("resize", ok, { once: true }))');
  const p = pages.get(curKey); if (p) { p.fit = null; await fitPage(p, curKey); } else pageScale = await emulate(call, cur.targetId, v);
  await Promise.race([resized, new Promise(ok => setTimeout(ok, 2000))]);
  await advance(17);
}
// one recorded file mutation, applied to this run's tree inside the sandbox
function applyEdit(e) {
  return new Promise(ok => {
    const p = sandboxed(PY, [path.join(HERE, 'edits.py'), out], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: path.join(out, 'tmp'), W95_REPLAY_CACHE: path.join(HERE, 'cache') } });
    let so = '', se = ''; p.stdout.on('data', d => so += d); p.stderr.on('data', d => se += d);
    p.on('exit', c => { try { ok(JSON.parse(so.trim().split('\n').pop())); } catch (_) { ok({ error: `edits.py ${c}: ${se.slice(-300)}` }); } });
    p.stdin.end(JSON.stringify({ name: e.name, input: e.input, sess: e.sess, reset: e.reset }));
  });
}
// a bench or crawl script from this commit's tree, pointed at this run's browser
async function nodeStep(s) {
  const tree = path.join(out, 'tree');
  if (s.kind === 'bench-steps') {
    const src = `import { PRELUDE, STEPS } from '${tree}/bench/steps.mjs'; import { connect } from '${tree}/bench/runner.mjs';
      const c = await connect('http://127.0.0.1:${cdpPort}'); for (const s of STEPS.filter(s => ${JSON.stringify(s.names)}.includes(s.name))) console.log(JSON.stringify(await c.evaluate('(async () => { ' + PRELUDE + '\\n return await (' + s.run.toString() + ')(); })()'))); c.close();`;
    fs.writeFileSync(path.join(out, 'tmp', 'one.mjs'), src);
    return { stdout: (await run(process.execPath, [path.join(out, 'tmp', 'one.mjs')])).slice(-4000) };
  }
  const script = path.join(tree, s.script); if (!fs.existsSync(script)) return { skipped: 'no ' + s.script + ' in this commit' };
  return { stdout: (await run(process.execPath, [script, `http://127.0.0.1:${cdpPort}`, ...s.args.filter(a => !/^https?:/.test(a))])).slice(-4000) };
}
results.write(JSON.stringify({ kind: 'blank-frames', count: blank.length, frames: blank.slice(0, 50) }) + '\n');
log(`blank frames: ${blank.length}${blank.length ? ' (steps ' + [...new Set(blank.map(b => b.step))].join(', ') + ')' : ''}`);
if (next) verify(next);
await ev('window.__replay && __replay.release()');
results.end(); ws.close();
// the browser and the server stay up, showing where the run ended
log(`done: ${path.join(out, 'results.jsonl')}`);
process.exit(0);
