#!/bin/bash
#
# Assemble Kingfisher.app.
#
# A .app is a folder with a prescribed layout, not a compiled binary, so this
# runs anywhere — including on the Linux box the app is developed on. Nothing
# here needs Xcode or a Mac.
#
#   ./packaging/make-app.sh [output-directory]
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$REPO/dist}"
APP="$OUT/Kingfisher.app"

VERSION="$(sed -n "s/^export const APP_VERSION = '\(.*\)';/\1/p" "$REPO/src/store/schema.js")"
BUILD="$(sed -n "s/^export const BUILD_DATE = '\(.*\)';/\1/p" "$REPO/src/store/schema.js")"
[ -n "$VERSION" ] || { echo "could not read APP_VERSION from src/store/schema.js" >&2; exit 1; }

echo "Kingfisher $VERSION (build $BUILD)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

# The web app itself. Only what the app needs at runtime — no tests, no build
# tooling, no notes.
for item in index.html src README.md OVERVIEW.md "START HERE.txt"; do
  [ -e "$REPO/$item" ] && cp -R "$REPO/$item" "$APP/Contents/Resources/app/"
done

python3 "$REPO/packaging/make-icon.py" >/dev/null
cp "$REPO/packaging/Kingfisher.icns" "$APP/Contents/Resources/Kingfisher.icns"

sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" \
  "$REPO/packaging/Info.plist" > "$APP/Contents/Info.plist"

cp "$REPO/packaging/launcher.sh" "$APP/Contents/MacOS/Kingfisher"
chmod +x "$APP/Contents/MacOS/Kingfisher"

# Marks the directory as a bundle for older Finders. Harmless on new ones.
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "built $APP"
find "$APP" -maxdepth 3 -not -path '*/app/src/*' | sed "s|$OUT/||"
