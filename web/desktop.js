/* The desktop view of the site: the extension's new tab page (newtab.js, copied in by
   copy-to-extension.sh) with the site's extras on top: a drawer listing every note, with
   search, and the #id links the phone app makes. Everything else is the board itself. */
(function () {
  'use strict';

  const drawer = document.getElementById('drawer');
  const list = document.getElementById('drawer-list');
  const q = document.getElementById('drawer-q');
  const btn = document.getElementById('drawer-btn');
  const dot = document.getElementById('drawer-status');
  const count = document.getElementById('drawer-count');

  const open = on => {
    drawer.classList.toggle('open', on);
    btn.setAttribute('aria-expanded', on);
    if (on) q.focus();
  };
  btn.addEventListener('click', () => open(!drawer.classList.contains('open')));
  document.addEventListener('pointerdown', e => {
    if (drawer.classList.contains('open') && !e.target.closest('#drawer, #drawer-btn')) open(false);
  });
  addEventListener('keydown', e => { if (e.key === 'Escape') open(false); });
  q.addEventListener('input', renderList);
  document.getElementById('drawer-new').addEventListener('click', () => {
    document.getElementById('new-note').click();
    open(false);
  });

  // Plain text with the line breaks a reader sees, as the phone app's cards show it.
  function htmlToText(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    let out = '';
    let pendingBreak = false;
    const nl = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const walk = parent => {
      for (const n of parent.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          if (pendingBreak && n.nodeValue) { nl(); pendingBreak = false; }
          out += n.nodeValue;
        } else if (n.tagName === 'BR') {
          out += '\n';
          pendingBreak = false;
        } else if (n.tagName === 'DIV' || n.tagName === 'P') {
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
    return out;
  }

  function ago(ms) {
    if (!ms) return '';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'Just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Where a note sits in the list, highest first. New notes get the newest, dragging changes it.
  const orderOf = n => n.ord || n.u || 0;
  const byOrder = NoteCards.sorter(orderOf); // pinned notes first
  let shown = [];

  function renderList() {
    if (reorder.active()) return; // drawn again when the card is dropped
    const query = q.value.trim().toLowerCase();
    const items = notes
      .map(n => ({ n, text: htmlToText(n.html || '') }))
      .filter(x => !query || x.text.toLowerCase().includes(query) || (x.n.title || '').toLowerCase().includes(query))
      .sort((a, b) => byOrder(a.n, b.n));
    shown = items.map(x => x.n);

    list.textContent = '';
    for (const { n, text } of items) {
      const li = document.createElement('li');
      li.className = 'drawer-card' + (n.pinned ? ' pinned' : '');
      li.dataset.id = n.id;
      li.style.background = n.color;
      li.style.color = textOn(n.color);

      const title = (n.title || '').trim();
      if (title) {
        const h = document.createElement('div');
        h.className = 'drawer-title';
        h.textContent = title;
        li.appendChild(h);
      }

      const p = document.createElement('div');
      p.className = 'drawer-text' + (title ? '' : ' lead');
      if (text.trim()) {
        p.innerHTML = NoteCards.preview(sanitize(n.html));
      } else if (!title) {
        p.textContent = /<img/i.test(n.html || '') ? 'Image' : 'Empty note';
        p.classList.add('empty');
      }

      const meta = document.createElement('div');
      meta.className = 'drawer-meta';
      meta.textContent = ago(n.edited || n.u);

      const pin = NoteCards.pinButton(n, 'drawer-pin');
      pin.addEventListener('click', e => {
        e.stopPropagation();
        n.pinned = !n.pinned;
        save(n);
        renderList();
      });

      li.append(p, meta, pin);
      li.addEventListener('click', () => goTo(n));
      list.appendChild(li);
    }
    count.textContent = items.length ? `${items.length} note${items.length === 1 ? '' : 's'}`
      : (query ? 'No matches' : 'No notes yet');
  }

  // Drag a card to move it in the list. The order syncs, the phone shows it the same way.
  const reorder = NoteCards.reorderable(list, {
    item: '.drawer-card',
    scroller: () => list,
    onDrop: (id, _above, _below, ids) => {
      const { above, below, group } = NoteCards.groupNeighbors(shown, ids, id);
      if (!above && !below) return; // the only note of its kind, it stays where it is
      for (const { note, ord } of NoteCards.place(group, orderOf, id, above, below)) {
        if (note.ord === ord) continue;
        note.ord = ord;
        save(note);
      }
    },
    onEnd: renderList,
  });

  // Bring a note to the front and put the caret in it.
  function goTo(n) {
    const el = noteEl(n.id);
    if (!el) return;
    if (hidden) { hidden = false; applyHidden(); save(); }
    front(n, el);
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 900);
    el.querySelector('.note-body').focus();
    open(false);
  }

  // The list follows the board: whatever newtab.js renders or changes shows up here.
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(renderList, 150);
  }).observe(board, { childList: true, subtree: true, characterData: true });
  renderList();

  const LABEL = { live: 'Live, synced', connecting: 'Connecting…', offline: 'Offline, will sync when back' };
  setInterval(() => {
    const s = (typeof sync !== 'undefined' && sync && sync.status) || 'connecting';
    if (dot.dataset.sync !== s) { dot.dataset.sync = s; dot.title = LABEL[s]; }
  }, 500);

  // A #id in the address, as the phone app's links carry, opens that note once it is here.
  function openFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    const n = id && notes.find(x => x.id === id);
    if (n) goTo(n);
  }
  let tries = 0;
  const waiting = setInterval(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id || noteEl(id) || ++tries > 40) { clearInterval(waiting); openFromHash(); }
  }, 250);
  addEventListener('hashchange', openFromHash);
})();
