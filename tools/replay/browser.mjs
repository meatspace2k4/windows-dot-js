// The replay browser: one Chrome window kept open between replays, in its own profile, under sandbox-exec with
// writes allowed only in its own directory and network only to 127.0.0.1. A replay reuses its first tab.
import { spawn } from 'node:child_process';
// resolves when `file` gains a line matching `re` (the process's own "listening" message), rejects after `ms`
const whenLogged = (file, re, ms = 20000) => new Promise((ok, no) => {
  const check = () => { const m = fs.readFileSync(file, 'utf8').match(re); if (m) { w.close(); clearTimeout(t); ok(m); return true; } };
  const w = fs.watch(file, check), t = setTimeout(() => { w.close(); no(new Error('not ready: ' + file)); }, ms);
  check();
});
import fs from 'node:fs'; import path from 'node:path';
const HERE = path.dirname(new URL(import.meta.url).pathname), DIR = path.join(HERE, 'browser'), STATE = path.join(DIR, 'state.json');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const alive = async port => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser; } catch (_) { return null; } };
export async function ensureBrowser(port = 9419) {
  fs.mkdirSync(path.join(DIR, 'profile'), { recursive: true }); fs.mkdirSync(path.join(DIR, 'tmp'), { recursive: true });
  const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
  if (st && await alive(st.port)) return st.port;
  const real = fs.realpathSync(DIR), sb = path.join(DIR, 'sandbox.sb');
  fs.writeFileSync(sb, `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "${real}") (subpath "${DIR}") (subpath "/dev") (subpath "/private/var/folders"))\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*") (literal "/private/var/run/mDNSResponder"))\n(deny signal (target others))\n`);
  const log = path.join(DIR, 'chrome.log'); fs.writeFileSync(log, '');
  const logf = fs.openSync(log, 'a');
  const p = spawn('/usr/bin/sandbox-exec', ['-f', sb, CHROME, `--user-data-dir=${path.join(DIR, 'profile')}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu-sandbox', '--disable-crash-reporter', '--disable-breakpad',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--disable-sync', '--disable-component-update', '--force-gpu-mem-available-mb=4096', '--window-size=840,640', 'about:blank'],
    { env: { ...process.env, TMPDIR: path.join(DIR, 'tmp') }, stdio: ['ignore', logf, logf], detached: true });
  p.unref();
  await whenLogged(log, /DevTools listening on ws:/);
  fs.writeFileSync(STATE, JSON.stringify({ port, pid: p.pid }));
  return port;
}

// The replay page's server: one fixed address for every run, so a new run is a same-origin reload and Chrome keeps
// showing the old frame until the new page paints. It serves browser/current, which each run points at its tree.
export async function ensureServer(port = 9420) {
  const up = async () => { try { return (await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })).status < 500; } catch (_) { return false; } };
  if (await up()) return port;
  const sb = path.join(DIR, 'server.sb');
  fs.writeFileSync(sb, `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "/dev"))\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(deny signal (target others))\n`);
  const py = (await import('node:child_process')).execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
  const log = path.join(DIR, 'server.log'); fs.writeFileSync(log, '');
  const fd = fs.openSync(log, 'a');
  const p = spawn('/usr/bin/sandbox-exec', ['-f', sb, py, '-u', '-m', 'http.server', String(port), '--bind', '127.0.0.1', '-d', path.join(DIR, 'current')], { stdio: ['ignore', fd, fd], detached: true });
  p.unref();
  await whenLogged(log, /Serving HTTP on/);
  return port;
}
// point the server at a run's tree (a symlink swapped in one rename)
export function serve(tree) {
  const link = path.join(DIR, 'current'), tmp = link + '.new';
  try { fs.unlinkSync(tmp); } catch (_) {}
  fs.symlinkSync(tree, tmp); fs.renameSync(tmp, link);
}
