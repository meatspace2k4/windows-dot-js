// A script's drag comes in as a person's does: the press, each move and the release once the machine has fed the last
// to USER (its frames say how much input it has taken from the ring and how many mouse events wait) and the page has
// drawn it. Sent at once, the release was in before USER's move loop began, and a window dragged by its title stayed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };
const drawn = cut('async function inputDrawn() {', '\n}\n');
const methods = cut('  /** the next message the machine sends of its screen', 'i.taken >= (this.ringPut || 0) && !i.mouse; }');
const drag = cut('  drag(x1, y1, x2, y2, steps = 8) {', '\n  },\n');

// a machine whose frames come when the test says, taking one ring entry and feeding it per frame
const App = new Function(`return class { constructor() { this.alive = true; this.ring = {}; this.snap = { input: { taken: 0, mouse: 0 } }; } ${methods} }`)();
const app = new App(), log = [];
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
const S = new Function('app', 'log', `
  const sysApp = app, nativeApps = new Set();
  const pointer = (type, x, y) => { log.push(type); app.ringPut = (app.ringPut || 0) + 1; };
  const resolveEl = null, actOn = null;
  ${drawn}
  const script = { ${drag} };
  return script;`)(app, log);
const frame = () => { const i = app.snap.input; if (i.taken < (app.ringPut || 0)) i.taken++; app.framed(); };

const done = S.drag(10, 10, 40, 10, 3);
await new Promise(r => setTimeout(r, 5));
assert.deepEqual(log, ['pointermove'], 'nothing more until the machine has taken the first');
let over = false; done.then(() => { over = true; });
for (let n = 0; n < 40 && !over; n++) { frame(); await new Promise(r => setTimeout(r, 2)); }
assert.ok(over, 'the release taken: the drag is over');
assert.deepEqual(log, ['pointermove', 'pointerdown', 'pointermove', 'pointermove', 'pointermove', 'pointerup']);
// a move fed into the ring but still in the machine's mouse queue is not yet fed
app.ringPut = app.snap.input.taken; app.snap.input.mouse = 1; assert.equal(app.inputFed(), false);
app.snap.input.mouse = 0; assert.equal(app.inputFed(), true);
console.log('dragpace: ok');
