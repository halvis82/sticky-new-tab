# Sticky New Tab

Sticky notes on Chrome's new tab page, and the same notes on your phone or any computer
through a small website of your own, kept in step live.

* Movable, resizable sticky notes on the new tab, with colors, titles, bold, italics, lists,
  links, pasted images and file attachments
* A phone friendly website with the same notes: search, pin, reorder by dragging, fold cards
* Edits show up everywhere within about a second, offline edits sync on reconnect
* History of deleted notes and removed text for 90 days, restorable from any device
* Locked to one account: every device asks for the password once
* Free to run: Supabase free plan for the data, Vercel Hobby plan for the website

```
 new tab (extension)  ─┐                            ┌─  website on your phone
 new tab (extension)  ─┼──  Supabase: notes table  ─┼─  website on a laptop
                       ┘    + realtime + storage    └─
```

| Folder | What it is |
|---|---|
| `extension/` | The Chrome extension: the new tab page with the notes |
| `helper/` | Optional second extension that turns the first back on when Chrome switches it off (see `helper/README.md`) |
| `web/` | The website, plain static files with no build step, plus the database schema and tests |

## Quick try: the extension alone, no accounts

1. Download or clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the
   `extension` folder.
3. Open a new tab. Double click anywhere or use **New note** on the left.

Notes stay in that Chrome profile only. Everything below adds syncing and the website.

## Full setup with sync and your own website

About 15 minutes. You need a GitHub account (free), a Supabase account (free) and a Vercel
account (free, sign in with GitHub).

### 1. Your own copy of the code

Fork this repo on GitHub (or use it as a template), then clone your fork.

### 2. The database (Supabase)

1. Create a project at [supabase.com](https://supabase.com) on the free plan. Any name and
   region. You can also create it from Vercel: **Storage**, **Create Database**, **Supabase**.
2. Pick the email the notes account will use. It never receives mail, so a made up address
   is fine, for example `notes@yourname.invalid`.
3. Open `web/scripts/schema.sql`, replace `notes@example.invalid` with that email, then paste the
   whole file into the Supabase **SQL Editor** and click **Run**. It creates the tables, the
   access rules, live updates and the storage buckets for images and files.
4. **Authentication**, **Users**, **Add user**, **Create new user**: that email and a password
   of your choice, with **Auto Confirm User** on. This password is what every device asks for.
5. Recommended: **Authentication**, **Sign In / Providers**, turn off **Allow new users to sign up**.
   Other accounts could never read your notes anyway, but there is no reason to allow them.
6. **Project Settings**, **API Keys**: copy the **Project URL** and the **publishable** key.

### 3. Point the code at your database

Edit `web/config.js`:

```js
window.NOTES_CONFIG = {
  url: 'https://abcdefghijklmnop.supabase.co',   // Project URL
  key: 'sb_publishable_...',                      // publishable key
  email: 'notes@yourname.invalid',                // the same email as in schema.sql
};
```

The publishable key is meant to be public. On its own it reads nothing: the database only lets
the notes account in. Commit and push.

### 4. The website (Vercel)

1. On [vercel.com](https://vercel.com), **Add New**, **Project**, import your fork.
2. Set **Root Directory** to `web` and **Framework Preset** to **Other**. Leave the build
   settings empty.
3. **Deploy**. You get an address like `your-project.vercel.app`. Every push to `main`
   deploys again by itself.

Open it on your phone, enter the password once, and add it to the home screen if you like.

### 5. Connect the extension

```sh
./web/copy-to-extension.sh
```

That copies `config.js` and the shared sync code into `extension/`. On Windows without bash,
copy `web/config.js`, `web/sync.js`, `web/history.js` and `web/vendor/supabase.js` into
`extension/` (the last one into `extension/vendor/`) by hand.

Then reload the extension on `chrome://extensions` (or load it now as in the quick try), open a
new tab and enter the password once. Notes you already made there are uploaded.

### 6. Keep the free database awake

Supabase pauses a free project after a week without any traffic. The workflow in
`.github/workflows/keepalive.yml` reads one row a day to prevent that. GitHub turns off
workflows on forks by default: open the **Actions** tab of your fork and enable them.

## Optional extras

* **Helper extension** (`helper/`): Chrome switches off any extension that replaces the new
  tab when you use **Change it back** in the Customize Chrome panel. Load `helper/` the same way
  and it offers to turn Sticky New Tab back on. Details in `helper/README.md`.
* **Your Chrome background and logo on the new tab** (macOS): `python3 extension/sync-chrome-theme.py`
  copies the background, colors and shortcuts you chose in Chrome into the extension.
  Without it the page is plain with a search box. Run it again after you change your theme.
* **Automatic theme sync and local backups** (macOS): `extension/install-agents.sh` installs two
  launchd agents, one rerunning the theme sync when Chrome's settings change and one saving
  snapshots of your notes into `extension/backups/`. `extension/restore-notes.sh` puts a
  snapshot back. macOS does not let these agents touch files inside `~/Documents`, so keep the
  extension folder somewhere else (for example `~/Library/Application Support/StickyNewTab`) if
  you use them. The agents assume the default Chrome profile.
* **The desktop site**: on a wide screen the website shows the same board as the new tab, notes
  where you left them, with a drawer listing every note. `?classic` gives a list and editor instead.

## Changing the code

* Website: edit in `web/`, push, Vercel deploys.
* The board (`newtab.js`, `newtab.css`) is written in `extension/` and copied into `web/` by
  `web/copy-to-extension.sh`, which copies both ways. Sync code (`sync.js`, `history.js`,
  `config.js`) is written in `web/` and copied into the extension. Run it after editing any of
  them.
* Database: edit `web/scripts/schema.sql` and run it again in the SQL Editor (it is safe to rerun),
  or `npm run migrate` from `web/` with `POSTGRES_URL_NON_POOLING` in `web/.env.local` (the
  **Direct connection** string from the Supabase **Connect** button).

More detail on how the sync works is in `web/README.md`.

## Tests

End to end tests with Playwright, in `web/tests/`. They run against your own Supabase project
but only touch the separate `notes_test` tables that `schema.sql` creates. They need
`web/.env.local` with:

```
NOTES_PASSWORD=the notes account password
SUPABASE_SECRET_KEY=sb_secret_...   (Project Settings, API Keys, secret key)
```

Then from `web/`: `npm install`, `npx playwright install chromium webkit`, and
`npm run test:web` (also `test:extension`, `test:history`, `test:cards`, `test:pins`, `test:fold`).
Never commit `.env.local`: the secret key bypasses every access rule.

## License

MIT, see `LICENSE`.
