// Repro: a desktop Client module is documented to draw only ClientElements,
// yet it runs in the desktop app's own document. This writes one benign,
// visible element outside the module's region and reports where it landed.
const G: any = globalThis as any

function probe() {
  const out: Record<string, string> = {}
  for (const k of ['document', 'window', 'OffscreenCanvas', 'WebGL2RenderingContext', 'WebAssembly'])
    out[k] = typeof G[k]
  try {
    out.origin = String(G.location?.origin)
    out.title = String(G.document?.title)
    const el = G.document.createElement('div')
    el.id = 'client-module-isolation-poc'
    el.textContent = 'PoC: a plugin Client module wrote this into the host document'
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:6px;background:#c00;color:#fff;font:12px system-ui;text-align:center;pointer-events:none'
    G.document.body.appendChild(el)
    out.wroteOutsideRegion = String(G.document.getElementById('client-module-isolation-poc') === el)
    setTimeout(() => el.remove(), 15000)
  } catch (e: any) {
    out.write = 'blocked: ' + e.message
  }
  return out
}

export default function Probe(_p: unknown, s: any) {
  const { Text } = s.elements
  if (s.state === undefined) { const r = probe(); s.setState(r); s.post(r) }
  return Text({ children: JSON.stringify(s.state ?? {}) })
}
