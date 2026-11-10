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
function send(method, params = {}, sessionId, untimed = false) {
  return new Promise((ok, no) => {
    // (untimed: a shell action, which answers once the system has taken it or has failed, win95.outcome)
    const id = nextId++, t = untimed ? null : setTimeout(() => { pending.delete(id); no(new Error(`${method}: no answer in ${TIMEOUT} ms`)); }, TIMEOUT);
    pending.set(id, { ok: v => { clearTimeout(t); ok(v); }, no: e => { clearTimeout(t); no(e); } });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
function onMessage(m) {
  if (m.id) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.no(new Error(m.error.message)); else p.ok(m.result); return; }
  if (m.method === 'Target.attachedToTarget') { const c = adopt(m.params.sessionId, m.params.targetInfo), parent = m.sessionId && bySessionId.get(m.sessionId); if (parent && parent.onChild) parent.onChild(c); return; }
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
  const s = { name: `s${sessions.size + 1}`, sessionId, targetId: info.targetId, type: info.type, url: info.url, title: info.title, scripts: new Map(), paused: null, console: [], seq: 0, waiters: [], breakpoints: new Map() };
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
      // (a page attached to already is not attached to again: each attach is a debugger session of its own on the page
      // and on every worker of it, holding their scripts; a dozen of them on a page that loads a 160 MB bundle ran its
      // tab out of memory)
      if (![...sessions.values()].some(s => s.targetId === t.targetId)) {
        // (its worker, when the browser lists one: attached as the page's auto-attach reports it, waited for by that
        // event, not by a time)
        const hasWorker = (await send('Target.getTargets')).targetInfos.some(x => x.type === 'worker' && /worker\.js/.test(x.url));
        const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const ps = adopt(sessionId, t), child = new Promise(r => { ps.onChild = c => { if (c.type === 'worker') r(c); }; });
        if (hasWorker) await child;
      }
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

// ---------------------------------------------------------------- the machine: guest code and the Windows API
// These work on the machine's worker through its debugger API (dynjs.js: W95DynJs.debug, the page's win95.debug).
// A place is an address in hex, 'MODULE+offset' or an API 'DLL!Export' ('USER32!DrawIconEx', 'USER!#123').
const worker = () => { const s = [...sessions.values()].find(x => x.type === 'worker' && /worker\.js/.test(x.url)); if (!s) throw new Error('no machine worker is attached; attach to the page first'); return s; };
const hx = v => (v >>> 0).toString(16);
/** one call of the machine's debugger API, in the worker (in the paused frame when it is paused) */
async function guest(method, ...args) {
  const s = worker(), expression = `JSON.stringify(self.W95DynJs.debug(machine.proc, ${JSON.stringify([method, ...args])}, machine))`;
  const r = s.paused ? await cmd(s, 'Debugger.evaluateOnCallFrame', { callFrameId: s.paused.callFrames[0].callFrameId, expression, returnByValue: true })
    : await cmd(s, 'Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
}
/** a script of the worker's by the end of its URL, waited for (a module just made JavaScript is parsed a moment later) */
async function scriptEnding(s, end, ms = 4000) {
  for (const t0 = Date.now(); ;) { const sc = [...s.scripts.values()].reverse().find(x => x.url.endsWith(end)); if (sc) return sc; if (Date.now() - t0 > ms) throw new Error(`no script ${end}`); await new Promise(r => setTimeout(r, 100)); }
}
/** a debugger breakpoint on the line after the first line matching `re` in a script */
async function breakAfter(s, sc, re, condition) {
  const L = (await cmd(s, 'Debugger.getScriptSource', { scriptId: sc.id })).scriptSource.split('\n'), i = L.findIndex(l => re.test(l)); if (i < 0) throw new Error(`${sc.url}: no line matches ${re}`);
  const r = await cmd(s, 'Debugger.setBreakpointByUrl', { lineNumber: i + 1, url: sc.url, ...(condition ? { condition } : {}) });
  return { id: r.breakpointId, line: i + 2 };
}
/** the machine where it is paused: its debugger state, plus the block or API call the pause is in */
async function guestWhere() {
  const s = worker(), st = await guest('state'), f = s.paused && s.paused.callFrames[0];
  if (f && /^b_[0-9a-f]+$/.test(f.functionName)) st.block = await guest('where', parseInt(f.functionName.slice(2), 16));
  if (f && f.functionName === 'w95ApiEntry') { const r = await cmd(s, 'Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression: 'JSON.stringify({ call, args: args.map(a => a.toString(16)), from, thread })', returnByValue: true }); st.api = JSON.parse(r.result.value); }
  return { paused: !!s.paused, ...st };
}
// ---------------------------------------------------------------- the shell: SCRIPTING.md's win95 API, called as it is
// An action (click, key, type, run) answers its outcome (win95.outcome): the events it caused, the screen once the
// machines have taken it (win95.report), or the error it ended on; the answer is the state to act on next. A query's
// strings in /slashes/ are regular expressions.
const pageSession = async () => {
  let s = [...sessions.values()].find(x => x.type === 'page' && /\/\?|win95|braid|localhost/.test(x.url || ''));
  if (!s) { await tools.attach.run({ url: process.env.W95_URL || 'localhost' }); s = [...sessions.values()].find(x => x.type === 'page'); }
  if (!s) throw new Error('no page is attached');
  return s;
};
const reviveQuery = 'const Q = q => { if (!q || typeof q !== "object") return q; const o = {}; for (const [k, v] of Object.entries(q)) { const m = typeof v === "string" && /^\\/(.*)\\/([a-z]*)$/.exec(v); o[k] = m ? new RegExp(m[1], m[2]) : v; } return o; };';
async function shell(body) {
  const s = await pageSession();
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${reviveQuery} ${body} })()`, awaitPromise: true, returnByValue: true }, s.sessionId, true);
  if (r.exceptionDetails) throw new Error(((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value === undefined ? 'done' : r.result.value;
}
const Q = { type: 'object', description: 'An element query: { name, role, window }, each a string or "/regexp/".' };
Object.assign(tools, {
  shell_report: { description: 'What happened since the last shell call (its events) and the screen now: every window with its controls\' text, the last n faults. Start here.',
    props: { n: N }, required: [], run: ({ n = 3 }) => shell(`return await win95.outcome(null, ${Number(n) || 3});`) },
  shell_click: { description: 'win95.click (or dblclick) on an element query: looked up as its machine shows it now; rejects saying what the window has, or at once when the system fails.',
    props: { query: Q, double: { type: 'boolean' } }, required: ['query'],
    run: ({ query, double }) => shell(`return await win95.outcome(() => win95.${double ? 'dblclick' : 'click'}(Q(${JSON.stringify(query)})));`) },
  shell_key: { description: 'win95.key(...keys): named keys (enter, esc, tab, alt+n, ctrl+shift+tab, ...). Answers its outcome.', props: { keys: { type: 'array', items: S } }, required: ['keys'],
    run: ({ keys }) => shell(`return await win95.outcome(() => win95.key(...${JSON.stringify(keys)}));`) },
  shell_type: { description: 'win95.type(text). Answers its outcome.', props: { text: S }, required: ['text'], run: ({ text }) => shell(`return await win95.outcome(() => win95.type(${JSON.stringify(text)}));`) },
  shell_run: { description: 'win95.run(command): what Start > Run does. Answers its outcome.', props: { command: S }, required: ['command'], run: ({ command }) => shell(`return await win95.outcome(() => win95.run(${JSON.stringify(command)}));`) },
  shell_next: { description: 'win95.next(type, test): the next event of that type whose title matches `title` ("/regexp/" or exact); ends at once when the system fails. Start it with `then` (a shell_* call to make once it is listening), so the event the call causes is not missed.',
    props: { type: S, title: S, ms: N, then: { type: 'object', description: '{ tool, args }: a shell_* tool to call once listening.' } }, required: ['type'],
    async run({ type, title, ms = 60000, then }) {
      const t = title ? JSON.stringify(title) : 'null';
      const s = await pageSession(), key = `__next${nextId++}`;
      await cmd(s, 'Runtime.evaluate', { expression: `(() => { ${reviveQuery} const t = ${t}, m = t && /^\\/(.*)\\/([a-z]*)$/.exec(t), re = m ? new RegExp(m[1], m[2]) : null; window.${key} = win95.next(${JSON.stringify(type)}, t === null ? null : e => re ? re.test(e.title || '') : e.title === t, ${Number(ms)}).then(e => ({ event: e }), e => ({ error: e.message })); })()` });
      const did = then && tools[then.tool] ? await tools[then.tool].run(then.args || {}) : null;
      const r = await cmd(s, 'Runtime.evaluate', { expression: `window.${key}.finally(() => { delete window.${key}; })`, awaitPromise: true, returnByValue: true });
      return { then: did, ...r.result.value };
    } },
  shell_cmd: { description: 'win95.sysApp.cmd(name, args): the system machine\'s diagnostics (probe, faults, watch, call16, ...).', props: { name: S, args: { type: 'array' } }, required: ['name'],
    run: ({ name, args = [] }) => shell(`return await win95.sysApp.cmd(${JSON.stringify(name)}, ${JSON.stringify(args)});`) },
  shell_eval: { description: 'Any win95 API expression, awaited (win95 in scope).', props: { expression: S }, required: ['expression'],
    run: ({ expression }) => shell(`return await (${expression});`) },
});
Object.assign(tools, {
  screenshot: { description: 'A picture of the page (the machine\'s screen). `file`: also save the PNG there.', props: { file: S }, required: [],
    async run({ file }) {
      const s = [...sessions.values()].find(x => x.type === 'page'); if (!s) throw new Error('no page is attached');
      const { data } = await cmd(s, 'Page.captureScreenshot', { format: 'png' });
      if (file) (await import('node:fs')).writeFileSync(file, Buffer.from(data, 'base64'));
      return { image: data, text: file ? `saved ${file}` : 'the page' };
    } },
  guest_modules: { description: 'The machine\'s translated modules: name, code range, blocks, and whether each runs as JavaScript (debuggable) or WebAssembly.', props: {}, required: [], run: () => guest('modules') },
  guest_run: { description: 'Run exactly these modules as JavaScript (names like MSTASK, EXPLORER; * for all); the rest run as WebAssembly. Not while paused.', props: { names: { type: 'array', items: S } }, required: ['names'], run: ({ names }) => guest('run', names) },
  guest_break: { description: 'Stop the machine when guest code enters the block at a place: an address in hex, MODULE+offset, or DLL!Export. Its module is run as JavaScript if it is not already. `condition` is a JavaScript expression over R (registers, e.g. R.eax) and r8/r16/r32(address).',
    props: { at: S, condition: S }, required: ['at'],
    async run({ at, condition }) {
      const s = worker(), { addr, name } = await guest('resolve', at), src = await guest('source', addr);
      if (!src) throw new Error(`${name} is not in a translated module`);
      if (src.block !== addr) throw new Error(`no block starts at ${name}; it is inside the block at ${await guest('where', src.block)} (${hx(src.block)})`);
      const mods = await guest('modules'), m = mods.find(x => x.name === src.module);
      if (!m.js) await guest('run', [...mods.filter(x => x.js).map(x => x.name), m.name]);
      const sc = await scriptEnding(s, `dyn/${m.label.replace(/[^\w.-]+/g, '_')}.js`), b = await breakAfter(s, sc, new RegExp(`^function b_${hx(addr)}\\(`), condition);
      s.breakpoints.set(b.id, { at: name, url: sc.url, line: b.line, condition: condition || null });
      return { id: b.id, at: name, address: hx(addr), script: `${sc.url}:${b.line}` };
    } },
  api_break: { description: 'Stop the machine at each call of a Windows API (DLL!Export), whatever module calls it and whether or not it runs as JavaScript. The pause reports the call, its first `args` arguments and the caller.',
    props: { call: S, args: N, condition: { ...S, description: 'A JavaScript expression over call, args (numbers), from and thread.' } }, required: ['call'],
    async run({ call, args = 6, condition }) {
      const s = worker(), stop = await guest('stopAt', call, args);
      if (s.apiBp) { await cmd(s, 'Debugger.removeBreakpoint', { breakpointId: s.apiBp.id }).catch(() => {}); s.breakpoints.delete(s.apiBp.id); }
      s.apiConds = { ...(s.apiConds || {}), [call]: condition || 'true' };
      const cond = Object.entries(s.apiConds).map(([c, e]) => `(call === ${JSON.stringify(c)} && (${e}))`).join(' || ');
      s.apiBp = await breakAfter(s, await scriptEnding(s, '/dynjs.js'), /^function w95ApiEntry\(/, cond);
      s.breakpoints.set(s.apiBp.id, { at: 'API calls: ' + Object.keys(s.apiConds).join(', '), condition: cond });
      return { ...stop, addr: hx(stop.addr), name: await guest('where', stop.addr) };
    } },
  api_unbreak: { description: 'End the stops at API calls: one by id (from api_break), or all.', props: { id: N }, required: [],
    async run({ id }) { const s = worker(), ids = await guest('unstop', id); if (!(await guest('stops')).length && s.apiBp) { await cmd(s, 'Debugger.removeBreakpoint', { breakpointId: s.apiBp.id }).catch(() => {}); s.breakpoints.delete(s.apiBp.id); s.apiBp = null; s.apiConds = {}; } return { ended: ids }; } },
  api_watch: { description: 'Trace calls of a Windows API without stopping: `dll` and `name` (an export, or /regexp/ over the DLL\'s exports), reading `args` arguments. Read them with api_calls.',
    props: { dll: S, name: S, args: N }, required: ['dll', 'name'], run: ({ dll, name, args = 6 }) => guest('watch', dll, name, args) },
  api_calls: { description: 'The API calls traced since the last api_calls (the last `max`, default 60): time, thread, call with arguments, return value, caller, and the text arguments point at. `filter` is a substring.',
    props: { max: N, filter: S }, required: [],
    async run({ max = 60, filter }) { return (await guest('calls') || []).map(r => `${r.t} th${r.thread} ${r.name}(${r.args.join(', ')}) -> ${r.eax}  from ${r.from}${(r.text || []).some(Boolean) ? '  text ' + JSON.stringify(r.text.filter(Boolean)) : ''}`).filter(l => !filter || l.includes(filter)).slice(-max); } },
  guest_state: { description: 'The machine\'s processor and running thread: registers, flags, the stack with each code address named (module+offset and nearest export), the thread, its program, the Win16Lock; when paused, the guest block or API call the pause is in.', props: {}, required: [], run: guestWhere },
  guest_memory: { description: 'A hex dump of guest memory at a place.', props: { at: S, length: N }, required: ['at'],
    async run({ at, length = 128 }) {
      const { addr } = await guest('resolve', at), b = await guest('read', addr, length), out = [];
      for (let i = 0; i < b.length; i += 16) { const row = b.slice(i, i + 16); out.push(`${hx(addr + i).padStart(8, '0')}  ${row.map(x => x.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${row.map(x => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')}`); }
      return out.join('\n');
    } },
  guest_step: { description: 'From a pause, run to the next guest block entered in a module run as JavaScript, and report the machine there.', props: {}, required: [],
    async run() {
      const s = worker(); if (!s.paused) throw new Error('the machine is not paused');
      // (paused on a block's first line, its own entry is still ahead: that one is passed, the next is the step)
      const from = s.paused.callFrames[0].functionName, once = async () => {
      const ev = e => cmd(s, 'Debugger.evaluateOnCallFrame', { callFrameId: s.paused.callFrames[0].callFrameId, expression: e, returnByValue: true });
      await ev('self.W95DynJs.stepping(true)');
      const b = await breakAfter(s, await scriptEnding(s, '/dynjs.js'), /^  at\(a, R, M\) \{/);
      s.paused = null; await cmd(s, 'Debugger.resume'); const hit = await waitPaused(s, 8000);
      await cmd(s, 'Debugger.removeBreakpoint', { breakpointId: b.id });
      if (!hit) { await cmd(s, 'Runtime.evaluate', { expression: 'self.W95DynJs.stepping(false)' }).catch(() => {}); return { paused: false, note: 'no block of a JavaScript-run module was entered in 8 s' }; }
      await ev('self.W95DynJs.stepping(false)');
      s.paused = null; await cmd(s, 'Debugger.stepOut'); await waitPaused(s, 3000);
      return null; };
      let r = await once();
      if (!r && s.paused && s.paused.callFrames[0].functionName === from) r = await once();
      return r || guestWhere();
    } },
  guest_record: { description: 'A recording breakpoint: each time the block at a place is entered (its module run as JavaScript) a hit is kept and the machine runs on. `when` and `capture` are expressions over R, r8/r16/r32, n (times reached) and thread.',
    props: { at: S, when: S, capture: S }, required: ['at'], run: ({ at, when, capture }) => guest('breakpoint', { at, when, capture }) },
  guest_hits: { description: 'The hits recording breakpoints kept, with seq above `since`: where, thread, registers, stack, captured value.', props: { since: N }, required: [],
    async run({ since = 0 }) { return (await guest('hits', since)).map(h => ({ seq: h.seq, id: h.id, at: hx(h.at), n: h.n, thread: h.thread, value: h.value, eax: hx(h.regs.eax), esp: hx(h.regs.esp), stack: h.stack.slice(0, 6).map(hx).join(' ') })); } },
});

// ---------------------------------------------------------------- MCP over stdio (JSON-RPC, one message a line)
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
async function handle(m) {
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'devtools', version: '1.0.0' } });
  if (m.method === 'ping') return reply(m.id, {});
  if (m.method === 'tools/list') return reply(m.id, { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.props, required: t.required } })) });
  if (m.method === 'tools/call') {
    const t = tools[m.params.name]; if (!t) return fail(m.id, -32602, `no tool ${m.params.name}`);
    try { await connect(); const r = await t.run(m.params.arguments || {}); if (r && r.image) return reply(m.id, { content: [{ type: 'image', data: r.image, mimeType: 'image/png' }, { type: 'text', text: r.text }] });
      return reply(m.id, { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] }); }
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
// A daemon for the shell, so breakpoints and pauses last between calls:
//   --daemon [port]            serve the tools on 127.0.0.1 (default port 9333)
//   --call <tool> '<json>'     call one tool on the daemon and print its result
const DPORT = 9333;
if (process.argv[2] === '--daemon') {
  const { createServer } = await import('node:http');
  createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', async () => {
      let r; try { const { name, args } = JSON.parse(body); if (!tools[name]) throw new Error(`no tool ${name}`); await connect(); r = await tools[name].run(args || {}); } catch (e) { r = `error: ${e.message}`; }
      if (r && r.image) r = r.text;
      res.end(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
    });
  }).listen(Number(process.argv[3]) || DPORT, '127.0.0.1');
  await new Promise(() => {});
}
if (process.argv[2] === '--call') {
  const r = await fetch(`http://127.0.0.1:${process.env.DEVTOOLS_PORT || DPORT}/`, { method: 'POST', body: JSON.stringify({ name: process.argv[3], args: JSON.parse(process.argv[4] || '{}') }) }).then(x => x.text()).catch(e => `error: the daemon does not answer (${e.message}); start it with --daemon`);
  console.log(r); process.exit(0);
}
createInterface({ input: process.stdin }).on('line', line => { if (!line.trim()) return; let m; try { m = JSON.parse(line); } catch (e) { return; } handle(m).catch(e => { if (m.id !== undefined) fail(m.id, -32603, e.message); }); });
