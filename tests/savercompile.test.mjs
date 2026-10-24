import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../saver-runtime.js', import.meta.url), 'utf8');
let compileCalls = 0, fetchCalls = 0, resolveCompile;
const context = {
  self: {},
  fetch(url) {
    fetchCalls++;
    const encoded = url.split(',')[1];
    const bytes = encoded === 'encoded' ? [1, 2, 3] : [4, 5];
    return Promise.resolve({ arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes).buffer) });
  },
  WebAssembly: {
    compile(bytes) {
      compileCalls++;
      assert.deepEqual([...bytes], [1, 2, 3]);
      return new Promise(resolve => { resolveCompile = resolve; });
    },
  },
};
vm.runInNewContext(source, context);
const { compileModule, findSaver, matchesImage, createPreviewWindow } = context.self.W95SaverRuntime;
const preview = createPreviewWindow(152, 104);
assert.equal(preview.pc, null, 'the host preview surface is not owned by a transient saver process');
assert.equal(preview.hostPreview, true);
assert.equal(preview.noInput, true);
assert.equal(preview.w, 152); assert.equal(preview.h, 104);
const bundles = {
  'SSPIPES.SCR': { wasm: 'encoded', scr: 'image-encoded' },
  'SSMAZE.SCR': { wasm: 'other-encoded' },
};
const longName = findSaver('C:\\WINDOWS\\SYSTEM\\3D Pipes.scr', bundles);
assert.equal(longName[0], 'SSPIPES.SCR'); assert.equal(longName[1], bundles['SSPIPES.SCR']);
const shortName = findSaver('C:/WINDOWS/SYSTEM/SSMAZE.SCR', bundles);
assert.equal(shortName[0], 'SSMAZE.SCR'); assert.equal(shortName[1], bundles['SSMAZE.SCR']);
assert.equal(findSaver('C:/WINDOWS/SYSTEM/unknown.scr', bundles), null, 'unknown saver names do not scan/decode bundled SCR binaries');
assert.equal(await matchesImage(Uint8Array.from([4, 5]), bundles['SSPIPES.SCR']), true, 'the selected image matches its bundle');
assert.equal(await matchesImage(Uint8Array.from([4, 6]), bundles['SSPIPES.SCR']), false, 'a modified image is rejected');
assert.equal(fetchCalls, 1, 'image verification decodes only the selected SCR and caches its bytes');
const saver = { wasm: 'encoded' };

const first = compileModule(saver);
const second = compileModule(saver);
await new Promise(resolve => setImmediate(resolve));
assert.equal(compileCalls, 1, 'concurrent saver launches share one asynchronous compilation');
assert.equal(fetchCalls, 2, 'the selected saver WASM is asynchronously decoded once');
assert.equal(first, second, 'concurrent callers await the same compilation');
const compiled = { compiled: true };
resolveCompile(compiled);
assert.deepEqual(await Promise.all([first, second]), [compiled, compiled]);
assert.equal(saver.modSync, compiled, 'successful compilation is cached for future launches');
assert.equal(await compileModule(saver), compiled);
assert.equal(compileCalls, 1, 'cached modules are not compiled again');
console.log('savercompile: ok');
