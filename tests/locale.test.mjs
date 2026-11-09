// Setup's national language support: LOCALE.INF's nls.reg (the code pages and locales Windows has) and its default
// locale's option (L0409: Nls\Locale's own value, the user's International locale, the ANSI and OEM code pages), on a
// registry that has not had them. Windows 98 Setup reads Nls\Locale's value for Internet Explorer's ChannelLocale
// (SETUPX), and wrote 0000 with none. nls.reg's RunOnce ADDREG.EXE only where the disk has the program.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
for (const file of ['fs.js', 'win32.js']) new Function(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))();
const src = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const fn = name => { const i = src.indexOf(`function ${name}(`), j = src.indexOf('\n}\n', i); return src.slice(i, j + 2); };
const INF = '[NLSAPI]\r\nAddReg    = nls.reg\r\n\r\n[Locale]\r\nDefaultOption=%Default_Locale%\r\n\r\n' +
  '[L0409]\r\nOptionDesc=%00000409%\r\nCopyFiles=CodePage437\r\nAddReg=SysLocale_0409, RegCP437\r\n\r\n' +
  '[SysLocale_0409]\r\nHKCU, "Control Panel\\International",Locale,,00000409\r\nHKLM, %KEY_Locale%,,,00000409\r\n\r\n' +
  '[RegCP437]\r\nHKLM, %KEY_Codepage%,ACP,,"1252"\r\nHKLM, %KEY_Codepage%,OEMCP,,"437"\r\n\r\n' +
  '[nls.reg]\r\nHKLM, Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce,NLSREG,,"%11%\\addreg.exe"\r\n' +
  'HKLM, %KEY_Codepage%,1252,,cp_1252.nls\r\nHKLM, %KEY_Locale%,00000409,,%00000409%\r\n\r\n' +
  '[Strings]\r\nKEY_Locale="system\\currentcontrolset\\control\\Nls\\Locale"\r\nKEY_Codepage="system\\currentcontrolset\\control\\Nls\\Codepage"\r\n' +
  'Default_Locale="L0409"\r\n00000409="English (United States)"\r\n';
const files = new Set();
const fs = { exists: p => files.has(p) };
const setupLocale = new Function('fs', 'W95Win32', 'W95FS', 'WINDIR', 'join',
  `${fn('infParse')}\n${fn('infAddReg')}\n${fn('setupLocale')}\nreturn setupLocale;`)(fs, window.W95Win32, window.W95FS, 'C:\\WINDOWS', window.W95FS.join);
window.W95SYSTEM = { infs: { 'LOCALE.INF': INF } };
const R = window.W95Win32, val = (k, n) => { const v = R.regGet(k, n); return v && window.W95FS.decode(v.data).replace(/\0+$/, ''); };
const NLS = 'hklm\\system\\currentcontrolset\\control\\nls', RO = 'hklm\\software\\microsoft\\windows\\currentversion\\runonce';

setupLocale();
assert.equal(val(NLS + '\\locale', ''), '00000409', 'the system locale, the default option\'s');
assert.equal(val(NLS + '\\locale', '00000409'), 'English (United States)', 'the locales, their names from [Strings]');
assert.deepEqual([val(NLS + '\\codepage', 'ACP'), val(NLS + '\\codepage', 'OEMCP'), val(NLS + '\\codepage', '1252')], ['1252', '437', 'cp_1252.nls']);
assert.equal(val('hkcu\\control panel\\international', 'Locale'), '00000409');
assert.equal(R.regGet(RO, 'NLSREG'), undefined, 'no ADDREG.EXE on the disk: no RunOnce item for it');

// a registry that has its locale is left as it is
R.regSet(NLS + '\\locale', '', { type: 1, data: window.W95FS.encode('00000407\0') });
files.add('C:\\WINDOWS\\SYSTEM\\ADDREG.EXE');
setupLocale();
assert.equal(val(NLS + '\\locale', ''), '00000407');
assert.equal(R.regGet(RO, 'NLSREG'), undefined);

// with the program on the disk, its RunOnce item is kept
R.regDel(NLS + '\\locale');
setupLocale();
assert.equal(val(RO, 'NLSREG'), 'C:\\WINDOWS\\SYSTEM\\addreg.exe');
console.log('locale: ok');
