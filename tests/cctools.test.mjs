// Claude Code's file tools in the Claude program (ccd.js FILES): Read, Write, Edit, Glob and Grep on the C: drive's real
// file system (fs.js), answering as Claude Code's do: a file is Read before it is written or edited, paths not absolute
// are the session's folder's, globs ignore case, Grep's three output modes
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

globalThis.window = globalThis; new Function(readFileSync(new URL('../fs.js', import.meta.url), 'utf8'))();
const fs = new window.W95FS.FileSystem(); fs.mount('C', { total: 1 << 24, kind: 'fixed' });
fs.mkdir('C:\\WINDOWS'); fs.mkdir('C:\\WINDOWS\\SYSTEM'); fs.mkdir('C:\\WORK');
fs.writeFile('C:\\WINDOWS\\WIN.INI', '[windows]\r\nload=\r\nrun=\r\n'); fs.writeFile('C:\\WINDOWS\\SYSTEM.INI', '[boot]\r\nshell=Explorer.exe\r\n');
fs.writeFile('C:\\WINDOWS\\SYSTEM\\VGA.DRV', 'MZ\0\0binary'); fs.writeFile('C:\\WORK\\NOTES.TXT', 'one\r\ntwo\r\nthree\r\n');
fs.writeFile('C:\\AUTOEXEC.BAT', '@ECHO OFF\r\n');

const reg = new Map(), boxes = [];
const ctx = { window: { W95FS: window.W95FS } };
vm.runInNewContext(readFileSync(new URL('../ccd.js', import.meta.url), 'utf8'), ctx);
const ui = {
  W95Win32: { regGet: (k, n) => reg.get(`${k}|${n}`), regSet: (k, n, v) => reg.set(`${k}|${n}`, v) }, fs,
  emit: () => {}, dirty: () => {}, on: () => {}, windows: () => [], screen: () => ({ width: 640, height: 480 }), gfx: {}, icon: 'app', popup: () => {},
  msgBox: (title, msg, type, buttons, cb) => { boxes.push(msg); setTimeout(() => cb('Yes')); return {}; }, closeWin: () => {}, activate: () => {},   // (the user allows each write)
  DialogBody: class {}, Win: class {}, openWin: w => w, dialog: () => ({}),
};
const ccd = ctx.window.W95Ccd(ui);
const call = (name, args) => ccd.callAs(null, name, args);
const rejects = (p, re) => assert.rejects(p, e => re.test(e.message), String(re));

for (const n of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) assert.ok(ccd.toolDefs().some(d => d.name === n), n);
assert.ok(!ccd.toolDefs().some(d => d.name.startsWith('files__')));

// Read: cat -n, offset and limit, a folder, a file not there, another drive
assert.equal(await call('Read', { file_path: 'C:\\WORK\\NOTES.TXT', offset: 2, limit: 1 }), '     2\ttwo');
assert.equal(await call('Read', { file_path: 'WORK/NOTES.TXT' }), '     1\tone\n     2\ttwo\n     3\tthree\n     4\t');
await rejects(call('Read', { file_path: 'C:\\NOPE.TXT' }), /^File does not exist\.$/);
await rejects(call('Read', { file_path: 'C:\\WINDOWS' }), /EISDIR/);
await rejects(call('Read', { file_path: 'D:\\SETUP.EXE' }), /not on C:/);

// Write and Edit: an existing file must be Read first; a new one need not be
await rejects(call('Edit', { file_path: 'C:\\AUTOEXEC.BAT', old_string: 'OFF', new_string: 'ON' }), /^File has not been read yet\. Read it first before writing to it\.$/);
await rejects(call('Write', { file_path: 'C:\\AUTOEXEC.BAT', content: 'x' }), /has not been read yet/);
assert.equal(await call('Write', { file_path: 'C:\\WORK\\NEW.TXT', content: 'a\nb' }),'File created successfully at: C:\\WORK\\NEW.TXT');
assert.equal(fs.readText('C:\\WORK\\NEW.TXT'), 'a\r\nb');
await call('Read', { file_path: 'C:\\AUTOEXEC.BAT' });
await rejects(call('Edit', { file_path: 'C:\\AUTOEXEC.BAT', old_string: 'NONE', new_string: 'x' }), /^String to replace not found in file\.\nString: NONE$/);
await rejects(call('Edit', { file_path: 'C:\\AUTOEXEC.BAT', old_string: 'O', new_string: 'x' }), /^Found 2 matches of the string to replace, but replace_all is false/);
await rejects(call('Edit', { file_path: 'C:\\AUTOEXEC.BAT', old_string: 'O', new_string: 'O' }), /No changes to make/);
assert.equal(await call('Edit', { file_path: 'C:\\AUTOEXEC.BAT', old_string: 'OFF', new_string: 'ON' }),'The file C:\\AUTOEXEC.BAT has been updated successfully.');
assert.equal(fs.readText('C:\\AUTOEXEC.BAT'), '@ECHO ON\r\n');

// Glob: ** across folders, case ignored, braces, the session's folder by default, none found
assert.deepEqual((await call('Glob', { pattern: '**/*.ini' })).split('\n').sort(), ['C:\\WINDOWS\\SYSTEM.INI', 'C:\\WINDOWS\\WIN.INI']);
assert.equal(await call('Glob', { pattern: '*.{bat,sys}' }), 'C:\\AUTOEXEC.BAT');
assert.equal(await call('Glob', { pattern: '*.TXT', path: 'C:\\WORK' }).then(r => r.split('\n').sort().join()), 'C:\\WORK\\NEW.TXT,C:\\WORK\\NOTES.TXT');
assert.equal(await call('Glob', { pattern: '**/*.XYZ' }), 'No files found');
assert.match(await call('Glob', { pattern: 'WINDOWS/**/*.DRV' }), /^C:\\WINDOWS\\SYSTEM\\VGA\.DRV$/);

// Grep: files (binary files skipped), content with line numbers, count, a glob, case, no match
assert.match(await call('Grep', { pattern: 'shell|run' }), /^Found 2 files\n/);
assert.equal(await call('Grep', { pattern: 'binary' }), 'No files found');
assert.equal(await call('Grep', { pattern: 'SHELL', '-i': true, output_mode: 'content' }), 'C:\\WINDOWS\\SYSTEM.INI:2:shell=Explorer.exe');
assert.equal(await call('Grep', { pattern: 't', path: 'C:\\WORK\\NOTES.TXT', output_mode: 'count' }), 'C:\\WORK\\NOTES.TXT:2\n\nFound 2 total occurrences across 1 file.');
assert.equal(await call('Grep', { pattern: '^\\[', glob: '*.INI', output_mode: 'count' }).then(r => r.split('\n\n')[1]), 'Found 2 total occurrences across 2 files.');
assert.equal(await call('Grep', { pattern: 'zzz', output_mode: 'content' }), 'No matches found');
await rejects(call('Grep', { pattern: '(' }), /Invalid regex/);

// what goes ahead of each request: the user's CLAUDE.MD, the project's in the session's folder and above it, the memory's
// index; a memory Claude writes (its folders made) is in the next request's
assert.match(ccd.context(), /MEMORY\.MD is empty or not there yet/);
fs.mkdir('C:\\WINDOWS\\CLAUDE'); fs.writeFile('C:\\WINDOWS\\CLAUDE\\CLAUDE.MD', 'Answer in French.'); fs.writeFile('C:\\CLAUDE.MD', 'This disk is a test disk.');
await ccd.directory.change_directory({ path: 'C:\\WORK' }); fs.writeFile('C:\\WORK\\CLAUDE.MD', 'Notes live here.');
let cx = ccd.context();
assert.match(cx, /Contents of C:\\WINDOWS\\CLAUDE\\CLAUDE\.MD \(the user's own instructions for all projects\):\n\nAnswer in French\./);
assert.ok(cx.indexOf('C:\\CLAUDE.MD (project') < cx.indexOf('C:\\WORK\\CLAUDE.MD (project'), 'the root\'s first, then the folder\'s');
assert.equal((cx.match(/WINDOWS\\CLAUDE\\CLAUDE\.MD/g) || []).length, 1);
assert.equal(await call('Write', { file_path: 'C:\\WINDOWS\\CLAUDE\\MEMORY\\MEMORY.MD', content: '- [French](FRENCH.MD) - the user reads French' }), 'File created successfully at: C:\\WINDOWS\\CLAUDE\\MEMORY\\MEMORY.MD');
assert.match(ccd.context(), /Contents of C:\\WINDOWS\\CLAUDE\\MEMORY\\MEMORY\.MD:\n\n- \[French\]\(FRENCH\.MD\)/);
console.log('cctools: ok');
