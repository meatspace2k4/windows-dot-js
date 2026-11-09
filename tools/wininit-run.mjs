#!/usr/bin/env node
// Windows 98's WININIT.EXE run offline in a DOS machine of the emulator (the bundle's MS-DOS 7.10, C: an in-memory
// fs.js through the redirector), with the WININIT.INI given: its screen and its last redirector calls.
//
//   node tools/wininit-run.mjs <WININIT.EXE> '[Rename]\nDIRNUL=C:\WINDOWS\$win98~1\n' ['{"C:\\path": "contents"}']
import { readFileSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname, [exePath, iniText, extra] = process.argv.slice(2);
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js', 'dyn.js', 'v86.js', 'msdos.js']) new Function(readFileSync(root + f, 'utf8'))();
const V = window.W95V86, D = window.W95DOS, b64 = s => Uint8Array.from(Buffer.from(s, 'base64'));
const fs = new window.W95FS.FileSystem(); fs.mount('C', { kind: 'fixed', total: 1 << 26 }); fs.mkdir('C:\\WINDOWS\\SYSTEM', { recursive: true });
fs.writeFile('C:\\WINDOWS\\WININIT.EXE', readFileSync(exePath));
fs.writeFile('C:\\WINDOWS\\WININIT.INI', Buffer.from(iniText.replace(/\\n/g, '\r\n')));
for (const [p, d] of Object.entries(JSON.parse(extra || '{}'))) fs.writeFile(p, Buffer.from(d));
fs.writeFile('C:\\WINDOWS\\WIN.COM', Uint8Array.of(0xcd, 0x20));   // (the program the box runs where WIN.COM would)
for (const k of Object.keys(D.files)) if (/COMMAND\.COM$/i.test(k)) fs.writeFile('C:\\' + k.split('\\').pop(), b64(D.files[k]));
const msdos = '[Paths]\r\nWinDir=C:\\WINDOWS\r\nWinBootDir=C:\\WINDOWS\r\nHostWinBootDrv=C\r\n[Options]\r\nBootGUI=0\r\nLogo=0\r\n' + Array(20).fill(';' + 'x'.repeat(68)).join('\r\n') + '\r\n';
const files = [{ name: 'IO.SYS', data: b64(D.files['IO.SYS']), attr: 7 }, { name: 'MSDOS.SYS', data: Buffer.from(msdos), attr: 7 },
  ...Object.keys(D.files).filter(p => p !== 'IO.SYS').map(p => ({ path: p, data: b64(D.files[p]) }))];
const m = V.machine({ disk: V.fat16(b64(D.boot), files, 16), program: 'C:\\COMMAND.COM', args: '/C C:\\WINDOWS\\WININIT.EXE', fs, capture: true });
m.v86Clock(); m.v86Boot();
const t0 = Date.now(); let st;
while (Date.now() - t0 < 60000) {
  st = m.v86Run(4000);
  if (st === 'idle') { m.halted = false; if (/Press any key/.test(m.out || '')) break; continue; }
  if (st === 'exit' || st === 'trap') break;
}
const screen = []; for (let y = 0; y < 25; y++) { let s = ''; for (let x = 0; x < 80; x++) { const c = m.u8[m.v86 + 0xb8000 + 2 * (y * 80 + x)]; s += c >= 32 && c < 127 ? String.fromCharCode(c) : c ? `{${c.toString(16)}}` : '.'; } if (s.replace(/[ .]/g, '')) screen.push(s.replace(/[ .]+$/, '')); }
console.log(JSON.stringify({ st, trapped: m.trapped || null, out: m.out || '', screen, rlog: (m.rlog || []).slice(-40), ini: fs.exists('C:\\WINDOWS\\WININIT.INI') ? 'INI' : fs.exists('C:\\WINDOWS\\WININIT.BAK') ? 'BAK' : 'gone' }, null, 1));
