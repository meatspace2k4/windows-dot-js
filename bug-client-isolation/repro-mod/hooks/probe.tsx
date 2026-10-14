// Read-only: where does a desktop Client module run?
const G: any = globalThis as any
const t = (f: () => unknown) => { try { return String(f()) } catch (e: any) { return 'throws ' + (e?.name ?? '') + ': ' + (e?.message ?? e) } }

function probe() {
  return {
    href: t(() => G.location.href),
    origin: t(() => G.origin),
    isTop: t(() => G.top === G.self),
    frameElement: t(() => G.frameElement),
    parentDocument: t(() => G.parent.document.title),
    topDocument: t(() => G.top.document.body.tagName),
    viewport: t(() => G.innerWidth + 'x' + G.innerHeight),
    bodyChildren: t(() => G.document.body.childElementCount),
    cookie: t(() => G.document.cookie.length),
    localStorage: t(() => typeof G.localStorage),
  }
}

export default function Probe(_p: unknown, s: any) {
  const { Text } = s.elements
  if (s.state === undefined) { const r = probe(); s.setState(r); s.post(r) }
  return Text({ children: JSON.stringify(s.state ?? {}) })
}
