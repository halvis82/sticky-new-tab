#!/bin/bash
# Two launchd agents:
#   themesync   - copies Chrome's new tab background/theme here when you change it
#   notesbackup - snapshots your notes out of Chrome's storage onto disk
#
# Both work only because this folder lives outside ~/Documents: macOS TCC blocks a launchd
# agent from reading or writing file contents there, and from exec'ing its script from there.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
STORE="$HOME/Library/Application Support/Google/Chrome/Default/Local Extension Settings/immpedeolbogdgdccglolkeikbocjnlo"
UID_N="$(id -u)"

install_agent() {
  local label="$1" script="$2" plist="$HOME/Library/LaunchAgents/$1.plist"
  shift 2
  cat > "$plist" <<PLI
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$REPO/$script</string>
    <string>--quiet</string>
  </array>
$*
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/stickynewtab-$label.log</string>
  <key>StandardErrorPath</key><string>/tmp/stickynewtab-$label.log</string>
</dict>
</plist>
PLI
  plutil -lint "$plist" >/dev/null
  launchctl bootout "gui/$UID_N/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$plist"
  echo "  $label installed"
}

# Chrome rewrites Preferences constantly; the script no-ops unless the photo changed.
install_agent com.stickynewtab.themesync sync-chrome-theme.py \
"  <key>WatchPaths</key>
  <array><string>$HOME/Library/Application Support/Google/Chrome/Default/Preferences</string></array>
  <key>ThrottleInterval</key><integer>20</integer>"

# No timer. Watching the storage directory fires on writes to the LevelDB inside it, so a
# snapshot lands seconds after you touch a note and never otherwise. ThrottleInterval keeps a
# burst of keystrokes to one run. The id comes from the manifest key, so it is stable.
install_agent com.stickynewtab.notesbackup backup-notes.py \
"  <key>WatchPaths</key>
  <array><string>$STORE</string></array>
  <key>ThrottleInterval</key><integer>5</integer>"

echo
echo "logs: /tmp/stickynewtab-com.stickynewtab.*.log"
echo "remove with: ./uninstall-agents.sh"
