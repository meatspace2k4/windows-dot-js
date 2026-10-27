// Sketching in a program with the mouse, from vectors (window.W95Sketch): an SVG's paths (M, L, H, V, C, S, Q, T, A,
// Z, absolute or relative) flattened to polylines, each subpath one stroke of the pointer (down, the moves, up),
// through the page's own input (win95.down/move/up), so what Paint gets is what a hand would give it: a pen that
// moves a few pixels at a time along the curve. Loaded in a tab with ?debug=1:
//
//   await import('/tools/sketch.mjs'); await W95Sketch.draw(svgText, { box: { x, y, w, h } })
//
// box: where on the screen the drawing's viewBox goes (fit inside, centred, aspect kept). Each stroke's points are
// spaced `step` pixels apart (3), corners kept (a cusp is a point of its own), and the pen's speed is a pace of
// `ms` per point (6) so the program takes every move. Strokes shorter than two points are a dot (down and up).
// `paths(svg)` gives the strokes as screen points without drawing them; `flatten(d)` a path's polylines in its own
// units. Bezier curves are split by flatness (a chord off its curve by under a fifth of a pixel at the drawn size).
(() => {
  const g = window;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // ---- the path's commands: numbers after letters, as the SVG grammar reads them
  function tokens(d) {
    const out = []; const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g; let m;
    while ((m = re.exec(d))) out.push(m[1] ? m[1] : parseFloat(m[2]));
    return out;
  }
  // an arc as cubic curves (the endpoint parameterisation of SVG's A command to its centre, then one cubic per quarter)
  function arcToCubics(x1, y1, rx, ry, phi, large, sweep, x2, y2) {
    if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
    const rad = phi * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry); if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let k = Math.sqrt(Math.max(0, num / den)); if (large === sweep) k = -k;
    const cxp = k * rx * y1p / ry, cyp = -k * ry * x1p / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI; if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.ceil(Math.abs(dt) / (Math.PI / 2)), out = [];
    for (let i = 0; i < n; i++) {
      const a = t1 + dt * i / n, b = t1 + dt * (i + 1) / n, t = 4 / 3 * Math.tan((b - a) / 4);
      const p = th => [cos * rx * Math.cos(th) - sin * ry * Math.sin(th) + cx, sin * rx * Math.cos(th) + cos * ry * Math.sin(th) + cy];
      const d = th => [-cos * rx * Math.sin(th) - sin * ry * Math.cos(th), -sin * rx * Math.sin(th) + cos * ry * Math.cos(th)];
      const [ax, ay] = p(a), [bx, by] = p(b), [dax, day] = d(a), [dbx, dby] = d(b);
      out.push([ax + t * dax, ay + t * day, bx - t * dbx, by - t * dby, bx, by]);
    }
    return out;
  }
  /** a cubic's points by flatness: split until each chord is within tol of its curve */
  function cubic(out, x0, y0, x1, y1, x2, y2, x3, y3, tol, depth = 0) {
    const d1 = Math.abs((x1 - x3) * (y0 - y3) - (y1 - y3) * (x0 - x3)), d2 = Math.abs((x2 - x3) * (y0 - y3) - (y2 - y3) * (x0 - x3));
    const dd = (x0 - x3) ** 2 + (y0 - y3) ** 2;
    if (depth > 16 || (d1 + d2) ** 2 <= tol * tol * dd * 16 && dd < 64 * 64 || dd < 1) { out.push([x3, y3]); return; }
    // (de Casteljau: the two halves)
    const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2, x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2, x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
    const x012 = (x01 + x12) / 2, y012 = (y01 + y12) / 2, x123 = (x12 + x23) / 2, y123 = (y12 + y23) / 2, xm = (x012 + x123) / 2, ym = (y012 + y123) / 2;
    cubic(out, x0, y0, x01, y01, x012, y012, xm, ym, tol, depth + 1); cubic(out, xm, ym, x123, y123, x23, y23, x3, y3, tol, depth + 1);
  }
  /** a path's polylines (one per subpath, [[x, y], ...]) in the path's own units; tol: flatness in those units */
  function flatten(d, tol = 0.1) {
    const t = tokens(d), polys = []; let poly = null, cmd = null, i = 0;
    let x = 0, y = 0, sx = 0, sy = 0, px = null, py = null, pq = null;   // (the last control point, for S and T)
    const num = () => t[i++];
    const start = () => { poly = [[x, y]]; polys.push(poly); sx = x; sy = y; };
    while (i < t.length) {
      if (typeof t[i] === 'string') cmd = t[i++];
      else if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l';
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      const ox = rel ? x : 0, oy = rel ? y : 0;
      let last = null;
      if (C === 'M') { x = ox + num(); y = oy + num(); start(); }
      else if (C === 'L') { x = ox + num(); y = oy + num(); poly.push([x, y]); }
      else if (C === 'H') { x = ox + num(); poly.push([x, y]); }
      else if (C === 'V') { y = oy + num(); poly.push([x, y]); }
      else if (C === 'C' || C === 'S') {
        let x1, y1; if (C === 'C') { x1 = ox + num(); y1 = oy + num(); } else { x1 = px !== null ? 2 * x - px : x; y1 = py !== null ? 2 * y - py : y; }
        const x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num();
        cubic(poly, x, y, x1, y1, x2, y2, x3, y3, tol); last = [x2, y2]; x = x3; y = y3;
      } else if (C === 'Q' || C === 'T') {
        let x1, y1; if (C === 'Q') { x1 = ox + num(); y1 = oy + num(); } else { x1 = pq ? 2 * x - pq[0] : x; y1 = pq ? 2 * y - pq[1] : y; }
        const x2 = ox + num(), y2 = oy + num();
        cubic(poly, x, y, x + 2 / 3 * (x1 - x), y + 2 / 3 * (y1 - y), x2 + 2 / 3 * (x1 - x2), y2 + 2 / 3 * (y1 - y2), x2, y2, tol);
        pq = [x1, y1]; x = x2; y = y2;
      } else if (C === 'A') {
        const rx = num(), ry = num(), phi = num(), large = !!num(), sweep = !!num(), x2 = ox + num(), y2 = oy + num();
        for (const c of arcToCubics(x, y, rx, ry, phi, large, sweep, x2, y2)) { cubic(poly, x, y, ...c, tol); x = c[4]; y = c[5]; }
      } else if (C === 'Z') { if (poly && (poly[0][0] !== x || poly[0][1] !== y)) poly.push([sx, sy]); x = sx; y = sy; if (i < t.length && typeof t[i] !== 'string') start(); }
      else throw new Error(`sketch: no command ${cmd}`);
      px = last ? last[0] : null; py = last ? last[1] : null; if (C !== 'Q' && C !== 'T') pq = null;
    }
    return polys.filter(p => p.length);
  }
  /** the paths of an SVG (its <path d>, <line>, <polyline>, <polygon>, <rect>, <circle>, <ellipse>) and its viewBox */
  function parse(svg) {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml'), root = doc.documentElement;
    const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const box = vb.length === 4 && vb.every(n => !isNaN(n)) ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : { x: 0, y: 0, w: +root.getAttribute('width') || 100, h: +root.getAttribute('height') || 100 };
    const ds = [], a = (el, n) => +el.getAttribute(n) || 0;
    for (const el of root.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse')) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'path') ds.push(el.getAttribute('d') || '');
      else if (tag === 'line') ds.push(`M${a(el, 'x1')},${a(el, 'y1')}L${a(el, 'x2')},${a(el, 'y2')}`);
      else if (tag === 'polyline' || tag === 'polygon') { const p = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number); let d = `M${p[0]},${p[1]}`; for (let i = 2; i < p.length; i += 2) d += `L${p[i]},${p[i + 1]}`; ds.push(tag === 'polygon' ? d + 'Z' : d); }
      else if (tag === 'rect') { const x = a(el, 'x'), y = a(el, 'y'), w = a(el, 'width'), h = a(el, 'height'); ds.push(`M${x},${y}h${w}v${h}h${-w}Z`); }
      else if (tag === 'circle' || tag === 'ellipse') { const cx = a(el, 'cx'), cy = a(el, 'cy'), rx = tag === 'circle' ? a(el, 'r') : a(el, 'rx'), ry = tag === 'circle' ? a(el, 'r') : a(el, 'ry'); ds.push(`M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`); }
    }
    return { box, ds };
  }
  /** a polyline resampled to points `step` apart along it, its corners kept (a bend sharper than 25 degrees is a point) */
  function resample(poly, step) {
    const out = [poly[0]]; let acc = 0;
    for (let i = 1; i < poly.length; i++) {
      const [x0, y0] = poly[i - 1], [x1, y1] = poly[i], len = Math.hypot(x1 - x0, y1 - y0);
      if (!len) continue;
      let d = step - acc;
      while (d <= len) { out.push([x0 + (x1 - x0) * d / len, y0 + (y1 - y0) * d / len]); d += step; }
      acc = len - (d - step);
      // (a corner: the next segment turns sharply; the point itself is kept)
      if (i + 1 < poly.length) { const [x2, y2] = poly[i + 1], a = Math.atan2(y1 - y0, x1 - x0), b = Math.atan2(y2 - y1, x2 - x1); let t = Math.abs(a - b); if (t > Math.PI) t = 2 * Math.PI - t; if (t > 25 * Math.PI / 180) { out.push([x1, y1]); acc = 0; } }
    }
    const last = poly[poly.length - 1], end = out[out.length - 1]; if (end[0] !== last[0] || end[1] !== last[1]) out.push(last);
    return out;
  }
  /** an SVG's strokes as screen points: its viewBox fitted into box (centred, aspect kept) */
  function paths(svg, o = {}) {
    const { box: vb, ds } = parse(svg), box = o.box || { x: 0, y: 0, w: 400, h: 300 }, step = o.step || 3;
    const s = Math.min(box.w / vb.w, box.h / vb.h), ox = box.x + (box.w - vb.w * s) / 2 - vb.x * s, oy = box.y + (box.h - vb.h * s) / 2 - vb.y * s;
    const strokes = [];
    for (const d of ds) for (const poly of flatten(d, 0.2 / s)) {
      const pts = poly.map(([x, y]) => [x * s + ox, y * s + oy]);
      strokes.push(resample(pts, step).map(([x, y]) => [Math.round(x), Math.round(y)]));
    }
    return strokes;
  }
  /** the SVG drawn with the pointer: each stroke down, along, up; o.ms the pace per point; o.pointer a function(type, x, y)
   *  in place of the page's own (win95.down/move/up); o.on(stroke index, strokes) between strokes */
  async function draw(svg, o = {}) {
    const strokes = paths(svg, o), ms = o.ms === undefined ? 6 : o.ms, w = g.win95;
    const ptr = o.pointer || ((t, x, y) => (t === 'down' ? w.down(x, y) : t === 'up' ? w.up(x, y) : w.move(x, y)));
    for (let i = 0; i < strokes.length; i++) {
      const pts = strokes[i];
      ptr('move', pts[0][0], pts[0][1]); await sleep(ms * 2);
      ptr('down', pts[0][0], pts[0][1]); await sleep(ms);
      for (let k = 1; k < pts.length; k++) { ptr('move', pts[k][0], pts[k][1]); await sleep(ms); }
      ptr('up', pts[pts.length - 1][0], pts[pts.length - 1][1]); await sleep(ms * 4);
      if (o.on) await o.on(i, strokes);
    }
    return strokes;
  }
  g.W95Sketch = { draw, paths, flatten, parse, resample, tokens };
})();
