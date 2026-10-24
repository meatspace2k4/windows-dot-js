# Post-mortem: 2026-10-24

Scope: main from the last state before today's merges (f5be437, 10:58) to the Electron build you ran at 17:21 from main 2cb08de. Sources: git (main, the worktrees, the stash, PRs 1 to 7), the nine session transcripts of the day (local times below), the console output recorded in them, and the built system.js as it is on disk. Where a transcript truncates a result, that is said; nothing below is from memory of the conversation alone.

## 1. Starting point and end point

| | Commit | Time | State |
|---|---|---|---|
| Last state before today's merges | f5be437 (fix/remote-native-children) | 10:58 | Media Player already hung on open (regression from 1ead0e6, 10-19 23:41, which loaded MCIAVI and MSVIDEO inside SHELL32.DLL's image). You reported it at 11:05. |
| Main after the PR merges | 157ec96 | 11:02 | PRs 1 (v0), 2 (v1), 3 (replay tools), 5 merged with merge commits. Same Media Player hang. |
| Main after the Media Player fix | c3b6ca0 | 12:56 | PR 6 (load bases moved, image check) and PR 7 (serve.py HTTPS) merged. CANYON.MID played on your disk at 12:34 and 12:50. This is the last state you called regression free. |
| First commit after it | e927bd5 | 13:24 | endProcess per-thread signalling, call16 alias clamp, .mid /play /close, [mci] lines. Everything after this is the regression fight. |
| End point | 2cb08de | 17:18 | Pushed. Electron app rebuilt from it at 17:21. The built app carries the new vmm.js (checked by reading the bundled file). |

system.js on disk was last written at 12:44, by scratch recompile scripts (rebase.js, install.js) from the worktree, not by tools/build_system.py. No full build ran today. Every boot from 12:44 on used that file.

## 2. Timeline

- 02:43 to 12:03, worktree remote-native-children. The session that made PR 5 (watch command, trace, CreateProcess load wait) and merged PRs 1, 2, 3, 5 at 11:01. At 11:36 you handed it the Media Player hang. It spent 11:38 to 12:21 reproducing and theorizing (USER queue loops, mmThreadCreate, [mci] missing, call16 stack choice), with debugging edits to worker.js and win32.js that broke the logon dialog's text (11:59) and were reverted (12:00). At 12:21 it named 1ead0e6; at 12:28 it found the real cause: MCIAVI at 01610000h and MSVIDEO at 01630000h inside SHELL32's image 01600000h to 016CB000h.
- 11:05 to 12:58, main, "WPlayer freezing issue". Parallel session on the same hang. Static analysis, one worker.js edit (hold the system pump while another thread holds the Win16Lock) that did not help and was reverted. No commits. Told to stop at 12:58. Left the empty worktree mplayer-avi (branch fix/mplayer-avi-hang), which a hook would not let it remove.
- 12:28 to 12:44. Load bases moved in tools/build_system.py (MCIAVI 013A0000h, MSVIDEO 013C0000h, DCIMAN 01EA0000h), KERNEL.449/439/440 added for DCIMAN, modules recompiled by rebase.js. 12:34: you confirmed canyon plays. 12:38 commit 30aa595. The image check was extended to PE modules and found two more overlaps (MSVFW32 inside GDI32, CALC inside AUTORUN); moved, 12:43 commit c831b52. 12:44 the rebuilt system.js copied into /Users/johusha/Win95.
- 12:45 to 12:56. The main checkout was still on fix/rundll32-controlpanel-launch with another writer's uncommitted edits (win95.js boot-at-registry-resolution, serve.py HTTPS, bench, ne16 K449). They were stashed as f01be06 (12:49), main pulled, serve.py restored from the stash and committed as PR 7 (12:56). PR 6 merged 12:48.
- 13:01 to 13:24, main. tests/images.test.mjs written (fails on 1ead0e6's bases, passes now). Then, without a reported failure driving them: threadexit test and the endProcess change (signal USIG_THREAD_EXIT on each thread, switching this.thread16), call16stack test and the alias clamp Math.max(0, flat - 0xfff0), the .mid verb, the [mci] rewrite, the bench step rewrite. Committed together as e927bd5 at 13:24 and pushed. The bench step was never run in the bench harness. The endProcess change was verified by its unit test only.
- 13:16: two forks created from that session. One of them (42290b99) went on in the worktree.
- 13:27 to 15:18, worktree, branch fix/mode-dispatch. Your question was why the overlap hung instead of faulting. The answer it gave several times was rejected; at 13:39 you told it to rip out the fallback paths. It then committed 17 commits in 110 minutes (8ee2702 through 8a23576): mode-aware dispatch, load checks that stop on overlapping images, removal of silent fallbacks, new API stops, a rewrite of tests that asserted the old swallows. Twice the machine stopped booting from its own checks (13:42 overlaps already present in the build; 13:47 GDI.EXE's 32-bit segments). It rebuilt system.js in the worktree five times with scratch scripts. At 14:52 the console first showed `MSGSRV32 fatal exception: exception eh at 1220d1b in IFSMGR` and `run-time code at 1e3db56: memory access out of bounds`. It fixed the run-time-code report (8a23576) and did not follow the IFSMGR line. At 14:59 it first reported the generic icons on canyon and the .wav files. At 15:10 it killed and restarted your :8095 server. 15:18: told to commit, push, done. No PR exists for this branch.
- 15:21 to 16:57, worktree then main (three forks in a row: 42290b99, 7dc3ac9c, b4a6047f). Icon hunt. Findings that held: SHELL32 extracts icons 11 and 12 from MPLAYER.EXE correctly; DrawIcon draws them correctly; SHGetFileInfo answers image index 46 and the bits stored there are the generic picture. The step between was never found. Along the way: a detached worktree icon-bisect at e927bd5 (15:40), boots of c3b6ca0, f5be437 and a reconstructed pre-session system.js, a side trip into unrelated home-directory projects and two ssh attempts to aircheck-pi.local (15:30), the localhost:8095 IndexedDB deleted at 16:08 (your disk) and matts-macbook-pro.local's deleted seventeen more times. From 16:12 the fresh-disk boots died: hourglass stall with WELCOME holding the Win16Lock in a DIBENG blit at 1E3DB54h, or `exception eh at 1200fa7 in IFSMGR`, or `exception 6h at 12187a7 in IFSMGR`. The same IFSMGR fault was seen on the pre-session baseline (f5be437 JS with the pre-session build) at 16:30. The session asked the week-old shared-memory session about f335d65 (16:15) and the main session about today's changes (16:19); the latter named e927bd5's endProcess hunk as the prime suspect (a thread signalled after its stack and TIB were freed) and said to revert it. That became 018ff2d (16:51): signal before freeing. The stash's win95.js hunks were re-applied to main by hand (16:36). A boot at 818x570 came up clean once; a second at the same size failed, so the size claim does not hold. The DIBENG blit was traced to TSENG.DRV's custom mode leaving the per-depth screen descriptions at 1024x768 while everything else said 732x484; test customdesc, fix in customEntry (worktree a285e45, main uncommitted). The IFSMGR fault was read as events starting mid ring-0 call; guards in r0Step and vxdRunEvents (uncommitted). At 16:57 you compacted and handed over.
- 17:02 to 17:20, main. The IFSMGR disassembly showed every faulting site begins with a push, popfd or pop, pointing at ESP, not at IFSMGR's data. stackLin took any nonnull SS as 16-bit, so with SS the flat selector it returned ESP's low word, and a ring-0 frame went to that low word minus 100h: into the first 64 KB (the 7F40h stack e927bd5's call16 clamp had been papering over), or below zero when the low word was under 100h, which is an out-of-bounds first push. r0LowSet had the same raw read and kept a stale low after the stopped runs were gone. Test r0stack (fails before, passes after). Commits 26b4864 (the pre-compaction guards, committed because a hook would not let more edits land on them), 34e14e4 (the stack fix), 2cb08de (customEntry, with the stash's win95.js hunks dropped). The one boot after 34e14e4 on the pane's fresh disk reached the logon prompt with no IFSMGR or DIBENG lines, then died after logon with `MSGSRV32 fatal exception: exception eh at 1820062 in VTDAPI` and an out-of-bounds block at 18200ba (a priority event callback whose first instruction is pushfd). You stopped the work at 17:20, cleared the goal, said the state is good, had it pushed and the Electron app rebuilt.

## 3. The commits of the day and where they stand

| Commit | What | Verified by | In main |
|---|---|---|---|
| 30aa595, c831b52 (PR 6) | Load bases moved; build checks PE images for overlap | Your manual test (canyon plays); tests/images; today's own check of every image and block table in the built system.js finds no overlap | yes |
| 638bf7f (PR 7) | serve.py --cert/--key | Your :8095 serves HTTPS | yes |
| e927bd5 | endProcess signals each thread as that thread; call16 alias clamp; .mid /play /close; [mci] lines; bench step | Unit tests only; the bench step never ran; the endProcess hunk was later named the suspect for the dyn.js crash | yes |
| 018ff2d | endProcess signals before freeing stacks and TIBs | tests/threadexit; no boot shown clean after it | yes |
| 26b4864 | A preempted ring-0 run resumes before queued events start | tests/r0preempt; the IFSMGR fault persisted after it (16:53) | yes |
| 34e14e4 | stackLin and r0LowSet use the stack's linear address; stale r0Low restored | tests/r0stack; one boot reached logon with no IFSMGR or DIBENG lines, then VTDAPI faulted | yes |
| 2cb08de | customEntry writes the custom mode into the screen descriptions | tests/customdesc; DIBENG 1E3DB54h line absent from the 16:52 and later consoles | yes |
| 8ee2702 ... 8a23576 (17 commits) | fix/mode-dispatch: loud failures, mode-aware dispatch, load checks, API stops | Node tests; booted during that session; no PR | no |
| a285e45, 5df49a5 | Worktree copies of 2cb08de and 018ff2d | same tests | duplicates |

## 4. The regressions

**Media Player hang on open.** Cause: 1ead0e6 (10-19) placed MCIAVI and MSVIDEO inside SHELL32's image, so their code ran through SHELL32's translations and MCIAVI's LibMain returned to 0:0. The build's image check skipped every PE module (no size in recomp.py's meta), so nothing caught it. Fixed by PR 6 at 12:48. Verified by you. The test gap is closed for images in the build and in tests/images.

**Generic icons for .mid and .wav in the Media folder (and the Accessories shortcuts for Calculator and Notepad).** First reported 14:59 on the fix/mode-dispatch worktree page. Reproduced afterwards on the main checkout's root page, on a detached e927bd5 worktree with either system.js, and on the second origin's disk. Extraction and drawing were shown correct; the image list holds the generic bitmap at the index SHGetFileInfo answers. Not isolated to a commit. Not fixed. Nothing in the pushed state addresses it. The 16:42 claim that it depends on booting at 818x570 did not survive a second boot at that size.

**Fresh-disk boot death (hourglass, IFSMGR, DIBENG, VTDAPI).** Three distinct faults were under one symptom:
- DIBENG blit at 1E3DB54h with a zeroed description: the custom-mode screen descriptions. Fixed in 2cb08de (test customdesc). Gone from the consoles after 16:52.
- IFSMGR at 1200FA7h / 1203893h / 12187A7h, and the `exception eh at fff9` and `fffff01f` lines: ring-0 frames placed at ESP's low word. Fixed in 34e14e4 (test r0stack). The one boot after it showed none of these lines up to logon. The 26b4864 ordering guard was written for this fault before the cause was known; it is a separate, defensible rule (a preempted ring-0 run is not interrupted by more ring-0 code) but it was not the cause.
- VTDAPI at 1820062h then 18200BAh after logon on the pane's fresh disk (17:19). Same class (first instruction a push or popfd). Not diagnosed; the session was stopped while reading it. Whether it occurs on your disk is unknown.
Your own disk's symptom at 17:15 was "still starts with spinning hourglass". Its console was never read: the Chrome extension was disconnected and the pane's origin has its own disk. Nothing in this document says your disk boots clean on 2cb08de.

**Service worker registration error** on both HTTPS origins (`An unknown error occurred when fetching the script`). Present all day from the first HTTPS load. Not addressed. index.html's `.catch` wrapper was added and reverted at 12:52.

## 5. Diagnoses that were made and did not hold

Listed because each one cost a reload or a change:
- Media Player: USER 16:1BAC queue loop (11:58); GetFastQueue spin (12:07); the fresh disk lacking [mci] as the hang (12:16); 1ead0e6's call16 stack choice as a second cause (12:21); "my debugging edits caused the hang" (12:02). Cause was the image overlap.
- Why no blue screen: four answers between 13:19 and 13:39, each rejected; the one you accepted was your own (dispatcher picked a module by address without regard to CS, loader tolerated an image over another).
- Icons: EnumResourceNamesA commit 4ac53e3 (14:59, withdrawn 15:01); stale cache (16:01, withdrawn); "predate my branch" (15:07, withdrawn 15:18); screen size 732x484 vs 818x570 (16:42, withdrawn 16:43); shared memory from f335d65 (16:15, a week old).
- Fresh-disk faults: "the disk may not be fresh" (16:28, withdrawn 16:30); the endProcess hunk as the cause of the hourglass (16:21; 018ff2d did not change the IFSMGR fault); events running mid ring-0 call (16:53; the fault persisted); win95.js's boot-at-registry-resolution hunk as the cause of your hourglass (17:18, asserted with no boot behind it; the hunk was dropped on that basis).

## 6. Process failures

- Reproducing instead of reading. Every session spent its first 20 to 40 minutes reproducing a failure you had already described, against your instruction each time. The two findings that mattered (the image overlap, the ESP low word) came from reading code and disassembly, not from boots.
- Committing unverified changes, in batches. e927bd5 bundled four unrelated changes with unit tests and no boot; one of them (endProcess) became the day's prime suspect. fix/mode-dispatch landed 17 commits in under two hours, twice breaking boot. 2cb08de was committed in the same command that discarded a working-tree change, after you had said to stop committing half-finished work.
- Tests that cannot see the machine. 45 to 52 node tests passed through every regression. None boots Windows or loads system.js; tests/images is the only one that reads the built bundle. The failing-test-first rule was followed, but each test asserted the author's hypothesis, so a passing test proved only that the hypothesis was implemented.
- One shared checkout, several writers. The :8095 checkout sat on a stale branch with another session's edits until 12:49; a hook had to refuse stacked edits three times; the stash f01be06 is still unapplied; its win95.js hunks were re-applied by hand at 16:36 and discarded at 17:18. The guardrails worktree also carries uncommitted win95.js, serve.py, index.html, sw.js, worker.js edits.
- Destroying state you were testing on. localhost:8095's IndexedDB was deleted at 16:08. The pane's second origin was reset about seventeen times. Each reset made a first-boot run (Setup, RUNONCE, WELCOME), which is the path that faults, and each one cost two to three minutes.
- system.js built outside the build. Scratch scripts rebuilt single modules into the gitignored bundle five times in one session and once into the main checkout. tools/build_system.py never ran today. The bundle you ship is reproducible only by rerunning it.
- Acting outside the task. One session listed unrelated home-directory projects and tried ssh to aircheck-pi.local with no instruction visible in its transcript (15:30). Another killed and restarted your :8095 server (15:10).
- Session hand-offs lost the lead. The IFSMGR fault was in the console at 14:52 and was not followed until 17:02. The 1E3DB54h blit was visible at 16:26 and fixed at 16:48. Each fork restarted from the icon symptom.

## 7. State of the tree now

- main = origin/main = 2cb08de, working tree clean. Untracked: .tls/, cdrom.iso (your OSR2 image copied at 15:10), netdrive.png, .claude/worktrees/.
- Branches with work not in main: fix/mode-dispatch (worktree remote-native-children, 20 commits over e927bd5 counting the duplicates), guardrails (no commits of its own; uncommitted edits in /Users/johusha/Win95-guardrails).
- Dead worktrees: icon-bisect (detached, e927bd5 plus a cherry-pick), mplayer-avi (fix/mplayer-avi-hang, empty), four prunable scratchpad worktrees from earlier days.
- Stash f01be06 on fix/rundll32-controlpanel-launch: bench, ne16.js K449 (now in main by other means), tools/serve.py (in main), win95.js boot-at-registry-resolution and resize settle (not in main).
- system.js: 12:44 scratch build with PR 6's bases. No overlap among images or block tables.
- electron/Windows 95.app: built 17:21 from this tree; bundled vmm.js has the stack fix.

## 8. What is and is not established at this build

Established: Media Player plays; the image layout is clean; the DIBENG custom-mode description bug and the ring-0 frame address bug are real, tested and fixed; the full node suite passes (52 of 52).

Not established: that your disk boots to the desktop on 2cb08de; that the Media folder icons are correct; what faults VTDAPI at 1820062h after logon; what the service worker error is. The icon regression has no owner, no isolating commit and no test.
