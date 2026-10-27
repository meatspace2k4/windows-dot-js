// The fuzzer over real machines: three tabs of this page in a private shared session, driven from the dev pane.
// Load it in a tab with ?debug=1 and run it:
//
//   await import('/tools/convolution/fuzz-tabs.mjs'); await W95FuzzTabs.run({ seed: 1, actions: 10 })
//
// This tab opens two more on the same origin (B and C) in a session of its own. Machine A (this tab) gets random
// win95.* actions: programs run, text typed, windows moved and closed. B gets random delays and a reload in the
// middle; C joins late. Once things are quiet, every machine's digest is compared: the session's windows, the
// shared registry values (osclass.js REG), and the effects logs (an action doubled, an echo, a diverging value); MRU
// conflicts are logged. A failing trace is shrunk to the fewest actions that still fail (each try a fresh session)
// and saved as a replay test (a file offered to download, and its text in the result).
(() => {
  const g = window;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rng = seed => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const sha = async s => { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(h)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join(''); };
  const url = (session, user) => `${location.origin}/?debug=1&mute=1&session=${encodeURIComponent(session)}&user=${encodeURIComponent(user)}`;
  /** a tab's page once Windows is up in it (its shell's desktop, the system's machine alive) */
  async function up(w, ms = 180000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const p = w.win95; if (p && p.sysApp && p.sysApp.alive && p.windows().some(x => /Program Manager|Welcome/.test(x.title)) && !p.windows().some(x => /Windows 95 Setup/.test(x.title))) { await sleep(2500); return p; } } catch (_) { /* loading */ }
      await sleep(500);
    }
    throw new Error('a tab did not come up');
  }
  /** nothing in flight on any tab: the sync logs still, no object being started, for 3 s */
  async function quiet(tabs, ms = 40000) {
    const t0 = Date.now(); let still = 0, last = null;
    while (Date.now() - t0 < ms) {
      const now = tabs.map(w => { try { return (w.W95SYNCLOG || []).length + ':' + w.win95.windows().length; } catch (_) { return 'x'; } }).join('|');
      still = now === last ? still + 1 : 0; last = now;
      if (still >= 6) return true;
      await sleep(500);
    }
    return false;
  }
  // ---- the actions machine A takes, each a function of its page; named for the trace
  const ACTIONS = [
    ['run notepad', p => p.run('notepad')],
    ['run calc', p => p.run('calc')],
    ['type', p => { const w = p.windows().find(x => /Notepad/.test(x.title)); if (w) { p.activate(w.title); p.type('fuzz '); } }],
    ['move', p => { const w = p.windows().find(x => x.active && !/Program Manager/.test(x.title)); if (w) p.drag(w.x + 60, w.y + 8, w.x + 120, w.y + 40); }],
    ['close', p => { const w = p.windows().find(x => /Notepad|Calculator/.test(x.title)); if (w) p.close(w.title); }],
    ['alt+F4', p => p.key('alt+F4')],
    ['escape', p => p.key('esc')],
  ];
  const dismiss = async p => { for (let i = 0; i < 3; i++) { const m = p.windows().find(x => x.modal); if (!m) return; p.key('alt+n'); await sleep(400); p.key('esc'); await sleep(400); } };
  /** a machine's digest: the session's windows, the shared registry values, its effects, and its MRU values */
  async function digest(w) {
    const p = w.win95, C = w.W95OSClass, R = w.W95Win32;
    const wins = p.windows().filter(x => x.title && !/Program Manager|Welcome|Debug Monitor/.test(x.title)).map(x => x.title).sort();
    const shared = [], mru = [];
    for (const [path, m] of R.regDump()) {
      for (const [name, v] of m) {
        const key = `${path}\\${name}`;
        if (C.reg(path, name) === 'shared') shared.push([key, Array.from(v.data || [])]);
        if (/mru|recentdocs/i.test(path)) mru.push([key, Array.from(v.data || []).join(',')]);
      }
    }
    shared.sort((a, b) => (a[0] < b[0] ? -1 : 1)); mru.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const effects = (await p.sysApp.cmd('effects')) || [];
    const execs = effects.filter(e => e.kind === 'exec').map(e => `${e.what}@${e.cause}`), echoes = effects.filter(e => e.kind === 'echo').length;
    const doubled = execs.filter((e, i) => execs.indexOf(e) !== i && /@remote$/.test(e));
    return { wins, reg: await sha(JSON.stringify(shared)), regShared: shared.length, mru: await sha(JSON.stringify(mru)), mruN: mru.length, echoes, doubled, effects: effects.length };
  }
  /** one run: the tabs opened, the actions taken, the digests compared; { ok, why, trace, digests } */
  async function once({ seed = 1, actions = 10, session = `fuzz-${seed}-${Date.now().toString(36)}`, keep = false } = {}) {
    const r = rng(seed), trace = [];
    const me = g.win95; if (!me) throw new Error('run this in a page of the shell');
    const bw = g.open(url(session, 'Bob')); if (!bw) throw new Error('the browser blocked a tab: allow pop-ups for this page');
    let cw = null, cPage = null;
    // A joins its own session too: this page is reloaded into it only if it is not there already
    if (!(g.W95HOST && g.W95HOST.shared && g.W95HOST.shared.session === session)) throw new Error(`open this tab in the session first: ${url(session, 'Ann')}`);
    const bPage = await up(bw);
    const half = Math.max(1, actions >> 1);
    for (let i = 0; i < actions; i++) {
      const [name, f] = g.__fuzzPick ? g.__fuzzPick() : ACTIONS[Math.floor(r() * ACTIONS.length)];   // (a replay: its trace's actions in order)
      trace.push(name);
      try { await f(me); } catch (e) { trace[trace.length - 1] += ` (${e.message})`; }
      await sleep(300 + Math.floor(r() * 1200));
      if (i === half) { trace.push('B reloads'); bw.location.reload(); await up(bw); }
      if (i === half) { trace.push('C joins'); cw = g.open(url(session, 'Cal')); cPage = await up(cw); }
      if (r() < 0.3) await sleep(Math.floor(r() * 2000));   // (B's and C's delays: the others run on while A waits)
    }
    const tabs = [g, bw, cw].filter(Boolean);
    await quiet(tabs);
    for (const t of tabs) await dismiss(t.win95);
    await quiet(tabs);
    const digests = await Promise.all(tabs.map(digest));
    const names = ['A', 'B', 'C'];
    let why = null;
    for (let i = 1; i < digests.length; i++) {
      const a = digests[0], b = digests[i];
      if (JSON.stringify(a.wins) !== JSON.stringify(b.wins)) why = `${names[i]}'s windows differ from A's: ${JSON.stringify(b.wins)} vs ${JSON.stringify(a.wins)}`;
      else if (a.reg !== b.reg) why = `${names[i]}'s shared registry values differ from A's`;
    }
    const doubled = digests.flatMap((d, i) => d.doubled.map(x => `${names[i]}: ${x}`));
    if (!why && doubled.length) why = `a remote start made twice: ${doubled.join('; ')}`;
    const mruDiff = digests.some(d => d.mru !== digests[0].mru);
    if (mruDiff) console.log('[fuzz-tabs] MRU values differ between machines (logged, no rule yet):', digests.map(d => d.mru));
    if (!keep) for (const t of [bw, cw]) if (t) try { t.close(); } catch (_) { /* gone */ }
    return { ok: !why, why, trace, digests, session, mruDiff };
  }
  /** the trace shrunk: each action left out in turn, kept out while the failure stays; the shortest failing trace */
  async function shrink(o, trace) {
    let best = trace.filter(t => !/^(B reloads|C joins)$/.test(t));
    for (let i = 0; i < best.length;) {
      const t = [...best.slice(0, i), ...best.slice(i + 1)];
      const r = await replay({ ...o, trace: t });
      if (!r.ok) best = t; else i++;
    }
    return best;
  }
  /** a trace replayed in a fresh session (the named actions, in order, with the reload and the late join in the middle) */
  async function replay(o) {
    const pick = o.trace.map(n => ACTIONS.find(a => a[0] === n.replace(/ \(.*\)$/, '')) || ['escape', p => p.key('esc')]);
    let k = 0; try {
      g.__fuzzPick = () => pick[k++ % pick.length];
      return await once({ ...o, actions: pick.length, session: `fuzz-replay-${Date.now().toString(36)}` });
    } finally { delete g.__fuzzPick; }
  }
  /** the test file for a failing trace: a replay the fuzzer runs the same way */
  const testText = (o, trace, why) => `// A shared session's convolution found by tools/convolution/fuzz-tabs.mjs (seed ${o.seed}): ${why}\n` +
    `// Replay in a tab of the shell in a session: await import('/tools/convolution/fuzz-tabs.mjs'); await W95FuzzTabs.replay({ trace: ${JSON.stringify(trace)} })\n` +
    `export const trace = ${JSON.stringify(trace)};\nexport const why = ${JSON.stringify(why)};\n`;
  async function run(o = {}) {
    const first = await once(o);
    if (first.ok) { console.log(`[fuzz-tabs] ok: ${first.trace.length} steps, no divergence`, first.digests); return first; }
    console.log(`[fuzz-tabs] ${first.why}\n  ${first.trace.join('\n  ')}`);
    const small = o.shrink === false ? first.trace : await shrink(o, first.trace);
    const text = testText(o, small, first.why);
    try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' })); a.download = `fuzztabs-${o.seed || 1}.test.mjs`; a.click(); } catch (_) { /* no download: the text is in the result */ }
    return { ...first, shrunk: small, test: text };
  }
  g.W95FuzzTabs = { run, replay, once, ACTIONS, digest };
})();
