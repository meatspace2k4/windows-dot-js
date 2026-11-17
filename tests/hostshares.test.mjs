// The app's shares (electron/shares.js): with no list, ~/Documents/Claude alone, as CLAUDE; a share is read-only (every
// operation that would change the Mac's files refused, the files left as they were, shown read-only, no free space)
// unless its entry says "writable": true; no path leads outside the share
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
const { open } = createRequire(import.meta.url)('../electron/shares.js');
const dir = mkdtempSync(join(tmpdir(), 'w95shares-'));
try {
  assert.deepEqual(open(join(dir, 'none.json')).all(), [{ name: 'CLAUDE', path: join(homedir(), 'Documents', 'Claude') }], 'the share with no list');
  const root = join(dir, 'root'); mkdirSync(join(root, 'sub'), { recursive: true }); writeFileSync(join(root, 'a.txt'), 'hello'); writeFileSync(join(dir, 'outside.txt'), 'out');
  writeFileSync(join(dir, 'list.json'), JSON.stringify([{ name: 'RO', path: root }, { name: 'RW', path: root, writable: true }]));
  writeFileSync(join(dir, 'gone.json'), JSON.stringify([{ name: 'GONE', path: join(dir, 'nowhere') }]));
  let told = 0; const S = open(join(dir, 'list.json'), () => { told++; });
  // a share is served once its folder has been read, which is not as the list opens: until then, nothing of it
  assert.deepEqual(S.list(), []); assert.deepEqual(S.op('RO', 'list', ''), { err: 'ENOENT' });
  await S.probed; assert.equal(told, 2, 'the page told as each joins');
  { const G = open(join(dir, 'gone.json')); await G.probed; assert.deepEqual(G.list(), [], 'a folder that cannot be read is no share'); }
  assert.deepEqual(S.list().map(s => [s.name, s.readonly]), [['RO', true], ['RW', false]]);
  // reading
  assert.equal(Buffer.from(S.op('RO', 'read', 'a.txt', 0, 100).ok).toString(), 'hello');
  assert.deepEqual(S.op('RO', 'list', '').ok.map(e => [e.name, e.readonly]).sort(), [['a.txt', true], ['sub', true]]);
  assert.equal(S.op('RO', 'stat', 'a.txt').ok.readonly, true); assert.equal(S.op('RO', 'space', '').ok.free, 0);
  assert.equal(S.op('RO', 'read', '..\\outside.txt', 0, 10).err, 'EACCES', 'no path outside the share');
  // every change refused, and nothing changed
  const tries = [['write', 'a.txt', 0, new Uint8Array([88])], ['truncate', 'a.txt', 0], ['create', 'new.txt', false], ['create', 'a.txt', false], ['mkdir', 'dir'], ['rmdir', 'sub'],
    ['unlink', 'a.txt'], ['rename', 'a.txt', 'b.txt'], ['times', 'a.txt', 0]];
  for (const [op, ...a] of tries) assert.deepEqual(S.op('RO', op, ...a), { err: 'EACCES' }, op);
  assert.deepEqual(readdirSync(root).sort(), ['a.txt', 'sub']); assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'hello');
  // a share its entry marks writable takes them
  assert.equal(S.op('RW', 'stat', 'a.txt').ok.readonly, false);
  assert.deepEqual(S.op('RW', 'write', 'a.txt', 0, new Uint8Array([72])), { ok: undefined }); assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'Hello');
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('hostshares: ok');
