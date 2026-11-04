# Windows 98 Setup from Windows 95: the benchmark

Windows 98 SE (upgrade CD, `WIN98 SE`, 318654 sectors), run from its CD in the running Windows 95. Each run: the
furthest step reached, the first gap that stopped it, its fix. Not a goal to pass; no special cases for Setup.

Run: `tools/serve.py <port> --iso "Win95 OSR2.ISO" --cd "Windows 98 se Upgrade.iso"`, a fresh origin
(`http://<name>.localhost:<port>/?debug=1&mute=1&shared=0`), `win95.cd.insert('Windows 98 se Upgrade.iso')`, Yes to
the upgrade question (or `win95.run('D:\\setup.exe')`).

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
| 2026-10-31 | pitIO (wip) | 1 | W98SETUP: unhandled INT 21h AX=5802h (UMB link state) | AH=58h: allocation strategy and UMB link |
