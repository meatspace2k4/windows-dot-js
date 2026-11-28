# Inside Windows

## Claude's tools in Windows

`ccd` (ccd.js) is the Claude desktop app's own tools as Windows has them: `ccd.<server>.<tool>(args)` with the app's
names and parameters, answering what the app would; what the app asks the user is a message box, and the call waits
for its answer. Sessions, groups, cards and settings live in the registry (`HKCU\Software\Claude\Code`); the Claude
window (its desktop icon, or `ccd.open()`) shows them.

| Server | Tools | In Windows |
| --- | --- | --- |
| `turn` | `update_plan`, `wrap_up` | the Claude window's task list and next-step box; its buttons are real buttons |
| `session` | `start_session`, `dismiss_task`, `hand_off_to_session`, `mark_chapter`, `read_widget_context`, `list_start_targets`, `move_to_cloud` | records; a proposal is a message box, or a card under CLAUDE.EXE's conversation; places are drives; no cloud |
| `session_mgmt` | `list_sessions`, `get_session`, `list_events`, `search_session_transcripts`, `archive_session`, `unarchive_session`, `delete_session`, `clear_session`, `stop_session`, `detach_session`, `set_session_*`, `set_remote_control`, `send_message`, `export_transcript`, `get_usage` | the records and transcripts; an export is `C:\My Documents\<title>.TXT` |
| `sidebar` | groups, sections, `move_sessions`, `set_pinned`, `set_unread`, `mark_completed`, `set_view` | the Claude window's sidebar |
| `view` | `show_pane`, `close_pane`, `get_layout`, `set_transcript_view` | `file` is Notepad, `terminal` an MS-DOS Prompt, `plan` the Claude window, `tasks` Close Program |
| `window`, `settings`, `host`, `directory`, `connectors`, `pr` | | the shell's windows; the app's keys; Notepad and folders; the session's folder; the page's hosts; no GitHub |

`ccd.open()`, `ccd.answer(i)`, `ccd.tools()`, `ccd.state()`, `ccd.toolDefs()`, `ccd.context(session)`,
`ccd.callAs(session, name, args)` and `ccd.cardAnswer(task_id, label)` drive it from the page. Its events are
`ccd.<server>.<tool>`, `ccd.code.<Tool>`, `ccd.reply`, `ccd.answer`, `ccd.message`, `ccd.session.start`,
`ccd.session.stop`, `ccd.notify`.

CLAUDE.EXE's Claude also has Claude Code's own tools: `Read`, `Write`, `Edit`, `Glob` and `Grep` on C: and on
`SRC:\`, the project's code as the local server serves it (refused on the deployed site, and for other drives);
`WebFetch`; `Agent`, a background subagent; `Skill` (`C:\WINDOWS\CLAUDE\SKILLS\<name>\SKILL.MD`); `JavaScript`, code in
the page with `win95` in scope; and `Bash`, an MS-DOS command (127 characters) run by `COMMAND.COM /C` in a machine
with no window. Each request begins with `C:\WINDOWS\CLAUDE\CLAUDE.MD`, the `CLAUDE.MD` files down to the session's
folder, the memory index `C:\WINDOWS\CLAUDE\MEMORY\MEMORY.MD`, and the skills.

## Changing the system while it runs

`win95.reloadScript(file)` loads one of the machines' scripts again into the running system (`claude-app.js`,
`shell32.js`, `dbwin.js`, ...): its definitions replace the exports in place, so programs already holding them call
the new code. Of the page's own scripts only `ccd.js` reloads; for any other (`win95.js`, ...) reload the page.

## MS-DOS

The MS-DOS Prompt and MS-DOS programs run in a virtual-8086 machine (v86.js) that boots the CD's own MS-DOS 7, with
Windows' C: and D:. `win95.dos` lists the machines; each has `keys` (scan code << 8 | character), `out`, and its
memory through `m8`/`m16`.
