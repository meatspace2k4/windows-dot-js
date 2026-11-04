// CLAUDE.DLL (claude-app.js): a turn ends when the reply's last line ('done' or 'error') has come, whether or not the
// server closes the stream after it. The deployed server (HTTP/1.1, no length, no chunking) left the connection open,
// so a turn read to the end of the stream never ended: the window stayed at "Claude is thinking...". Also: a tool the
// reply asks for runs on the page and its result goes back in the next request; the turn then ends idle
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../claude-app.js', import.meta.url), 'utf8');
const enc = new TextEncoder(), dec = new TextDecoder();
const KEY = 'hkcu\\software\\claude\\code';

function machine(serve) {
  const reg = new Map(), defs = {}, posts = [], bodies = [];
  const self = {
    W95Win32: { def: (dll, name, n, f) => { defs[name] = f; }, regGet: (k, n) => reg.get(`${k}|${n}`), regSet: (k, n, v) => reg.set(`${k}|${n}`, v) },
    W95FS: { encode: s => enc.encode(s), decode: b => dec.decode(b) },
  };
  // a stream of the given lines that never closes when `open` (as the deployed server's)
  const stream = (lines, open) => new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n`)); if (!open) c.close(); } });
  const fetch = async (url, o) => { const q = JSON.parse(o.body); bodies.push(q); const [lines, open] = serve(q, bodies.length); return new Response(stream(lines, open), { status: 200 }); };
  const ctx = { self, importScripts() {}, console, fetch, Response, ReadableStream, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, post: m => posts.push(m), JSON, Date, Math };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  // the program's process, as far as the window's code asks of it: every USER32 call answers 1 (the window is 1)
  let heap = 0x10000; const mem = new Map();
  const p = {
    byName: new Map([['USER32', { exports: { get: n => n } }], ['KERNEL32', { exports: { get: n => n } }]]),
    call: () => 1, thunkFor: () => 1, alloc: n => { const a = heap; heap += (n + 15) & ~15; return a; }, free() {},
    writeA: (a, s) => mem.set(a, s), readA: a => mem.get(a) || '', w32: (a, v) => mem.set(a, v), r32: a => mem.get(a) | 0,
  };
  defs.Start.call(p, 1, 1);
  const timer = () => defs.Handle.call(p, 1, 0x113, 1, 0, p.alloc(4));
  const sessions = () => { const v = reg.get(`${KEY}|sessions`); return v ? JSON.parse(dec.decode(v.data).replace(/\0.*$/, '')) : []; };
  const prompt = text => { const l = sessions(); l.push({ id: 'local_t', title: 'T', state: 'working', archived: false, model: 'claude-opus-5-5', effort: 'low', permissionMode: 'default', cwd: 'C:\\', transcript: [{ uuid: 'm1', t: 1, role: 'user', text }], agents: [] });
    reg.set(`${KEY}|sessions`, { type: 1, data: enc.encode(`${JSON.stringify(l)}\0`) }); };
  // the page's side: the app's tools (ccd.js) answered as the page answers them
  const answerPage = (tools) => { for (const m of posts.splice(0)) if (m.t === 'ccd') self.W95ClaudeReply({ id: m.id, ...(m.name === '@defs' ? { result: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }] } : m.name === '@context' ? { result: '' } : tools(m)) }); };
  // the script loaded again into the running machine (worker.js cmd 'reload'): its functions defined anew
  const reload = () => vm.runInContext(src, ctx);
  const handle = (msg, wp, lp) => defs.Handle.call(p, 1, msg, wp, lp, p.alloc(4));
  return { self, sessions, prompt, timer, answerPage, bodies, posts, reload, handle };
}
const settle = async (m, tools = () => ({ result: 'ok' }), ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { m.answerPage(tools); await new Promise(r => setTimeout(r, 5)); const s = m.sessions().find(x => x.id === 'local_t'); if (s && s.state !== 'working') return s; }
  return m.sessions().find(x => x.id === 'local_t');
};

// a reply whose stream stays open after its 'done' line
{
  const m = machine(() => [[{ t: 'text', d: 'Hello' }, { t: 'done', stop: 'end_turn', model: 'claude-opus-5-5', in: 3, out: 1, content: [{ type: 'text', text: 'Hello' }] }], true]);
  m.prompt('hi'); m.timer();
  const s = await settle(m);
  assert.equal(s.state, 'idle', 'the turn ends at the reply\'s last line');
  assert.equal(s.transcript.filter(x => x.role === 'assistant').map(x => x.text).join(), 'Hello');
}

// an error line, the stream left open: the turn ends failed, saying why
{
  const m = machine(() => [[{ t: 'error', e: 'Rate limited (429): try again shortly' }], true]);
  m.prompt('hi'); m.timer();
  const s = await settle(m);
  assert.equal(s.state, 'failed');
  assert.match(s.transcript[s.transcript.length - 1].text, /429/);
}

// a tool use: the tool runs on the page, its result goes in the next request, and that reply ends the turn
{
  const m = machine((q, n) => n === 1
    ? [[{ t: 'done', stop: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'C:\\A.TXT' } }] }], true]
    : [[{ t: 'text', d: 'Read it' }, { t: 'done', stop: 'end_turn', content: [{ type: 'text', text: 'Read it' }] }], true]);
  m.prompt('read A'); m.timer();
  const s = await settle(m, x => (x.name === 'Read' ? { result: 'contents of A' } : { error: 'no' }));
  assert.equal(s.state, 'idle');
  assert.equal(m.bodies.filter(b => b.tools && b.tools.length).length, 2, 'two requests of the turn (the prompt suggestion after it has no tools)');
  const last = m.bodies[1].messages[m.bodies[1].messages.length - 1];
  assert.deepEqual(last.content.map(b => [b.type, b.tool_use_id, b.content]), [['tool_result', 'tu1', 'contents of A']]);
}

// reloaded during a turn (as CLAUDE.EXE's Claude reloads it after changing it): the turn in progress ends, its tool's
// answer reaching it, and the window is still the program's (a later turn runs from the new code's timer)
{
  const m = machine((q, n) => n === 1
    ? [[{ t: 'done', stop: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] }], true]
    : [[{ t: 'text', d: `reply ${n}` }, { t: 'done', stop: 'end_turn', content: [{ type: 'text', text: `reply ${n}` }] }], true]);
  m.prompt('first'); m.timer();
  // (the page answers the setup calls, then holds the tool until the reload)
  let toolCall = null;
  for (let i = 0; i < 200 && !toolCall; i++) { for (const x of m.posts.splice(0)) { if (x.t !== 'ccd') continue; if (x.name === 'Read') toolCall = x; else m.self.W95ClaudeReply({ id: x.id, result: x.name === '@defs' ? [] : '' }); } await new Promise(r => setTimeout(r, 5)); }
  assert.ok(toolCall, 'the turn asked for its tool');
  m.reload();
  m.self.W95ClaudeReply({ id: toolCall.id, result: 'contents' });
  let s = await settle(m);
  assert.equal(s.state, 'idle', 'the turn begun before the reload ends');
  // a second prompt, run from the reloaded code's timer: its window is still the one the program made
  const l = m.sessions(); const t = l.find(x => x.id === 'local_t'); t.state = 'working'; t.transcript.push({ uuid: 'm9', t: 2, role: 'user', text: 'second' });
  m.self.W95Win32.regSet('hkcu\\software\\claude\\code', 'sessions', { type: 1, data: enc.encode(`${JSON.stringify(l)}\0`) });
  m.timer();
  s = await settle(m);
  assert.equal(s.state, 'idle');
  assert.ok(s.transcript.some(x => x.role === 'assistant' && /reply/.test(x.text) && x.t > 2), 'the reloaded code answered the second prompt');
}

console.log('claudeturn: ok');
