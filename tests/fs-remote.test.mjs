// fs.js remote volumes (network drives and UNC shares) against an in-memory server: trying to break them
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; new Function(readFileSync(new URL('../fs.js', import.meta.url), 'utf8'))();
const { FileSystem, FSError } = window.W95FS;
// a server: a tree of { dir, data } nodes; paths relative to the share, '\\'-separated
function server() {
  const t = new Map([['', { dir: true }]]); const hs = new Map(); let n = 1;
  const key = r => r.toUpperCase(), par = r => r.split('\\').slice(0, -1).join('\\');
  const ent = (r, x) => ({ name: r.split('\\').pop(), dir: !!x.dir, size: x.dir ? 0 : x.data.length, attrs: x.dir ? 0x10 : 0x20, ctime: 1, mtime: 1, atime: 1 });
  const need = r => { const x = t.get(key(r)); if (!x) throw new FSError(2, r); return x; };
  const b = {
    stat: r => { const x = t.get(key(r)); return x ? ent(r, x) : null; },
    list: r => { need(r); const p = r ? key(r) + '\\' : ''; return [...t].filter(([k]) => k !== key(r) && k.startsWith(p) && !k.slice(p.length).includes('\\')).map(([k, x]) => ent(x.name || k, x)); },
    open: (r, f) => { let x = t.get(key(r)); if (!x) { if (!f.create) throw new FSError(2, r); if (!t.get(key(par(r)))) throw new FSError(3, r); x = { data: new Uint8Array(0), name: r }; t.set(key(r), x); } else if (x.dir) throw new FSError(5, r); if (f.trunc) x.data = new Uint8Array(0); hs.set(n, x); return n++; },
    read: (h, pos, len) => hs.get(h).data.slice(pos, pos + len),
    write: (h, pos, d) => { const x = hs.get(h); const nb = new Uint8Array(Math.max(x.data.length, pos + d.length)); nb.set(x.data); nb.set(d, pos); x.data = nb; },
    truncate: (h, len) => { const x = hs.get(h); x.data = x.data.slice(0, len); },
    size: h => hs.get(h).data.length, close: h => hs.delete(h),
    mkdir: r => { if (t.has(key(r))) throw new FSError(183, r); if (!t.get(key(par(r)))) throw new FSError(3, r); t.set(key(r), { dir: true, name: r }); },
    rmdir: r => { if (b.list(r).length) throw new FSError(145, r); t.delete(key(r)); },
    unlink: r => { need(r); t.delete(key(r)); },
    rename: (a, c) => { const x = need(a); t.delete(key(a)); x.name = c; t.set(key(c), x); },
    setAttrs: () => {}, setTime: () => {}, space: () => ({ total: 1 << 20, free: 1 << 19 }),
  };
  return b;
}
const fails = []; const T = (name, fn) => { try { fn(); } catch (e) { fails.push(name + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)); } };
const fs = new FileSystem(); fs.mount('C', { total: 1 << 24 }); fs.mount('N', { remote: server(), unc: '\\\\HOST\\HOME', label: 'HOME' });
const names = p => fs.readdir(p).map(e => e.name || e).sort();

T('write and read back a file', () => { fs.writeFile('N:\\a.txt', 'hello'); assert.equal(new TextDecoder().decode(fs.readFile('N:\\a.txt')), 'hello'); });
T('mkdir and nested file', () => { fs.mkdir('N:\\Dir'); fs.writeFile('N:\\Dir\\b.txt', 'x'); assert.deepEqual(names('N:\\Dir'), ['b.txt']); });
T('case-insensitive paths', () => { assert.equal(fs.stat('n:\\DIR\\B.TXT').size, 1); });
T('trailing backslash on a folder', () => { assert.deepEqual(names('N:\\Dir\\'), ['b.txt']); });
T('root listing', () => { assert.deepEqual(names('N:\\'), ['Dir', 'a.txt']); });
T('missing file is ENOENT 2', () => { assert.throws(() => fs.readFile('N:\\nope.txt'), e => e.code === 2); });
T('missing folder path is an error', () => { assert.throws(() => fs.writeFile('N:\\no\\x.txt', 'y'), e => e.code === 2 || e.code === 3); });
T('append', () => { const fd = fs.open('N:\\a.txt', 'a'); fs.write(fd, new TextEncoder().encode('!')); fs.close(fd); assert.equal(new TextDecoder().decode(fs.readFile('N:\\a.txt')), 'hello!'); });
T('overwrite truncates', () => { fs.writeFile('N:\\a.txt', 'hi'); assert.equal(new TextDecoder().decode(fs.readFile('N:\\a.txt')), 'hi'); });
T('rename within the share', () => { fs.rename('N:\\a.txt', 'N:\\c.txt'); assert.ok(fs.exists('N:\\c.txt')); assert.ok(!fs.exists('N:\\a.txt')); });
T('copy local to share and back', () => { fs.writeFile('C:\\l.txt', 'local'); fs.copyFile ? fs.copyFile('C:\\l.txt', 'N:\\l.txt') : fs.writeFile('N:\\l.txt', fs.readFile('C:\\l.txt')); assert.equal(new TextDecoder().decode(fs.readFile('N:\\l.txt')), 'local'); });
T('move share to local', () => { fs.rename('N:\\l.txt', 'C:\\moved.txt'); assert.equal(new TextDecoder().decode(fs.readFile('C:\\moved.txt')), 'local'); assert.ok(!fs.exists('N:\\l.txt')); });
T('rmdir non-empty fails 145', () => { assert.throws(() => fs.rmdir('N:\\Dir'), e => e.code === 145); });
T('unlink then rmdir', () => { fs.unlink('N:\\Dir\\b.txt'); fs.rmdir('N:\\Dir'); assert.ok(!fs.exists('N:\\Dir')); });
T('seek past end and write extends', () => { const fd = fs.open('N:\\s.bin', 'w+'); fs.seek(fd, 4, 0); fs.write(fd, new Uint8Array([7])); fs.close(fd); assert.equal(fs.stat('N:\\s.bin').size, 5); });
T('read a folder as a file fails', () => { fs.mkdir('N:\\F'); assert.throws(() => fs.readFile('N:\\F')); });
T('statvfs of the share', () => { const v = fs.statvfs('N:\\'); assert.ok(v.total > 0); });
T('UNC path reaches the share', () => { fs.uncBackend = unc => (unc.toUpperCase() === '\\\\HOST\\HOME' ? fs.vols.get('N').remote : null); assert.ok(fs.exists('\\\\HOST\\HOME\\c.txt')); });
T('UNC to an unknown share is not found', () => { assert.ok(!fs.exists('\\\\HOST\\NOPE\\x')); });
T('chdir into the share and relative read', () => { fs.chdir('N:\\'); assert.equal(new TextDecoder().decode(fs.readFile('c.txt')), 'hi'); fs.chdir('C:\\'); });
T('wildcard readdir', () => { assert.deepEqual(fs.readdir('N:\\', '*.txt').map(e => e.name || e).sort(), ['c.txt']); });
T('unmount closes handles', () => { const fd = fs.open('N:\\c.txt', 'r'); fs.unmount('N'); assert.throws(() => fs.read(fd)); });
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'fs-remote: all pass');
process.exit(fails.length ? 1 : 0);
