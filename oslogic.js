// A shared session's decisions about the OS's objects, with no I/O (window.W95OSLogic): what this machine sends of its
// own windows and what of the session's it sets here. win95.js runs them on the machine's windows (osRead, osApply);
// tests/sessionmodel.test.mjs runs the same code on modelled machines, under every interleaving, to check that the
// machines and the session agree once nothing is in flight.
(() => {
  const g = typeof self !== 'undefined' ? self : window;
  const same = (p, q) => JSON.stringify(p) === JSON.stringify(q);
  const GRIP = 40, CAPTION = 22;   // (of a title bar: the width left on the screen to drag it by; its height)
  /** a window's place as this machine shows the session's: moved only as far as keeps its title bar on this machine's
   *  work area (a screen smaller than the machine's that placed it); a minimized or maximized one as it is */
  function fit(v, area) {
    if (!area || !area.w || !area.h || v.min || v.max || v.x === undefined) return v;
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const x = clamp(v.x, area.x - v.w + GRIP, area.x + area.w - GRIP), y = clamp(v.y, area.y, area.y + area.h - CAPTION);
    return x === v.x && y === v.y ? v : { ...v, x, y };
  }
  /**
   * this machine's windows read (o.local: id -> state) against what it last saw of each (o.seen, kept here) and the
   * session's (o.world): which to send (sends: [id, state or null for one closed here]), which of the session's to set
   * here (applies: [id, state]), and which of the session's to start again (retries). o.starting: the ones being
   * started for the session (one up is taken off); o.closing: the mark of one this machine is closing; o.area and
   * o.lastArea: the work area now and at the last read (a change: the session's places set again, nothing sent)
   */
  function read(o) {
    const { world, local, seen, starting, closing } = o, sends = [], applies = [], retries = [];
    const area = JSON.stringify(o.area || null), resized = o.lastArea !== null && o.lastArea !== undefined && area !== o.lastArea;
    const reset = new Set();
    if (resized) for (const [id] of local) if (world.get(id) && seen.has(id) && seen.get(id) !== closing) { reset.add(id); applies.push([id, world.get(id)]); }
    for (const [id, v] of local) {
      if (reset.has(id)) continue;
      starting.delete(id);   // (one started for the session: up)
      if (seen.get(id) === closing || same(seen.get(id), v)) continue;   // (one this machine is closing: not reported)
      // (one the session has that came up here, started for it: the session's, set here; one of this machine's: sent)
      if (!seen.has(id) && world.get(id)) { seen.set(id, v); applies.push([id, world.get(id)]); continue; }
      seen.set(id, v); sends.push([id, v]);
    }
    for (const id of [...seen.keys()]) if (!local.has(id)) {
      const was = seen.get(id); seen.delete(id);
      if (was !== closing && world.get(id)) sends.push([id, null]);   // (closed by this machine's person: closed everywhere)
      else if (was === closing) for (const [w, v] of world) if (v && !local.has(w)) applies.push([w, v]);   // (one waiting for it to go)
    }
    // (one the session has that this machine has not, and is not starting: its start failed, or came too early)
    if (o.caught) for (const [id, wv] of world) if (wv && !local.has(id) && !starting.has(id) && !seen.has(id) && !sends.some(s => s[0] === id)) retries.push(id);
    return { sends, applies, retries, area };
  }
  g.W95OSLogic = { fit, read, same, GRIP, CAPTION };
})();
