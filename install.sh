#!/bin/sh
# Installs Premiere Smooth Curve for the current macOS user.
set -e
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.pronk.smooth"
SRC="$(cd "$(dirname "$0")" && pwd)"
for v in 9 10 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
mkdir -p "$DEST"
rsync -a --delete --exclude .git --exclude .github --exclude tests --exclude docs --exclude install.bat --exclude install.sh --exclude README.md --exclude LICENSE --exclude .gitignore "$SRC/" "$DEST/"
echo "Done. Restart Premiere Pro, then open Window > Extensions > Premiere Smooth Curve."
