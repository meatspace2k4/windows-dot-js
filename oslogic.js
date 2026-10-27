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
   * started for the session (one up is taken off); o.remoteClosed: the ids of the windows this machine closed under a
   * remote cause (another machine's person closed them there: the machine's cause tag, ne16.js remoteClose), whose
   * going is not a close of this machine's own; o.area and o.lastArea: the work area now and at the last read (a
   * change: the session's places set again, nothing sent)
   */
  function read(o) {
    const { world, local, seen, starting } = o, remoteClosed = o.remoteClosed || new Set(), sends = [], applies = [], retries = [];
    const area = JSON.stringify(o.area || null), resized = o.lastArea !== null && o.lastArea !== undefined && area !== o.lastArea;
    const reset = new Set();
    if (resized) for (const [id] of local) if (world.get(id) && seen.has(id) && !remoteClosed.has(id)) { reset.add(id); applies.push([id, world.get(id)]); }
    for (const [id, v] of local) {
      if (reset.has(id)) continue;
      starting.delete(id);   // (one started for the session: up)
      if (remoteClosed.has(id) || same(seen.get(id), v)) continue;   // (one closing under a remote cause: not reported)
      // (one the session has that came up here, started for it: the session's, set here; one of this machine's: sent)
      if (!seen.has(id) && world.get(id)) { seen.set(id, v); applies.push([id, world.get(id)]); continue; }
      const prev = seen.get(id); seen.set(id, v); sends.push([id, v, diff(prev, v)]);
    }
    for (const id of [...seen.keys()]) if (!local.has(id)) {
      seen.delete(id);
      if (!remoteClosed.has(id) && world.get(id)) sends.push([id, null]);   // (closed by this machine's person: closed everywhere)
      else if (remoteClosed.has(id)) { remoteClosed.delete(id); for (const [w, v] of world) if (v && !local.has(w)) applies.push([w, v]); }   // (one waiting for it to go)
    }
    // (one the session has that this machine has not, and is not starting: its start failed, or came too early)
    if (o.caught) for (const [id, wv] of world) if (wv && !local.has(id) && !starting.has(id) && !seen.has(id) && !sends.some(s => s[0] === id)) retries.push(id);
    return { sends, applies, retries, area };
  }
  // ---- an object's changes by field: its place's and other top-level fields, and each control. Two people changing
  // different fields of one window at once (one moving it, one typing in it) both keep their change; for one field, the
  // last the server has wins
  /** what changed from one state to the next, as a patch; the whole state for one not seen before */
  function diff(prev, v) {
    if (!prev || typeof prev !== 'object' || !v || typeof v !== 'object') return v;
    const p = {};
    for (const k of Object.keys(v)) if (k !== 'ctrls' && !same(prev[k], v[k])) p[k] = v[k];
    const pc = prev.ctrls || {}, vc = v.ctrls || {}, c = {};
    for (const k of Object.keys(vc)) if (!same(pc[k], vc[k])) c[k] = vc[k];
    if (Object.keys(c).length) p.ctrls = c;
    return p;
  }
  /** a state with a patch made to it (null: closed; a patch to nothing: the patch) */
  function merge(base, patch) {
    if (patch === null || patch === undefined) return null;
    if (!base || typeof base !== 'object') return patch;
    const out = { ...base, ...patch };
    if (base.ctrls || patch.ctrls) out.ctrls = { ...(base.ctrls || {}), ...(patch.ctrls || {}) };
    return out;
  }
  /** a patch's fields, by name ('ctrls.<control>' for a control) */
  const fields = patch => (patch ? Object.keys(patch).flatMap(k => (k === 'ctrls' ? Object.keys(patch.ctrls).map(c => `ctrls.${c}`) : [k])) : []);
  /** a patch without the given fields; null if none is left */
  function without(patch, drop) {
    const out = {};
    for (const k of Object.keys(patch)) {
      if (k === 'ctrls') { const c = Object.fromEntries(Object.entries(patch.ctrls).filter(([n]) => !drop.has(`ctrls.${n}`))); if (Object.keys(c).length) out.ctrls = c; }
      else if (!drop.has(k)) out[k] = patch[k];
    }
    return Object.keys(out).length ? out : null;
  }
  g.W95OSLogic = { fit, read, same, diff, merge, fields, without, GRIP, CAPTION };
})();
