# Sticky New Tab extension

The new tab page with the notes. Load this folder with **Load unpacked** on `chrome://extensions`.

Without a `config.js` here the notes stay in this Chrome profile only. With one (copied in by
`web/copy-to-extension.sh`) they sync with your website and every other new tab. Setup is in the
README at the top of the repo.

| File | Job |
|---|---|
| `newtab.html`, `newtab.js`, `newtab.css` | The page and the board of notes |
| `sync.js`, `history.js`, `vendor/supabase.js` | Sync and history, copied from `web/` |
| `sync-chrome-theme.py` | macOS: copies your Chrome background, colors and shortcuts into `theme.json` and `assets/` |
| `install-agents.sh`, `uninstall-agents.sh` | macOS: launchd agents for automatic theme sync and note backups |
| `backup-notes.py`, `restore-notes.sh` | Note snapshots into `backups/`, and putting one back |

The `key` in `manifest.json` only fixes the extension id, which `install-agents.sh` uses to find
the notes in Chrome's storage. It is not a secret.
