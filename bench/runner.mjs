// Runs benchmark steps in the shell's page over the DevTools protocol and compares results with a baseline.
// Shared by bench.mjs and every replay script it records (which carry a copy of this file).

export async function connect(endpoint) {
  const list = await (await fetch(endpoint + '/json')).json();
  const page = list.find(t => t.type === 'page' && /index\.html|localhost:8095\/?$/.test(t.url)) || list.find(t => t.type === 'page');
  if (!page) throw new Error('no page at ' + endpoint);
  const version = await (await fetch(endpoint + '/json/version')).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(), events = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else events.push(d); };
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
  return { call, evaluate, version, url: page.url, close: () => ws.close() };
}

// boot: reload the page and time it until the shell has drawn its desktop
async function boot(c) {
  const t0 = Date.now();
  await c.call('Page.enable');
  await c.call('Page.reload', { ignoreCache: false });
  for (;;) {
    await new Promise(r => setTimeout(r, 10));
    let ready = false;
    try { ready = await c.evaluate(`typeof win95 === 'object' && win95.state.screen === 'desktop' && document.fonts.status === 'loaded'`); } catch (_) { /* page still loading */ }
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
