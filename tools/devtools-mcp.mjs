#!/usr/bin/env node
// An MCP server (stdio) that drives a browser's debugger over the Chrome DevTools Protocol.
// It attaches to a page and its workers, so the machine's worker and the dyn/NAME.js modules can be debugged:
// breakpoints, pause, resume, step, call frames, scope variables, evaluate, script source, console.
//
// The browser must expose the protocol:
//   Chrome:            --remote-debugging-port=9222
//   the Windows 95 app: 127.0.0.1:9334
// Endpoint: CDP_URL (default http://127.0.0.1:9222). No dependencies (Node 22: fetch, WebSocket).
//
// Register:  claude mcp add devtools -- node tools/devtools-mcp.mjs
import { createInterface } from 'node:readline';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TIMEOUT = 15000;

// ---------------------------------------------------------------- the protocol connection
let ws = null, nextId = 1;
const pending = new Map();
/** sessions by short name (s1, s2, ...): { name, sessionId, type, url, title, scripts, paused, console, breakpoints } */
const sessions = new Map();
const bySessionId = new Map();

async function connect() {
  if (ws && ws.readyState === 1) return;
  const v = await fetch(`${CDP_URL}/json/version`).then(r => r.json()).catch(e => { throw new Error(`no browser answers at ${CDP_URL} (${e.message}); start it with --remote-debugging-port`); });
  ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error(`could not open ${v.webSocketDebuggerUrl}`)); });
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => { ws = null; sessions.clear(); bySessionId.clear(); for (const p of pending.values()) p.no(new Error('the browser closed the connection')); pending.clear(); };
}
function send(method, params = {}, sessionId) {
  return new Promise((ok, no) => {
    const id = nextId++, t = setTimeout(() => { pending.delete(id); no(new Error(`${method}: no answer in ${TIMEOUT} ms`)); }, TIMEOUT);
    pending.set(id, { ok: v => { clearTimeout(t); ok(v); }, no: e => { clearTimeout(t); no(e); } });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
function onMessage(m) {
  if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.no(new Error(m.error.message)); else p.ok(m.result); return; }
  if (m.method === 'Target.attachedToTarget') { adopt(m.params.sessionId, m.params.targetInfo); return; }
  if (m.method === 'Target.detachedFromTarget') { const s = bySessionId.get(m.params.sessionId); if (s) { sessions.delete(s.name); bySessionId.delete(s.sessionId); } return; }
  const s = bySessionId.get(m.sessionId); if (!s) return;
  const p = m.params;
  if (m.method === 'Debugger.scriptParsed') { if (p.url) s.scripts.set(p.scriptId, { id: p.scriptId, url: p.url, lines: p.endLine + 1 }); }
  else if (m.method === 'Debugger.paused') { s.paused = p; for (const w of s.waiters.splice(0)) w(); }
  else if (m.method === 'Debugger.resumed') s.paused = null;
  else if (m.method === 'Runtime.consoleAPICalled') note(s, p.type, p.args.map(show).join(' '));
  else if (m.method === 'Runtime.exceptionThrown') note(s, 'exception', (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text);
}
const note = (s, level, text) => { s.console.push({ n: ++s.seq, level, text: String(text).slice(0, 2000) }); if (s.console.length > 2000) s.console.shift(); };
/** a new target's session: named, its debugger and runtime turned on, its own workers attached as they start */
function adopt(sessionId, info) {
  if (bySessionId.has(sessionId)) return bySessionId.get(sessionId);
  const s = { name: `s${sessions.size + 1}`, sessionId, type: info.type, url: info.url, title: info.title, scripts: new Map(), paused: null, console: [], seq: 0, waiters: [], breakpoints: new Map() };
  while (sessions.has(s.name)) s.name = `s${Number(s.name.slice(1)) + 1}`;
  sessions.set(s.name, s); bySessionId.set(sessionId, s);
  const on = (method, params) => send(method, params, sessionId).catch(() => {});
  on('Runtime.enable'); on('Debugger.enable'); on('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); on('Runtime.runIfWaitingForDebugger');
  return s;
}
const session = name => { const s = sessions.get(name); if (!s) throw new Error(`no session ${name}; attach first (sessions: ${[...sessions.keys()].join(', ') || 'none'})`); return s; };
const cmd = (s, method, params) => send(method, params, s.sessionId);

// ---------------------------------------------------------------- values
/** a remote object as short text */
function show(o) {
  if (!o) return 'undefined';
  if (o.type === 'undefined') return 'undefined';
  if ('value' in o) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  return o.description || o.className || o.type;
}
/** an object's own properties as { name: text }, `max` of them */
async function props(s, objectId, max = 60) {
  const r = await cmd(s, 'Runtime.getProperties', { objectId, ownProperties: true, generatePreview: false });
  const out = {};
  for (const p of r.result.slice(0, max)) out[p.name] = p.value ? show(p.value) : p.get ? '(getter)' : 'undefined';
  if (r.result.length > max) out['…'] = `${r.result.length - max} more`;
  return out;
}
const scriptOf = (s, id) => s.scripts.get(id) || { id, url: `(script ${id})` };
const frameLine = (s, f) => `${f.functionName || '(anonymous)'}  ${scriptOf(s, f.location.scriptId).url}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`;
/** where a paused session is: the reason, its call frames, and the top frame's local variables (closure and global
 *  names are left to evaluate) */
async function where(s, frames = 12, scopes = true) {
  if (!s.paused) return { paused: false };
  const p = s.paused, out = { paused: true, reason: p.reason, hitBreakpoints: p.hitBreakpoints || [], frames: p.callFrames.slice(0, frames).map((f, i) => `#${i} ${frameLine(s, f)}`) };
  if (scopes && p.callFrames[0]) {
    out.scopes = {};
    for (const sc of p.callFrames[0].scopeChain) if ((sc.type === 'local' || sc.type === 'block') && sc.object.objectId) out.scopes[sc.type + (sc.name ? ` ${sc.name}` : '')] = await props(s, sc.object.objectId);
  }
  return out;
}
const waitPaused = (s, ms) => (s.paused ? Promise.resolve(true) : new Promise(ok => { const t = setTimeout(() => ok(false), ms); s.waiters.push(() => { clearTimeout(t); ok(true); }); }));

// ---------------------------------------------------------------- the tools
const S = { type: 'string' }, N = { type: 'number' }, B = { type: 'boolean' };
const sess = { session: { ...S, description: 'A session name from attach (s1, s2, ...): the page or one of its workers.' } };
const tools = {
  targets: { description: 'List the browser\'s pages and the sessions attached so far.', props: {}, required: [],
    async run() {
      await connect();
      const t = (await send('Target.getTargets')).targetInfos.filter(x => x.type === 'page').map(x => ({ targetId: x.targetId, url: x.url, title: x.title, attached: x.attached }));
      return { pages: t, sessions: [...sessions.values()].map(s => ({ session: s.name, type: s.type, url: s.url, paused: !!s.paused, scripts: s.scripts.size })) };
    } },
  attach: { description: 'Attach to a page (by targetId, or the first whose URL contains `url`) and to its workers. Returns the sessions: the page and each worker. Use a worker\'s session to debug the machine.',
    props: { targetId: S, url: { ...S, description: 'Part of the page\'s URL.' } }, required: [],
    async run({ targetId, url }) {
      await connect();
      const all = (await send('Target.getTargets')).targetInfos.filter(x => x.type === 'page');
      const t = targetId ? all.find(x => x.targetId === targetId) : all.find(x => !url || x.url.includes(url));
      if (!t) throw new Error(`no page matches (pages: ${all.map(x => x.url).join(', ') || 'none'})`);
      const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      adopt(sessionId, t);
      await new Promise(r => setTimeout(r, 800));   // its workers attach, their scripts are listed
      return [...sessions.values()].map(s => ({ session: s.name, type: s.type, url: s.url, scripts: s.scripts.size }));
    } },
  scripts: { description: 'The scripts a session has loaded (url, lines). `filter` is a substring of the URL, e.g. "dyn/" for the modules run as JavaScript.',
    props: { ...sess, filter: S }, required: ['session'],
    async run({ session: n, filter }) { const s = session(n); return [...s.scripts.values()].filter(x => !filter || x.url.includes(filter)).map(x => `${x.url}  (${x.lines} lines)`); } },
  source: { description: 'Lines of a script. Give `url` (substring) and either `find` (a regular expression: returns matching lines with their numbers) or `from` and `count` (1-based line numbers).',
    props: { ...sess, url: S, find: S, from: N, count: N, max: { ...N, description: 'Most matches to return (default 40).' } }, required: ['session', 'url'],
    async run({ session: n, url, find, from = 1, count = 40, max = 40 }) {
      const s = session(n), sc = [...s.scripts.values()].reverse().find(x => x.url.includes(url)); if (!sc) throw new Error(`no script matches ${url}`);
      const L = (await cmd(s, 'Debugger.getScriptSource', { scriptId: sc.id })).scriptSource.split('\n');
      if (find) { const re = new RegExp(find), out = []; for (let i = 0; i < L.length && out.length < max; i++) if (re.test(L[i])) out.push(`${i + 1}: ${L[i].slice(0, 300)}`); return { url: sc.url, lines: L.length, matches: out }; }
      return { url: sc.url, lines: L.length, text: L.slice(from - 1, from - 1 + count).map((t, i) => `${from + i}: ${t.slice(0, 300)}`).join('\n') };
    } },
  breakpoint: { description: 'Set a breakpoint at a line of a script (1-based), optionally with a condition (a JavaScript expression evaluated in that frame). Returns its id and where it resolved.',
    props: { ...sess, url: { ...S, description: 'The script\'s URL, or a substring of it.' }, line: N, column: N, condition: S }, required: ['session', 'url', 'line'],
    async run({ session: n, url, line, column = 0, condition }) {
      const s = session(n), sc = [...s.scripts.values()].reverse().find(x => x.url === url) || [...s.scripts.values()].reverse().find(x => x.url.includes(url));
      const r = await cmd(s, 'Debugger.setBreakpointByUrl', { lineNumber: line - 1, columnNumber: column, ...(sc ? { url: sc.url } : { urlRegex: url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }), ...(condition ? { condition } : {}) });
      s.breakpoints.set(r.breakpointId, { url: sc ? sc.url : url, line, condition: condition || null });
      return { id: r.breakpointId, resolved: r.locations.map(l => `${scriptOf(s, l.scriptId).url}:${l.lineNumber + 1}:${l.columnNumber + 1}`) };
    } },
  breakpoints: { description: 'The breakpoints set in a session.', props: sess, required: ['session'],
    async run({ session: n }) { return [...session(n).breakpoints].map(([id, b]) => ({ id, ...b })); } },
  remove_breakpoint: { description: 'Remove a breakpoint by id, or all of a session\'s when no id is given.', props: { ...sess, id: S }, required: ['session'],
    async run({ session: n, id }) { const s = session(n), ids = id ? [id] : [...s.breakpoints.keys()]; for (const i of ids) { await cmd(s, 'Debugger.removeBreakpoint', { breakpointId: i }); s.breakpoints.delete(i); } return { removed: ids }; } },
  pause: { description: 'Pause a session at the next statement it runs.', props: sess, required: ['session'],
    async run({ session: n }) { const s = session(n); await cmd(s, 'Debugger.pause'); await waitPaused(s, 3000); return where(s); } },
  resume: { description: 'Resume a paused session. With `wait_ms`, waits that long for the next pause and reports it.', props: { ...sess, wait_ms: N }, required: ['session'],
    async run({ session: n, wait_ms = 0 }) { const s = session(n); if (s.paused) { s.paused = null; await cmd(s, 'Debugger.resume'); } if (wait_ms) await waitPaused(s, wait_ms); return where(s); } },
  step: { description: 'Step a paused session: over, into or out. Reports where it stops.', props: { ...sess, kind: { ...S, enum: ['over', 'into', 'out'] } }, required: ['session', 'kind'],
    async run({ session: n, kind }) {
      const s = session(n); if (!s.paused) throw new Error('the session is not paused');
      s.paused = null; await cmd(s, { over: 'Debugger.stepOver', into: 'Debugger.stepInto', out: 'Debugger.stepOut' }[kind]); await waitPaused(s, 5000); return where(s);
    } },
  paused: { description: 'Where a session is paused: the reason, the call frames, and the top frame\'s variables. With `wait_ms`, waits that long for a pause first.',
    props: { ...sess, wait_ms: N, frames: N }, required: ['session'],
    async run({ session: n, wait_ms = 0, frames = 12 }) { const s = session(n); if (wait_ms) await waitPaused(s, wait_ms); return where(s, frames); } },
  evaluate: { description: 'Evaluate a JavaScript expression in a session. While paused it runs in call frame `frame` (0 is the top) and sees that frame\'s variables; otherwise in the global scope. Promises are awaited when not paused.',
    props: { ...sess, expression: S, frame: N }, required: ['session', 'expression'],
    async run({ session: n, expression, frame = 0 }) {
      const s = session(n);
      const r = s.paused ? await cmd(s, 'Debugger.evaluateOnCallFrame', { callFrameId: s.paused.callFrames[frame].callFrameId, expression, returnByValue: false, generatePreview: false })
        : await cmd(s, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: false });
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      const o = r.result;
      if (o.objectId && o.type === 'object' && o.subtype !== 'error') return { value: show(o), properties: await props(s, o.objectId) };
      return { value: show(o) };
    } },
  console: { description: 'A session\'s console messages and uncaught exceptions with number above `since` (the last `max`, default 100). `filter` is a substring.',
    props: { ...sess, since: N, filter: S, max: N }, required: ['session'],
    async run({ session: n, since = 0, filter, max = 100 }) { return session(n).console.filter(c => c.n > since && (!filter || c.text.includes(filter))).slice(-max).map(c => `${c.n} [${c.level}] ${c.text}`); } },
};

// ---------------------------------------------------------------- MCP over stdio (JSON-RPC, one message a line)
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
async function handle(m) {
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'devtools', version: '1.0.0' } });
  if (m.method === 'ping') return reply(m.id, {});
  if (m.method === 'tools/list') return reply(m.id, { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.props, required: t.required } })) });
  if (m.method === 'tools/call') {
    const t = tools[m.params.name]; if (!t) return fail(m.id, -32602, `no tool ${m.params.name}`);
    try { await connect(); const r = await t.run(m.params.arguments || {}); return reply(m.id, { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] }); }
    catch (e) { return reply(m.id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }); }
  }
  if (m.id !== undefined) fail(m.id, -32601, `no method ${m.method}`);
}
// From the shell, without an MCP client: --run '[["attach",{"url":"8151"}],["scripts",{"session":"s2","filter":"dyn/"}]]'
// runs the calls in order in one connection and prints each result. Breakpoints and pauses end with the process.
if (process.argv[2] === '--run') {
  for (const [name, args] of JSON.parse(process.argv[3])) {
    let r; try { await connect(); r = await tools[name].run(args || {}); } catch (e) { r = `error: ${e.message}`; }
    console.log(`## ${name}\n${typeof r === 'string' ? r : JSON.stringify(r, null, 1)}`);
  }
  if (process.argv[4] !== '--hold') process.exit(0);   // --hold: stay attached, so a pause stays until this is stopped
  await new Promise(() => {});
}
createInterface({ input: process.stdin }).on('line', line => { if (!line.trim()) return; let m; try { m = JSON.parse(line); } catch (e) { return; } handle(m).catch(e => { if (m.id !== undefined) fail(m.id, -32603, e.message); }); });
