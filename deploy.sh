#!/usr/bin/env bash
# Deploys to Firebase Hosting, stamping a fresh build marker first so
# already-open tabs (staff who never close their browser, always-on TV
# kiosks) detect the update and reload themselves - see the app-build
# comment in index.html for why this has to touch two files, not one.
set -euo pipefail
cd "$(dirname "$0")"

BUILD=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sed -i "s|<meta name=\"app-build\" content=\"[^\"]*\"/>|<meta name=\"app-build\" content=\"$BUILD\"/>|" index.html
printf '%s' "$BUILD" > app-build.txt

npx --yes firebase-tools deploy --only hosting --non-interactive "$@"
