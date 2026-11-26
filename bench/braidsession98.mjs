#!/usr/bin/env node
// Braid in a shared session, with real machines: this page is Ann's machine in a fresh session, and Bob's and Cal's
// are frames in it (tools/convolution/fuzz-tabs.mjs's frames). Ann opens Notepad and marks m1 through the session;
// Calculator is opened and Notepad moved; Bob travels to m1 through the session. Then both machines must have the
// session's windows as at m1 (fuzz-tabs' digests equal: windows, shared registry, no program started twice) and
// Notepad where it was, with the server's world the same; Cal joins after, and must take that state without making
// the Braid intents again (no moment, no fork of its own).
//
//   node bench/braidsession98.mjs [endpoint]     a DevTools address (default http://127.0.0.1:9334) whose page is a
//                                                dev server's origin of its own (never one with work in it)
// In a page with no endpoint: `(await import('/bench/braidsession98.mjs')).pageCheck()`. Prints `BRAIDSESSION98 {json}`;
// exit 0 when it held. The three machines run at once: about three cores while it runs, a minute or two.
import { connect } from './runner.mjs';

/** runs in the page (Ann's machine, any session): { ok, why, steps } */
export const pageCheck = async (o = {}) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms)), steps = [], session = o.session || `braid-${Date.now().toString(36)}`;
  const step = s => steps.push(s);
  await import('/tools/convolution/fuzz-tabs.mjs'); const D = window.W95FuzzTabs.digest;
  const until = async (f, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* not yet */ } await sleep(400); } throw new Error(`no ${what} in ${ms / 1000} s`); };
  const upIn = w => until(() => { const p = w.win95; return p && p.sysApp && p.sysApp.alive && p.windows().some(x => /Program Manager/.test(x.title)) && p; }, 120000, 'Windows up');
  const frame = user => { const f = document.createElement('iframe'); f.src = `${location.origin}/?debug=1&mute=1&session=${session}&user=${user}&client=${user.toLowerCase()}${Math.random().toString(36).slice(2, 8)}`; Object.assign(f.style, { position: 'fixed', left: '0', top: '0', width: '1024px', height: '768px', opacity: '0.02', pointerEvents: 'none', zIndex: '-1' }); document.body.appendChild(f); return f; };
  const frames = [];
  try {
    if (!window.W95Shared || window.W95Shared.logon.session !== session) {
      // (Ann must be in the session herself: the page is moved into it, and this check run again there)
      if (o.noMove) throw new Error('this page is not in the session');
      const u = new URL(location.href); u.searchParams.set('session', session); u.searchParams.set('user', 'Ann'); u.searchParams.set('mute', '1');
      return { ok: false, moveTo: u.toString(), why: `open ${u} and run again with { session: '${session}' }` };
    }
    const A = await upIn(window); step('Ann up');
    const fb = frame('Bob'); frames.push(fb); const B = await upIn(fb.contentWindow); step('Bob up');
    for (const p of [A, B]) if (p.windows().some(x => x.title === 'Welcome')) p.close('Welcome');
    A.run('notepad'); await until(() => B.windows().some(x => /Notepad/.test(x.title)), 30000, 'Notepad on Bob'); await sleep(1500); step('Notepad shared');
    const at = p => { const w = p.windows().find(x => /Notepad/.test(x.title)); return w && [w.x, w.y]; };
    const before = at(A);
    await A.braid.mark('m1'); step('m1 marked through the session');
    const has = async p => (await p.braid.moments()).some(m => m.name === 'm1' && m.here);
    if (!(await has(A)) || !(await has(B))) throw new Error('m1 not on both machines');
    A.run('calc'); await until(() => B.windows().some(x => /Calculator/.test(x.title)), 30000, 'Calculator on Bob');
    const n = A.windows().find(x => /Notepad/.test(x.title)); await A.drag(n.x + 80, n.y + 8, n.x + 230, n.y + 128); await sleep(3000);
    if (JSON.stringify(at(A)) === JSON.stringify(before)) throw new Error('Notepad did not move');
    step('Calculator opened, Notepad moved');
    await B.braid.travel('m1'); await until(() => A.braid.line.gen >= 1 && B.braid.line.gen >= 1, 30000, 'travel on both'); await sleep(5000); step('Bob travelled; both at m1');
    const [da, db] = [await D(window), await D(fb.contentWindow)];
    const srv = await fetch(`/__session/${session}/state`).then(r => r.json()), sw = Object.values(srv.world).filter(Boolean);
    const want = ['Untitled - Notepad'];
    if (JSON.stringify(da.wins) !== JSON.stringify(want) || JSON.stringify(db.wins) !== JSON.stringify(want)) throw new Error(`windows after the travel: Ann ${JSON.stringify(da.wins)}, Bob ${JSON.stringify(db.wins)}`);
    if (da.reg !== db.reg) throw new Error('shared registry differs');
    if (da.doubled.length || db.doubled.length) throw new Error(`a program started twice: ${[...da.doubled, ...db.doubled]}`);
    if (JSON.stringify(at(A)) !== JSON.stringify(before) || JSON.stringify(at(B)) !== JSON.stringify(before)) throw new Error(`Notepad at ${at(A)} / ${at(B)}, at m1 ${before}`);
    if (sw.length !== 1 || sw[0].x !== before[0] || sw[0].y !== before[1]) throw new Error(`the server's world: ${JSON.stringify(sw)}`);
    if (Object.keys(srv.intents).some(k => /^braid/.test(k))) throw new Error('a Braid intent kept as a setting');
    step('digests equal, as at m1, the server too');
    const fc = frame('Cal'); frames.push(fc); const C = await upIn(fc.contentWindow);
    await until(() => C.windows().some(x => /Notepad/.test(x.title)), 30000, 'Notepad on Cal'); await sleep(4000);
    // (its own line: moments in its memory, and m1 anywhere; the origin's anchors from other runs are on every page's list)
    const cm = (await C.braid.moments()).filter(m => m.here || m.name === 'm1');
    if (cm.length || C.braid.line.gen !== 0) throw new Error(`the joiner made a Braid intent again: ${JSON.stringify(cm.map(m => m.name))}, generation ${C.braid.line.gen}`);
    const dc = await D(fc.contentWindow);
    if (JSON.stringify(dc.wins.filter(t => t !== 'Welcome')) !== JSON.stringify(want) || dc.reg !== da.reg) throw new Error(`the joiner's state: ${JSON.stringify(dc.wins)}`);
    step('Cal joined: the same state, no Braid intents made again');
    return { ok: true, steps };
  } catch (e) { return { ok: false, why: e.message, steps }; }
  finally { for (const f of frames) f.remove(); }
};

if (typeof process === 'object' && import.meta.url === `file://${process.argv[1]}`) {
  const c = await connect(process.argv[2] || process.env.W95_DEVTOOLS || 'http://127.0.0.1:9334');
  const session = `braid-${Date.now().toString(36)}`;
  let r = await c.evaluate(`import('/bench/braidsession98.mjs').then(m => m.pageCheck({ session: ${JSON.stringify(session)} }))`, 600000);
  if (r.moveTo) {
    await c.call('Page.navigate', { url: r.moveTo }); await new Promise(res => setTimeout(res, 3000));
    r = await c.evaluate(`import('/bench/braidsession98.mjs').then(m => m.pageCheck({ session: ${JSON.stringify(session)}, noMove: true }))`, 600000);
  }
  console.log('BRAIDSESSION98 ' + JSON.stringify(r));
  c.close(); process.exitCode = r.ok ? 0 : 1;
}
