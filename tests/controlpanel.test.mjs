// Control Panel's applets: SHELL32 runs RUNDLL32 from Setup's SharedDir (HKLM CurrentVersion\Setup), so Setup's
// registration leaves it (the Windows folder); the system machine's exec finds the program by that full path and hands
// it the rest of the line
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };

{
  const reg = new Map(), key = (k, n) => k + '|' + n.toLowerCase();
  const R = { regGet: (k, n) => reg.get(key(k, n)), regSet: (k, n, v) => reg.set(key(k, n), new TextDecoder().decode(v.data)) };
  const run = () => new Function('W95Win32', 'W95FS', 'window', `const WINDIR = 'C:\\\\WINDOWS';\n${cut('function setupRegistration() {', '\n}')}\nsetupRegistration();`)(
    R, { encode: s => new TextEncoder().encode(s) }, {});
  run();
  assert.equal(reg.get(key('hklm\\software\\microsoft\\windows\\currentversion\\setup', 'SharedDir')), 'C:\\WINDOWS\0');
  reg.set(key('hklm\\software\\microsoft\\windows\\currentversion\\setup', 'SharedDir'), 'D:\\SHARED\0'); run();   // (one already there: kept)
  assert.equal(reg.get(key('hklm\\software\\microsoft\\windows\\currentversion\\setup', 'SharedDir')), 'D:\\SHARED\0');
}

// exec: RUNDLL32 by its full path (as SHELL32 combines SharedDir and its name), the applet's line as its arguments
{
  const k = readFileSync(new URL('../worker.js', import.meta.url), 'utf8'), i = k.indexOf('  exec(cmd, show) {'); assert.ok(i >= 0);
  const src = k.slice(i, k.indexOf('\n  }\n', i) + 4);
  const files = new Set(['C:\\WINDOWS\\RUNDLL32.EXE']);
  const fs = { exists: f => files.has(f.toUpperCase()), cwd: 'C:\\WINDOWS\\DESKTOP' };
  const join = (...a) => a.filter(Boolean).join('\\'), basename = f => f.slice(f.lastIndexOf('\\') + 1), extname = f => (/\.[^.\\]*$/.exec(f) || [''])[0];
  const A = new Function('fs', 'join', 'basename', 'extname', 'self', 'rpc', `return class {\n${src}\n spawnProgram(f, a) { return { f, a }; }\n isNE() { return false; }\n bundled() { return null; } }`)(fs, join, basename, extname, { W95SYSTEM: {} }, () => null);
  const a = new A();
  assert.deepEqual(a.exec('C:\\WINDOWS\\rundll32.exe shell32.dll,Control_RunDLL main.cpl,Mouse', 1), { f: 'C:\\WINDOWS\\rundll32.exe', a: 'shell32.dll,Control_RunDLL main.cpl,Mouse' });
  assert.deepEqual(a.exec('"C:\\WINDOWS\\rundll32.exe" shell32.dll,Control_RunDLL x', 1), { f: 'C:\\WINDOWS\\rundll32.exe', a: 'shell32.dll,Control_RunDLL x' });
  assert.deepEqual(a.exec('rundll32.exe x', 1), { f: 'C:\\WINDOWS\\rundll32.exe', a: 'x' });
  assert.equal(a.exec('C:\\NOWHERE\\rundll32.exe x', 1), 2);
  // a Windows 3.x program from disk the bundle does not carry (MSBDEMOS's chooser starting SOLARDEM): a task, as
  // KERNEL's WinExec starts one, its instance the answer, not a Win32 process record
  files.add('D:\\DEMOS\\SOLARDEM.EXE');
  const B = new Function('fs', 'join', 'basename', 'extname', 'self', 'rpc', `return class {\n${src}\n spawnProgram() { throw new Error('spawned as Win32'); }\n isNE() { return true; }\n bundled() { return null; } }`)({ ...fs, realpath: f => f }, join, basename, extname, { W95SYSTEM: {} }, () => null);
  const b = new B(), started = []; b.proc = { winExec16: (f, arg, show) => { started.push([f, arg, show]); return 0x1a27; } };
  assert.equal(b.exec('D:\\DEMOS\\SOLARDEM.EXE /x', 5), 0x1a27); assert.deepEqual(started, [['D:\\DEMOS\\SOLARDEM.EXE', '/x', 5]]);
}
console.log('controlpanel: ok');
