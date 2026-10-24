// A program file that is not there is reported as Windows 95 reports it ("Cannot find the file"), not as an invalid
// application: runNative's catch took any error reading it as "not a program". Errors other than the file system's
// are the machine's to answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const fn = name => {
  let i = src.indexOf(`\nfunction ${name}(`); if (i < 0) i = src.indexOf(`\nasync function ${name}(`); assert.ok(i >= 0, name);
  return src.slice(i + 1, src.indexOf('\n}\n', i) + 2);
};
class FSError extends Error { constructor(code, path) { super(`${path}: not found`); this.code = code; } }
const make = (files, readFile) => {
  const seen = [];
  const f = new Function('fs', 'msgBox', 'dispName', 'basename', 'runNotepad', 'openPath', 'resolveArg', 'openFolder', 'MyComputer', 'nativeProgram', 'FSError', 'window', 'startSystem', 'NativeApp', 'RemoteApp',
    `${fn('runExe')}\n${fn('runNative')}\nreturn runExe;`)(
    { exists: p => files.includes(p), readFile }, (t, m) => seen.push(m.split('\n')[0]), n => n, p => p.split('\\').pop(), () => {}, () => {}, a => a, () => {}, null,
    async () => null, FSError, {}, async () => null, class {}, class {});
  return [f, seen];
};
{ const [run, seen] = make([], p => { throw new FSError(2, p); }); run('C:\\WINDOWS\\CONTROL.EXE'); await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(seen, ["Cannot find the file 'C:\\WINDOWS\\CONTROL.EXE' (or one of its components). Make sure the path and filename are correct and that all required libraries are available."]); }
{ const [run, seen] = make(['C:\\X.EXE'], () => new Uint8Array(4)); run('C:\\X.EXE'); await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(seen, ['C:\\X.EXE is not a valid Windows application.'], 'a file that is no program here: not a valid application'); }
console.log('runexe: ok');
