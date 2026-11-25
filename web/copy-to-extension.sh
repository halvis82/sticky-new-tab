#!/bin/bash
# The extension and this site share code, in both directions. sync.js, history.js and config.js are written
# here and copied to the extension. The board (newtab.js, newtab.css) is written in the
# extension and copied here, where desktop.html shows it without the new-tab dressing.
# Run after editing any of them, then open a new tab or push.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="${EXT:-$HERE/../extension}"  # override with EXT=/path if the extension lives elsewhere
mkdir -p "$EXT/vendor"

cp "$HERE/sync.js" "$HERE/history.js" "$HERE/config.js" "$EXT/"
cp "$HERE/vendor/supabase.js" "$EXT/vendor/"
echo "to extension: sync.js, history.js, config.js, vendor/supabase.js"

cp "$EXT/newtab.js" "$EXT/newtab.css" "$HERE/"
echo "to site: newtab.js, newtab.css"
