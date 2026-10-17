// dev-page harness for the network bring-up: window.__net(budgetMs) starts MPREXE with traces and a time budget
window.__net = function (budget = 10000, opts = {}) {
  window.__e = []; window.__r = []; window.__t = [];
  const oe = console.error, ow = console.warn;
  console.error = (...a) => { __e.push(a.map(x => (x && x.message) || String(x)).join(' ').slice(0, 400)); oe(...a); };
  console.warn = (...a) => { __e.push('W ' + a.join(' ').slice(0, 400)); ow(...a); };
  window.W95VXDTRACE = (d, n, p, at) => { if (d === 1 && n === 0x3f) return; __t.push(d.toString(16) + ':' + n.toString(16) + '@' + at.toString(16)); if (__t.length > 600) __t.shift(); };
  window.W95VXDRET = (d, n, p, arg, r) => {
    let s = ''; try { s = [0, 1, 2, 3].map(i => arg(i).toString(16)).join(','); } catch (e) {}
    __r.push(d.toString(16) + ':' + n.toString(16) + ' (' + s + ') -> ' + r.toString(16)); if (__r.length > 600) __r.shift();
  };
  // the budget is for one stretch of the main thread: a timer the page runs between stretches marks where the last ended
  window.__b = new Uint32Array(256); window.__bn = 0; window.__tick = performance.now();
  clearInterval(window.__tickTimer); window.__tickTimer = setInterval(() => { window.__tick = performance.now(); }, 50);
  window.W95BTRACE = e => { __b[__bn++ & 255] = e; if ((__bn & 0xffff) === 0 && performance.now() - __tick > budget) throw new Error('budget'); };
  window.__done = false;
  setTimeout(() => win95.startNetwork().finally(() => { window.__done = true; }), 0);
};
window.__blocks = n => { const out = []; for (let i = n; i > 0; i--) out.push(__b[(__bn - i) & 255].toString(16)); return out.join(' '); };
