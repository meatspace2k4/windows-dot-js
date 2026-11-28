// TCP/IP's VxDs load from the disk at boot (vmm.js DISK_VXDS, vxdBoot asks with disk): only the bundle's were
// loaded, and TCP/IP installed by Network's Add had no network under it
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../vmm.js', import.meta.url), 'utf8');
const m = /const DISK_VXDS = new Set\(\[([^\]]*)\]\)/.exec(src);
for (const f of ['VIP.386', 'VTCP.386', 'VDHCP.386', 'VNBT.386', 'WSOCK.VXD']) assert.ok(m[1].includes(`'${f}'`), f);
assert.match(src, /this\.vxdStatics\(\)\.map\(f => this\.vxd\(f, true\)\)/, 'static VxDs looked for on the disk too');
console.log('tcpipvxds: ok');
