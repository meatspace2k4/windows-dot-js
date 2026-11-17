#!/bin/sh
# Builds electron/Windows 95.app: Electron's prebuilt app, renamed, with the shell inside.
set -e
cd "$(dirname "$0")"
APP="Windows 95.app"
rm -rf "$APP"
cp -R node_modules/electron/dist/Electron.app "$APP"
R="$APP/Contents/Resources"
mkdir -p "$R/app/web/icons"
cp package.json main.js preload.js store.js shares.js webdav.js "$R/app/"
python3 ../tools/build_floppy.py ../mac ../floppy.js   # A: as mac/assets is now
cp ../index.html ../*.js ../*.mod "$R/app/web/"
# the drivers a page imports from beside itself (bench/setup98.mjs pageDrive, bench/anchor98.mjs)
mkdir -p "$R/app/web/bench"; cp ../bench/runner.mjs ../bench/setup98.mjs ../bench/anchor98.mjs "$R/app/web/bench/"
# the disc in the CD drive: the project's cdrom.iso, the one serve.py serves the page (File > Insert CD Image swaps it)
ISO="$(cd .. && pwd)/cdrom.iso"
test -f "$ISO" || { echo "no $ISO: the CD image the drive holds (serve.py --iso serves the same)" >&2; exit 1; }
printf '{ "image": "%s" }\n' "$ISO" > "$R/app/cd.json"
# the audio CD in the second drive: its table of contents in the app, its sectors the project's audiocd.bin (read by path)
AUDIO="$(cd .. && pwd)/audiocd.bin"
cp ../audiocd.json "$R/app/audiocd.json"; printf '{ "file": "%s" }\n' "$AUDIO" > "$R/app/audio.json"
cp ../icons/*.png "$R/app/web/icons/"
rm "$R/app/web/sw.js"
P="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "Windows 95" "$P"
plutil -replace CFBundleDisplayName -string "Windows 95" "$P"
plutil -replace CFBundleIdentifier -string "local.win95" "$P"
plutil -replace CFBundleIconFile -string "win95.icns" "$P"
ICONSET=$(mktemp -d)/win95.iconset; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s ../icons/icon512.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) ../icons/icon512.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$R/win95.icns"
codesign -s - --force --deep "$APP" >/dev/null 2>&1
