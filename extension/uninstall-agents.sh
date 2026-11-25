#!/bin/bash
for label in com.stickynewtab.themesync com.stickynewtab.notesbackup; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
  echo "  $label removed"
done
