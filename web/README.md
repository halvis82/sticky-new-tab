# Notes on the web

The sticky notes from the Chrome new tab page, on any phone or computer. One password, asked
once per device and then remembered. Edits show up everywhere within about a second: this site,
every open new tab, every other device. Setup is in the README at the top of the repo.

## How it fits together

```
 new tab (extension)  ─┐                           ┌─  this site (phone, laptop)
 new tab (extension)  ─┼──  Supabase: notes table ─┼─  this site
 chrome.storage.local ─┘    + realtime + storage   └─  localStorage cache
```

* **Supabase** holds one row per note and pushes every change over a websocket. Images and
  attached files go in private storage buckets.
* **`sync.js`** is the whole sync engine, shared byte for byte with the extension. Each note
  carries `u`, its last change time. The newest copy wins everywhere, and a database trigger
  drops older writes. Deletes are tombstones, so a stale copy cannot bring a note back.
* Pasted images go in as data URIs (instant, works offline) and are uploaded and swapped for a
  stored address before the note is sent.
* Offline edits are kept locally and sent on reconnect.
* **History**: deleted notes and text, images or files taken out of a note go to the
  `note_history` table and can be restored from any device for 90 days (newest 500). The sync
  engine compares each run of edits (ended by 4 quiet seconds) with the note before it, so every
  client records the same way.

## Files

| | |
|---|---|
| `index.html`, `app.css`, `app.js` | The phone app, and `?classic` on a wide screen. Static, no build step |
| `desktop.html`, `desktop.js`, `desktop.css` | Wide screens: the extension's board, notes where they are in Chrome, with a drawer listing every note |
| `cards.js` | Note cards shared by the phone list and the drawer: previews and drag to reorder |
| `newtab.js`, `newtab.css` | The board, copied from the extension by `copy-to-extension.sh`. Edit them there |
| `chrome-shim.js` | The few `chrome.*` calls the board makes, over localStorage |
| `sync.js` | Sync engine, also used by the extension. Also decides what goes to history |
| `history.js` | The history list, shared by the phone app, the desktop site and the new tab |
| `config.js` | Your Supabase URL, publishable key and the notes account email (public by design) |
| `vendor/supabase.js` | supabase js UMD build, vendored since an extension cannot load remote code |
| `scripts/schema.sql` | Tables, trigger, access rules, realtime, buckets. Safe to run again |
| `tests/` | End to end tests, see the top README |

## Privacy

The notes, their history, images and files are locked to the one account in `config.js` by row
level security (`is_owner()` in `scripts/schema.sql`). Each device asks for its password once
and stays signed in after that. Until then the page shows nothing and takes no input, even
notes the device kept from before. The publishable key alone reads nothing. Images and files
sit in private buckets: a note stores the plain storage address, which opens nothing by itself,
and the page shows a copy fetched with the session.

The site also sends `noindex` and a `robots.txt` that disallows everything.

Worth knowing:

* Use a long password. Each device asks only once, so it costs nothing.
* Turn off new signups in Supabase (see the setup steps). Other accounts see nothing, but there
  is no reason to allow them.
* Each device keeps its own copy of the notes unencrypted (new tab storage, site localStorage).
