/* Live sync for the sticky notes, through Supabase.

   The same file runs in the Chrome extension and in the web app. The copy in web/ is the one to
   edit; ./copy-to-extension.sh puts it next to newtab.js.

   Model: every note carries `u`, the time of its last edit in ms. For any note id the copy with
   the larger `u` wins, everywhere: in this engine, in each client, and in the database (a trigger
   drops an update older than the row it would replace). Deleting leaves a tombstone
   { id, deleted: true, u } instead of removing the row, so a stale copy can never bring a
   deleted note back.

   Images never travel inside the note. A pasted image goes in as a data URI so it shows at once
   and works offline; before the note is sent the engine uploads it to storage and swaps in the
   public URL (onRewrite tells the client, so it can swap the <img> it is showing too).

   History: the engine also notices what local edits take away. A run of edits to one note (a
   burst, closed after a few quiet seconds) is compared with the note as it was before the run;
   if text, an image or a file went, the earlier version goes to the history table. Deleting a
   note puts the whole note there. Every client queues its edits through here, so the phone,
   the site and the new tab all keep history the same way. onHistory gets the list. */
(function () {
  'use strict';

  const COLUMNS = 'id,html,color,fx,fy,w,h,z,collapsed,title,ord,edited,pinned,expanded,deleted,u,origin';
  const PUSH_DELAY = 350;
  const BUCKET = 'images';
  const FILES_BUCKET = 'files';
  const DATA_IMG = /src="(data:image\/[^"]+)"/g;

  const HISTORY_COLUMNS = 'id,note_id,kind,at,html,removed,marks,media,snap';
  const HISTORY_KEEP = 500;
  const BURST_IDLE = 4000;   // quiet time that ends a run of edits
  const BURST_MAX = 60000;   // a run this long is checkpointed anyway
  const MIN_REMOVED = 6;     // characters, so a fixed typo is not history

  function toRow(rec, origin) {
    return {
      id: rec.id,
      html: rec.html || '',
      color: rec.color || '#fff5a5',
      fx: Number.isFinite(rec.fx) ? rec.fx : 0.1,
      fy: Number.isFinite(rec.fy) ? rec.fy : 0.1,
      w: Math.round(rec.w || 220),
      h: Math.round(rec.h || 200),
      z: Math.round(rec.z || 1),
      collapsed: !!rec.collapsed,
      title: rec.title || '',
      ord: Number(rec.ord) || 0,
      edited: Math.round(rec.edited || 0),
      pinned: !!rec.pinned,
      expanded: !!rec.expanded,
      deleted: !!rec.deleted,
      u: Math.round(rec.u || 0),
      origin,
    };
  }

  function fromRow(r) {
    const rec = {
      id: r.id, html: r.html, color: r.color, fx: r.fx, fy: r.fy, w: r.w, h: r.h, z: r.z,
      collapsed: !!r.collapsed, title: r.title || '', ord: Number(r.ord) || 0,
      edited: Number(r.edited) || 0, pinned: !!r.pinned, expanded: !!r.expanded,
      u: Number(r.u) || 0,
    };
    if (r.deleted) rec.deleted = true;
    return rec;
  }

  // A fresh edit time, always past the previous one even if the clock stepped back.
  function stamp(prev) {
    return Math.max(Date.now(), (prev || 0) + 1);
  }

  function dataUriToBlob(uri) {
    const [head, b64] = uri.split(',');
    const type = (head.match(/^data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  /* ---- what an edit took away ---- */

  // Plain text with the line breaks a reader sees: <br> and each block start a new line.
  function textOf(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html || '';
    let out = '';
    let pendingBreak = false;
    const nl = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const walk = parent => {
      for (const n of parent.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          if (pendingBreak && n.nodeValue) { nl(); pendingBreak = false; }
          out += n.nodeValue;
        } else if (n.nodeName === 'BR') {
          out += '\n';
          pendingBreak = false;
        } else if (n.nodeName === 'DIV' || n.nodeName === 'P') {
          nl();
          pendingBreak = false;
          walk(n);
          pendingBreak = true;
        } else {
          walk(n);
        }
      }
    };
    walk(tpl.content);
    return out.replace(/\u00a0/g, ' ').replace(/\s+$/, '');
  }

  // Images and file chips in a note, keyed so the same one is recognized in two versions.
  function mediaOf(html) {
    const out = new Map();
    for (const m of (html || '').matchAll(/<img[^>]*?src="([^"]+)"/g)) {
      if (!m[1].startsWith('data:')) out.set('i' + m[1], { type: 'img', src: m[1] });
    }
    for (const m of (html || '').matchAll(/<a\b[^>]*>/g)) {
      const name = (m[0].match(/data-file="([^"]*)"/) || [])[1];
      const href = (m[0].match(/href="([^"]*)"/) || [])[1];
      if (name !== undefined && href) out.set('f' + href, { type: 'file', name, href });
    }
    return out;
  }

  const hasContent = html => !!textOf(html).trim() || /<img|data-file=/.test(html || '');

  // Where the text of `a` is missing from `b`, as [start, end] ranges in `a`. The common start
  // and end are skipped, then the middle is compared word by word when it is small enough.
  function removedRanges(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const aEnd = a.length - s;
    if (!a.slice(p, aEnd).trim()) return [];

    const tok = (str, from, to) => {
      const out = [];
      const re = /\S+|\s+/g;
      const part = str.slice(from, to);
      for (let m; (m = re.exec(part));) out.push({ t: m[0], at: from + m.index });
      return out;
    };
    const ta = tok(a, p, aEnd);
    const tb = tok(b, p, b.length - s);
    if (!tb.length || ta.length * tb.length > 250000) return [[p, aEnd]];

    // Longest common subsequence of the words, then every word of `a` outside it.
    const W = tb.length + 1;
    const L = new Uint32Array((ta.length + 1) * W);
    for (let i = ta.length - 1; i >= 0; i--) {
      for (let j = tb.length - 1; j >= 0; j--) {
        L[i * W + j] = ta[i].t === tb[j].t ? L[(i + 1) * W + j + 1] + 1
          : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      }
    }
    const gone = [];
    for (let i = 0, j = 0; i < ta.length;) {
      if (j < tb.length && ta[i].t === tb[j].t) { i++; j++; }
      else if (j < tb.length && L[i * W + j + 1] >= L[(i + 1) * W + j]) j++;
      else gone.push(ta[i++]);
    }
    const ranges = [];
    for (const g of gone) {
      if (!g.t.trim()) continue;
      const last = ranges[ranges.length - 1];
      if (last && !a.slice(last[1], g.at).trim()) last[1] = g.at + g.t.length;
      else ranges.push([g.at, g.at + g.t.length]);
    }
    return ranges;
  }

  // What going from one version of a note to the next took away, or null if nothing worth
  // keeping did: a few characters, a whole line, an image or a file.
  function whatWent(beforeHtml, afterHtml) {
    const a = textOf(beforeHtml);
    const b = textOf(afterHtml);
    const ranges = a === b ? [] : removedRanges(a, b);

    const after = mediaOf(afterHtml);
    const media = [...mediaOf(beforeHtml)].filter(([k]) => !after.has(k)).map(([, v]) => v);

    const mask = new Uint8Array(a.length);
    let chars = 0;
    for (const [x, y] of ranges) for (let i = x; i < y; i++) { mask[i] = 1; if (a[i].trim()) chars++; }
    let wholeLine = false;
    let at = 0;
    for (const line of a.split('\n')) {
      if (line.trim() && [...line].every((c, i) => !c.trim() || mask[at + i])) wholeLine = true;
      at += line.length + 1;
    }
    if (chars < MIN_REMOVED && !wholeLine && !media.length) return null;

    // The list shows whole words, even when only part of one went.
    const snippets = ranges.map(([x, y]) => {
      while (x > 0 && a[x - 1].trim()) x--;
      while (y < a.length && a[y].trim()) y++;
      return a.slice(x, y).trim();
    });
    return { removed: snippets.join('\n\u2026\n').slice(0, 4000), marks: ranges, media };
  }

  const snapOf = (rec, prev) => {
    const src = rec.color ? rec : (prev && prev.snap) || {};
    return {
      color: src.color || '#fff5a5', fx: src.fx, fy: src.fy, w: src.w, h: src.h,
      collapsed: !!src.collapsed, title: src.title || '', ord: Number(src.ord) || 0,
      pinned: !!src.pinned,
    };
  };
  const knownOf = rec => ({
    html: rec.html || '', deleted: !!rec.deleted, u: Number(rec.u) || 0, snap: snapOf(rec),
  });

  // Until this device signs in, nothing on the page shows or takes input, not even notes it kept
  // from before. Decided before the page draws anything, from whether a session is stored.
  const AUTH_KEY = 'notes-auth';
  function lock() {
    if (document.getElementById('notes-locked')) return;
    const style = document.createElement('style');
    style.id = 'notes-locked';
    style.textContent = 'body > :not(#notes-login) { visibility: hidden !important; }';
    (document.head || document.documentElement).appendChild(style);
  }
  function unlock() {
    const style = document.getElementById('notes-locked');
    if (style) style.remove();
  }
  let hasSession = false;
  try { hasSession = !!localStorage.getItem(AUTH_KEY); } catch { /* no storage: ask */ }
  // No config.js (the extension on its own, notes kept in this profile only): nothing to sign in to.
  if (!hasSession && window.NOTES_CONFIG) lock();

  /* Images and files are private too. Notes keep their plain storage address, which by itself
     opens nothing. Every <img> pointing there is shown from a copy fetched with the session
     instead (a blob: URL), and sanitizing maps that back, so the note never stores it. */
  const MEDIA = /\/storage\/v1\/object\/public\/(images|files)\//;
  const blobs = new Map();   // stored address -> Promise<blob: URL>
  const stored = new Map();  // blob: URL -> stored address
  let signedIn = null;       // the client that holds the session
  let whenSignedIn;
  const signedInReady = new Promise(r => { whenSignedIn = r; });

  function mediaUrl(url) {
    if (!url || !MEDIA.test(url)) return Promise.resolve(url);
    if (!blobs.has(url)) {
      blobs.set(url, signedInReady.then(async () => {
        const res = await fetch(url.replace('/object/public/', '/object/authenticated/'), {
          headers: { apikey: signedIn.key, Authorization: 'Bearer ' + signedIn.token },
        });
        if (!res.ok) throw new Error('media ' + res.status);
        const b = URL.createObjectURL(await res.blob());
        stored.set(b, url);
        return b;
      }).catch(e => { blobs.delete(url); throw e; }));
    }
    return blobs.get(url);
  }

  function showImage(img) {
    const src = img.getAttribute('src');
    if (!src || !MEDIA.test(src)) return;
    img.style.visibility = 'hidden'; // no broken image icon while it loads
    mediaUrl(src).then(b => {
      if (img.getAttribute('src') === src) img.setAttribute('src', b);
    }, () => {}).finally(() => {
      img.style.removeProperty('visibility');
      if (!img.getAttribute('style')) img.removeAttribute('style');
    });
  }

  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') { showImage(m.target); continue; }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') showImage(n);
        else for (const img of n.querySelectorAll('img')) showImage(img);
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  for (const img of document.querySelectorAll('img')) showImage(img);

  // Asked once per device, over the hidden page. The browser's
  // password manager can fill and keep it. Resolves when tryIt(password) says it was right.
  function askPassword(email, tryIt) {
    return new Promise(resolve => {
      const box = document.createElement('form');
      box.id = 'notes-login';
      box.style.cssText = 'position:fixed;top:30vh;left:50%;transform:translateX(-50%);z-index:2147483647;'
        + 'display:flex;gap:8px;align-items:center;max-width:calc(100vw - 32px);box-sizing:border-box;'
        + 'padding:8px 8px 8px 14px;border-radius:12px;background:Canvas;color:CanvasText;color-scheme:light dark;'
        + 'box-shadow:0 4px 24px rgba(0,0,0,.25);font:14px system-ui,-apple-system,sans-serif';
      box.innerHTML = '<span style="white-space:nowrap">Notes password</span>'
        + '<input name="username" autocomplete="username" style="display:none">'
        + '<input name="password" type="password" autocomplete="current-password" style="font:inherit;'
        + 'font-size:16px;width:150px;min-width:0;padding:5px 8px;border:1px solid rgba(127,127,127,.4);'
        + 'border-radius:7px;background:transparent;color:inherit">'
        + '<button style="font:inherit;font-size:16px;padding:5px 12px;border:0;border-radius:7px;'
        + 'background:#1a73e8;color:#fff;cursor:pointer">Unlock</button>';
      box.username.value = email;
      const input = box.password;
      box.addEventListener('submit', async e => {
        e.preventDefault();
        if (!input.value) return;
        input.disabled = true;
        const ok = await tryIt(input.value);
        input.disabled = false;
        if (ok) { box.remove(); resolve(); return; }
        input.value = '';
        input.placeholder = 'Wrong password';
        input.focus();
      });
      const show = () => { document.body.appendChild(box); input.focus(); };
      if (document.body) show(); else addEventListener('DOMContentLoaded', show);
    });
  }

  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

  class NoteSync {
    /* url, key: the Supabase project and its public key.
       local():          every record this client holds, tombstones included.
       onRemote(recs):   records from elsewhere. The client keeps each one only if it is newer.
       onRewrite(id, m): image data URIs in a note were uploaded. m maps data URI -> URL.
       onStatus(s):      'connecting' | 'live' | 'offline'.
       onHistory(list):  the history changed. Newest first. */
    constructor({ url, key, email, password, table, local, onRemote, onRewrite, onStatus, onHistory }) {
      this.url = url;
      this.key = key;
      this.email = email;
      this.password = password; // only tests pass it. Everyone else is asked once
      this.token = null;
      this.table = table || 'notes';
      this.local = local;
      this.onRemote = onRemote || (() => {});
      this.onRewrite = onRewrite || (() => {});
      this.onStatus = onStatus || (() => {});
      this.onHistory = onHistory || (() => {});
      this.historyTable = this.table === 'notes' ? 'note_history' : this.table + '_history';

      this.origin = Math.random().toString(36).slice(2, 10);
      this.db = supabase.createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: AUTH_KEY },
      });
      this.db.auth.onAuthStateChange((event, session) => {
        this.token = session ? session.access_token : null;
        // Signed out from elsewhere, or the session was revoked: ask again, then catch up.
        // Outside the callback, which must not wait on the auth client itself.
        if (event !== 'SIGNED_OUT' || !this.connected) return;
        this.connected = false;
        setTimeout(() => this.signIn().then(() => { this.connected = true; this.resync(); }));
      });

      this.pending = new Map();
      this.timer = null;
      this.retryDelay = 1000;
      this.sending = false;
      this.syncing = false;
      this.again = false;
      this.subscribed = false;
      this.status = null;
      this.uploads = new Map(); // data URI -> Promise<url>, so one image uploads once

      this.known = new Map();       // id -> the note as history last accounted for it
      this.bursts = new Map();      // id -> { base, rec, started, timer }
      this.history = new Map();     // id -> entry
      this.historyOut = new Map();  // entries made here and not yet stored
      this.historyGone = new Set(); // entries removed here and not yet removed there
      this.historyKey = 'note-history:' + this.table;
      try {
        const c = JSON.parse(localStorage.getItem(this.historyKey) || '{}');
        for (const e of c.entries || []) this.history.set(e.id, e);
        for (const id of c.out || []) if (this.history.has(id)) this.historyOut.set(id, this.history.get(id));
        for (const id of c.gone || []) this.historyGone.add(id);
      } catch {
        /* no cache yet, or no storage. The server has it. */
      }
    }

    start() {
      this.setStatus('connecting');
      for (const rec of this.local()) this.setKnown(rec);
      if (this.history.size) this.emitHistory();
      this.signIn().then(() => this.connect());
    }

    // The notes are readable only by the one account. A device signs in once and stays signed in.
    async signIn() {
      for (;;) {
        const { data, error } = await this.db.auth.getSession();
        if (data.session) { this.token = data.session.access_token; this.unlocked(); return; }
        if (!error) break; // nobody signed in on this device yet
        // Signed in, but the session could not be renewed, most likely offline. Wait, not ask.
        await new Promise(r => setTimeout(r, 5000));
      }
      const tryIt = async password => {
        const { data, error } = await this.db.auth.signInWithPassword({ email: this.email, password });
        if (data && data.session) this.token = data.session.access_token;
        return !error;
      };
      lock();
      if (!(this.password && await tryIt(this.password))) await askPassword(this.email, tryIt);
      this.unlocked();
    }

    unlocked() {
      unlock();
      signedIn = this;
      whenSignedIn();
    }

    connect() {
      this.connected = true;
      this.channel = this.db.channel(this.table + '-' + this.origin)
        .on('postgres_changes', { event: '*', schema: 'public', table: this.table }, p => this.event(p))
        .on('postgres_changes', { event: '*', schema: 'public', table: this.historyTable }, p => this.historyEvent(p))
        // SUBSCRIBED can come before the change feed is running (a cold server takes seconds).
        // This fires once it really is, and anything written in the gap is fetched here.
        .on('system', {}, p => {
          if (p && p.extension === 'postgres_changes' && p.status === 'ok') this.resync();
        })
        .subscribe(state => {
          if (state === 'SUBSCRIBED') {
            this.subscribed = true;
            this.resync(); // also catches anything missed while the socket was down
          } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
            this.subscribed = false;
            this.setStatus('offline');
          }
        });

      addEventListener('online', () => this.resync());
      addEventListener('pagehide', () => this.beacon());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.resync();
        else this.beacon();
      });

      // Belt and braces for a socket that died without saying so (a phone asleep, a laptop lid).
      setInterval(() => {
        if (document.visibilityState === 'visible') this.resync();
      }, 60000);

      this.resync(); // no need to wait for the socket before the first fetch
    }

    setStatus(s) {
      if (s === 'live' && !this.subscribed) s = 'connecting';
      if (s === this.status) return;
      this.status = s;
      this.onStatus(s);
    }

    /* ---- incoming ---- */

    async event(p) {
      const row = p.new;
      if (!row || !row.id) return;
      if (row.origin === this.origin) return; // our own write coming back

      // Very large rows arrive without their big fields. Fetch those whole.
      if (typeof row.html !== 'string') {
        const { data } = await this.db.from(this.table).select(COLUMNS).eq('id', row.id).maybeSingle();
        if (!data) return;
        this.setKnown(fromRow(data));
        this.onRemote([fromRow(data)]);
        return;
      }
      this.setKnown(fromRow(row));
      this.onRemote([fromRow(row)]);
    }

    async resync() {
      if (!this.connected) return;
      if (this.syncing) { this.again = true; return; }
      this.syncing = true;
      try {
        const { data, error } = await this.db.from(this.table).select(COLUMNS);
        if (error) throw error;

        const server = new Map();
        for (const r of data) server.set(r.id, fromRow(r));
        for (const rec of server.values()) this.setKnown(rec);
        this.onRemote([...server.values()]);

        // Anything this client holds that the server lacks, or holds an older copy of,
        // was edited here while offline (or before sync existed). Send it.
        for (const rec of this.local()) {
          const s = server.get(rec.id);
          if (!s || (rec.u || 0) > s.u) this.queue(rec, 0);
        }
        this.setStatus('live');
        await this.syncHistory();
      } catch {
        this.setStatus('offline');
      } finally {
        this.syncing = false;
        if (this.again) { this.again = false; this.resync(); }
      }
    }

    /* ---- outgoing ---- */

    // Queue a record to send. The record is sent as it is at send time, so a client can pass
    // its live note object and keep editing it.
    queue(rec, delay = PUSH_DELAY) {
      // Lists show notes by ord, highest first. A note without one takes its edit time, so a
      // new note goes on top and stays where it is after that, unless someone drags it.
      if (!rec.deleted && !rec.ord) rec.ord = rec.u || Date.now();
      // "Edited" times only move for what the note says. u moves for everything, so a note that
      // was only moved or recolored keeps the time it was last written in.
      const k = this.known.get(rec.id);
      if (!rec.deleted && (!k || k.deleted || !rec.edited || k.html !== (rec.html || '') ||
          k.snap.title !== (rec.title || ''))) rec.edited = rec.u;
      this.track(rec);
      this.pending.set(rec.id, rec);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.send(), delay);
    }

    async send() {
      if (!this.connected) return; // signing in. connect() catches up on everything held here
      if (this.sending) { this.resend = true; return; }
      const batch = [...this.pending.values()];
      if (!batch.length) return;
      this.pending.clear();
      this.sending = true;

      try {
        const rows = [];
        for (const rec of batch) {
          await this.externalize(rec);
          rows.push(toRow(rec, this.origin));
        }
        const { error } = await this.db.from(this.table).upsert(rows, { onConflict: 'id' });
        if (error) throw error;
        for (const r of rows) this.setKnown(fromRow(r));
        this.retryDelay = 1000;
        this.setStatus('live');
      } catch {
        // Keep whatever was queued since, it is newer.
        for (const rec of batch) if (!this.pending.has(rec.id)) this.pending.set(rec.id, rec);
        this.setStatus('offline');
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.send(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
        return;
      } finally {
        this.sending = false;
      }

      if (this.resend || this.pending.size) {
        this.resend = false;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.send(), PUSH_DELAY);
      }
    }

    // The page is going away with edits still inside the debounce. fetch with keepalive
    // outlives the page, which the supabase client's own requests do not.
    beacon() {
      this.settleAll();
      if (!this.token) return; // not signed in yet. The cache keeps it for next time
      this.historyBeacon();
      if (!this.pending.size) return;
      const rows = [...this.pending.values()]
        .filter(r => !(r.html || '').includes('src="data:')) // too big for keepalive; sent next time
        .map(r => toRow(r, this.origin));
      if (!rows.length) return;
      clearTimeout(this.timer);
      this.pending.clear();
      try {
        fetch(`${this.url}/rest/v1/${this.table}?on_conflict=id`, {
          method: 'POST',
          keepalive: true,
          headers: {
            apikey: this.key,
            Authorization: 'Bearer ' + this.token,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(rows),
        }).catch(() => {});
      } catch {
        /* over the keepalive size limit. The next load sends it, since its `u` is newer. */
      }
    }

    /* ---- history ---- */

    setKnown(rec) {
      const cur = this.known.get(rec.id);
      if (cur && cur.u > (Number(rec.u) || 0)) return;
      const k = knownOf(rec);
      if (rec.html === undefined && cur) k.html = cur.html; // a bare tombstone keeps the text
      if (rec.deleted && cur) k.snap = cur.snap;
      this.known.set(rec.id, k);
    }

    // A local change to a note is on its way out. Deleting records the whole note; anything
    // else joins the note's current run of edits, compared once the run ends.
    track(rec) {
      const before = this.known.get(rec.id);
      if (rec.deleted) {
        if (this.bursts.has(rec.id)) this.settle(rec.id, rec);
        const prev = this.known.get(rec.id);
        if (prev && prev.deleted) return;
        const html = rec.html !== undefined ? rec.html : (prev && prev.html) || '';
        if (hasContent(html)) {
          this.addHistory({
            id: `${rec.id}:d:${rec.u}`, note_id: rec.id, kind: 'deleted', at: Date.now(), html,
            removed: textOf(html).slice(0, 4000), marks: null, media: [...mediaOf(html).values()],
            snap: snapOf(rec, prev),
          });
        }
        this.setKnown({ ...rec, html });
        return;
      }

      // Back from the dead: "deleted" entries for it no longer describe anything.
      for (const e of this.history.values()) {
        if (e.note_id === rec.id && e.kind === 'deleted') this.removeHistory(e.id);
      }
      if (!before || before.deleted) { this.setKnown(rec); return; }

      let b = this.bursts.get(rec.id);
      if (!b) {
        b = { base: before, rec, started: Date.now(), timer: null };
        this.bursts.set(rec.id, b);
      }
      b.rec = rec;
      clearTimeout(b.timer);
      if (Date.now() - b.started > BURST_MAX) this.settle(rec.id);
      else b.timer = setTimeout(() => this.settle(rec.id), BURST_IDLE);
    }

    // End a note's run of edits now and keep what it took away, if anything.
    settle(id, after) {
      const b = this.bursts.get(id);
      if (!b) return;
      clearTimeout(b.timer);
      this.bursts.delete(id);
      const rec = after || b.rec;
      const html = rec.html || '';
      if (html !== b.base.html) {
        const went = whatWent(b.base.html, html);
        if (went) {
          this.addHistory({
            id: `${id}:${b.base.u}`, note_id: id, kind: 'removed', at: Date.now(),
            html: b.base.html, ...went, snap: snapOf(rec, b.base),
          });
        }
      }
      this.setKnown({ ...rec, html, deleted: false });
    }

    settleAll() {
      for (const id of [...this.bursts.keys()]) this.settle(id);
    }

    entries() {
      return [...this.history.values()].sort((a, b) => b.at - a.at);
    }

    emitHistory() {
      this.saveHistory();
      this.onHistory(this.entries());
    }

    saveHistory() {
      clearTimeout(this.historyCacheTimer);
      this.historyCacheTimer = setTimeout(() => {
        try {
          localStorage.setItem(this.historyKey, JSON.stringify({
            entries: this.entries().slice(0, HISTORY_KEEP),
            out: [...this.historyOut.keys()],
            gone: [...this.historyGone],
          }));
        } catch {
          /* over quota. The server keeps it. */
        }
      }, 300);
    }

    addHistory(e) {
      e.origin = this.origin;
      this.history.set(e.id, e);
      this.historyOut.set(e.id, e);
      this.emitHistory();
      this.pushHistorySoon();
    }

    removeHistory(id) {
      if (!this.history.has(id)) return;
      this.history.delete(id);
      this.historyOut.delete(id);
      this.historyGone.add(id);
      this.emitHistory();
      this.pushHistorySoon();
    }

    clearHistory() {
      for (const id of [...this.history.keys()]) {
        this.history.delete(id);
        this.historyOut.delete(id);
        this.historyGone.add(id);
      }
      this.emitHistory();
      this.pushHistorySoon();
    }

    pushHistorySoon() {
      clearTimeout(this.historyTimer);
      this.historyTimer = setTimeout(() => this.pushHistory(), 200);
    }

    async pushHistory() {
      // Signed out, a delete would match no rows and look done. Wait for the sign in.
      if (!this.connected) return;
      if (this.historyPushing) { this.historyAgain = true; return; }
      this.historyPushing = true;
      try {
        if (this.historyOut.size) {
          const rows = [...this.historyOut.values()];
          const { error } = await this.db.from(this.historyTable)
            .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
          if (error) throw error;
          for (const r of rows) if (this.historyOut.get(r.id) === r) this.historyOut.delete(r.id);
        }
        const gone = [...this.historyGone];
        for (let i = 0; i < gone.length; i += 100) {
          const ids = gone.slice(i, i + 100);
          const { error } = await this.db.from(this.historyTable).delete().in('id', ids);
          if (error) throw error;
          for (const id of ids) this.historyGone.delete(id);
        }
        this.saveHistory();
      } catch {
        // Kept, and sent again with the next resync.
      } finally {
        this.historyPushing = false;
        if (this.historyAgain) { this.historyAgain = false; this.pushHistorySoon(); }
      }
    }

    // The server's list wins, apart from what this client has not sent yet.
    async syncHistory() {
      try {
        const { data, error } = await this.db.from(this.historyTable).select(HISTORY_COLUMNS)
          .order('at', { ascending: false }).limit(HISTORY_KEEP);
        if (error) throw error;
        const next = new Map();
        for (const r of data) if (!this.historyGone.has(r.id)) next.set(r.id, { ...r, at: Number(r.at) });
        for (const e of this.historyOut.values()) next.set(e.id, e);
        this.history = next;
        this.emitHistory();
        if (this.historyOut.size || this.historyGone.size) this.pushHistory();
      } catch {
        /* offline. The cached list stays. */
      }
    }

    historyEvent(p) {
      if (p.eventType === 'DELETE') {
        const id = p.old && p.old.id;
        if (id && this.history.delete(id)) this.emitHistory();
        return;
      }
      const r = p.new;
      if (!r || !r.id || this.historyGone.has(r.id)) return;
      if (typeof r.html !== 'string') { this.syncHistory(); return; } // too big for the feed
      this.history.set(r.id, { ...r, at: Number(r.at) });
      this.emitHistory();
    }

    historyBeacon() {
      if (!this.historyOut.size) return;
      try {
        fetch(`${this.url}/rest/v1/${this.historyTable}?on_conflict=id`, {
          method: 'POST',
          keepalive: true,
          headers: {
            apikey: this.key,
            Authorization: 'Bearer ' + this.token,
            'Content-Type': 'application/json',
            Prefer: 'resolution=ignore-duplicates,return=minimal',
          },
          body: JSON.stringify([...this.historyOut.values()]),
        }).catch(() => {});
      } catch {
        /* too big for keepalive. Sent on the next load from the cache. */
      }
    }

    /* ---- images ---- */

    async upload(blob) {
      const type = blob.type || 'image/png';
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${EXT[type] || 'img'}`;
      const { error } = await this.db.storage.from(BUCKET).upload(name, blob, {
        contentType: type,
        cacheControl: '31536000', // names are never reused, so cache forever
      });
      if (error) throw error;
      return this.db.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
    }

    /* ---- files ---- */

    // Any file, kept under its own name so the address ends in it. Returns the public URL.
    async uploadFile(file) {
      const safe = (file.name || 'file').replace(/[^\w.\-()+]+/g, '_').slice(-120);
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}/${safe}`;
      const { error } = await this.db.storage.from(FILES_BUCKET).upload(name, file, {
        contentType: file.type || 'application/octet-stream',
        cacheControl: '31536000',
      });
      if (error) throw error;
      return this.db.storage.from(FILES_BUCKET).getPublicUrl(name).data.publicUrl;
    }

    uploadDataUri(uri) {
      if (!this.uploads.has(uri)) {
        const p = this.upload(dataUriToBlob(uri));
        p.catch(() => this.uploads.delete(uri)); // let a later attempt retry
        this.uploads.set(uri, p);
      }
      return this.uploads.get(uri);
    }

    // Swap every data URI image in a record for an uploaded one. Throws if an upload fails,
    // so the send is retried rather than pushing megabytes of base64 through the database.
    async externalize(rec) {
      if (!rec.html || !rec.html.includes('src="data:image/')) return;
      const uris = [...new Set([...rec.html.matchAll(DATA_IMG)].map(m => m[1]))];
      const map = {};
      for (const uri of uris) map[uri] = await this.uploadDataUri(uri);
      rec.html = rec.html.replace(DATA_IMG, (m, uri) => `src="${map[uri] || uri}"`);
      this.onRewrite(rec.id, map);
    }
  }

  NoteSync.stamp = stamp;
  NoteSync.textOf = textOf;
  // What a note stores for a shown image: its storage address, not the blob: copy.
  NoteSync.storedUrl = url => stored.get(url) || url;
  // Opening a stored image or file. The tab opens now, while the click still counts as one,
  // and gets the private copy once it is here.
  NoteSync.open = url => {
    if (!MEDIA.test(url)) { window.open(url, '_blank', 'noopener'); return; }
    const w = window.open('', '_blank');
    mediaUrl(url).then(b => { if (w) w.location.href = b; }, () => { if (w) w.close(); });
  };
  // Saving one under this file name.
  NoteSync.save = async (url, name) => {
    const a = document.createElement('a');
    a.href = await mediaUrl(NoteSync.storedUrl(url));
    a.download = name || '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  window.NoteSync = NoteSync;
})();
