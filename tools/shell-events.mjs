#!/usr/bin/env node
// The shell's events as they happen, a line each (docs/scripting/events.md: the __w95event binding), for a watch that
// reports while something long runs (Setup, a boot): faults, failures on the page, screens, windows opened, programs
// that failed, braid's travels and anchors.
//
//   node tools/shell-events.mjs [seconds] [file]
//
// Runs `seconds` (default 1800) or until the page closes. `file`: every event appended there whole, a JSON line each.
// Endpoint: CDP_URL, else the Windows 95 app (127.0.0.1:9334). It waits for the page, so it can be started first.
import { appendFileSync } from 'node:fs';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9334', [secs = 1800, file] = process.argv.slice(2);
const isShell = t => t.type === 'page' && /\/app\/web\/index\.html|localhost/.test(t.url);
let pg;
for (let i = 0; i < 300 && !pg; i++) {
  pg = await fetch(`${CDP_URL}/json`).then(r => r.json()).then(l => l.find(isShell), () => null);
  if (!pg) await new Promise(r => setTimeout(r, 200));
}
if (!pg) { console.log(`no shell page at ${CDP_URL}`); process.exit(1); }
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
ws.onopen = () => { send('Runtime.enable'); send('Runtime.addBinding', { name: '__w95event' }); };
const SHOW = /^(system\.|braid\.(fault|broken|travel|anchor)|screen$|window\.open|program\.exit|pc\.)/;
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; console.log('exception ' + String(d.exception ? d.exception.description : d.text).slice(0, 300)); }
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== '__w95event') return;
  if (file) appendFileSync(file, m.params.payload + '\n');
  let e; try { e = JSON.parse(m.params.payload); } catch (_) { return; }
  // (a program's end only when it failed: a first start ends dozens with a code of their own, GRPCONV's 1 each time)
  if (!SHOW.test(e.type) || (e.type === 'program.exit' && !e.why)) return;
  const { type, x, y, w, h, t, ...rest } = e;
  console.log(`${type} ${JSON.stringify(rest).slice(0, 330)}`);
};
ws.onclose = () => { console.log('the page closed'); process.exit(0); };
setTimeout(() => process.exit(0), Number(secs) * 1000);
