/* Note cards, shared by the phone list and the desktop drawer: the formatted preview, and
   dragging cards to reorder the list.

   A finger holds a card for a moment to pick it up, so a swipe still scrolls the list. A mouse
   picks it up as soon as it moves with the button down. The card follows the pointer, the
   others slide out of its way, the list scrolls when the card nears an edge, and on release the
   card settles into its gap. onDrop then gets the card's id and its new neighbors' ids. The
   click a drag ends with is swallowed, so dropping a card does not open it.

   place works out the new order values: lists show the highest first. */
(function () {
  'use strict';

  const HOLD = 260;   // ms a finger rests on a card before it lifts
  const SLOP = 8;     // px a finger may wander during the hold, more is a scroll
  const EDGE = 70;    // px from the top or bottom where the list starts scrolling

  // A card shows the note as the editor does, bold, italics and links included, without the
  // images and with no link a click could follow. Takes the note's sanitized HTML.
  function preview(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html || '';
    const root = tpl.content;
    for (const img of root.querySelectorAll('img')) img.remove();
    for (const a of root.querySelectorAll('a')) {
      const span = document.createElement('span');
      span.className = a.hasAttribute('data-file') ? 'chip' : 'link';
      span.append(...a.childNodes);
      a.replaceWith(span);
    }
    // Text before the first line block or break is the first line. A div of its own, so it
    // can be bold.
    const lead = [];
    for (const n of [...root.childNodes]) {
      if (n.nodeName === 'DIV') break;
      if (n.nodeName === 'BR') { if (lead.length) n.remove(); break; }
      lead.push(n);
    }
    if (lead.length) {
      const d = document.createElement('div');
      root.insertBefore(d, lead[0]);
      d.append(...lead);
    }
    // No blank lines at the start or end, at most one in a row, and not more than a card shows.
    const blank = n => n.nodeType === Node.TEXT_NODE ? !n.nodeValue.trim()
      : n.tagName === 'BR' || !n.textContent.trim();
    let prevBlank = true;
    let lines = 0;
    for (const n of [...root.childNodes]) {
      const b = blank(n);
      if ((b && prevBlank) || lines >= 30) n.remove();
      else lines++;
      prevBlank = b;
    }
    while (root.lastChild && blank(root.lastChild)) root.lastChild.remove();
    return tpl.innerHTML;
  }

  function reorderable(list, { item, scroller, onDrop, onEnd }) {
    let press = null;
    let drag = null;
    let settling = false; // the card is gliding into its gap, the list must not redraw yet
    let swallowUntil = 0;

    const scrollEl = () => (scroller && scroller()) || document.scrollingElement;
    const listTop = () => list.getBoundingClientRect().top;

    list.addEventListener('pointerdown', e => {
      if (drag || e.button !== 0) return;
      const card = e.target.closest(item);
      if (!card || !list.contains(card) || e.target.closest('button, input, textarea')) return;
      press = { card, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse' };
      if (!press.mouse) press.timer = setTimeout(() => lift(), HOLD);
    });

    addEventListener('pointermove', e => {
      if (drag) { drag.y = e.clientY; move(); return; }
      if (!press) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= (press.mouse ? 4 : SLOP)) return;
      if (press.mouse) { lift(); if (drag) { drag.y = e.clientY; move(); } }
      else cancelPress();
    });

    addEventListener('pointerup', () => { if (drag) drop(); else cancelPress(); });
    addEventListener('pointercancel', () => { if (drag) drop(); else cancelPress(); });

    // Once a card is up the finger moves it, not the page.
    document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
    list.addEventListener('contextmenu', e => { if (press || drag) e.preventDefault(); });
    list.addEventListener('click', e => {
      if (performance.now() < swallowUntil) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    function cancelPress() {
      if (press) clearTimeout(press.timer);
      press = null;
    }

    function lift() {
      const { card, y } = press;
      press = null;
      const cards = [...list.querySelectorAll(item)];
      const from = cards.indexOf(card);
      if (from < 0 || cards.length < 2) return;
      const top = listTop();
      const boxes = cards.map(c => {
        const r = c.getBoundingClientRect();
        return { top: r.top - top, h: r.height };
      });
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      drag = { card, cards, from, to: from, boxes, gap, y, startY: y - top, frame: 0 };
      list.classList.add('sorting');
      card.classList.add('dragging');
      if (navigator.vibrate) navigator.vibrate(8);
      getSelection().removeAllRanges();
      drag.frame = requestAnimationFrame(edgeScroll);
    }

    function move() {
      const { card, cards, from, boxes, gap } = drag;
      const dy = drag.y - listTop() - drag.startY;
      card.style.transform = `translateY(${dy}px) scale(1.02)`;
      const mid = boxes[from].top + dy + boxes[from].h / 2;
      const shift = boxes[from].h + gap;
      let to = from;
      cards.forEach((c, i) => {
        if (i === from) return;
        const center = boxes[i].top + boxes[i].h / 2;
        let off = 0;
        if (i < from && mid < center) { off = shift; to--; }
        if (i > from && mid > center) { off = -shift; to++; }
        c.style.transform = off ? `translateY(${off}px)` : '';
      });
      drag.to = to;
    }

    function edgeScroll() {
      if (!drag) return;
      const el = scrollEl();
      const win = el === document.scrollingElement;
      const r = win ? { top: 0, bottom: innerHeight } : el.getBoundingClientRect();
      const y = drag.y;
      let v = 0;
      if (y < r.top + EDGE) v = -Math.min(1, (r.top + EDGE - y) / EDGE);
      else if (y > r.bottom - EDGE) v = Math.min(1, (y - r.bottom + EDGE) / EDGE);
      if (v) {
        const before = el.scrollTop;
        el.scrollTop += v * 14;
        if (el.scrollTop !== before) move();
      }
      drag.frame = requestAnimationFrame(edgeScroll);
    }

    function drop() {
      const d = drag;
      drag = null;
      settling = true;
      cancelAnimationFrame(d.frame);
      swallowUntil = performance.now() + 500;
      const { card, cards, from, to, boxes } = d;
      // Where the card lands, in the list as it is drawn now.
      const land = to > from ? boxes[to].top + boxes[to].h - boxes[from].h : boxes[to].top;
      card.classList.add('settling');
      card.style.transform = `translateY(${land - boxes[from].top}px)`;

      const done = () => {
        card.removeEventListener('transitionend', done);
        clearTimeout(timer);
        settling = false;
        list.classList.add('still');
        for (const c of cards) c.style.transform = '';
        card.classList.remove('dragging', 'settling');
        list.classList.remove('sorting');
        if (to !== from) {
          const order = cards.filter(c => c !== card);
          order.splice(to, 0, card);
          if (order.every(c => c.parentNode === list)) {
            list.insertBefore(card, to < order.length - 1 ? order[to + 1] : cards[cards.length - 1].nextSibling);
          }
          const id = c => (c ? c.dataset.id : null);
          onDrop(card.dataset.id, id(order[to - 1]), id(order[to + 1]), order.map(id));
        }
        list.offsetHeight; // the transforms go without animating
        list.classList.remove('still');
        if (onEnd) onEnd();
      };
      const timer = setTimeout(done, 260);
      card.addEventListener('transitionend', done);
    }

    return { active: () => !!drag || settling };
  }

  // The order values that put the note `id` between `above` and `below`, as [{ note, ord }].
  // notes is the list in the order it was shown, key(note) its current value. Usually only the
  // moved note changes; when two neighbors sit too close to split, the whole list is renumbered.
  const place = (notes, key, id, above, below) => {
    const find = x => notes.find(n => n.id === x);
    const note = find(id);
    const a = above && find(above);
    const b = below && find(below);
    const ka = a && key(a);
    const kb = b && key(b);
    let ord;
    if (a && b) ord = (ka + kb) / 2;
    else if (b) ord = kb + 1000;
    else ord = ka - 1000;
    if ((!a || ord < ka) && (!b || ord > kb)) return [{ note, ord }];

    const order = notes.filter(n => n !== note);
    order.splice(b ? order.indexOf(b) : order.length, 0, note);
    const top = Math.max(...notes.map(key));
    return order.map((n, i) => ({ note: n, ord: top - i * 1000 }));
  };

  // Pinned notes come first, then the rest, each highest order first.
  const PIN_ICON = '<svg viewBox="0 0 24 24"><path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5a3 3 0 0 1-3 3v2h5.97v7l1 1 1-1v-7H19v-2a3 3 0 0 1-3-3z"/></svg>';
  const UNPIN_ICON = '<svg viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7a1 1 0 0 0 0 2h1v5a3 3 0 0 1-3 3v2h5.97v7l1 1 1-1v-7H19v-2a3 3 0 0 1-3-3V4h1a1 1 0 0 0 0-2z"/></svg>';
  const sorter = key => (a, b) => (!!b.pinned - !!a.pinned) || key(b) - key(a);

  // The pin button a card carries in its top right corner.
  function pinButton(note, cls) {
    const b = document.createElement('button');
    b.className = cls + (note.pinned ? ' on' : '');
    b.title = note.pinned ? 'Unpin' : 'Pin';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', note.pinned ? 'true' : 'false');
    b.innerHTML = note.pinned ? PIN_ICON : UNPIN_ICON;
    return b;
  }

  // A dropped card stays with its own kind: an unpinned note dragged among the pins lands at the
  // top of the unpinned ones, and a pin dragged below them at the bottom of the pins. ids is the
  // list's order after the drop. Gives the neighbors to pass to place, within that group.
  function groupNeighbors(notes, ids, id) {
    const byId = new Map(notes.map(n => [n.id, n]));
    const pinned = !!(byId.get(id) || {}).pinned;
    const group = ids.filter(x => byId.has(x) && !!byId.get(x).pinned === pinned);
    const i = group.indexOf(id);
    return { above: group[i - 1] || null, below: group[i + 1] || null, group: notes.filter(n => !!n.pinned === pinned) };
  }

  window.NoteCards = { preview, reorderable, place, sorter, pinButton, groupNeighbors };
})();
