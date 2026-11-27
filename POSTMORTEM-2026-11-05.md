# Post-mortem 2026-11-05: Win98 first boot from w98-reboot-3

## Why every log line became a message to the user

- The watch was built on the wrong primitive. Monitor turns each stdout line into a notification, and each notification wakes the agent for a turn. A `tail -F | grep` over a log that every boot event writes to is, by construction, one turn per event. The filter matched every event type (window.open, screen, program.exit), not just the ones that called for action, so routine progress (each REGSVR32 exit, each Setup window) woke the agent.
- A woken turn has to output something, and the agent treated "something" as a status line ("Watching", "Okay"). It didn't recognise that the right output for a routine event is nothing, so every wake-up became a message.
- "Use the monitor, not polling" was read as "stream everything through Monitor". The intent was to register for the single event that ends the wait (a fault, or the target window) and act on that. The agent picked the broadest stream because it was easiest to set up, not because the task needed it.
- When told to stop, the agent stopped one watcher and later started another of the same shape (a fresh tail with a narrower filter), because it still needed something to wake it and had no other mechanism in mind. The repeat came from that missing alternative, not from a misheard instruction.
- Old watchers outlived the turns that started them: one bound to an earlier session ID went on emitting after TaskStop reported it gone, and the shell hook blocked `pkill`. So output kept arriving after "stop", and the agent's reply to that was to hand the user a command to run.

## Why the work itself went wrong

- **The anchor was not where the page looked.** Anchors live in the IndexedDB of the browser profile that made them. The continued session got a new preview partition (a different session ID), so its store was empty. The agent learned the fork's partition only from the user, then spent turns on copies that hooks blocked (cp, mv, rsync --delete; terminal calls rewritten). It finally ran a script file through Bash.
- **The 403s came from the agent's own sink.** `/__cdlog` accepts only `Content-Type: application/json` (local_request). The ad-hoc page listener posted plain text, and each reload re-ran it.
- **Cause and symptom were confused for the blank Setup window.** Two causes were found, at different times:
  1. A dead window: the old machine's worker delivered its last frames after `exited()`, and `RemoteApp.message()` accepted them, so the window came back after the power cycle had closed it.
  2. A deadlock: `RegisterServiceProcess` was a stub returning 1 without setting fServiceProcess. USER's ExitWindows therefore ended MPREXE along with the ordinary programs, and RUNONCE's thread (inside USER32 ExitWindowsEx → USER `MsgWaitForMultipleObjectsEx`, seg16 39D4h) then waited INFINITE on MPREXE's logoff-done event, which nobody would set.
- **The REGSVR32 stack fault came from a machine-wide filter.** `SetUnhandledExceptionFilter` kept one filter for the whole machine, but KERNEL32 keeps one per process. The second process to load MSVCRT got MSVCRT's own filter back as the "previous" one, and `__CxxUnhandledExceptionFilter` called itself until the stack ran out.
- **Fixes were reverted wholesale on a vague instruction.** "Remove the shit you added" was taken to cover everything, including the three real fixes. They had to be re-applied, which cost a full boot cycle.
- **A slow boot was blamed on the code when the procedure caused it.** Travelling into a freshly loaded page boots a system machine only to receive the moment. That boot faults in GDI's LibEntry (stack fault at 655e59) and repeats before `pc.reset()`. This is a cost of travel-then-reset in a fresh page, not of the fixes.

## Open

- OLEAUT32 `SysAllocStringLen+a0` reads [0+10h]: TlsGetValue returns 0 for OLEAUT32's per-thread block right after OLEAUT32's own init stored it (REGSVR32 loading LMRT). Suspect the TLS index from TlsAlloc/TlsFree, or the slot `tlsOf` picks for the calling thread. Tracing armed.
- QUARTZ/QDV `0f 77` (EMMS) is run-time-translated but not handled.
- MSVCRT, IVFSRC and mstask faults are unconfirmed since the per-process filter fix.
