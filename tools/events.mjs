// The pages' win95 events from the dev server's /__events (tools/serve.py; a page posts them with ?debug=1):
//
//     node tools/events.mjs wait http://127.0.0.1:8141 'window\.open' 5000   the first matching event after now, as JSON; exit 1 at the timeout
//     node tools/events.mjs tail http://127.0.0.1:8141                        every event from now on, a line of JSON each
const [cmd, endpoint, ...rest] = process.argv.slice(2);
const [match, ms] = cmd === 'wait' ? rest : [''];
if (!/^(wait|tail)$/.test(cmd || '') || !endpoint || match == null) {
  console.error('usage: node tools/events.mjs wait <endpoint> <type-regexp> [timeout-ms]\n       node tools/events.mjs tail <endpoint>');
  process.exit(2);
}
const base = endpoint.replace(/\/+$/, '');
async function poll(since, wait) {
  const q = new URLSearchParams({ wait: String(wait), match });
  if (since != null) q.set('since', String(since));
  // (the server answers local requests only, sent as JSON: tools/claude_api.py local_request)
  const r = await fetch(`${base}/__events?${q}`, { headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`${base}/__events: ${r.status}`);
  return r.json();
}
let since = null;
if (cmd === 'wait') {
  const end = Date.now() + (ms ? Number(ms) : 60000);
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) process.exit(1);
    const r = await poll(since, Math.min(left, 60000));
    if (r.events.length) { console.log(JSON.stringify(r.events[0])); process.exit(0); }
    since = r.next;
  }
} else {
  for (;;) {
    const r = await poll(since, 60000);
    for (const e of r.events) console.log(JSON.stringify(e));
    since = r.next;
  }
}
