// Winsock's VxD is one of the boot's (win95.js setupNetwork: Services\VxD\WSOCK StaticVxD wsock.vxd, vmm.js loads it
// from the disk): opened later by WSOCK32 as a dynamic VxD it failed SYS_DYNAMIC_DEVICE_INIT, and Internet Explorer
// said "an internal error occurred in the Windows Internet extensions"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'vmm.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, P = W.Process.prototype;
W.regSet('hklm\\system\\currentcontrolset\\services\\vxd\\wsock', 'StaticVxD', { type: 1, data: new TextEncoder().encode('wsock.vxd\0') });
const p = Object.create(P); p.host = { lan: true };
assert.ok(P.vxdStatics.call(p).includes('WSOCK.VXD'), 'WSOCK.VXD among the boot\'s VxDs');
const src = readFileSync(new URL('../vmm.js', import.meta.url), 'utf8');
assert.match(src, /const DISK_VXDS = new Set\(\[[^\]]*'WSOCK\.VXD'/, 'loaded from the disk');
assert.match(readFileSync(new URL('../win95.js', import.meta.url), 'utf8'), /vxd\\\\wsock', \{ StaticVxD: 'wsock\.vxd'/, 'setupNetwork writes it');
console.log('wsockstatic: ok');
