# Windows 98 Setup from Windows 95: the benchmark

Windows 98 SE (upgrade CD, `WIN98 SE`, 318654 sectors), run from its CD in the running Windows 95. Each run: the
furthest step reached, the first gap that stopped it, its fix. Not a goal to pass; no special cases for Setup.

Run: `tools/serve.py <port> --iso "Win95 OSR2.ISO" --cd "Windows 98 se Upgrade.iso"`, a fresh origin
(`http://<name>.localhost:<port>/?debug=1&mute=1&shared=0`), `win95.cd.insert('Windows 98 se Upgrade.iso')`, Yes to
the upgrade question (or `win95.run('D:\\setup.exe')`). `W98KEY=... node bench/setup98.mjs [endpoint]` drives the
ladder through the shell's API (each page's control waited for, then pressed; the key from the environment, written
nowhere) and reports what stopped it; in a page with no DevTools endpoint, its `pageDrive` is evaluated there.

## The ladder

1. The CD mounts as D: and its AUTORUN.INF offers the upgrade.
2. SETUP.EXE starts (16-bit), runs its setup engine (W98SETUP.BIN) and shows the wizard.
3. Setup's ScanDisk pass runs and returns.
4. The wizard's pages: license, product key (the operator types it), folder, save system files, options, boot disk (declined).
5. File copy: Setup extracts its CABs with its own code onto C:.
6. Setup ends Windows 95 and restarts into its next phase (ExitWindowsExec, WININIT.INI, the real-mode phase).
7. Windows 98's own IO.SYS, VMM32.VXD and VxDs boot.
8. Hardware detection and the GUI phase of Setup.
9. Windows 98's desktop.

## Runs

| Date | Commit | Furthest step | First gap | Fix |
| --- | --- | --- | --- | --- |
| 2026-10-31 | 3b697d9 | 0 | no CD swap: D: is always the Windows 95 CD | a2a427d: D: takes any ISO 9660 image while running (`win95.cd`), media change for MSCDEX, AutoRun |
| 2026-10-31 | a2a427d | 1 (mounted) | AUTORUN.EXE ends at once, -1, no window: the bundle's Windows 95 AUTORUN.EXE translation ran over the Windows 98 image (chosen by file name) | 33fb1e0: a bundled translation only for the file it was made from (SHA-256) |
| 2026-10-31 | 33fb1e0 | 1 | Setup: "requires MS-DOS version 5.00 or later" (KERNEL GetVersion: 4F4h, DX unset) | 2823081: 5F03h, DX 0700h |
| 2026-10-31 | 2823081 (wip) | 1 | "requires a computer with an 80486 processor or higher" (POPFD dropped AC) | 2823081: run-time code keeps AF, NT, AC, ID |
| 2026-10-31 | 2823081 (wip) | 1 | "requires at least 16MB of memory" (List of Lists +45h, extended memory, was 0) | 2823081: boot drive, 386 flag, 15360 KB |
| 2026-10-31 | 2823081 | 1 | W98SETUP divide by zero (1:790): its CPU-speed loop times itself on 8254 channel 2, every port read FFh | the 8254 and port 61h by the clock (ne16.js pitIO) |
| 2026-10-31 | 421b712 | 2 | "Setup could not check the hard drives": SCANDISK.EXE started by WinExec answered 11 (not a Windows program) | 92c226c: WinExec of an MS-DOS program runs WINOA386.MOD (with VGAFULL.3GR, PIFMGR.DLL, APPS.INF) |
| 2026-10-31 | 92c226c | 2 | WinOldAp: SHELL's Create_VM had no VMM to make the VM | 71285d9: VMs made from the booted DOS (vmm.js Create_VM, DOSMGR's exec, v86.js machines in Windows' memory) |
| 2026-10-31 | 71285d9 | 2 | ScanDisk's VM refused, "not enough memory": Allocate_V86_Pages read SHELL's KB as pages | KB; the WinOldAp clipboard (INT 2Fh AH=17h) in VMs |
| 2026-10-31 | b6a7798 | 2 | ScanDisk runs in its VM and tests nothing (C: remote through the redirector, D: and E: CDs): SCANDISK.LOG "did not perform any tests"; Setup: "not enough conventional memory to check your computer's hard disks" | C: a local disk in VMs, a FAT16 view of fs.js (v86.js FatView); the VMM's INT 2Fh 1600h/160Ah answers in VMs, so ScanDisk's /CLIP reports to the clipboard |
| 2026-10-31 | (wip) | 3 (passed) | "Setup cannot create a temporary directory. You may not have enough disk space." | 2d8dd93: a protected-mode INT whose real-mode vector points into a GlobalDOSAlloc block is reflected to V86 mode (W98SETUP's INT 12h probes) |
| 2026-11-01 | 8292541 | 4 (preparing the Wizard) | "Message SU991010" (0x3f2): SUWIN's physical lock of unit 80h (INT 21h 440Dh CX=084Bh, BL the INT 13h unit) was read as drive letter 80h and refused | 440Dh 084Bh/086Bh take BL as the BIOS unit (80h C:'s FAT view, 0/1 the diskettes) |
| 2026-11-01 | (wip) | 4 | "Message SU0409", unable to update your system files: the CMOS anti-virus check writes the MBR and boot sector back by INT 13h AH=03h, refused (write protected) | the FAT view takes writes to the sectors ahead of its FATs (MBR, hidden track, boot sector) and reads them back; INT 13h 03h |
| 2026-11-01 | (wip) | 5 (Wizard: License Agreement) | stops for the operator: accepting the EULA, then the product key | |
| 2026-11-01 | f3fed3e | 5 (Product Key) | the key's check never ends: PIDGEN.DLL's binary GCD runs on with x = 0, y = 1; an interrupt in the middle of a thread's run (the input poll, the VMM's time-outs: ne16.js asInterrupt) kept only SS:ESP, so the flags between a CMP and its jump in the next block were the handler's | asInterrupt gives the interrupted code every register and flag back, as IRET does |
| 2026-11-01 | 517985a | 5 (Product Key accepted) | "Setup cannot create C:\WINDOWS" (SU0343): MKDIR of the existing folder answered 183 (Win32's ERROR_ALREADY_EXISTS), not MS-DOS's 5 | ea26221: INT 21h maps the file system's Win32-only codes to MS-DOS's (183, 145, 267 to 5; 123 to 3) |
| 2026-11-01 | ea26221 | 6 (Wizard: Save System Files) | the key's check takes about 70 s, "Checking for installed components" about 4 min; Explorer meanwhile faults in USER.EXE 4:20C0 (`mov es,[bp-2]`, 556Fh no longer a selector after LES loaded it from the same word two blocks earlier) | |
| 2026-11-01 | ea26221 | 6 (after Save System Files, No) | SUWIN ends: "unhandled int 21h ax=DC00" (NetWare's connection number); Explorer's fault did not recur on this run (a probe of USER's sent-message records found no bad sender field) | INT 21h functions past 73h nothing claims answer AL 0, as DOS's dispatcher does |
| 2026-10-31 | pitIO (wip) | 1 | W98SETUP: unhandled INT 21h AX=5802h (UMB link state) | AH=58h: allocation strategy and UMB link |
| 2026-11-01 | b5e1a2e | 3 (ScanDisk ran) | "Setup does not have enough conventional memory to check your computer's hard disks": ScanDisk's clipboard open (INT 2Fh 1701h) answered 0 while Setup's thread held the Win16Lock, so it quit without its report | 869ab92: the VM waits at the INT until USER is free, as SHELL has the call made when it can |
| 2026-11-01 | b5e1a2e | 3 | Explorer faults after ScanDisk's VM ends, "invalid page fault at 0002:3B08" (each run, under a driver that reads Setup's controls): USER called through a sent-message record freed while Explorer's queue still held it; the record's bytes a posted message's time. The sender was the host's own WM_GETTEXT to Setup's edits (`elements()`, nativeChildren), which came back after one turn and let USER free the record | c5534fa: a host-made SendMessage waits for its reply (64 turns, 200 ms); the controls are not asked while a thread holds the Win16Lock |
| 2026-11-01 | c5534fa | 6 (Saving System Files, 86%) | SUWIN ends: "unhandled int 21h ax=44E0" | 337a8fd: an IOCTL subfunction past the table answers invalid function (1), as the CD's IO.SYS dispatcher does (154D9h) |
