// The classes of a shared session's state and of the calls that touch it (window.W95OSClass), which the machine
// (ne16.js: the world's objects, intents, the effects log) and the tests read. Every piece of state is one of:
//   shared    one for the session, set on every machine (a program's windows, their places and controls; a setting)
//   derived   made on each machine from a shared cause, and replicated as that cause (a folder window: the shell's
//             open; Setup's first-start programs: the start itself)
//   local     each machine's own (its disk and registry, the display's mode, the work area, temporary files)
//   singleton one on each machine, that machine's (the shell, the message server, the notification-area programs)
//   identity  who the machine's person is (the logged-on user)
// A call is classed by what it does to a session: it reads a hidden input (time, randomness: the same on every
// machine only from the session's clock), probes for a single instance, writes shared state, broadcasts to every
// program, opens a device one machine has, or runs a modal loop.
(() => {
  const g = typeof self !== 'undefined' ? self : window;
  const STATE = ['shared', 'derived', 'local', 'singleton', 'identity'];
  // the programs, by file, that are not the session's objects
  const PROGRAMS = {
    singleton: ['EXPLORER.EXE', 'MSGSRV32.EXE', 'MPREXE.EXE', 'SYSTRAY.EXE', 'SESSTRAY.EXE', 'MMTASK.TSK', 'SPOOL32.EXE'],
    derived: ['RUNONCE.EXE', 'GRPCONV.EXE', 'SETUP.EXE', 'SUWIN.EXE'],
  };
  /** a program's class by its file (and command line): shared unless the table says otherwise. RUNDLL32 running a
   *  Control Panel applet (Display Properties) is derived: its command line is what the session replicates, each
   *  machine's shell placing the sheet itself; its controls still sync one by one */
  const program = (file, cmd) => {
    const f = String(file || '').split('\\').pop().toUpperCase();
    for (const [cls, list] of Object.entries(PROGRAMS)) if (list.includes(f)) return cls;
    if (f === 'RUNDLL32.EXE' && /\.CPL\b/i.test(String(cmd || ''))) return 'derived';
    return 'shared';
  };
  // SystemParametersInfo's settings a person makes for the session (an intent): by action, how its parameters are
  // kept (ui: uiParam; str: pvParam a string; mouse: pvParam three ints). The rest are each machine's (the work area,
  // 47; the display's)
  const SPI = { 4: 'mouse', 11: 'ui', 13: 'ui', 15: 'ui', 17: 'ui', 19: 'ui', 20: 'str', 21: 'str', 23: 'ui', 24: 'ui', 26: 'ui', 29: 'ui', 30: 'ui',
    32: 'ui', 33: 'ui', 37: 'ui', 75: 'ui', 81: 'ui', 82: 'ui', 85: 'ui', 86: 'ui' };
  const spi = action => SPI[action] || null;
  // the settings a structure carries, made through USER32's SystemParametersInfoA (the Appearance tab's): the icon
  // titles' font (34, LOGFONTA, uiParam its size), the window metrics and fonts (42, NONCLIENTMETRICSA), the minimized
  // windows' (44, MINIMIZEDMETRICS), the icons' spacing and font (46, ICONMETRICSA); the others by their cbSize
  const SPI_STRUCT = new Set([34, 42, 44, 46]);
  const spiStruct = action => SPI_STRUCT.has(action);
  // the registry's values a person sets for the session that no other call carries (an intent of their own): the
  // screen saver's password being asked for (Display Properties' check box)
  const REG = { 'hkcu\\control panel\\desktop': ['screensaveusepassword'] };
  const reg = (path, name) => ((REG[String(path || '').toLowerCase()] || []).includes(String(name || '').toLowerCase()) ? 'shared' : 'local');
  /** a settings file's class: the system's (WIN.INI, SYSTEM.INI) shared, as intents; any other program's file local */
  const ini = file => (/^(WIN|SYSTEM)\.INI$/.test(String(file || '').split('\\').pop().toUpperCase()) ? 'shared' : 'local');
  // the registry's and the disk's areas: each machine's own, but who is logged on
  const AREAS = [[/^hklm\\network\\logon$/i, 'identity'], [/\\display\\settings$/i, 'local'], [/^c:\\windows\\temp\\|\.tmp$/i, 'local']];
  const area = path => { for (const [re, cls] of AREAS) if (re.test(String(path || ''))) return cls; return 'local'; };
  // the calls, by name (32-bit stand-ins and the 16-bit ones the same), by what they do to a session
  const API = {
    'hidden-input': ['GetTickCount', 'GetCurrentTime', 'timeGetTime', 'QueryPerformanceCounter', 'GetSystemTime', 'GetLocalTime', 'GetSystemTimeAsFileTime', 'CoCreateGuid', 'UuidCreate'],
    'singleton-probe': ['FindWindowA', 'FindWindowExA', 'CreateMutexA', 'OpenMutexA', 'CreateSemaphoreA', 'OpenSemaphoreA', 'CreateEventA', 'OpenEventA', 'CreateFileMappingA', 'OpenFileMappingA', 'GlobalFindAtomA'],
    'shared-write': ['WriteProfileStringA', 'WritePrivateProfileStringA', 'SystemParametersInfoA', 'RegSetValueA', 'RegSetValueExA', 'RegCreateKeyA', 'RegCreateKeyExA', 'RegDeleteKeyA', 'RegDeleteValueA'],
    broadcast: ['BroadcastSystemMessage', 'SendMessageTimeoutA', 'SHChangeNotify'],
    'exclusive-device': ['waveOutOpen', 'waveInOpen', 'midiOutOpen', 'midiInOpen', 'mciSendCommandA', 'mciSendStringA', 'sndPlaySoundA', 'PlaySoundA', 'OpenComm', 'joyGetPos'],
    modal: ['DialogBoxParamA', 'DialogBoxIndirectParamA', 'MessageBoxA', 'GetOpenFileNameA', 'GetSaveFileNameA', 'ChooseColorA', 'ChooseFontA', 'PrintDlgA', 'TrackPopupMenu'],
  };
  const byName = new Map(Object.entries(API).flatMap(([cls, names]) => names.map(n => [n, cls])));
  const api = name => byName.get(name) || null;
  g.W95OSClass = { STATE, PROGRAMS, program, SPI, spi, spiStruct, REG, reg, ini, area, API, api };
})();
