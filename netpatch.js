'use strict';
// Fixes to Windows' own code, kept by the file they belong to (its SHA-256 as it is on the disk or the CD), applied to
// the module's code before it is translated: a module loaded from its file as it loads (dyn.js netPatch, the memo's
// hash then the fixed code's), the bundle's modules as they are built (tools/netpatch.py, from build_system.py). Keyed
// by the file, a fix written for one build never touches another's code; another build's file needs its own entry.
//
//   files: { "<sha256>": { name, patches: [ { at, expect, bytes, why } | { at, handler, why } ] } }
//     at       "S:OFF" a 16-bit module's segment S (from 1) and offset OFF, hex; "rva:OFF" an image's offset, hex
//     expect   the bytes there as the file has them (hex); bytes, what the fix puts there: the same length
//     handler  a function of handlers below run as control arrives there (win32.js setEntryHook), the host's code
//
// The files part is JSON between its markers (tools/netpatch.py reads it)
(function () {
const files =
/*JSON*/{}/*END*/;
const handlers = {};
self.W95NetPatch = { files, handlers };
})();
