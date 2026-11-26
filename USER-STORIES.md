# User stories

Each is something a person at the machine does and what they then see or hear, with how it is checked. A story is
done when its check passes on the running machine, not when the code for it is written.

## 1. The start-up sound is Windows' own, and whole

As someone starting Windows 95 (in a browser tab, the app, or a Discord Activity), I hear The Microsoft Sound once as
the desktop comes up, from its first sample to its last, without breaks or repeats.

- The sound is played from within the OS: MSGSRV32 plays the SystemStart event through MMSYSTEM and the sound
  driver to the machine's sound card. The page never plays the sound's file itself, at the DOS part of the start or
  anywhere else. If it is ever found played by the page, that is a defect to remove, not a path to keep.
- The card's samples reach the speakers off the page's thread (the machine's worker to the audio worklet), so a busy
  page does not break the sound up.
- Check: on a fresh launch, the system machine's output stream reports no underrun (`dry`) between the sound's first
  and last sample; and nothing on the page's side calls the output with samples of its own.

## 2. Solitaire: Game > Win!

As someone playing Solitaire, I open the Game menu and choose **Win!** (the W underlined, so Alt+G, W chooses it), and
the game is won: the cards bounce across the window as they do when the last card goes home.

- It is a mod (`mod-*.js`), off unless asked for; without it Solitaire's menu is as Windows shipped it.
- The item is added to Solitaire's own Game menu in the running program, through Windows (the menu the program
  owns, a command the program's window receives), not drawn over it by the page.
- Choosing it puts the game in its won state in the program's own memory first (every card on its foundation, as
  the program keeps them), then has the program run its own end of game, so the bouncing cards are Solitaire's own
  code running, not an imitation.
- Found and proved with the machine's own tools (the devtools server's `shell_*`, breakpoints in the guest), in a
  browser tab before Discord.
- Check: with the mod on, Game has Win! with W as its access key; choosing it by mouse and by Alt+G, W both start
  the cascade; with the mod off the item is not there.
