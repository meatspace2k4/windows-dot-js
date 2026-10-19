// Screen savers must run and render as ordinary processes and HWNDs in the worker machine, never as page-created canvases.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const k = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const g = readFileSync(new URL('../win32.js', import.meta.url), 'utf8');
const n = readFileSync(new URL('../ne16.js', import.meta.url), 'utf8');
const sr = readFileSync(new URL('../saver-runtime.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

assert.match(k, /'dyn\.js', 'savers\.js'/, 'the worker loads the compiled saver bundle');
assert.match(k, /'savers\.js', 'saver-runtime\.js'/, 'the worker loads the asynchronous saver compiler');
assert.match(sw, /'savers\.js', 'saver-runtime\.js'/, 'the service worker precaches the worker runtime dependency');
assert.match(k, /fs\.readFile\(file\)/, 'the mounted SCR file supplies the process image');
assert.match(k, /async spawnSaverAsync\(file, arg\)[\s\S]*?findSaver\(file, savers\)[\s\S]*?await self\.W95SaverRuntime\.matchesImage\(bytes, d\)[\s\S]*?await self\.W95SaverRuntime\.compileModule\(d\)/,
  'selection resolves and asynchronously validates one bundle before compiling it');
assert.doesNotMatch(k, /Object\.entries\(savers\)\.find|d\.scrBytes\s*=\s*b64bytes\(d\.scr\)/,
  'selection never synchronously scans and decodes the whole saver bundle');
assert.match(sr, /LONG_SAVER_NAMES[\s\S]*?findSaver\(file, savers\)/,
  'installed long saver filenames map directly to their bundled image names');
assert.match(k, /createPreviewWindow\(152, 104\)/, 'the /p parent is a Win32 handle, not a separately rendered preview surface');
assert.match(k, /return \/\\.SCR\$\/i\.test\(args\[0\] \|\| ''\) \? this\.spawnSaverAsync\(/,
  'the UI spawn command uses the non-blocking saver launch path');

assert.match(w, /app\.spawnProgram\(s\.path, '\/p 0x7ff0'\)/, 'Preview launches the SCR with its actual process HWND');
assert.match(w, /stopSaverProcess\(previewRun\)/, 'switching or closing the applet terminates its process');
assert.match(w, /previewWindowHwnd = result\.previewHwnd \|\| 0;[\s\S]*?w\.preview && w\.guestParent === previewWindowHwnd/,
  'the monitor resolves the actual guest child HWND from worker frames');
assert.match(w, /const guestWindow = sysApp && previewWindowHwnd && \[\.\.\.sysApp\.wins\.values\(\)\]\.find\(w => w\.preview && w\.guestParent === previewWindowHwnd\);[\s\S]*?ctx\.drawImage\(guestWindow\.surface/,
  'the monitor displays the guest window surface directly, without a preview canvas');
assert.match(k, /w\.child && !w\.previewChild[\s\S]*?w\.ctx\.getImageData\(0, 0, w\.w, w\.h\)[\s\S]*?preview: !!w\.previewChild/,
  'the actual saver child HWND surface is copied into machine frames');
assert.match(w, /if \(this\.preview && windows\.some\(w => w\.title === 'Display Properties'\)\) dirty\(\);/,
  'new preview pixels invalidate the monitor window for repaint');
assert.match(w, /if \(w\.win32\) \{ if \(w\.surface\) ctx\.drawImage\(w\.surface/, 'the existing NativeWin pass draws guest surfaces');
assert.doesNotMatch(w, /class SaverRun|saverRuns|overlayAt|saverStop|saverExit/, 'page-side saver execution and overlay are absent');
assert.doesNotMatch(k, /host', 'saver|saverExit|saverStop/, 'the worker no longer diverts saver execution through page RPC');
assert.match(g, /pw && pw\.hostPreview[\s\S]*?win\.previewChild = true;[\s\S]*?win\.ctx = this\.host\.surface\(hwnd, win\.w, win\.h, win, this\.pc\)/,
  'the saver child HWND renders through its ordinary machine-owned window surface');
assert.doesNotMatch(g, /W95SaverRuntime/, 'page-hosted Win32 windows do not require worker-only saver runtime globals');
assert.doesNotMatch(g, /host\.previewParent|host\.previewW|host\.previewH/, 'USER32 has no synthetic preview-parent exception');
assert.match(n, /destroy\[1\]\.call\(this, w\.hwnd\)/, 'process exit destroys its guest-owned windows');
assert.match(k, /pc = p\.spawn\(bytes, mod, \{ \.\.\.d\.meta/, 'the saver is launched through the ordinary machine process API');
assert.match(k, /for \(const dll of native \? \[\] : \['USER32', 'GDI32', 'OPENGL32', 'GLU32'\]\)[\s\S]*?native\.exports\.set\(fn, p\.thunkFor\(dll, fn\)\)[\s\S]*?finally \{ for \(const \[native, fn, address\] of rebound\)/,
  'a saver on the machine with its own USER32 binds to it; only a machine without one rebinds to the JS personality');
assert.match(k, /const native = !!isWin && \(mode !== 'p' \|\| \(named > 0 && !!p\.call\(isWin, \[named\]\)\)\)/,
  'a /p saver runs on the machine USER32 when the starter named a real USER window (Display Properties\' monitor)');
assert.match(k, /cmdline = native \? `"\$\{real\}" \$\{arg\.trim\(\) \|\| '\/s'\}`/,
  'the native saver gets the command line its starter gave (/p hwnd of the monitor window, /c:hwnd)');
assert.match(k, /pc\.nativeGdi = native/, 'the saver process records that its DCs are the machine GDI32\'s (gl.js presents through it)');
assert.match(k, /pc\.onExit = code =>/, 'the normal child-process lifecycle reports saver exit');
assert.doesNotMatch(k, /savers\.values\(\).*dispatchInput|\.map\(run => run\.proc\)/,
  'P.spawn process records are not mistaken for independent Process instances');
assert.match(k, /p\.dispatchInput\(W\.WM\.MOUSEMOVE/,
  'child saver windows share the system machine input dispatcher');
assert.match(k, /host\.vmTop = 0x0a000000/, 'the system VM allocator skips the saver static image and lookup region');
assert.match(k, /pc\.previewHwnd = run\.previewHwnd;\s*if \(mode === 'p' && !native\) pc\.previewKey = `w32:\$\{run\.previewHwnd\}`;[\s\S]*?return pc;/,
  'WinExec receives the actual child process and only preview mode returns its HWND key');
assert.match(k, /previewCmd = `"\$\{real\}" \/p \$\{parent\.hwnd\}`/,
  'the preview HWND uses decimal format expected by the saver argument parser');
assert.match(k, /if \(mode === 'p' && !native\) \{\s*const parent = self\.W95SaverRuntime\.createPreviewWindow[\s\S]*?pc\.cmdPtr = p\.alloc\(previewCmd\.length \+ 1\); p\.writeA\(pc\.cmdPtr, previewCmd\);\s*\}\s*pc\.previewHwnd = run\.previewHwnd;\s*if \(mode === 'p' && !native\) pc\.previewKey/,
  'only a JS-personality preview gets a host HWND and a rewritten command line; the native one keeps the monitor HWND');
assert.match(k, /: `"\$\{real\}" \$\{mode === 'p' \? '\/p' : mode === 'c' \? '\/c:0' : '\/s'\}`/,
  'the executable path is quoted so saver argument parsing works for names with spaces');
assert.match(n, /P\.processIdle = function \(pc\) \{\s*const t = pc && pc\.main;\s*if \(!t\) return true;/,
  'WinExec safely handles a process whose main thread already ended');
assert.match(n, /if \(t\.pc && t\.pc\.saverMode\) \{\s*t\.state = 'done'; t\.pc\.trapped = e\.message;\s*this\.endProcess\(t\.pc, 0xffffffff\);/,
  'a saver hang terminates only that child instead of freezing the system process');
console.log('saverprocess: ok');
