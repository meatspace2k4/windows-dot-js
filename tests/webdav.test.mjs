// The app's shares as the Mac sees them (electron/webdav.js): a folder's listing and a file's bytes (whole and by
// range) over WebDAV; every method that would change a file refused, the file as it was; no path outside the share
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { serve } = createRequire(import.meta.url)('../electron/webdav.js');
const dir = mkdtempSync(join(tmpdir(), 'w95dav-'));
const root = join(dir, 'root'); mkdirSync(join(root, 'sub dir'), { recursive: true }); writeFileSync(join(root, 'a.txt'), 'hello world'); writeFileSync(join(dir, 'outside.txt'), 'out');
const server = serve(() => [{ name: 'CLAUDE', path: root, home: false }], 0);
await new Promise(ok => server.on('listening', ok));
const base = `http://127.0.0.1:${server.address().port}`, q = (method, p, headers = {}, body) => fetch(base + p, { method, headers, body });
try {
  { const r = await q('OPTIONS', '/CLAUDE/'); assert.equal(r.headers.get('dav'), '1', 'class 1: no locks, so macOS connects it read-only'); }
  { const r = await q('PROPFIND', '/', { Depth: '1' }), t = await r.text(); assert.equal(r.status, 207); assert.match(t, /<D:href>\/CLAUDE\/<\/D:href>/); }
  { const r = await q('PROPFIND', '/CLAUDE/', { Depth: '1' }), t = await r.text(); assert.equal(r.status, 207);
    assert.match(t, /<D:href>\/CLAUDE\/a\.txt<\/D:href>.*?<D:getcontentlength>11</s); assert.match(t, /<D:href>\/CLAUDE\/sub%20dir\/<\/D:href>.*?<D:collection\/>/s); }
  { const r = await q('PROPFIND', '/CLAUDE/a.txt', { Depth: '0' }); assert.equal(r.status, 207); }
  assert.equal(await (await q('GET', '/CLAUDE/a.txt')).text(), 'hello world');
  { const r = await q('GET', '/CLAUDE/a.txt', { Range: 'bytes=6-' }); assert.equal(r.status, 206); assert.equal(await r.text(), 'world'); assert.equal(r.headers.get('content-range'), 'bytes 6-10/11'); }
  { const r = await q('HEAD', '/CLAUDE/a.txt'); assert.equal(r.headers.get('content-length'), '11'); }
  assert.equal((await q('GET', '/CLAUDE/none.txt')).status, 404); assert.equal((await q('GET', '/OTHER/a.txt')).status, 404);
  assert.equal((await q('GET', '/CLAUDE/%2e%2e/outside.txt')).status, 404, 'no path outside the share');
  // nothing changes a file
  for (const [m, p, h, b] of [['PUT', '/CLAUDE/a.txt', {}, 'X'], ['PUT', '/CLAUDE/new.txt', {}, 'X'], ['DELETE', '/CLAUDE/a.txt'], ['MKCOL', '/CLAUDE/d'], ['MOVE', '/CLAUDE/a.txt', { Destination: base + '/CLAUDE/b.txt' }],
    ['COPY', '/CLAUDE/a.txt', { Destination: base + '/CLAUDE/b.txt' }], ['PROPPATCH', '/CLAUDE/a.txt', {}, '<x/>'], ['LOCK', '/CLAUDE/a.txt', {}, '<x/>'], ['POST', '/CLAUDE/a.txt', {}, 'X']])
    assert.equal((await q(m, p, h, b)).status, 403, m);
  assert.deepEqual(readdirSync(root).sort(), ['a.txt', 'sub dir']); assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'hello world');
} finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
console.log('webdav: ok');
