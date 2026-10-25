// deploy/win95/deploy.sh: a signed build stamps the page's build-* tags and every script URL with <ver>+<sha>, refuses
// a wrong commit, a malformed version and an unaffirmed --prod; win95_server.py serves the dev tree to its DEV_HOST
// only, answers byte ranges, keeps assets out of the browser's cache, and has no /__share
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sh = join(root, 'deploy/win95/deploy.sh');
const run = (args, env = {}) => spawnSync('bash', [sh, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
const head = execFileSync('git', ['-C', root, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();

// refusals: nothing is built or shipped
let r = run(['--build-only', '--commit', '0000000', '--version', '0-01']);
assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /does not match the checkout's HEAD/);
r = run(['--build-only', '--commit', head, '--version', '1-1']);
assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /must be <MAJOR>-<M><I>/);
if (existsSync(join(root, 'deploy/win95/deploy.config'))) {
  r = run(['--prod', '--commit', head, '--version', '0-01'], { W95_ALLOW_PROD: '' });
  assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /W95_ALLOW_PROD is not 1/);
}

// a signed build
r = run(['--build-only', '--commit', head, '--version', '0-01']);
assert.equal(r.status, 0, r.stdout + r.stderr);
const sig = `0-01+${head}`, cb = `?v=${sig}`, site = join(root, 'deploy/win95/.staging/site');
const page = readFileSync(join(site, 'index.html'), 'utf8');
const tag = n => page.match(new RegExp(`<meta name="build-${n}" content="([^"]*)" />`))[1];
assert.equal(tag('channel'), 'dev'); assert.equal(tag('sig'), sig); assert.equal(tag('version'), '0.0.1'); assert.equal(tag('commit'), head);
const srcs = [...page.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
assert.ok(srcs.length > 10 && srcs.every(s => s.endsWith(cb)), srcs.join(' '));
assert.ok(page.includes(`register('sw.js${cb}')`));
assert.ok(readFileSync(join(site, 'win95.js'), 'utf8').includes(`new Worker('worker.js${cb}')`));
const imports = readFileSync(join(site, 'worker.js'), 'utf8').split('\n').find(l => l.startsWith('importScripts('));
assert.ok([...imports.matchAll(/'([^']+)'/g)].every(m => m[1].endsWith(cb)), imports);
assert.ok(readFileSync(join(site, 'sw.js'), 'utf8').includes(`const CACHE = 'win95-${sig}';`));
for (const f of ['system.js', 'cdrom.iso', 'icons/icon192.png', 'manifest.webmanifest']) assert.ok(existsSync(join(site, f)), f);
// the working tree is untouched by the stamps
assert.ok(readFileSync(join(root, 'index.html'), 'utf8').includes('<meta name="build-sig" content="local" />'));
assert.ok(readFileSync(join(root, 'win95.js'), 'utf8').includes("new Worker('worker.js')"));

// the server: prod and dev trees beside each other, as on the Pi
const base = mkdtempSync(join(tmpdir(), 'w95deploy-'));
const inst = join(base, 'win95'), dev = join(base, 'win95-dev');
mkdirSync(join(inst, 'site'), { recursive: true }); mkdirSync(join(dev, 'site'), { recursive: true });
writeFileSync(join(inst, 'win95_server.py'), readFileSync(join(root, 'deploy/win95/win95_server.py')));
writeFileSync(join(inst, 'site/index.html'), '<meta name="build-channel" content="prod" />');
writeFileSync(join(inst, 'site/a.js'), '0123456789');
writeFileSync(join(dev, 'site/index.html'), '<meta name="build-channel" content="dev" />');
const port = 20000 + Math.floor(Math.random() * 20000);
const srv = spawn('python3', [join(inst, 'win95_server.py'), '--port', String(port)], { stdio: 'ignore' });
// node's fetch sets Host itself; http.request sends the one given, as the edge does
const once = (path, host, init) => new Promise((res, rej) => {
  const q = request({ host: '127.0.0.1', port, path, method: init.method || 'GET', headers: { Host: host, ...(init.headers || {}) } }, r => {
    let b = ''; r.setEncoding('latin1'); r.on('data', d => { b += d; });
    r.on('end', () => res({ status: r.statusCode, headers: { get: k => r.headers[k] ?? null }, text: async () => b }));
  });
  q.on('error', rej); q.end(init.body);
});
const get = async (path, host, init = {}) => {
  for (let i = 0; ; i++) {
    try { return await once(path, host, init); }
    catch (e) { if (i > 50) throw e; await new Promise(res => setTimeout(res, 100)); }
  }
};
try {
  let x = await get('/', 'win95.funstuff.app');
  assert.match(await x.text(), /content="prod"/);
  assert.equal(x.headers.get('cache-control'), 'public, no-cache, s-maxage=60');
  assert.equal(x.headers.get('cross-origin-embedder-policy'), 'require-corp');
  x = await get('/', 'win95-dev.funstuff.app');
  assert.match(await x.text(), /content="dev"/);
  x = await get('/a.js?v=1', 'win95.funstuff.app', { headers: { Range: 'bytes=2-4' } });
  assert.equal(x.status, 206); assert.equal(await x.text(), '234');
  assert.equal(x.headers.get('cache-control'), 'no-store, max-age=0');
  x = await get('/../win95_server.py', 'win95.funstuff.app');
  assert.equal(x.status, 404); await x.text();
  x = await get('/__share', 'win95.funstuff.app', { method: 'POST', body: '{"op":"$list"}' });
  assert.equal(x.status, 405); await x.text();
} finally { srv.kill(); }
console.log('deploy: ok');
