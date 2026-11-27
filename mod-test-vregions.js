// (a test: VirtualAlloc's regions in this machine by owner (the process they go with, or kept), their total, the spare
// list, and the address space above the heap they came from, into the console)
(() => {
  const p = typeof machine !== 'undefined' && machine.proc; if (!p) return;
  const by = {}; let total = 0, n = 0;
  for (const [b, r] of p.vregions || []) {
    const k = r.pc ? (r.pc.path || '?').split('\\').pop() + (r.pc.exitCode != null ? ' (ended)' : '') : 'kept' + (r.heap ? ' (heap)' : '') + ' ' + (r.by || '');
    const e = by[k] || (by[k] = { n: 0, mb: 0, big: 0 }); e.n++; e.mb += r.size / 1048576; if (r.size >= 0x100000) e.big++; total += r.size; n++;
  }
  const kept = [...(p.vregions || [])].filter(([, r]) => !r.pc).map(([b, r]) => `${(b >>> 0).toString(16)}+${(r.size / 1048576).toFixed(2)}MB${r.heap ? ' heap' : ''} first bytes ${Array.from(p.u8.subarray(b, b + 16), v => v.toString(16).padStart(2, '0')).join('')}`);
  console.warn('[vregions kept] ' + JSON.stringify(kept));
  const spare =(p.vspare || []).reduce((s, r) => s + r.size, 0);
  console.warn('[vregions] ' + JSON.stringify({ n, totalMB: +(total / 1048576).toFixed(1), spareMB: +(spare / 1048576).toFixed(1), spareN: (p.vspare || []).length, vmLo: p.vmLo && (p.vmLo >>> 0).toString(16), vmTop: (p.vmTop >>> 0).toString(16),
    by: Object.entries(by).sort((a, b) => b[1].mb - a[1].mb).slice(0, 20).map(([k, v]) => `${k}: ${v.n} regions ${v.mb.toFixed(1)}MB (${v.big} of 1MB+)`) }));
})();
