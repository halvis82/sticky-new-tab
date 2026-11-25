/* The history list: notes deleted and text taken out of notes, newest first, each with a way
   to bring it back. sync.js decides what goes in; this only shows it.

   Shared by the phone app, the desktop site and the new tab page, like sync.js: the copy in
   web/ is the one to edit, and ./copy-to-extension.sh puts it next to newtab.js. Each page
   gives it a box to draw in and says how to restore a note:

     const h = NoteHistory.mount(box, {
       sync:    () => the NoteSync,
       current: id => the note as this page has it ({ html, deleted }) or null,
       restore: entry => put entry.html back into note entry.note_id (entry.snap has its color,
                place and size, for a note that is gone),
     });
     h.render(list)   // from NoteSync's onHistory */
(function () {
  'use strict';

  const STYLE = `
.nh { display: flex; flex-direction: column; min-height: 0; height: 100%; color: var(--nh-fg, inherit); }
.nh-bar { display: flex; align-items: center; gap: 8px; padding: 4px 4px 10px; font-size: 12.5px; color: var(--nh-muted, #888); }
.nh-bar .nh-count { flex: 1; }
.nh-clear { border: 0; background: none; color: inherit; font: inherit; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
.nh-clear:hover { background: rgba(127,127,127,.16); color: var(--nh-fg, inherit); }
.nh-clear[hidden] { display: none; }
.nh-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 2px 16px; -webkit-overflow-scrolling: touch; }
.nh-list { list-style: none; margin: 0; padding: 0; }
.nh-day { position: sticky; top: 0; z-index: 1; padding: 10px 4px 6px; font-size: 12px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--nh-muted, #888); background: var(--nh-bg, transparent); }
.nh-item { display: grid; grid-template-rows: 1fr; transition: grid-template-rows .2s ease, opacity .2s ease, margin .2s ease; margin-bottom: 8px; }
.nh-item > .nh-card { overflow: hidden; min-height: 0; }
.nh-item.nh-leaving { grid-template-rows: 0fr; opacity: 0; margin-bottom: 0; }
.nh-item.nh-new > .nh-card { animation: nh-in .25s ease; }
@keyframes nh-in { from { opacity: 0; transform: translateY(-6px); } }
.nh-card { border-radius: 10px; background: var(--note); color: var(--note-fg); box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 2px 8px rgba(0,0,0,.08); }
.nh-inner { padding: 9px 11px 6px; }
.nh-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; opacity: .72; }
.nh-kind { font-weight: 600; }
.nh-time { flex: 1; }
.nh-x { width: 26px; height: 26px; margin: -5px -6px -5px 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 50%; background: none; color: inherit; cursor: pointer; opacity: .8; }
.nh-x:hover { background: rgba(127,127,127,.22); opacity: 1; }
.nh-x svg { width: 15px; height: 15px; fill: currentColor; }
.nh-title { margin-top: 3px; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nh-text { margin: 4px 0 0; font-size: 13.5px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.nh-text.nh-gone { text-decoration: line-through; text-decoration-color: rgba(127,127,127,.7); text-decoration-thickness: 1px; }
.nh-text.nh-open { display: block; -webkit-line-clamp: unset; text-decoration: none; max-height: 340px; overflow-y: auto; }
.nh-text mark { background: rgba(217,48,37,.22); color: inherit; border-radius: 3px; text-decoration: line-through; text-decoration-color: rgba(217,48,37,.8); }
.nh-media { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.nh-media:empty { display: none; }
.nh-media img { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; background: rgba(127,127,127,.2); }
.nh-media a { display: inline-flex; align-items: center; max-width: 100%; padding: 3px 8px; border-radius: 6px; background: rgba(127,127,127,.18); color: inherit; font-size: 12px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nh-actions { display: flex; gap: 2px; padding: 0 5px 5px; }
.nh-actions button { border: 0; background: none; color: inherit; font: inherit; font-size: 12.5px; font-weight: 600; padding: 6px 8px; border-radius: 6px; cursor: pointer; opacity: .85; }
.nh-actions button:hover:not(:disabled) { background: rgba(127,127,127,.2); opacity: 1; }
.nh-actions button:disabled { opacity: .45; cursor: default; }
.nh-actions .nh-restore { opacity: 1; }
.nh-empty { margin: 0; padding: 48px 16px; text-align: center; font-size: 14px; line-height: 1.5; color: var(--nh-muted, #888); }
.nh-empty[hidden] { display: none; }
`;

  const X_ICON = '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

  function textOn(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#1a1a1a';
    const ch = i => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5) > 0.4 ? '#1a1a1a' : '#ffffff';
  }

  const textOf = html => (window.NoteSync ? NoteSync.textOf(html) : '');
  const titleOf = text => (text.split('\n').find(l => l.trim()) || '').trim().slice(0, 60);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function dayLabel(ms) {
    const d = new Date(ms);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((today - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, {
      month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
  }

  function kindLabel(e) {
    if (e.kind === 'deleted') return 'Deleted note';
    const media = e.media || [];
    const imgs = media.filter(m => m.type === 'img').length;
    const files = media.length - imgs;
    const parts = [];
    if ((e.removed || '').trim()) parts.push('text');
    if (imgs) parts.push(imgs === 1 ? 'an image' : plural(imgs, 'image'));
    if (files) parts.push(files === 1 ? 'a file' : plural(files, 'file'));
    return 'Removed ' + (parts.length ? parts.join(' and ').replace(/ and (?=.* and )/, ', ') : 'text');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // A button says what it did for a moment, then goes back.
  function flashLabel(btn, text) {
    const was = btn.dataset.label || btn.textContent;
    btn.dataset.label = was;
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1400);
  }

  function mount(root, opts) {
    if (!document.getElementById('nh-style')) {
      const st = document.createElement('style');
      st.id = 'nh-style';
      st.textContent = STYLE;
      document.head.appendChild(st);
    }

    root.innerHTML = `
      <div class="nh">
        <div class="nh-bar"><span class="nh-count"></span><button class="nh-clear" hidden>Clear all</button></div>
        <div class="nh-scroll">
          <ul class="nh-list"></ul>
          <p class="nh-empty" hidden>Nothing yet.<br>Deleted notes and text you take out of a note show up here for 90 days.</p>
        </div>
      </div>`;
    const list = root.querySelector('.nh-list');
    const count = root.querySelector('.nh-count');
    const clear = root.querySelector('.nh-clear');
    const empty = root.querySelector('.nh-empty');

    const items = new Map(); // id -> { li, entry }
    let entries = [];
    let first = true;

    const sync = () => opts.sync();

    function card(e) {
      const li = document.createElement('li');
      li.className = 'nh-item' + (first ? '' : ' nh-new');
      li.dataset.id = e.id;
      const color = (e.snap && e.snap.color) || '#fff5a5';

      const c = document.createElement('div');
      c.className = 'nh-card';
      c.style.setProperty('--note', color);
      c.style.setProperty('--note-fg', textOn(color));

      const inner = document.createElement('div');
      inner.className = 'nh-inner';

      const head = document.createElement('div');
      head.className = 'nh-head';
      const kind = document.createElement('span');
      kind.className = 'nh-kind';
      kind.textContent = kindLabel(e);
      const time = document.createElement('span');
      time.className = 'nh-time';
      time.textContent = '· ' + new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const x = document.createElement('button');
      x.className = 'nh-x';
      x.title = 'Remove from history';
      x.setAttribute('aria-label', 'Remove from history');
      x.innerHTML = X_ICON;
      head.append(kind, time, x);
      inner.appendChild(head);

      const full = textOf(e.html);
      if (e.kind === 'removed') {
        const t = document.createElement('div');
        t.className = 'nh-title';
        t.textContent = titleOf(full) ? `in “${titleOf(full)}”` : 'in a note';
        inner.appendChild(t);
      }

      const p = document.createElement('p');
      p.className = 'nh-text';
      if (e.kind === 'removed' && (e.removed || '').trim()) p.classList.add('nh-gone');
      p.textContent = (e.removed || '').trim() || (e.kind === 'deleted' ? '' : '');
      if (!p.textContent && e.kind === 'deleted') p.textContent = full.trim();
      if (p.textContent) inner.appendChild(p);

      const media = document.createElement('div');
      media.className = 'nh-media';
      for (const m of e.media || []) {
        if (m.type === 'img') {
          const im = document.createElement('img');
          im.src = m.src;
          im.alt = '';
          im.loading = 'lazy';
          media.appendChild(im);
        } else {
          const a = document.createElement('a');
          a.href = m.href;
          // Files are private: opened with the session, not by following the address.
          a.addEventListener('click', ev => { ev.preventDefault(); NoteSync.open(m.href); });
          a.textContent = m.name || 'File';
          media.appendChild(a);
        }
      }
      inner.appendChild(media);
      c.appendChild(inner);

      const actions = document.createElement('div');
      actions.className = 'nh-actions';
      const restore = document.createElement('button');
      restore.className = 'nh-restore';
      const copy = document.createElement('button');
      copy.className = 'nh-copy';
      copy.textContent = 'Copy';
      copy.title = e.kind === 'deleted' ? 'Copy the note' : 'Copy the removed text';
      actions.append(restore, copy);

      // The earlier note in full, with what went marked in it.
      if (e.kind === 'removed' && full.trim()) {
        const more = document.createElement('button');
        more.className = 'nh-more';
        more.textContent = 'Show note';
        actions.appendChild(more);
      }
      c.appendChild(actions);
      li.appendChild(c);
      return li;
    }

    function showFull(li, e) {
      let p = li.querySelector('.nh-text');
      const btn = li.querySelector('.nh-more');
      if (p && p.classList.contains('nh-open')) {
        p.classList.remove('nh-open');
        if ((e.removed || '').trim()) {
          p.classList.add('nh-gone');
          p.textContent = e.removed.trim();
        } else {
          p.remove();
        }
        btn.textContent = 'Show note';
        return;
      }
      if (!p) {
        p = document.createElement('p');
        p.className = 'nh-text';
        li.querySelector('.nh-media').before(p);
      }
      const full = textOf(e.html);
      p.textContent = '';
      let at = 0;
      for (const [x, y] of (e.marks || []).filter(r => r[0] >= at && r[1] <= full.length)) {
        p.append(full.slice(at, x));
        const m = document.createElement('mark');
        m.textContent = full.slice(x, y);
        p.appendChild(m);
        at = y;
      }
      p.append(full.slice(at));
      p.classList.remove('nh-gone');
      p.classList.add('nh-open');
      btn.textContent = 'Show less';
    }

    // Restore says what it would do, given where the note is now.
    function updateRestore(li, e) {
      const b = li.querySelector('.nh-restore');
      const cur = opts.current(e.note_id);
      const live = cur && !cur.deleted;
      if (e.kind === 'deleted') {
        b.textContent = 'Restore note';
        b.title = 'Put the note back';
        b.disabled = false;
      } else if (live && cur.html === e.html) {
        b.textContent = 'Restored';
        b.title = 'The note is like this now';
        b.disabled = true;
      } else {
        b.textContent = live ? 'Restore' : 'Restore note';
        b.title = live
          ? 'Put the note back the way it was before this. What it says now is kept here.'
          : 'The note was deleted since. Bring it back the way it was before this.';
        b.disabled = false;
      }
      delete b.dataset.label;
    }

    function render(next) {
      entries = next || entries;
      const want = new Set(entries.map(e => e.id));
      for (const [id, it] of items) {
        if (!want.has(id)) { it.li.remove(); items.delete(id); }
      }

      const frag = document.createDocumentFragment();
      let day = null;
      for (const e of entries) {
        const label = dayLabel(e.at);
        if (label !== day) {
          day = label;
          const h = document.createElement('li');
          h.className = 'nh-day';
          h.textContent = label;
          frag.appendChild(h);
        }
        let it = items.get(e.id);
        if (!it) {
          it = { li: card(e), entry: e };
          items.set(e.id, it);
        }
        it.li.classList.remove('nh-leaving');
        updateRestore(it.li, e);
        frag.appendChild(it.li);
      }
      list.textContent = '';
      list.appendChild(frag);
      first = false;

      count.textContent = entries.length ? plural(entries.length, 'change') + ' · kept 90 days' : '';
      clear.hidden = !entries.length;
      empty.hidden = !!entries.length;
    }

    // An entry slides shut first, then goes.
    function dismiss(li, id) {
      li.classList.add('nh-leaving');
      setTimeout(() => sync() && sync().removeHistory(id), 200);
    }

    list.addEventListener('click', async ev => {
      const li = ev.target.closest('.nh-item');
      if (!li) return;
      const it = items.get(li.dataset.id);
      if (!it) return;
      const e = it.entry;
      const btn = ev.target.closest('button');
      if (!btn) return;

      if (btn.classList.contains('nh-x')) {
        dismiss(li, e.id);
      } else if (btn.classList.contains('nh-copy')) {
        const text = e.kind === 'deleted' || !(e.removed || '').trim() ? textOf(e.html) : e.removed;
        flashLabel(btn, (await copyText(text)) ? 'Copied' : 'Copy failed');
      } else if (btn.classList.contains('nh-more')) {
        showFull(li, e);
      } else if (btn.classList.contains('nh-restore')) {
        opts.restore(e);
        // What it said a moment ago is history now, and shows up at the top right away.
        if (sync()) sync().settle(e.note_id);
        render();
        if (e.kind === 'removed') flashLabel(btn, 'Restored');
      }
    });

    clear.addEventListener('click', () => {
      if (!sync() || !confirm('Clear all history? Deleted notes in it can no longer be brought back.')) return;
      sync().clearHistory();
    });

    // "Today" turns into "Yesterday" while a page sits open.
    setInterval(() => { if (document.visibilityState === 'visible' && entries.length) render(); }, 60000);

    render([]);
    return { render, refresh: () => render() };
  }

  window.NoteHistory = { mount };
})();
