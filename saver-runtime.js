'use strict';

// (in a function of its own: a script loaded again over the running machine (reloadScript, importScripts) redeclared
// its top-level consts, a SyntaxError, and the reload did nothing)
(() => {
const LONG_SAVER_NAMES = {
  'CURVES AND COLORS.SCR': 'BEZIER.SCR',
  'SCROLLING MARQUEE.SCR': 'SSMARQUE.SCR',
  'MYSTIFY YOUR MIND.SCR': 'SSMYST.SCR',
  'BLANK SCREEN.SCR': 'SCRNSAVE.SCR',
  'FLYING WINDOWS.SCR': 'SSFLYWIN.SCR',
  'FLYING THROUGH SPACE.SCR': 'SSSTARS.SCR',
  '3D FLYING OBJECTS.SCR': 'SS3DFO.SCR',
  '3D FLOWER BOX.SCR': 'SSFLWBOX.SCR',
  '3D MAZE.SCR': 'SSMAZE.SCR',
  '3D PIPES.SCR': 'SSPIPES.SCR',
  '3D TEXT.SCR': 'SSTEXT3D.SCR',
};

const decodeBase64 = async encoded => new Uint8Array(await (await fetch(`data:application/octet-stream;base64,${encoded}`)).arrayBuffer());

self.W95SaverRuntime = {
  createPreviewWindow(width, height) {
    return {
      kind: 'window', cls: { name: 'SAVER_PREVIEW', proc: 0, brush: 0 }, proc: 0, pc: null,
      style: 0x10000000, ex: 0, x: 0, y: 0, w: width, h: height, parent: 0, child: false, dirty: true,
      surfaceVersion: 1, title: '', extra: new Map(), hostPreview: true, noInput: true,
    };
  },
  findSaver(file, savers) {
    const leaf = String(file).replace(/\\/g, '/').split('/').pop().toUpperCase();
    const key = LONG_SAVER_NAMES[leaf] || leaf;
    return Object.hasOwn(savers, key) ? [key, savers[key]] : null;
  },
  decodeBase64,
  async matchesImage(bytes, saver) {
    const bundled = saver.scrBytes || (saver.scrBytes = await decodeBase64(saver.scr));
    if (bytes.length !== bundled.length) return false;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== bundled[i]) return false;
    return true;
  },
  compileModule(saver) {
    if (saver.modSync) return Promise.resolve(saver.modSync);
    if (!saver.modPromise) {
      saver.modPromise = decodeBase64(saver.wasm).then(bytes => WebAssembly.compile(bytes))
        .then(module => (saver.modSync = module))
        .finally(() => { saver.modPromise = null; });
    }
    return saver.modPromise;
  },
};
})();
