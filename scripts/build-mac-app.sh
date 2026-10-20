#!/bin/sh
# Builds Narrowbit.app (a native window around `narrowbit ui`) with SwiftPM — no Xcode project
# needed, the Command Line Tools are enough. Usage: scripts/build-mac-app.sh [--install]
#   --install  copy the app to /Applications (or ~/Applications when you cannot write there); it then shows up in Launchpad / Spotlight
set -eu
cd "$(dirname "$0")/.."
swift build -c release --package-path mac
APP=mac/build/Narrowbit.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "mac/.build/release/Narrowbit" "$APP/Contents/MacOS/Narrowbit"
# Build AppIcon.icns from the single 1024x1024 source (mac/Resources/icon.png) — iconset needs
# every size named explicitly; macOS applies the rounded-square mask/shadow itself at display time.
ICONSET=$(mktemp -d)/AppIcon.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size mac/Resources/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) mac/Resources/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$ICONSET")"
VERSION=$(node -p 'require("./package.json").version')
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Narrowbit</string>
  <key>CFBundleDisplayName</key><string>Narrowbit</string>
  <key>CFBundleIdentifier</key><string>dev.narrowbit.app</string>
  <key>CFBundleExecutable</key><string>Narrowbit</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
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
  # The system Applications folder when this account may write there (an administrator can), else your own ~/Applications.
  # NARROWBIT_APPS_DIR overrides the choice.
  if [ -n "${NARROWBIT_APPS_DIR:-}" ]; then DEST="$NARROWBIT_APPS_DIR"
  elif [ -w /Applications ]; then DEST=/Applications
  else DEST="$HOME/Applications"; fi
  mkdir -p "$DEST"
  rm -rf "$DEST/Narrowbit.app"
  cp -R "$APP" "$DEST/"
  # An older copy in your own Applications folder would be a stale duplicate.
  if [ "$DEST" = /Applications ]; then rm -rf "$HOME/Applications/Narrowbit.app"; fi
  echo "installed $DEST/Narrowbit.app"
fi
