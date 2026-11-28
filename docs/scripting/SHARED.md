# Shared sessions

In a shared session several people use one Windows: each runs their own machine on the session's disk and registry,
and each program's windows are the session's objects, kept alike on every machine. A person's mouse strokes into a
window (a drag in Paint, a card in Solitaire) are fed into every machine's copy of that window, so several people can
draw in one Paint at once; the windows are the same size everywhere so the strokes land alike. Another person's pointer
is drawn where their stroke has got to.

To draw with the pointer from an SVG: `await import('/tools/sketch.mjs'); await W95Sketch.draw(svgText, { box, ms })`
(paths, lines, shapes, each subpath one stroke). To fuzz a session over real machines, in a tab opened with
`?debug=1&mute=1&session=<name>&user=Ann`: `await import('/tools/convolution/fuzz-tabs.mjs');
await W95FuzzTabs.run({ seed: 1, actions: 10 })`; it opens two more tabs (or frames, `{ frames: true }`), acts on one
while another reloads and a third joins late, compares the machines, and shrinks a failing trace to a replay test.
