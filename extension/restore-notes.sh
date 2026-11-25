#!/bin/bash
# Restore notes from a snapshot.
#
# Nothing outside Chrome can write into chrome.storage, so this stages the snapshot as
# restore.json. The extension picks it up on the next new tab and imports it once.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

FILE="${1:-$HERE/backups/latest.json}"
[ -f "$FILE" ] || { echo "no such file: $FILE"; echo; echo "available:"; ls -1 "$HERE/backups"; exit 1; }

COUNT=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$FILE")
python3 - "$FILE" "$HERE/restore.json" <<'PY'
import json, sys, datetime
notes = json.load(open(sys.argv[1]))
json.dump({"stamp": datetime.datetime.now().isoformat(timespec="seconds"), "notes": notes},
          open(sys.argv[2], "w"), indent=2)
PY
echo "staged $COUNT note(s) from $(basename "$FILE")"
echo "open a new tab to apply. this replaces whatever notes are there now."
