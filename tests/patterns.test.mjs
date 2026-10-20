// Setup's desktop patterns: SHELL.INF's patterns.inis lines, their %strings% put in, become CONTROL.INI's [Patterns],
// the list Display Properties' Background page shows; a disk that has the section keeps it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const fn = name => { const i = src.indexOf(`function ${name}(`), j = src.indexOf('\n}\n', i); return src.slice(i, j + 2); };
const files = new Map();
const fs = { readText: p => { if (!files.has(p)) throw new Error('none'); return files.get(p); }, writeFile: (p, t) => files.set(p, typeof t === 'string' ? t : new TextDecoder().decode(t)) };
const INF = '[patterns.inis]\r\ncontrol.ini,Patterns,,"%NoneDesc%=%NoneDesc%"\r\ncontrol.ini,Patterns,,"%BricksDesc%=187 95 174 93 186 117 234 245"\r\n\r\n' +
  '[Strings]\r\nNoneDesc="(None)"\r\nBricksDesc="Bricks"\r\n';
const setupPatterns = new Function('fs', 'W95Win32', 'WINDIR', `${fn('infParse')}\n${fn('infUpdateInis')}\n${fn('setupPatterns')}\nreturn setupPatterns;`)(fs, window.W95Win32, 'C:\\WINDOWS');
window.W95SYSTEM = { infs: { 'SHELL.INF': INF } };

setupPatterns();
const ini = window.W95Win32.iniRead(fs, 'CONTROL.INI').get('patterns');
assert.deepEqual(ini && ini.lines.map(e => [e.name, e.value]), [['(None)', '(None)'], ['Bricks', '187 95 174 93 186 117 234 245']], 'the names from [Strings]');

files.set('C:\\WINDOWS\\CONTROL.INI', '[Patterns]\r\nMine=1 2 3 4 5 6 7 8\r\n');
setupPatterns();
assert.deepEqual([...window.W95Win32.iniRead(fs, 'CONTROL.INI').get('patterns').keys.keys()], ['mine'], 'a disk with its own is left');
console.log('patterns: ok');
