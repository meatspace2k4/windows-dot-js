// the Start menu as Setup leaves it: SETUPC.INF's SETUP.INI lines (with its strings and dirids put in) and GRPCONV -s
// run once to make the links; a Start menu already made of shell links is left alone
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const w = readFileSync(new URL('../win95.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = w.indexOf(a); assert.ok(i >= 0, a); return w.slice(i, w.indexOf(b, i) + b.length); };
const INF = `[BaseWinOptions]
UpdateInis = winbase.inis

[winbase.inis]
system.ini,386Enh,,"maxbps=270"
;Create StartUp Folder and modify links in it:
setup.ini, progman.groups,, "group1=""%StartUp_DESC%"""                ;creates folder
setup.ini, group1,, """%PenPal_DESC%"""                           ;deletes existing link
setup.ini, progman.groups,, "group0="            ;creates "null" folder
setup.ini, group0,, """%WinExplorer_DESC%"", ""Explorer.exe /n,/e,%30%"", EXPLORER.EXE, 1,,,%WinExplorer_ShortDESC%"

[winother.links]
setup.ini, progman.groups,, "group4=%APPS_DESC%"         ;creates folder
setup.ini, group4,, """%Notepad_DESC%"", NOTEPAD.EXE" ;creates link
setup.ini, progman.groups,, "group4=%APPS_DESC%"         ;creates folder (again)

[Strings]
StartUp_DESC    = "StartUp"
PenPal_DESC     = "PenPal"
WinExplorer_DESC= "Windows Explorer"
WinExplorer_ShortDESC = "Wexplore"
APPS_DESC       = "Accessories"
Notepad_DESC    = "Notepad"
`;
// APPLETS.INF's component sections: Calculator's links (its program in the bundle), Paint's (not)
const APPLETS = `[Calc.links]
setup.ini, progman.groups,, "group4=%APPS_DESC%"         ;creates folder
setup.ini, group4,, """%Calc_Desc%"", CALC.EXE,,, calc,,%Calc_ShortDesc%"  ;creates link

[Calc.links.remove]
setup.ini, group4,, """%Calc_Desc%"""

[MSPaint.links]
setup.ini, group4,, """%MSPaint_Desc%"", MSPAINT.EXE"

[wingames.links]
setup.ini, progman.groups, , "group6=%GAMES_DESC%"         ;creates folder
setup.ini, group6,, """%Sol_Desc%"", SOL.EXE,,,,,%Sol_ShortDesc%"            ;creates link
setup.ini, progman.groups,, "OldGames=%Games_WIN31%" ; from Win31
setup.ini, OldGames,, "%Sol_WIN31%"             ; from Win31

[Strings]
GAMES_DESC = "Accessories\\Games"
Sol_Desc = "Solitaire"
Sol_ShortDesc = "Sol"
Games_WIN31 = "Games"
Sol_WIN31 = "Solitaire"
APPS_DESC = "Accessories"
Calc_Desc = "Calculator"
Calc_ShortDesc = "Calc"
MSPaint_Desc = "Paint"
`;
// MOTOWN.INF's Multimedia accessories (Accessories\Multimedia, group12), with its section names in mixed case
const MOTOWN = `[MPlay.links]
setup.ini, progman.groups,, "group12=%MMEDIA_DESC%"                ;create Accessories/MultiMedia if necessary
setup.ini, group12,, """%MPlayerLinkDesc%"", MPLAYER.EXE,,,,,%MPlayerLinkShortDesc%"    ;creates link
powerpnt.ini,"OLE Play Options",,"AVIFile=Movie,1,1"

[Rec.links]
setup.ini, progman.groups,, "group12=%MMEDIA_DESC%"
setup.ini, group12,, """%SoundRec_Desc%"", SNDREC32.EXE,,,,,%SoundRec_ShortDesc%"

[Vol.links]
setup.ini, progman.groups,, "group12=%MMEDIA_DESC%"
setup.ini, group12,, """%SndVolLinkDesc%"", SNDVOL32.EXE,,,,,%SndVolLinkShortDesc%"

[Strings]
MMEDIA_DESC = "Accessories\\Multimedia"
MPlayerLinkDesc = "Media Player"
MPlayerLinkShortDesc = "MPlayer"
SoundRec_Desc = "Sound Recorder"
SoundRec_ShortDesc = "Recorder"
SndVolLinkDesc = "Volume Control"
SndVolLinkShortDesc = "Volume"
`;
function run(lnkBytes, withGrpconv = true, o = {}) {
  const files = new Map(o.files || []), reg = [];
  if (lnkBytes) files.set('C:\\WINDOWS\\Start Menu\\Programs\\Windows Explorer.lnk', lnkBytes);
  const env = {
    window: { ...(o.games ? { W95DOS: { windows: { 'SOL.EXE': 'x' } } } : {}), W95SYSTEM: { infs: { 'SETUPC.INF': INF, ...(o.applets ? { 'APPLETS.INF': APPLETS } : {}), ...(o.motown ? { 'MOTOWN.INF': MOTOWN } : {}) },
      programs: { ...(withGrpconv ? { 'GRPCONV.EXE': {} } : {}), ...(o.calc ? { 'CALC.EXE': {} } : {}), ...Object.fromEntries((o.programs || []).map(p => [p, {}])) } } },
    fs: { readFile: p => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); }, writeFile: (p, d) => files.set(p, d), exists: p => files.has(p) },
    W95FS: { encode: s => new TextEncoder().encode(s), decode: b => new TextDecoder().decode(b) },
    W95Win32: { regSet: (k, n, v) => reg.push([k, n, new TextDecoder().decode(v.data)]),
      regGet: (k, n) => (o.programsFolder && /shell folders$/.test(k) && n === 'Programs' ? { data: new TextEncoder().encode(o.programsFolder + '\0') } : undefined) },
  };
  new Function('window', 'fs', 'W95FS', 'W95Win32', `
    const WINDIR = 'C:\\\\WINDOWS', PROGRAMS = 'C:\\\\WINDOWS\\\\Start Menu\\\\Programs', join = (...a) => a.filter(Boolean).join('\\\\');
    ${cut('function infParse(text) {', '\n  return { sec, fields, subst };\n}')}
    ${cut('function setupStartMenu() {', "grpconv.exe') + ' -s'));\n}")}
    setupStartMenu();`)(env.window, env.fs, env.W95FS, env.W95Win32);
  return { files, reg, ini: files.has('C:\\WINDOWS\\SETUP.INI') ? new TextDecoder().decode(files.get('C:\\WINDOWS\\SETUP.INI')) : null };
}

// a fresh Start menu: SETUP.INI with the folders and links, GRPCONV -s to run once
{
  const r = run(null);
  assert.equal(r.ini, '[progman.groups]\r\ngroup1="StartUp"\r\ngroup0=\r\ngroup4=Accessories\r\n\r\n' +
    '[group1]\r\n"PenPal"\r\n\r\n[group0]\r\n"Windows Explorer", "Explorer.exe /n,/e,C:\\", EXPLORER.EXE, 1,,,Wexplore\r\n\r\n' +
    '[group4]\r\n"Notepad", NOTEPAD.EXE\r\n');
  assert.deepEqual(r.reg, [['hklm\\software\\microsoft\\windows\\currentversion\\runonce\\setup', 'Programs on the Start menu', 'C:\\WINDOWS\\grpconv.exe -s\0']]);   // (Setup's item: RUNONCE runs it before the shell)
  assert.ok(!/maxbps/.test(r.ini));   // (other files' lines are not SETUP.INI's)
}
// the page's own old shortcut (text) is no shell link: made again
assert.ok(run(new TextEncoder().encode('[Shortcut]\r\nTarget=C:\\WINDOWS\\EXPLORER.EXE\r\n')).ini);
// a shell link already there: nothing written, nothing run
{ const r = run(Uint8Array.of(0x4c, 0, 0, 0, 1, 0x14, 2, 0)); assert.equal(r.ini, null); assert.deepEqual(r.reg, []); }
// no GRPCONV in the system bundle: nothing to make the links with
{ const r = run(null, false); assert.equal(r.ini, null); assert.deepEqual(r.reg, []); }
// an accessory the system has: its links from APPLETS.INF, in its folder; one whose program is not here, none
const LNK = Uint8Array.of(0x4c, 0, 0, 0, 1, 0x14, 2, 0), CALC = 'C:\\WINDOWS\\Start Menu\\Programs\\Accessories\\Calculator.lnk';
{
  const r = run(null, true, { applets: true, calc: true });
  assert.ok(r.ini.endsWith('[group4]\r\n"Notepad", NOTEPAD.EXE\r\n"Calculator", CALC.EXE,,, calc,,Calc\r\n'));
  assert.ok(!/Paint/.test(r.ini));
}
// a made Start menu without the accessory's link: made again, with it; with it: left alone
assert.ok(/Calculator/.test(run(LNK, true, { applets: true, calc: true }).ini));
assert.equal(run(LNK, true, { applets: true, calc: true, files: [[CALC, LNK]] }).ini, null);
// the Multimedia accessories the system has, from MOTOWN.INF's sections (named in mixed case): Accessories\Multimedia
// with Media Player and Sound Recorder; Volume Control's program not here, no link; all made: left alone
{
  const r = run(LNK, true, { motown: true, programs: ['MPLAYER.EXE', 'SNDREC32.EXE'] });
  assert.ok(/\r\ngroup12=Accessories\\Multimedia\r\n/.test(r.ini));
  assert.ok(r.ini.endsWith('[group12]\r\n"Media Player", MPLAYER.EXE,,,,,MPlayer\r\n"Sound Recorder", SNDREC32.EXE,,,,,Recorder\r\n'));
  assert.ok(!/Volume|powerpnt|AVIFile/.test(r.ini));
  const MM = 'C:\\WINDOWS\\Start Menu\\Programs\\Accessories\\Multimedia\\';
  assert.equal(run(LNK, true, { motown: true, programs: ['MPLAYER.EXE', 'SNDREC32.EXE'], files: [[MM + 'Media Player.lnk', LNK], [MM + 'Sound Recorder.lnk', LNK]] }).ini, null);
}
// the user's Programs folder a profile's (Shell Folders): the links GRPCONV made there count, so Setup's item is not
// armed again at every start; that profile's Start menu without them: made
{
  const P = 'C:\\WINDOWS\\Profiles\\Ann\\Start Menu\\Programs';
  assert.equal(run(null, true, { programsFolder: P, files: [[P + '\\Windows Explorer.lnk', LNK]] }).ini, null);
  assert.ok(run(null, true, { programsFolder: P }).ini);
}
// the Games (an optional component Setup installed, msdos.js): their links in Accessories\Games, the old Win 3.1 group's
// removed; made again while Solitaire's link is not there, left alone once it is
{
  const r = run(LNK, true, { applets: true, games: true });
  assert.ok(/\r\ngroup6=Accessories\\Games\r\n/.test(r.ini) && /\[group6\]\r\n"Solitaire", SOL\.EXE,,,,,Sol\r\n/.test(r.ini), r.ini);
  assert.equal(run(LNK, true, { applets: true, games: true, files: [['C:\\WINDOWS\\Start Menu\\Programs\\Accessories\\Games\\Solitaire.lnk', LNK]] }).ini, null);
  assert.ok(!/Solitaire/.test(run(LNK, true, { applets: true }).ini || ''), 'not installed: no link');
}
console.log('startmenu: ok');
