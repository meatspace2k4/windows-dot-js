// A program that fails to load stops there, naming why. spawnProgram read any error from the loader as WinExec's 8
// (a second instance: its place here taken), and the system started the program in a machine of its own: a load
// refused for a broken layout ran somewhere else without a word.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const method = (file, name) => {
  const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const i = src.indexOf(`  ${name}(file, arg) {`); assert.ok(i >= 0, `${file} has ${name}`);
  return src.slice(i, src.indexOf('\n  }\n', i) + 4);
};
for (const [file, scope] of [['worker.js', 'self'], ['win95.js', 'window']]) {
  const M = new Function(scope, 'fs', 'basename', 'b64bytes', 'post', 'emit', `return class {\n${method(file, 'spawnProgram')}\n}`);
  const g = { W95SYSTEM: { programs: { 'NOTEPAD.EXE': { meta: { base: 0x400000 }, modSync: {} } } } };
  const fs = { realpath: f => f, readFile: () => new Uint8Array(0) };
  const m = new (M(g, fs, f => f.split('\\').pop(), null, null, null))();
  m.proc = { modules: [], spawn() { throw new Error('EXE at 400000 lies over SHELL32.DLL\'s image'); } };
  m.kick = () => {};
  assert.throws(() => m.spawnProgram('C:\\WINDOWS\\NOTEPAD.EXE'), /lies over SHELL32/, `${file}: a load that fails stops, naming why`);
}
console.log('spawnfail: ok');
