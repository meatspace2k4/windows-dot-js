// KERNEL32 SetTimeZoneInformation records the zone as Windows 95 keeps it, under HKLM\System\CurrentControlSet\
// control\TimeZoneInformation, and returns TRUE. Date/Time Properties (TIMEDATE.CPL) sets it on Windows 95 OSR 2.5
// Setup's first start, and with no stand-in for the call MSGSRV32 was ended ("an illegal operation")
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.self = globalThis;
for (const f of ['fs.js', 'win32.js', 'ne16.js']) new Function(readFileSync(new URL('../' + f, import.meta.url), 'utf8'))();
const W = window.W95Win32, API = W.API, dec = v => W95FS.decode(v.data).replace(/\0.*$/, '');
const u8 = new Uint8Array(4096), dv = new DataView(u8.buffer);
const g = { u8, r32: a => dv.getUint32(a, true), r16: a => dv.getUint16(a, true),
  readW(a, n) { let s = ''; for (let i = 0; i < n; i++) { const c = dv.getUint16(a + 2 * i, true); if (!c) break; s += String.fromCharCode(c); } return s; } };
const tz = 0x100, wstr = (o, s) => [...s].forEach((c, i) => dv.setUint16(tz + o + 2 * i, c.charCodeAt(0), true));
dv.setInt32(tz, 420, true); wstr(4, 'US Mountain Standard Time'); dv.setInt32(tz + 148, 0, true);
wstr(152, 'US Mountain Daylight Time'); dv.setInt32(tz + 296, -60, true); dv.setUint16(tz + 132 + 2, 10, true);   // (StandardDate: October)
assert.equal(API.KERNEL32.SetTimeZoneInformation[1].call(g, tz), 1, 'TRUE');
const key = 'hklm\\system\\currentcontrolset\\control\\timezoneinformation', v = n => W.regGet(key, n);
assert.equal(new DataView(v('Bias').data.buffer, v('Bias').data.byteOffset).getInt32(0, true), 420, 'its bias');
assert.equal(dec(v('StandardName')), 'US Mountain Standard Time');
assert.equal(dec(v('DaylightName')), 'US Mountain Daylight Time');
assert.equal(v('StandardStart').data[2], 10, 'the standard date, a SYSTEMTIME');
assert.equal(new DataView(v('DaylightBias').data.buffer, v('DaylightBias').data.byteOffset).getInt32(0, true), -60);
console.log('settimezone: ok');
