#!/bin/sh
# Builds mac/Windows 95.app from the web files in the parent folder.
set -e
cd "$(dirname "$0")"
APP="Windows 95.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp Info.plist "$APP/Contents/"
swiftc -O -o "$APP/Contents/MacOS/Win95" main.swift -framework Cocoa -framework WebKit
cp ../index.html ../*.js "$APP/Contents/Resources/web/"
codesign -s - --force "$APP" >/dev/null 2>&1
