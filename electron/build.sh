#!/bin/sh
# Builds electron/Windows 95.app: Electron's prebuilt app, renamed, with the shell inside.
set -e
cd "$(dirname "$0")"
APP="Windows 95.app"
rm -rf "$APP"
cp -R node_modules/electron/dist/Electron.app "$APP"
R="$APP/Contents/Resources"
mkdir -p "$R/app/web/icons"
cp package.json main.js "$R/app/"
cp ../index.html ../*.js "$R/app/web/"
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
