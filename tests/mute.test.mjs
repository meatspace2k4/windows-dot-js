// ?mute=1: the page's sound is muted. The sound card's output is made as sound.js loads (before win95.js runs), with its
// gain at 0 from the page's URL; without the flag, at 1
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis; window.addEventListener = () => {}; window.removeEventListener = () => {};
globalThis.URL.createObjectURL = () => 'blob:x'; globalThis.URL.revokeObjectURL = () => {};
const gains = [];
window.AudioContext = class {
  constructor() { this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: () => Promise.resolve() }; }
  createGain() { const g = { gain: { value: 1 }, connect() {} }; gains.push(g); return g; } close() {}
};
const load = search => {
  gains.length = 0; delete window.W95MUTE; globalThis.location = { search };
  for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js', 'sound.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
  return gains.map(g => g.gain.value);
};
assert.deepEqual(load('?debug=1&mute=1'), [0], 'muted: the output there, at no gain');
assert.equal(window.W95MUTE, true, 'the flag for the rest of the page');
assert.deepEqual(load('?debug=1'), [1]);
console.log('mute: ok');
