// Runs benchmark steps in the shell's page over the DevTools protocol and compares results with a baseline.
// Shared by bench.mjs and every replay script it records (which carry a copy of this file).

export async function connect(endpoint) {
  const list = await (await fetch(endpoint + '/json')).json();
  const page = list.find(t => t.type === 'page' && /index\.html|localhost:8095\/?$/.test(t.url)) || list.find(t => t.type === 'page');
  if (!page) throw new Error('no page at ' + endpoint);
  const version = await (await fetch(endpoint + '/json/version')).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const api = { onEvent: null };
  ws.onmessage = m => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (api.onEvent) api.onEvent(d); };
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  const call = (method, params = {}) => new Promise((ok, no) => {
    pend.set(++id, d => d.error ? no(new Error(`${method}: ${d.error.message}`)) : ok(d.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, timeout = 300000) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return Object.assign(api, { call, evaluate, version, url: page.url, close: () => ws.close() });
}

// the shell is up, evaluated in the page: with the system's machine built in (W95SYSTEM) that is the machine's
// Explorer with its desktop window (Progman, "Program Manager") on the screen; the page's own desktop, shown a second
// after a reload while the machine boots, is not it
export const SHELL_READY = `typeof win95 === 'object' && win95.state.screen === 'desktop' && document.fonts.status === 'loaded'
  && (typeof W95SYSTEM !== 'object' || (!!win95.sysApp && win95.sysApp.alive && win95.windows().some(w => w.title === 'Program Manager')))`;

// the windows to close to get back to the bare desktop, top first: everything but Explorer's desktop window (Progman,
// "Program Manager") and its taskbar (no title); a driver closes them instead of reloading the page, which boots the
// machine again
export const homeTargets = wins => wins.filter(w => w.title && w.title !== 'Program Manager' && !w.minimized).map(w => w.title).reverse();

// boot: reload the page and time it until the shell has drawn its desktop
async function boot(c) {
  const t0 = Date.now();
  await c.call('Page.enable');
  await c.call('Page.reload', { ignoreCache: false });
  for (;;) {
    await new Promise(r => setTimeout(r, 10));
    let ready = false;
    try { ready = await c.evaluate(SHELL_READY); } catch (_) { /* page still loading */ }
    if (ready) break;
    if (Date.now() - t0 > 60000) throw new Error('shell did not boot within 60 s');
  }
  const nav = await c.evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; return { dom_content_loaded_ms: +n.domContentLoadedEventEnd.toFixed(1), load_ms: +n.loadEventEnd.toFixed(1) }; })()`);
  await new Promise(r => setTimeout(r, 300));
  return { to_desktop_ms: Date.now() - t0, ...nav };
}

export async function runAll(endpoint, prelude, steps, log = console.log) {
  const c = await connect(endpoint);
  const env = await c.evaluate(`({ userAgent: navigator.userAgent, screen: win95.screen(), dpr: devicePixelRatio, cores: navigator.hardwareConcurrency, store: typeof W95HOST === 'object' })`);
  env.browser = c.version.Browser; env.url = c.url;
  const results = {};
  log(`boot ...`); results.boot = await boot(c);
  for (const s of steps) {
    log(`${s.name} ...`);
    const src = typeof s.run === 'string' ? s.run : s.run.toString();
    try { results[s.name] = await c.evaluate(`(async () => { ${prelude}\n return await (${src})(); })()`); }
    catch (e) { results[s.name] = { failed: e.message.split('\n')[0] }; }
  }
  await c.evaluate(`(async () => { ${prelude}\n await reset(); })()`).catch(() => {});
  c.close();
  return { env, results, at: new Date().toISOString() };
}

// every leaf metric as [path, value]
export function flatten(o, pre = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const p = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, p, out); else out.push([p, v]);
  }
  return out;
}

export function table(results, baseline) {
  const base = baseline ? new Map(flatten(baseline)) : null, rows = [];
  for (const [p, v] of flatten(results)) {
    if (/\.n$|p50_ms$|max_ms$/.test(p)) continue;
    const row = { metric: p, value: v };
    if (base && base.has(p) && typeof v === 'number' && typeof base.get(p) === 'number') {
      const b = base.get(p); row.baseline = b;
      if (b !== 0) {
        const d = (v - b) / Math.abs(b) * 100, lowerBetter = /_ms$|_pct$/.test(p), higherBetter = /_per_s$/.test(p);
        row.change = `${d >= 0 ? '+' : ''}${d.toFixed(1)}%` + (Math.abs(d) < 10 || !(lowerBetter || higherBetter) ? '' : (d < 0) === lowerBetter ? ' better' : ' worse');
      }
    } else if (base && base.has(p)) row.baseline = base.get(p);
    rows.push(row);
  }
  return rows;
}

export function print(rows) {
  const cols = Object.keys(rows.reduce((a, r) => Object.assign(a, r), {}));
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = r => cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  ');
  console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
  console.log(w.map(n => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
}

// controls that change or destroy files, settings or the session: no automated driver presses them
export const DESTRUCTIVE = /^(Shut Down\.\.\.|Delete|Empty Recycle Bin|Format\.\.\.|Rename|Cut|Paste( Shortcut)?|Undo.*|Restore|Remove.*|Clear|Save|Save As\.\.\.|Print|Sharing\.\.\.|Disconnect.*|Restart.*|Log Off.*|Create Shortcut(\(s\) Here)?|New|Send To|Set as Wallpaper|Install)$/;

// what went wrong while the page ran, as gaps.mjs and explore.mjs report it, on a connection of its own with the
// __w95event binding registered: add(kind, detail) for each finding, onEvent(event) for every shell event
export async function capture(c, add, onEvent = () => {}) {
  c.onEvent = d => {
    if (d.method === 'Runtime.exceptionThrown') add('exception', d.params.exceptionDetails.exception?.description?.split('\n').slice(0, 2).join(' ') || d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning'))
      add('console.' + d.params.type, d.params.args.map(a => a.value ?? a.description ?? '').join(' ').split('\n')[0]);
    else if (d.method === 'Runtime.bindingCalled' && d.params.name === '__w95event') {
      const e = JSON.parse(d.params.payload);
      onEvent(e);
      if (e.type === 'key.unhandled') add('key unhandled', `${e.key} in ${e.target}`);
      else if (e.type === 'menu.noop') add('menu item does nothing', e.label);
      else if (e.type === 'button.noop') add('button does nothing', e.label);
      else if (e.type === 'program.exit' && e.why) add('program failed', `${e.path}: ${e.why}`);
      else if (e.type === 'window.open' && e.message && /error|warning/.test(e.message.type || '')) add(`${e.message.type} box`, `${e.title}: ${e.message.text.replace(/\s+/g, ' ')}`);
    }
  };
  await c.call('Runtime.enable');
  await c.call('Runtime.addBinding', { name: '__w95event' });
}

// a self-contained replay script: the steps (each run a function or the source of one), the runner's code without its
// exports, and a recorded run as the baseline
export function replaySource({ title, usage, prelude, steps, recorded, runnerSrc }) {
  const runner = runnerSrc.replace(/^export /gm, '');
  const st = steps.map(s => `  { name: ${JSON.stringify(s.name)}, about: ${JSON.stringify(s.about || '')},\n    run: ${typeof s.run === 'string' ? s.run : s.run.toString()} },`).join('\n');
  return `#!/usr/bin/env node
// ${title}
//
//   node ${usage} [endpoint]     default http://127.0.0.1:9334 (the app's control port)
//
// Runs the recorded steps against a running shell and prints each metric next to the value recorded here.
// --record prints this run's results as JSON instead.

const PRELUDE = ${JSON.stringify(prelude)};

const STEPS = [
${st}
];

const RECORDED = ${JSON.stringify(recorded, null, 2)};

// ---- runner (bench/runner.mjs)
${runner}
// ---- replay
const endpoint = process.argv.slice(2).find(a => !a.startsWith('--')) || 'http://127.0.0.1:9334';
const now = await runAll(endpoint, PRELUDE, STEPS, m => process.stderr.write(m + '\\n'));
if (process.argv.includes('--record')) console.log(JSON.stringify(now, null, 2));
else { console.log(\`recorded \${RECORDED.at} on \${RECORDED.env.browser}; now \${now.at} on \${now.env.browser}\\n\`); print(table(now.results, RECORDED.results)); }
`;
}
