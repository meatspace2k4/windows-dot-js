// A session exported from the Electron app's store (electron/store.js: File > Export Session) is the store as it was
// when exported, even while it is open and written after; check() accepts it and refuses a file that is not one;
// opened as a store, it has the same C: and registry (File > Import Session).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const st = require('../electron/store.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w95session-'));
const f = n => path.join(dir, n);

const a = st.open(f('A.db'));
a.apply('node', [{ sid: 1, parent: 0, name: 'AUTOEXEC.BAT', short: 'AUTOEXEC.BAT', dir: false, ord: 1, attrs: 0, ctime: 1, mtime: 1, atime: 1 }]);
a.apply('data', [1, 0, Buffer.from('@ECHO OFF\r\n')]);
a.apply('reg', [{ op: 'set', path: 'hkcu\\software\\claude\\code', name: 'sessions', value: { type: 1, data: new Uint8Array([91, 93, 0]) } }]);
a.exportTo(f('out.w95session'));
a.apply('data', [1, 0, Buffer.from('CHANGED AFTER EXPORT')]);

assert.equal(st.check(f('out.w95session')), null);
fs.writeFileSync(f('junk.w95session'), 'not a session');
assert.match(st.check(f('junk.w95session')), /no node table|not a Windows 95 session/);
const empty = st.open(f('empty.db')); empty.close();
assert.match(st.check(f('empty.db')), /empty/);

fs.copyFileSync(f('out.w95session'), f('B.db'));
const b = st.open(f('B.db'));
assert.equal(Buffer.from(b.loadDisk().nodes[0].data).toString(), '@ECHO OFF\r\n', 'the file as it was when exported');
assert.deepEqual(b.loadRegistry().map(k => [k[0], k[1].map(v => v[0])]), [['hkcu\\software\\claude\\code', ['sessions']]]);
// the page's side (session-file.js, sql.js there; node:sqlite here, through the same interface): the app's file read
// as rows, and rows written as a file the app opens
const W = require('../session-file.js');
const { DatabaseSync } = require('node:sqlite');
const adapt = d => ({ exec: s => d.exec(s), run: (s, p) => d.prepare(s).run(...p), all: s => d.prepare(s).all() });
const fromApp = new DatabaseSync(f('out.w95session'), { readOnly: true });
assert.equal(W.check(adapt(fromApp)), null);
const rows = W.read(adapt(fromApp)); fromApp.close();
assert.equal(rows.node[0].name, 'AUTOEXEC.BAT'); assert.equal(rows.node[0].dir, false);
assert.equal(Buffer.from(rows.chunk[0].bytes).toString(), '@ECHO OFF\r\n');
assert.deepEqual(rows.regval[0].value.type, 1); assert.deepEqual([...rows.regval[0].value.data], [91, 93, 0]);
const fromPage = new DatabaseSync(f('page.w95session')); W.write(adapt(fromPage), rows); fromPage.close();
assert.equal(st.check(f('page.w95session')), null, 'the app accepts the page\'s file');
const c = st.open(f('page.w95session'));
assert.equal(Buffer.from(c.loadDisk().nodes[0].data).toString(), '@ECHO OFF\r\n');
const val = c.loadRegistry()[0][1][0][1];   // (the app's own v8.deserialize reads the page's encoding)
assert.equal(val.type, 1); assert.deepEqual([...val.data], [91, 93, 0]);
assert.match(W.check(adapt(new DatabaseSync(':memory:'))), /no node table/);

a.close(); b.close(); c.close();
console.log('sessionfile: ok');
