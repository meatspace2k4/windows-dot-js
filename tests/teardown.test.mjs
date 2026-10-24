// A process's end goes through USER (DestroyWindow for its windows, SignalProc32 for its threads and itself); what
// goes wrong there is the machine's to answer, not a console line. Swallowed, USER kept the windows and queues of a
// process that was gone, and the next thing to touch them hung.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const { Process, API } = window.W95Win32;

const mk = () => {
  const p = Object.create(Process.prototype);
  const pc = { pid: 0x6c, started: true, exe: { base: 0x420000 }, exitCode: null };
  p.threadsById = new Map([[0x90, { id: 0x90, pc, state: 'running' }]]);
  p.ne = new Map([['USER', { meta: {}, exports: new Map([[391, 0x14071886]]), names: {} }]]);
  p.hinst16 = () => 0x1af7;
  p.user16 = () => ({ ax: 1 });
  return [p, pc];
};

const destroy = API.USER32.DestroyWindow;
try {
  API.USER32.DestroyWindow = [1, () => { throw new TypeError('w.cls is undefined'); }];
  const [p, pc] = mk(); p.windows = new Map([[0x1234, { hwnd: 0x1234, pc }]]);
  assert.throws(() => p.endProcess(pc, 0), /w\.cls is undefined/, 'an error destroying its windows stops the teardown, naming it');
} finally { API.USER32.DestroyWindow = destroy; }

{
  const [p, pc] = mk();
  p.user16 = ord => { if (ord === 391) throw new TypeError('queue is null'); return { ax: 1 }; };
  assert.throws(() => p.endProcess(pc, 0), /queue is null/, 'an error in USER\'s SignalProc32 stops the teardown, naming it');
}
console.log('teardown: ok');
