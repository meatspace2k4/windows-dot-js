#!/usr/bin/env node
// A session file (.w95session, session-file.js's tables) made from a folder that is a PC's C: as it was on its own
// disk: a Windows 3.1 installation kept as a folder (its C:\ root: WINDOWS, its programs, WIN.BAT). Each file and folder
// a node under the root, its name as the folder has it and its 8.3 name as FAT gives one (the name itself when it is one,
// else NAME~1), the attributes a copied file has (archive), its times; its bytes in 64 KB chunks; the volume's label and
// serial. Windows 3.1's registry, its registration database (WINDOWS\REG.DAT, SHCC3.10), is the session's
// HKEY_CLASSES_ROOT. With --under, the tree is a folder of C: (as C:\WIN31), for a session imported into another one's C:.
//
//   node tools/build_session.mjs FOLDER OUT.w95session [--label NAME] [--under PATH]
import { readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'session-file.js'));
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const label = (opt('--label') || '').toUpperCase().slice(0, 11), under = opt('--under');
const [src, out] = args;
if (!src || !out) { console.error('usage: node tools/build_session.mjs FOLDER OUT.w95session [--label NAME] [--under PATH]'); process.exit(2); }

const CHUNK = 65536, rows = { node: [], chunk: [], volume: [], regkey: [], regval: [] };
let sid = 0, ord = 1;
// (fs.js's names: an 8.3 name as it is; another's alias from its letters, ~n the first free)
const SFN_OK = /^[A-Z0-9!#$%&'()\-@^_`{}~\x80-\xff]+$/, SFN_BAD = /[^A-Z0-9!#$%&'()\-@^_`{}~\x80-\xff]/g;
const is83 = n => { const m = /^([^.]{1,8})(?:\.([^.]{1,3}))?$/.exec(n); return !!m && SFN_OK.test(m[1]) && (!m[2] || SFN_OK.test(m[2])); };
const shortFor = (taken, name) => {
  const up = name.toUpperCase(); if (is83(up) && !taken.has(up)) return up;
  const dot = up.lastIndexOf('.'), base = (dot > 0 ? up.slice(0, dot) : up).replace(/[ .]/g, '').replace(SFN_BAD, '_') || '_';
  const ext = dot > 0 ? up.slice(dot + 1).replace(/ /g, '').replace(SFN_BAD, '_').slice(0, 3) : '';
  for (let i = 1; ; i++) { const t = '~' + i, s = base.slice(0, 8 - t.length) + t + (ext ? '.' + ext : ''); if (!taken.has(s)) return s; }
};
const node = (parent, name, short, dir, t) => { const s = sid++; rows.node.push({ sid: s, parent, name, short, dir, ord: parent < 0 ? 0 : ord++, attrs: dir ? 0x10 : 0x20, ctime: t, mtime: t, atime: t, size: 0 }); return s; };
const root = node(-1, '', '', true, Date.now());
let top = root;
if (under) for (const seg of under.replace(/^[A-Za-z]:\\?/, '').split('\\').filter(Boolean)) top = node(top, seg, shortFor(new Set(), seg), true, Date.now());
const walk = (dir, parent) => {
  const taken = new Set();
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;   // (the host's own: macOS's .DS_Store, not the PC's)
    const p = join(dir, e.name), st = statSync(p), short = shortFor(taken, e.name); taken.add(short);
    if (e.isDirectory()) { walk(p, node(parent, e.name, short, true, st.mtimeMs)); continue; }
    const s = node(parent, e.name, short, false, st.mtimeMs), data = readFileSync(p);
    rows.node[rows.node.length - 1].size = data.length;
    for (let i = 0; i * CHUNK < data.length; i++) rows.chunk.push({ sid: s, idx: i, bytes: new Uint8Array(data.subarray(i * CHUNK, (i + 1) * CHUNK)) });
  }
};
walk(src, top);
rows.volume.push({ k: 'label', v: label }, { k: 'serial', v: (Math.random() * 0xffffffff) >>> 0 });

// REG.DAT: a header (SHCC3.10; the table's offset and count, the text's offset), a table of 8-byte entries, each a
// directory entry (sibling, child, key, value) or a key's or value's text (its length and offset in the text part)
const reg = (() => { try { return readFileSync(join(src, 'WINDOWS', 'REG.DAT')); } catch (_) { return null; } })();
if (reg && reg.toString('latin1', 0, 8) === 'SHCC3.10') {
  const u16 = o => reg.readUInt16LE(o), u32 = o => reg.readUInt32LE(o), tab = u32(8), count = u32(16), text = u32(20);
  const ent = i => tab + 8 * i, str = i => { if (!i || i >= count) return null; const e = ent(i); return reg.toString('latin1', text + u16(e + 6), text + u16(e + 6) + u16(e + 4)); };
  const keys = new Map();
  const visit = (i, path, depth) => {
    for (let n = 0; i && i < count && n < 10000; n++) {
      const e = ent(i), sib = u16(e), child = u16(e + 2), name = str(u16(e + 4)), value = str(u16(e + 6));
      const p = name === null ? path : `${path}\\${name}`;
      if (name !== null) {
        keys.set(p.toLowerCase(), name);
        if (value !== null) rows.regval.push({ path: p.toLowerCase(), name: '', value: { type: 1, data: new Uint8Array([...Buffer.from(value, 'latin1'), 0]) } });
      }
      if (child && depth < 64) visit(child, p, depth + 1);
      i = sib;
    }
  };
  visit(u16(ent(0) + 2), 'hkcr', 0);
  rows.regkey.push({ path: 'hkcr' });
  for (const [p, n] of keys) { const parts = p.split('\\'); for (let k = 2; k < parts.length; k++) { const q = parts.slice(0, k).join('\\'); if (!keys.has(q)) keys.set(q, null); } }
  for (const [p, n] of [...keys].sort()) rows.regkey.push(n && n !== p.slice(p.lastIndexOf('\\') + 1) ? { path: p, name: n } : { path: p });
}
if (!rows.regkey.length) rows.regkey.push({ path: 'hkcr' });

rmSync(out, { force: true });
const db = new DatabaseSync(out);
W.write({ exec: s => db.exec(s), run: (s, p) => db.prepare(s).run(...p), all: s => db.prepare(s).all() }, rows);
db.close();
console.log(`${out}: ${rows.node.length - 1} files and folders, ${rows.chunk.length} chunks, ${rows.regkey.length} keys`);
