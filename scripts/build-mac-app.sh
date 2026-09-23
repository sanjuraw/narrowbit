#!/bin/sh
# Builds Narrowbit.app (a native window around `narrowbit ui`) with SwiftPM — no Xcode project
# needed, the Command Line Tools are enough. Usage: scripts/build-mac-app.sh [--install]
#   --install  copy the app to ~/Applications (it then shows up in Launchpad / Spotlight)
set -eu
cd "$(dirname "$0")/.."
swift build -c release --package-path mac
APP=mac/build/Narrowbit.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "mac/.build/release/Narrowbit" "$APP/Contents/MacOS/Narrowbit"
VERSION=$(node -p 'require("./package.json").version')
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Narrowbit</string>
  <key>CFBundleDisplayName</key><string>Narrowbit</string>
  <key>CFBundleIdentifier</key><string>dev.narrowbit.app</string>
  <key>CFBundleExecutable</key><string>Narrowbit</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
# Ad-hoc signature: enough for macOS to run a locally built app.
codesign --force --sign - "$APP" >/dev/null
echo "built $APP"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Narrowbit.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "installed ~/Applications/Narrowbit.app"
fi
