// A meter in the page's corner, drawn as a Windows 95 window (the shell's palette and bevels, win95.js K, frameRaised,
// field): how much of each 8 s of wall time the system's machine spends running guest threads (worker.js
// switchMs.run, cmd 'views'), as a solid progress bar, and how far its own clock moves in that time (cmd 'now',
// which braid.speed stretches). For watching a long run, Windows 98 Setup's copy:
// `(await import('/tools/speedmeter.mjs')).show()`; `hide()` ends it.
const WINDOW = 8000, EVERY = 1000;
const K = { face: '#c0c0c0', lt: '#c0c0c0', hl: '#ffffff', sh: '#808080', dk: '#000000', cap: '#000080', win: '#ffffff' };
const raised = `inset -1px -1px ${K.dk}, inset 1px 1px ${K.lt}, inset -2px -2px ${K.sh}, inset 2px 2px ${K.hl}`;
const sunken = `inset 1px 1px ${K.sh}, inset -1px -1px ${K.hl}, inset 2px 2px ${K.dk}, inset -2px -2px ${K.lt}`;
const FONT = '11px/13px "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Geneva, sans-serif';
let box = null, timer = null;
export const show = () => {
  if (box) return box;
  box = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', right: '8px', top: '8px', zIndex: 99999, width: '206px', padding: '3px',
    background: K.face, boxShadow: raised, font: FONT, color: K.dk, userSelect: 'none', WebkitFontSmoothing: 'none' });
  const cap = document.createElement('div');
  // (Windows 98's caption: a gradient from the active caption colour to its second colour, the window's icon at the
  // left, bold text, and the close button's cross drawn in the face's own bevel)
  Object.assign(cap.style, { background: 'linear-gradient(90deg, #000080, #1084d0)', color: '#fff', fontWeight: 'bold', height: '18px',
    padding: '0 2px 0 2px', display: 'flex', alignItems: 'center', gap: '3px' });
  const icon = '<svg width="16" height="16" viewBox="0 0 16 16" style="flex:none" shape-rendering="crispEdges"><rect x="1" y="3" width="14" height="11" fill="#c0c0c0" stroke="#000"/>'
    + '<rect x="3" y="5" width="10" height="5" fill="#fff" stroke="#808080"/><rect x="4" y="6" width="2" height="3" fill="#000080"/><rect x="7" y="6" width="2" height="3" fill="#000080"/>'
    + '<rect x="10" y="6" width="2" height="3" fill="#ff0000"/><rect x="3" y="11" width="3" height="2" fill="#008000"/></svg>';
  cap.innerHTML = `${icon}<span style="flex:1;white-space:nowrap">Machine Speed</span>`;
  const x = document.createElement('div');
  Object.assign(x.style, { width: '16px', height: '14px', background: K.face, boxShadow: raised, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' });
  x.innerHTML = '<svg width="8" height="7" viewBox="0 0 8 7" shape-rendering="crispEdges"><path d="M0 0h2v1h1v1h2V1h1V0h2v1H7v1H6v1H5v1h1v1h1v1h1v1H6V6H5V5H3v1H2v1H0V6h1V5h1V4h1V3H2V2H1V1H0z" fill="#000"/></svg>';
  x.onclick = () => hide(); cap.appendChild(x);
  const body = document.createElement('div'); body.style.padding = '8px 6px 6px';
  body.innerHTML = '<div style="margin-bottom:4px">Turbo</div>';
  const well = document.createElement('div');
  // (Windows 98's progress bar with PBS_SMOOTH: a 1-pixel sunken border, one solid bar of the highlight colour)
  Object.assign(well.style, { height: '18px', background: K.face, boxShadow: `inset 1px 1px ${K.sh}, inset -1px -1px ${K.hl}`, padding: '2px', boxSizing: 'border-box' });
  const bar = document.createElement('div'); Object.assign(bar.style, { height: '100%', width: '0', background: K.cap }); well.appendChild(bar);
  const txt = document.createElement('div'); Object.assign(txt.style, { marginTop: '6px', display: 'flex', justifyContent: 'space-between' });
  txt.innerHTML = '<span class="run">…</span><span class="mach"></span>';
  body.append(well, txt); box.append(cap, body); document.body.appendChild(box);
  const samples = [];   // [wall ms, run ms, machine ms]
  const tick = async () => {
    const app = window.win95 && win95.sysApp; if (!app || !app.alive) { txt.querySelector('.run').textContent = 'No system machine'; return; }
    let v, now; try { [v, now] = await Promise.all([app.cmd('views'), app.cmd('now')]); } catch (_) { return; }
    const t = performance.now(); samples.push([t, v && v.switchMs ? v.switchMs.run : 0, now || 0]);
    while (samples.length > 1 && t - samples[0][0] > WINDOW) samples.shift();
    if (samples.length < 2) return;
    const [w0, r0, m0] = samples[0], [w1, r1, m1] = samples[samples.length - 1], k = WINDOW / (w1 - w0);
    const run = (r1 - r0) * k / 1000, mach = (m1 - m0) * k / 1000;
    bar.style.width = `${(Math.min(1, run / 8) * 100).toFixed(1)}%`;
    txt.querySelector('.run').textContent = `${run.toFixed(1)} s run`;
    txt.querySelector('.mach').textContent = `${mach.toFixed(1)} s machine`;
  };
  timer = setInterval(tick, EVERY); tick();
  return box;
};
export const hide = () => { clearInterval(timer); timer = null; if (box) box.remove(); box = null; };
