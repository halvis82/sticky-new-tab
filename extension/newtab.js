"use strict";

const COLORS = [
  '#fff5a5', '#ffd08a', '#ff9aa2', '#f4b6d2', '#c9b6f7', '#a8d8ff',
  '#a8e6b8', '#e0e0e0', '#1a73e8', '#8e24aa', '#c62828', '#2d2d2d',
];

const DEFAULT_W = 220;
const DEFAULT_H = 200;
const MIN_W = 140;
const MIN_H = 90;
const MAX_IMAGE_PX = 1600; // generous now that unlimitedStorage is on; still bounded

const board = document.getElementById('board');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');
const toggleBtn = document.getElementById('toggle-all');
const rail = document.getElementById('rail');

let notes = [];
let hidden = false;
let railY = 0.5;      // fraction of viewport height
let railCollapsed = false;
let topZ = 1;
let saveTimer = null;
let tombs = {};       // id -> time deleted, so a stale copy elsewhere cannot bring a note back
let sync = null;      // NoteSync, once started
let undoState = null;
let undoTimer = null;

/* ---------------- color ---------------- */

// Perceived lightness of the note color decides black or white text (sRGB relative luminance).
function textOn(hex) {
  const ch = i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  return L > 0.4 ? '#1a1a1a' : '#ffffff';
}

function contrast(hexA, hexB) {
  const lum = hex => {
    const ch = i => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  };
  const a = lum(hexA), b = lum(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Blue reads as "link" everywhere, but disappears on a blue note. Red is the fallback,
// and whichever contrasts better against this note's background wins.
function linkColor(bg) {
  const dark = textOn(bg) === '#ffffff';
  const blue = dark ? '#8ab4f8' : '#1a73e8';
  const red = dark ? '#f28b82' : '#c5221f';
  return contrast(blue, bg) >= 3.2 || contrast(blue, bg) >= contrast(red, bg) ? blue : red;
}

/* ---------------- rich text ---------------- */

// Bold, italic, underline, strikethrough, links and images. Nothing else survives, whatever is
// pasted in. Paragraphs, headings and list items become plain lines: a <p> brings its margins
// along, and every Enter typed after one made another with the same double gap.
const ALLOWED = {
  B: [], STRONG: [], I: [], EM: [], U: [], S: [], STRIKE: [], BR: [], DIV: [],
  A: ['href', 'data-file', 'data-size'], IMG: ['src', 'width'],
};
const AS_LINE = /^(P|H[1-6]|LI|DT|DD|DL|UL|OL|BLOCKQUOTE|PRE|ADDRESS|FIGURE|FIGCAPTION|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|NAV|MAIN|CENTER|TABLE|THEAD|TBODY|TFOOT|TR)$/;
const DROP = /^(SCRIPT|STYLE|TITLE|META|LINK|HEAD|TEMPLATE|NOSCRIPT|IFRAME|OBJECT|EMBED|SVG|MATH|CANVAS|VIDEO|AUDIO|SELECT|TEXTAREA)$/;

// Google Docs and Word carry formatting as style rather than as tags, and Docs wraps a whole
// paste in a <b> that its style turns back to normal weight.
function styleTags(el) {
  const s = el.getAttribute('style') ? el.style : null;
  if (!s) return [];
  const tags = [];
  const w = s.fontWeight;
  if (!/^(B|STRONG)$/.test(el.tagName) && (w === 'bold' || w === 'bolder' || +w >= 600)) tags.push('B');
  if (!/^(I|EM)$/.test(el.tagName) && /italic|oblique/.test(s.fontStyle)) tags.push('I');
  const d = s.textDecorationLine || s.textDecoration || '';
  if (el.tagName !== 'U' && /underline/.test(d)) tags.push('U');
  if (!/^(S|STRIKE)$/.test(el.tagName) && /line-through/.test(d)) tags.push('S');
  return tags;
}
const notBold = el => /^(B|STRONG)$/.test(el.tagName) && /^(normal|lighter|[1-5]00)$/.test(el.style.fontWeight);

function wrapIn(tags, nodes) {
  for (const t of tags) {
    const w = document.createElement(t);
    w.append(...nodes);
    nodes = [w];
  }
  return nodes;
}

function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  // A shown image is a private blob: copy. The note keeps its storage address. Mapped back
  // before the checks below, which keep only web and data addresses.
  if (window.NoteSync) for (const img of tpl.content.querySelectorAll('img')) {
    img.setAttribute('src', NoteSync.storedUrl(img.getAttribute('src')));
  }

  const walk = parent => {
    for (let node of [...parent.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) continue;
      if (node.nodeType !== Node.ELEMENT_NODE || DROP.test(node.tagName.toUpperCase())) { node.remove(); continue; }

      const tags = styleTags(node);
      if (AS_LINE.test(node.tagName)) {
        const d = document.createElement('div');
        d.append(...node.childNodes);
        node.replaceWith(d);
        node = d;
      } else if (node.tagName === 'DEL') {
        const s = document.createElement('s');
        s.append(...node.childNodes);
        node.replaceWith(s);
        node = s;
      }

      const allowed = ALLOWED[node.tagName];
      if (!allowed || notBold(node)) {
        // Unwrap rather than delete, so the text inside a <span style=...> is not lost. What is
        // inside is cleaned first: it is not visited again once it has moved out.
        walk(node);
        node.replaceWith(...wrapIn(tags, [...node.childNodes]));
        continue;
      }

      for (const attr of [...node.attributes]) {
        if (!allowed.includes(attr.name)) node.removeAttribute(attr.name);
      }

      if (node.tagName === 'A') {
        if (!/^(https?:|mailto:)/i.test(node.getAttribute('href') || '')) {
          node.removeAttribute('href');
        } else {
          node.target = '_blank';
          node.rel = 'noreferrer';
        }
      }

      if (node.tagName === 'IMG' && !/^(data:image\/|https:)/i.test(node.getAttribute('src') || '')) {
        node.remove();
        continue;
      }

      walk(node);
      if (tags.length && node.firstChild) node.append(...wrapIn(tags, [...node.childNodes]));
    }
  };

  walk(tpl.content);
  return tpl.innerHTML;
}

const escapeHtml = s =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Our own insertions fire input events too; the typing rules below must not react to those.
let inserting = false;
function insertHtml(html) {
  inserting = true;
  try {
    document.execCommand('insertHTML', false, html);
  } finally {
    inserting = false;
  }
}

/* ---------------- links (mirrored in the web app) ---------------- */

const LINK_RE = /^(https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?)$/i;
const TLD_RE = /\.(com|org|net|edu|gov|mil|int|io|co|dev|app|ai|no|uk|de|me|tv|info|xyz|be|ly|gg|to|us|ca|fr|se|dk|fi|it|es|nl|ch|eu|au|nz|jp|kr|cn|in|br|ru|pl|cz|at|ie|is|sh|cc|fm|so|re|page|site|online|store|tech|blog|cloud|news|shop|pro|biz|club|design|studio|space|live|life|world|today|wiki|zone|run|fun|art|gl|id|ws)(\/|$|:|\?|#)/i;

function href(word) {
  return /^https?:\/\//i.test(word) ? word : 'https://' + word;
}

// Does a word on its own read as a web address? An explicit scheme or www. always does; a bare
// domain needs a known ending, so "file.txt" and "e.g." stay text.
function isLink(word) {
  if (!LINK_RE.test(word)) return false;
  return /^(https?:\/\/|www\.)/i.test(word) || TLD_RE.test(word);
}

// The address inside a token: no wrapping brackets or quotes, no sentence punctuation after.
function trimToken(token) {
  const lead = token.match(/^[(\[<"']+/);
  const start = lead ? lead[0].length : 0;
  let end = token.length;
  while (end > start && /[.,;:!?)\]>"']/.test(token[end - 1])) end--;
  return [start, end];
}

// Plain text to HTML, with every address in it as a link and every newline as a break.
function linkifyText(text) {
  return text.split(/(\s+)/).map(part => {
    if (/^\s+$/.test(part)) return part.replace(/\r?\n/g, '<br>');
    const [s, e] = trimToken(part);
    const word = part.slice(s, e);
    if (!word || !isLink(word)) return escapeHtml(part);
    return escapeHtml(part.slice(0, s)) +
      `<a href="${escapeHtml(href(word))}" target="_blank" rel="noreferrer">${escapeHtml(word)}</a>` +
      escapeHtml(part.slice(e));
  }).join('');
}

// The node just before `n` in reading order, going down into last children.
function nodeBefore(n, root) {
  if (n === root) return null;
  if (n.previousSibling) {
    n = n.previousSibling;
    while (n.lastChild) n = n.lastChild;
    return n;
  }
  return n.parentNode === root ? null : n.parentNode;
}

const BLOCK = { DIV: 1, P: 1 };

// The text node holding the word that was just finished, and where that word ends in it.
// "Finished" means the caret sits right after whitespace in the same text, or at the start of
// a line whose previous line ends with it. Null for anything else, including an image or an
// empty line in between: only the word just typed or pasted can become a link.
function finishedWordAt(root) {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return null;
  const { focusNode: node, focusOffset: offset } = sel;
  if (!node || !root.contains(node)) return null;

  let n;
  if (node.nodeType === Node.TEXT_NODE) {
    const upto = node.nodeValue.slice(0, offset);
    if (upto.trim()) return /\s$/.test(upto) ? [node, upto.trimEnd().length] : null;
    n = node; // only whitespace so far on this line: look before it
  } else if (offset > 0) {
    n = node.childNodes[offset - 1];
    while (n.lastChild) n = n.lastChild;
  } else {
    n = node;
  }

  let breaks = 0;
  for (; n && n !== root; n = nodeBefore(n, root)) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n === node || !n.nodeValue.trim()) continue;
      return breaks <= 1 ? [n, n.nodeValue.trimEnd().length] : null;
    }
    if (n.nodeName === 'IMG') return null;
    if (n.nodeName === 'BR') {
      if (n.nextSibling) breaks++; // a <br> ending its parent is a placeholder, not a line
    } else if (BLOCK[n.nodeName]) {
      breaks++;
    }
    if (breaks > 1) return null;
  }
  return null;
}

// Link the word just finished with a space or a new line, the way an editor autocorrects:
// immediately, and undoable with one Cmd+Z that puts the plain text back and nothing else.
// Runs after the browser has done its part, so it works the same with every keyboard.
function autolink(root, beforeChange) {
  const hit = finishedWordAt(root);
  if (!hit) return false;
  const [node, end] = hit;
  if (node.parentElement.closest('a')) return false;

  const m = node.nodeValue.slice(0, end).match(/(\S+)$/);
  if (!m) return false;
  const [s, e] = trimToken(m[1]);
  const word = m[1].slice(s, e);
  if (!word || !isLink(word)) return false;
  const start = end - m[1].length + s;
  const stop = start + word.length;

  const sel = getSelection();
  const { focusNode: cn, focusOffset: co } = sel;
  const parent = node.parentNode;
  const index = [...parent.childNodes].indexOf(node);

  beforeChange(); // undo then takes back the linking alone
  const a = document.createElement('a');
  a.href = href(word);
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = word;
  const tail = document.createTextNode(node.nodeValue.slice(stop));
  node.nodeValue = node.nodeValue.slice(0, start);
  node.after(a, tail);

  // Put the caret back where it was, in terms of the new nodes.
  const r = document.createRange();
  if (cn === node) r.setStart(co >= stop ? tail : node, co >= stop ? co - stop : Math.min(co, start));
  else if (cn === parent && co > index) r.setStart(parent, co + 2);
  else r.setStart(cn, co);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);

  return true;
}

// After an insertion that ends in a link, step the caret out of it so typing on continues
// after the link rather than editing it.
function leaveLink(root) {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const n = sel.focusNode;
  const el = n && (n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement);
  const a = el && el.closest('a');
  if (!a || !root.contains(a) || a === root) return;
  const r = document.createRange();
  r.setStartAfter(a);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// Editing inside a link means it is no longer the thing that was recognised, so it stops
// being a link. Its text and formatting stay. It can become one again the next time a space
// or Enter finishes the word.
function unlinkAtCaret(root) {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const node = sel.focusNode;
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  const a = el && el.closest('a');
  if (!a || !root.contains(a) || a === root) return false;
  unwrap(a);
  return true;
}

// Take an element out and leave its contents in place, with the caret where it was.
function unwrap(el) {
  const sel = getSelection();
  let node = sel.rangeCount ? sel.focusNode : null;
  let offset = sel.rangeCount ? sel.focusOffset : 0;
  const parent = el.parentNode;
  const index = [...parent.childNodes].indexOf(el);
  const kids = el.childNodes.length ? [...el.childNodes] : [document.createTextNode('')];
  if (node === el) {
    node = parent;
    offset += index;
  } else if (node === parent && offset > index) {
    offset += kids.length - 1;
  }
  el.replaceWith(...kids);
  if (!node || !node.isConnected) return;
  const r = document.createRange();
  const max = node.nodeType === Node.TEXT_NODE ? node.length : node.childNodes.length;
  r.setStart(node, Math.min(offset, max));
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

function endsWord(e) {
  if (e.isComposing) return false;
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') return true;
  if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') {
    return !e.data || /\s$/.test(e.data);
  }
  return false;
}


// Big screenshots are common and would fill storage fast, so cap the long edge.
function imageToDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_PX / Math.max(img.width, img.height));
        if (scale === 1) return resolve(reader.result); // already within bounds, keep it untouched
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------------- trailing line and file chips (mirrored in the web app) ---------------- */

// Every note shows one empty line after its last content, so there is always somewhere to
// click and carry on under an image or a file. Pressing Enter down there makes more, to get
// further down; they stay while the caret is on them and go back to the one line once it
// leaves with nothing typed. Display only: store() takes the empty tail off again, so a note
// that was only looked at never counts as edited.
function ensureTrailingLine(root, leaving) {
  const sel = getSelection();
  const caretNode = sel.rangeCount && root.contains(sel.anchorNode) ? sel.anchorNode : null;
  // WebKit can keep an offset from before the note's HTML was replaced, so it is clamped.
  const caretMax = !caretNode ? 0 : caretNode.nodeType === Node.TEXT_NODE ? caretNode.length : caretNode.childNodes.length;
  const caretOffset = Math.min(caretNode ? sel.anchorOffset : 0, caretMax);
  const setCaret = (node, offset) => {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  if (!root.textContent.trim() && !root.querySelector('img, a[data-file]')) {
    if (!root.childNodes.length) return false;
    root.textContent = '';
    if (caretNode) setCaret(root, 0);
    return true;
  }

  if (isCanonicalEnd(root)) return false;

  // Blank lines being made on purpose: the caret is down there, so leave them be.
  if (!leaving && caretNode && caretOnEmptyTail(root, caretNode, caretOffset)) {
    flattenTail(root, caretNode);
    return false;
  }

  // Peel every empty line off the end, then put exactly one back.
  for (;;) {
    const n = lastSolid(root);
    if (!n || n.nodeType === Node.TEXT_NODE) break;
    if (n.nodeName === 'BR' || (BLOCK[n.nodeName] && isEmptyBlock(n))) {
      dropWithSpace(n);
      continue;
    }
    if (BLOCK[n.nodeName]) trimInside(n);
    break;
  }
  const d = document.createElement('div');
  d.appendChild(document.createElement('br'));
  root.appendChild(d);
  return true;
}

// Chrome answers Enter after text at the top level by nesting a block inside the next one.
// Empty blocks at the end that show more than one line are redrawn as one flat <div><br></div>
// per line, with the caret on the last of them, which is where Chrome had it. A block that is
// already one line stays as it is: Chrome keeps the bold of the line above in it as
// <div><b><br></b></div>, and redrawing that made Cmd+B on the new line do nothing.
function flattenTail(root, caretNode) {
  const lines = b => [...b.childNodes].reduce((n, c) =>
    n + (c.nodeName === 'BR' ? 1 : BLOCK[c.nodeName] ? lines(c) : 0), 0);
  for (let n = lastSolid(root); n && BLOCK[n.nodeName] && isEmptyBlock(n); ) {
    let prev = n.previousSibling;
    while (prev && prev.nodeType === Node.TEXT_NODE && !prev.nodeValue.trim()) prev = prev.previousSibling;
    if (n.querySelector('div, p') || lines(n) > 1) {
      const had = n.contains(caretNode);
      const flat = [];
      for (let i = Math.max(1, lines(n)); i > 0; i--) {
        const d = document.createElement('div');
        d.appendChild(document.createElement('br'));
        flat.push(d);
      }
      n.replaceWith(...flat);
      if (had) caretBeside(flat[flat.length - 1].firstChild, false);
    }
    n = prev;
  }
}

// Nothing but whitespace after the caret, and a line break between it and the last content:
// the caret sits on an empty line at the end rather than at the end of the text.
function caretOnEmptyTail(root, node, offset) {
  const after = document.createRange();
  after.setStart(node, offset);
  after.setEnd(root, root.childNodes.length);
  const rest = after.cloneContents();
  if (rest.textContent.trim() || rest.querySelector('img, a[data-file]')) return false;

  let n;
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.nodeValue.slice(0, offset).trim()) return false;
    n = node;
  } else if (offset > 0) {
    n = node.childNodes[offset - 1];
    while (n.lastChild) n = n.lastChild;
  } else {
    n = node;
  }
  let breaks = 0;
  for (; n && n !== root; n = nodeBefore(n, root)) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n === node || !n.nodeValue.trim()) continue;
      return breaks > 0;
    }
    if (n.nodeName === 'IMG' || (n.nodeName === 'A' && n.dataset.file !== undefined)) return breaks > 0;
    if (n.nodeName === 'BR') { if (n.nextSibling) breaks++; } else if (BLOCK[n.nodeName]) breaks++;
  }
  return false;
}

const lastSolid = parent => {
  let n = parent.lastChild;
  while (n && n.nodeType === Node.TEXT_NODE && !n.nodeValue.trim()) n = n.previousSibling;
  return n;
};
const isEmptyBlock = n => !n.textContent.trim() && !n.querySelector('img, a[data-file]');
const dropWithSpace = n => {
  while (n.nextSibling && n.nextSibling.nodeType === Node.TEXT_NODE && !n.nextSibling.nodeValue.trim()) n.nextSibling.remove();
  n.remove();
};

// Already ends in one <div><br></div> after real content, with no empty line before it.
function isCanonicalEnd(root) {
  const last = lastSolid(root);
  if (!last || last.nodeName !== 'DIV' || last.childNodes.length !== 1 || last.firstChild.nodeName !== 'BR') return false;
  let prev = last.previousSibling;
  while (prev && prev.nodeType === Node.TEXT_NODE && !prev.nodeValue.trim()) prev = prev.previousSibling;
  if (!prev) return false;
  if (prev.nodeName === 'BR' || (BLOCK[prev.nodeName] && (isEmptyBlock(prev) || endsInEmptyLine(prev)))) return false;
  return true;
}

// Inside the last block: trailing <br>s beyond a placeholder, and empty blocks, are empty lines.
function endsInEmptyLine(block) {
  const a = lastSolid(block);
  if (!a) return false;
  if (BLOCK[a.nodeName]) return isEmptyBlock(a) || endsInEmptyLine(a);
  if (a.nodeName !== 'BR') return false;
  let b = a.previousSibling;
  while (b && b.nodeType === Node.TEXT_NODE && !b.nodeValue.trim()) b = b.previousSibling;
  return !!b && (b.nodeName === 'BR' || !!BLOCK[b.nodeName] || b.nodeName === 'IMG' ||
    (b.nodeName === 'A' && b.dataset.file !== undefined));
}

function trimInside(block) {
  while (endsInEmptyLine(block)) {
    const a = lastSolid(block);
    if (BLOCK[a.nodeName] && !isEmptyBlock(a)) { trimInside(a); break; }
    dropWithSpace(a);
  }
}

const EMPTY_LINE_RE = /(?:<div><br><\/div>|<p><br><\/p>|<br>|&nbsp;|\s)+$/;
const trimTrailingLine = html => html.replace(EMPTY_LINE_RE, '');

/* ---------------- pasting, Enter at the end, undo (mirrored in the web app) ---------------- */

// Pasted HTML as inline content with a <br> wherever a line ended, so it joins the line it
// lands in the way pasted text does, instead of dropping whole blocks (and their spacing) into
// the middle of one. Formatting and links stay; blocks, margins and stray newlines go.
const INLINE = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, A: 1 };
function pastedLines(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = sanitize(html);
  const out = document.createElement('div');
  let open = false;    // the current line holds something
  let pending = false; // a line ended in a block: the next content starts a new one
  const put = (leaf, chain) => {
    if (pending) { out.appendChild(document.createElement('br')); pending = false; }
    let node = leaf;
    for (let i = chain.length - 1; i >= 0; i--) {
      const w = chain[i].cloneNode(false);
      w.appendChild(node);
      node = w;
    }
    out.appendChild(node);
  };
  const lastOfBlock = n => {
    for (let s = n.nextSibling; s; s = s.nextSibling) {
      if (s.nodeType === Node.ELEMENT_NODE || s.nodeValue.trim()) return false;
    }
    return !INLINE[n.parentNode.nodeName];
  };
  const walk = (parent, chain) => {
    for (const n of parent.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        let t = n.nodeValue.replace(/[\t\n\r ]+/g, ' ');
        if (!open) t = t.replace(/^ +/, '');
        if (!t || (t === ' ' && /\n/.test(n.nodeValue))) continue;
        put(document.createTextNode(t), chain);
        open = true;
      } else if (n.nodeName === 'BR') {
        if (open && lastOfBlock(n)) continue; // only holds its line open
        put(document.createElement('br'), chain);
        open = false;
      } else if (n.nodeName === 'IMG') {
        put(n.cloneNode(false), chain);
        open = true;
      } else if (INLINE[n.nodeName]) {
        walk(n, [...chain, n]);
      } else {
        if (open) { pending = true; open = false; }
        walk(n, chain);
        if (open) { pending = true; open = false; }
      }
    }
  };
  walk(tpl.content, []);

  // One <b> per run of text rather than one per piece of it.
  const merge = parent => {
    for (let n = parent.firstChild; n; ) {
      const next = n.nextSibling;
      const prev = n.previousSibling;
      if (prev && INLINE[n.nodeName] && prev.nodeName === n.nodeName &&
          prev.cloneNode(false).outerHTML === n.cloneNode(false).outerHTML) {
        prev.append(...n.childNodes);
        n.remove();
      }
      n = next;
    }
    for (const c of parent.children) merge(c);
  };
  merge(out);
  return out.innerHTML;
}

// Put pasted HTML in at the caret as plain nodes. execCommand('insertHTML') dresses them in
// inline styles copied from around the caret, which is how a paste used to bold a whole note.
function insertPasted(root, html) {
  if (!html) return;
  insertAtCaret(root, html);
  // A <br> ending a block only holds its line open, so a paste that ends in a line break needs
  // one more for that break to show. The caret goes on the new line, between the two.
  const sel = getSelection();
  const at = sel.rangeCount ? sel.focusNode : null;
  const before = at && at.childNodes[sel.focusOffset - 1];
  if (before && before.nodeName === 'BR') {
    let next = before.nextSibling;
    while (next && next.nodeType === Node.TEXT_NODE && !next.nodeValue.trim()) next = next.nextSibling;
    if (!next) {
      before.after(document.createElement('br'));
      caretBeside(before, true);
    }
  }
}

function caretOnTail(root) {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed || !root.contains(sel.anchorNode)) return false;
  const max = sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.length : sel.anchorNode.childNodes.length;
  return caretOnEmptyTail(root, sel.anchorNode, Math.min(sel.anchorOffset, max));
}

// Enter at the end of the last line moves onto the empty line that is always showing there.
// Chrome instead nests that line inside the new one, which put the caret a line too far down,
// so after such an Enter the caret's line is made the one empty line at the end.
function settleEnter(root) {
  const sel = getSelection();
  if (!sel.rangeCount || !caretOnTail(root)) return;
  const caret = sel.anchorNode;
  for (let n = lastSolid(root); n && BLOCK[n.nodeName] && isEmptyBlock(n); ) {
    let prev = n.previousSibling;
    while (prev && prev.nodeType === Node.TEXT_NODE && !prev.nodeValue.trim()) prev = prev.previousSibling;
    if (!n.contains(caret)) dropWithSpace(n);
    n = prev;
  }
}

// Cmd+Z goes through these snapshots of the note, not through the browser's own undo. The
// trailing line, autolinks and pastes change the note behind the browser's back, and its undo
// then put text back in odd places. Each change the note records is a step; typing joins the
// step before it until a new word starts, deleting joins until something else happens.
const MAX_UNDO_CHARS = 20e6;
function makeUndo(root, restored) {
  let past = [], future = [];
  let kind = null, at = 0, next = null;
  const caret = () => {
    const sel = getSelection();
    if (!sel.rangeCount || !root.contains(sel.anchorNode)) return null;
    const r = sel.getRangeAt(0);
    return [pointToOffset(root, r.startContainer, r.startOffset), pointToOffset(root, r.endContainer, r.endOffset)];
  };
  const snap = () => ({ html: root.innerHTML, caret: caret() });
  // Only the display line at the end is left out: a space typed at the end is a change here.
  const bare = html => html.replace(/(?:<div><br><\/div>|<p><br><\/p>|<br>)+$/, '');
  const same = (a, b) => bare(a) === bare(b);
  const apply = s => {
    root.innerHTML = s.html;
    const r = document.createRange();
    if (s.caret) {
      r.setStart(...offsetToPoint(root, s.caret[0]));
      r.setEnd(...offsetToPoint(root, s.caret[1]));
    } else {
      r.selectNodeContents(root);
      r.collapse(false);
    }
    if (document.activeElement !== root) root.focus({ preventScroll: true });
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    kind = null;
    restored();
  };
  return {
    // The note as it first shows, or as another device just changed it: nothing to undo yet.
    reset() { past = [snap()]; future = []; kind = null; next = null; },
    // A typed change is about to happen (from beforeinput). A new step starts from where the
    // caret is now, so undoing it puts the caret back there.
    before(k) {
      next = k;
      const joins = k && past.length > 1 && Date.now() - at < 2000 && (k === kind || (kind === 'type' && k === 'space'));
      if (!joins && past.length && same(past[past.length - 1].html, root.innerHTML)) past[past.length - 1].caret = caret();
    },
    // The note just changed (from store). Joins the last step when it is the same run.
    record() {
      const k = next;
      next = null;
      if (!past.length) { past = [snap()]; return; }
      const top = past[past.length - 1];
      if (same(top.html, root.innerHTML)) return;
      const now = Date.now();
      const joins = k && past.length > 1 && now - at < 2000 && (k === kind || (kind === 'type' && k === 'space'));
      at = now;
      kind = k;
      if (joins) past[past.length - 1] = snap();
      else past.push(snap());
      future = [];
      let size = past.reduce((n, s) => n + s.html.length, 0);
      while (past.length > 200 || (past.length > 2 && size > MAX_UNDO_CHARS)) size -= past.shift().html.length;
    },
    undo() {
      if (past.length < 2) return false;
      future.push(past.pop());
      apply(past[past.length - 1]);
      return true;
    },
    redo() {
      if (!future.length) return false;
      const s = future.pop();
      past.push(s);
      apply(s);
      return true;
    },
  };
}

// The run a typed change belongs to, for undo.
function runOf(e) {
  if (/^insert(Text|CompositionText|ReplacementText)$/.test(e.inputType)) return /^\s+$/.test(e.data || '') ? 'space' : 'type';
  if (/^delete(Content|Word)(Backward|Forward)$/.test(e.inputType)) return 'delete';
  return null;
}

// A file lives in the note as a link with its name on it. Not editable inside, so the caret
// treats it as one thing and Backspace takes the whole chip.
function fileChip(url, name, size) {
  return `<a href="${escapeHtml(url)}" data-file="${escapeHtml(name)}" data-size="${size || 0}">${escapeHtml(name)}</a>`;
}

// Put HTML in at the caret as plain nodes (execCommand would dress them in inline styles),
// and leave the caret after it.
function insertAtCaret(root, html) {
  const sel = getSelection();
  if (!sel.rangeCount || !root.contains(sel.anchorNode)) {
    const r = document.createRange();
    r.selectNodeContents(root);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const last = tpl.content.lastChild;
  range.insertNode(tpl.content);
  const r = document.createRange();
  r.setStartAfter(last);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

function dressChips(root) {
  for (const a of root.querySelectorAll('a[data-file]')) {
    if (a.contentEditable !== 'false') a.contentEditable = 'false';
  }
}

// Take a node out of the note, and with it the space after it and a block it leaves empty.
// Returns where it was, as a caret position.
function removeFromNote(node, root) {
  const parent = node.parentNode;
  let index = [...parent.childNodes].indexOf(node);
  const next = node.nextSibling;
  node.remove();
  if (next && next.nodeType === Node.TEXT_NODE && !next.nodeValue.trim()) next.remove();
  if (parent !== root && BLOCK[parent.nodeName] && !parent.textContent.trim() &&
      !parent.querySelector('img, a[data-file], br')) {
    const gp = parent.parentNode;
    index = [...gp.childNodes].indexOf(parent);
    parent.remove();
    return [gp, index];
  }
  return [parent, Math.min(index, parent.childNodes.length)];
}

// The caret where something was dropped, or at the end of the note when the point was not
// over its text (a margin, a resize grip).
function caretAtDrop(root, x, y) {
  const pos = document.caretRangeFromPoint?.(x, y);
  const r = document.createRange();
  if (pos && root.contains(pos.startContainer)) r.setStart(pos.startContainer, pos.startOffset);
  else r.selectNodeContents(root), r.collapse(false);
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

const fmtSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function downloadUrl(url, name) {
  if (!url.startsWith('data:')) { NoteSync.save(url, name); return; }
  const a = document.createElement('a');
  a.href = url;
  a.download = name || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const MAX_FILE = 25 * 1024 * 1024;

// Images go in as before. Anything else is uploaded first and then put in as a chip, at the
// caret as it was when the file arrived.
async function attachFiles(body, store, files) {
  for (const f of [...files]) {
    if (f.type.startsWith('image/')) {
      try {
        const uri = await imageToDataUri(f);
        body.focus();
        const sel = getSelection();
        if (!sel.rangeCount || !body.contains(sel.anchorNode)) {
          const r = document.createRange();
          r.selectNodeContents(body);
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        insertHtml(`<img src="${uri}">`);
        ensureTrailingLine(body);
        store();
      } catch {
        notice(`Could not read ${f.name}`);
      }
      continue;
    }
    if (f.size > MAX_FILE) { notice(`${f.name} is over 25 MB`); continue; }
    if (!sync) { notice('Not connected'); continue; }
    const sel = getSelection();
    const at = sel.rangeCount && body.contains(sel.anchorNode)
      ? pointToOffset(body, sel.anchorNode, sel.anchorOffset) : units(body);
    notice(`Uploading ${f.name}…`);
    try {
      const url = await sync.uploadFile(f);
      body.focus();
      const r = document.createRange();
      r.setStart(...offsetToPoint(body, at));
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      insertAtCaret(body, fileChip(url, f.name, f.size) + '&nbsp;');
      dressChips(body);
      ensureTrailingLine(body);
      store();
      notice(`Attached ${f.name}`);
    } catch {
      notice(`Could not upload ${f.name}`);
    }
  }
}

// A file chip under the mouse, or clicked, shows its own controls: open, save, remove. A
// clicked chip is also selected, so Backspace or Delete takes it out.
const OPEN_ICON = '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';
const SAVE_ICON = '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
// Full screen: the note takes most of the window and goes back to its place and size after.
const GROW_ICON = '<svg viewBox="0 0 24 24"><path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z"/></svg>';
const SHRINK_ICON = '<svg viewBox="0 0 24 24"><path d="M22 3.41 16.71 8.7 20 12h-8V4l3.29 3.29L20.59 2 22 3.41zM3.41 22l5.29-5.29L12 20v-8H4l3.29 3.29L2 20.59 3.41 22z"/></svg>';
function dressGrow(btn, note) {
  btn.innerHTML = note.expanded ? SHRINK_ICON : GROW_ICON;
  btn.title = note.expanded ? 'Exit full screen' : 'Full screen';
}

const CLIP_ICON = '<svg viewBox="0 0 24 24"><path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z"/></svg>';

let chipTools = null; // { el, chip, body, store }
let chipTimer = null;

function showChipTools(a, body, store) {
  clearTimeout(chipTimer);
  if (chipTools && chipTools.chip === a) { placeChipTools(); return; }
  hideChipTools();
  const m = document.createElement('div');
  m.className = 'chip-tools';
  const name = a.dataset.file;
  const size = +a.dataset.size;
  m.title = size ? `${name} · ${fmtSize(size)}` : name;
  for (const [label, icon, fn] of [
    ['Open', OPEN_ICON, () => NoteSync.open(a.href)],
    ['Save', SAVE_ICON, () => downloadUrl(a.href, name)],
    ['Remove', '×', () => removeChip(a, body, store)],
  ]) {
    const b = document.createElement('button');
    b.title = label;
    b.innerHTML = icon;
    b.addEventListener('pointerdown', ev => ev.preventDefault()); // the caret stays in the note
    b.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
    m.appendChild(b);
  }
  m.addEventListener('mouseenter', () => clearTimeout(chipTimer));
  m.addEventListener('mouseleave', scheduleHideChipTools);
  document.body.appendChild(m);
  chipTools = { el: m, chip: a, body, store };
  placeChipTools();
}

function placeChipTools() {
  if (!chipTools) return;
  const { el, chip } = chipTools;
  const r = chip.getBoundingClientRect();
  const left = Math.max(4, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 4));
  const above = r.top - el.offsetHeight - 3;
  el.style.left = left + 'px';
  el.style.top = (above >= 0 ? above : r.bottom + 3) + 'px';
}

function scheduleHideChipTools() {
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => { if (!(chipTools && chipTools.chip.classList.contains('chip-selected'))) hideChipTools(); }, 250);
}

function hideChipTools() {
  clearTimeout(chipTimer);
  if (chipTools) chipTools.el.remove();
  chipTools = null;
}

function selectChip(a, body, store) {
  for (const c of document.querySelectorAll('a.chip-selected')) if (c !== a) c.classList.remove('chip-selected');
  a.classList.add('chip-selected');
  showChipTools(a, body, store);
}

function deselectChips() {
  for (const c of document.querySelectorAll('a.chip-selected')) {
    c.classList.remove('chip-selected');
    if (!c.className) c.removeAttribute('class');
  }
  hideChipTools();
}

function removeChip(a, body, store) {
  deselectChips();
  const [at, offset] = removeFromNote(a, body);
  body.focus();
  const r = document.createRange();
  r.setStart(at, offset);
  r.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
  ensureTrailingLine(body);
  store();
}

document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.chip-tools, a[data-file]')) deselectChips();
}, true);
addEventListener('resize', hideChipTools);
document.addEventListener('scroll', hideChipTools, true);

// One picker for every note's paperclip. Files go into the note that asked.
const filePicker = document.createElement('input');
filePicker.type = 'file';
filePicker.multiple = true;
filePicker.hidden = true;
document.body.appendChild(filePicker);
let pickerTarget = null; // { body, store }
filePicker.addEventListener('change', async () => {
  const files = [...filePicker.files];
  filePicker.value = '';
  const target = pickerTarget;
  pickerTarget = null;
  if (files.length && target) await attachFiles(target.body, target.store, files);
});

// The caret moved: blank lines left behind at the end of a note go back to the one.
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  const n = sel.rangeCount ? sel.anchorNode : null;
  const el = n && (n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement);
  const body = el && el.closest('.note-body');
  if (body) ensureTrailingLine(body);
});

// A short message in the toast, without the Undo button the delete uses.
let noticeTimer = null;
function notice(text) {
  toastText.textContent = text;
  document.getElementById('undo').hidden = true;
  toast.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { if (document.getElementById('undo').hidden) toast.hidden = true; }, 2000);
}

/* ---------------- image resizing ---------------- */

// Chrome dropped native image handles in contenteditable, so these are drawn over the note.
let selectedImg = null;

function clearImageHandles() {
  for (const h of document.querySelectorAll('.img-handle')) h.remove();
  if (selectedImg) {
    selectedImg.classList.remove('selected');
    if (!selectedImg.className) selectedImg.removeAttribute('class');
  }
  selectedImg = null;
}

function selectImage(img, noteEl, body, store) {
  clearImageHandles();
  if (!img) return;

  selectedImg = img;
  img.classList.add('selected');

  const positionAll = () => {
    const nb = noteEl.getBoundingClientRect();
    const ib = img.getBoundingClientRect();
    for (const h of noteEl.querySelectorAll('.img-handle')) {
      h.style.left = (ib[h.dataset.c.includes('w') ? 'left' : 'right'] - nb.left - 6) + 'px';
      h.style.top = (ib[h.dataset.c.includes('n') ? 'top' : 'bottom'] - nb.top - 6) + 'px';
    }
  };

  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const h = document.createElement('div');
    h.className = 'img-handle ' + corner;
    h.dataset.c = corner;
    noteEl.appendChild(h);

    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      const sx = e.clientX;
      const startW = img.getBoundingClientRect().width;
      const grow = corner.includes('e') ? 1 : -1;

      const move = ev => {
        const w = Math.max(40, startW + (ev.clientX - sx) * grow);
        img.setAttribute('width', Math.round(w));
        img.style.maxWidth = '100%';
        positionAll();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        store();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  }

  positionAll();
}

document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.img-handle') && e.target.tagName !== 'IMG') clearImageHandles();
}, true);

// The image itself in a new tab. A just-pasted image is still a data URI, which Chrome will
// not open as a page, so it goes out as a blob URL of the same bytes. Built synchronously:
// window.open only passes the popup check while the click is being handled.
function openImage(img) {
  let url = img.getAttribute('src') || '';
  if (url.startsWith('data:')) {
    const [head, b64] = url.split(',');
    const type = (head.match(/^data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    url = URL.createObjectURL(new Blob([bytes], { type }));
  }
  if (url) NoteSync.open(url);
}

function caretBeside(node, after) {
  const r = document.createRange();
  if (after) r.setStartAfter(node);
  else r.setStartBefore(node);
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------------- caret that survives a remote update ---------------- */

// Positions counted in characters, with <br> and <img> as one each, so the caret can be put
// back in the same place after a note's HTML is replaced by a newer copy from elsewhere.
function units(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.length;
  if (node.nodeName === 'BR' || node.nodeName === 'IMG') return 1;
  let n = 0;
  for (const c of node.childNodes) n += units(c);
  return n;
}

function pointToOffset(root, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, offset);
  return units(r.cloneContents());
}

function offsetToPoint(root, target) {
  let seen = 0;
  const find = parent => {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const n = parent.childNodes[i];
      if (n.nodeType === Node.TEXT_NODE) {
        if (seen + n.length >= target) return [n, target - seen];
        seen += n.length;
      } else if (n.nodeName === 'BR' || n.nodeName === 'IMG') {
        if (seen + 1 > target) return [parent, i];
        seen += 1;
      } else {
        const hit = find(n);
        if (hit) return hit;
      }
    }
    return null;
  };
  return find(root) || [root, root.childNodes.length];
}

function replaceKeepingCaret(body, html) {
  const sel = getSelection();
  const focused = document.activeElement === body && sel.rangeCount && body.contains(sel.anchorNode);
  let caret = null;
  if (focused) {
    const r = sel.getRangeAt(0);
    caret = {
      start: pointToOffset(body, r.startContainer, r.startOffset),
      end: pointToOffset(body, r.endContainer, r.endOffset),
    };
  }
  body.innerHTML = html;
  if (!caret) return;
  const r = document.createRange();
  r.setStart(...offsetToPoint(body, caret.start));
  r.setEnd(...offsetToPoint(body, caret.end));
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------------- storage ---------------- */

function payload() {
  return { notes, tombs, hidden, railY, railCollapsed };
}

// save(note) records an edit to that note: it gets a fresh edit time and goes to the server.
// save() alone just writes this page's state to disk.
function save(note) {
  if (note) {
    note.u = window.NoteSync ? NoteSync.stamp(note.u) : Date.now();
    if (sync) sync.queue(note);
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  chrome.storage.local.set(payload());
  // Restore buttons in the history say what they would do to the notes as they are now.
  if (hist && historyPanel.classList.contains('open')) hist.refresh();
}

// Everything this page holds, as sync records, deleted notes included.
function records() {
  return [...notes, ...Object.entries(tombs).map(([id, u]) => ({ id, deleted: true, u }))];
}

// Take a note from another tab, the server, or the phone, if it is newer than ours.
// Existing note objects are updated in place: their event handlers hold on to them.
function applyRecord(rec) {
  const cur = notes.find(n => n.id === rec.id);
  const curU = cur ? (cur.u || 0) : (rec.id in tombs ? tombs[rec.id] : -1);
  if ((rec.u || 0) <= curU) return false;

  if (rec.deleted) {
    tombs[rec.id] = rec.u;
    if (cur) {
      notes.splice(notes.indexOf(cur), 1);
      noteEl(rec.id)?.remove();
    }
    return true;
  }

  delete tombs[rec.id];
  const data = {
    id: rec.id, html: rec.html || '', color: rec.color, fx: rec.fx, fy: rec.fy,
    w: rec.w, h: rec.h, z: rec.z, collapsed: !!rec.collapsed, title: rec.title || '', ord: rec.ord || 0,
    edited: rec.edited || 0, pinned: !!rec.pinned, expanded: !!rec.expanded, u: rec.u,
  };
  if (cur) {
    Object.assign(cur, data);
    patch(cur);
  } else {
    notes.push(data);
    render(data);
  }
  topZ = Math.max(topZ, data.z || 1);
  return true;
}

function noteEl(id) {
  return board.querySelector(`.note[data-id="${CSS.escape(id)}"]`);
}

// Bring a rendered note in line with its data, without rebuilding it, so focus and the caret
// survive a change arriving while you type in it.
function patch(note) {
  const el = noteEl(note.id);
  if (!el) { render(note); return; }

  el.classList.toggle('collapsed', !!note.collapsed);
  el.classList.toggle('expanded', !!note.expanded);
  dressGrow(el.querySelector('.note-grow'), note);
  el.style.width = note.w + 'px';
  el.style.height = note.collapsed ? '' : note.h + 'px';
  el.style.background = note.color;
  el.style.color = textOn(note.color);
  el.style.setProperty('--link', linkColor(note.color));
  el.style.zIndex = note.z;
  place(el, note);

  const fold = el.querySelector('.note-bar button');
  fold.textContent = note.collapsed ? '▸' : '▾';
  fold.title = note.collapsed ? 'Expand' : 'Collapse';
  const line = el.querySelector('.note-preview');
  if (document.activeElement !== line) line.value = note.title || '';
  line.placeholder = placeholder(note);

  const body = el.querySelector('.note-body');
  const html = trimTrailingLine(sanitize(note.html || ''));
  if (trimTrailingLine(sanitize(body.innerHTML)) !== html) {
    if (selectedImg && body.contains(selectedImg)) clearImageHandles();
    replaceKeepingCaret(body, html);
    dressChips(body);
    ensureTrailingLine(body);
    body.undo?.reset(); // undo must not bring back what the other device just changed
  }
}

function startSync() {
  if (!window.NoteSync || !window.NOTES_CONFIG) return;
  sync = new NoteSync({
    url: NOTES_CONFIG.url,
    key: NOTES_CONFIG.key,
    email: NOTES_CONFIG.email,
    password: NOTES_CONFIG.password,
    table: NOTES_CONFIG.table,
    local: records,
    onRemote: recs => {
      let changed = false;
      for (const r of recs) changed = applyRecord(r) || changed;
      if (changed) save();
    },
    // Pasted images were uploaded: point the note's <img> at the stored copy.
    onHistory: list => hist && hist.render(list),
    onRewrite: (id, map) => {
      const el = noteEl(id);
      if (el) {
        for (const img of el.querySelectorAll('.note-body img')) {
          const url = map[img.getAttribute('src')];
          if (url) img.setAttribute('src', url);
        }
      }
      save();
    },
  });
  sync.start();
}

// A debounce means the last keystrokes are still pending when a tab closes. Both of these
// fire before the page goes away, so nothing typed is lost.
addEventListener('pagehide', () => { if (saveTimer) flush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) flush();
});

async function load() {
  const got = await chrome.storage.local.get(
    ['notes', 'tombs', 'hidden', 'railY', 'railCollapsed', 'lastRestore']);
  notes = Array.isArray(got.notes) ? got.notes : [];
  tombs = got.tombs && typeof got.tombs === 'object' ? got.tombs : {};
  hidden = !!got.hidden;
  railY = typeof got.railY === 'number' ? got.railY : 0.5;
  railCollapsed = !!got.railCollapsed;

  // A snapshot staged by restore-notes.sh. Applied once, identified by its stamp, so
  // reopening tabs does not keep re-importing it.
  let restored = false;
  try {
    const r = await (await fetch('restore.json?t=' + Date.now())).json();
    if (r && Array.isArray(r.notes) && r.stamp && r.stamp !== got.lastRestore) {
      // A restore has to beat what the server holds, so every restored note is stamped as
      // edited now, and every note that is not in the snapshot is deleted now.
      const now = Date.now();
      const keep = new Set(r.notes.map(n => n.id));
      for (const n of notes) if (!keep.has(n.id)) tombs[n.id] = now;
      notes = r.notes;
      for (const n of notes) { n.u = now; delete tombs[n.id]; }
      restored = true;
      await chrome.storage.local.set({ notes, tombs, lastRestore: r.stamp });
    }
  } catch {
    /* no restore staged, the normal case */
  }

  // A fresh profile, or a new extension id. seed.json restores once; deleting every note
  // leaves an empty array rather than undefined, so this cannot fire again afterwards.
  if (!restored && got.notes === undefined) {
    try {
      const seed = await (await fetch('seed.json')).json();
      if (Array.isArray(seed) && seed.length) notes = seed;
    } catch {
      /* no seed file, the normal case */
    }
  }

  // Older notes stored plain text. Carry them across rather than dropping them. This has to
  // happen after the seed import, since a seed file can hold the old shape too.
  let changed = !restored && got.notes === undefined && notes.length > 0;
  for (const n of notes) {
    if (n.html === undefined) {
      n.html = escapeHtml(n.text || '').replace(/\n/g, '<br>');
      delete n.text;
      changed = true;
    }
  }
  if (changed) flush();

  topZ = notes.reduce((m, n) => Math.max(m, n.z || 1), 1);
  applyHidden();
  applyRail();
  renderAll();
  startSync();
}

// Another tab wrote. Merge note by note, newest edit wins, so a tab that is behind cannot
// overwrite what this one (or the phone) did more recently.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.hidden) { hidden = !!changes.hidden.newValue; applyHidden(); }
  if (changes.railY) { railY = changes.railY.newValue; applyRail(); }
  if (changes.railCollapsed) { railCollapsed = !!changes.railCollapsed.newValue; applyRail(); }

  if (changes.notes || changes.tombs) {
    const incoming = [
      ...(changes.notes?.newValue ?? []),
      ...Object.entries(changes.tombs?.newValue ?? {}).map(([id, u]) => ({ id, deleted: true, u })),
    ];
    for (const r of incoming) applyRecord(r);
    if (hist && historyPanel.classList.contains('open')) hist.refresh();
  }
});

/* ---------------- notes ---------------- */

/* Chrome full screen with the toolbar hidden (cmd shift F): the page fills the whole screen,
   but a new tab shows the toolbar over the top of it, without the page getting any smaller.
   The board then starts below where the toolbar lands, so no note sits under it.

   Told apart by the page's height against the screen's, not by the window frame: in macOS full
   screen the toolbar is an overlay even when it is always shown, so the frame reads zero both
   ways. Hidden, the page is as tall as the screen (less a MacBook notch, the window stops below
   it). Shown, it is shorter by the toolbar. A normal window is shorter still.

   The inset is the toolbar's real height, learned with the toolbar shown (the hidden page
   height minus the shown one), or from a normal window's frame, so a note sits at the same
   spot on screen with the toolbar hidden or always shown. Note places stay fractions of the
   board. */
const NOTCH = 60;   // px the full screen page may fall short of the screen, for the notch
let topInset = 0;

function stored(key) {
  try { return +localStorage.getItem(key) || 0; } catch { return 0; }
}
function store(key, v) {
  try { localStorage.setItem(key, String(Math.round(v))); } catch {}
}

function measureInset() {
  const sane = v => v > 20 && v < 250;
  const frame = outerHeight - innerHeight;
  const hidden = !document.fullscreenElement
    && innerHeight >= screen.height - NOTCH && innerHeight <= screen.height + 2;
  if (hidden) {
    store('fullPageHeight', innerHeight);
  } else if (frame <= 20) {
    // Full screen with the toolbar always shown: it takes exactly what the page lost.
    const bar = stored('fullPageHeight') - innerHeight;
    if (sane(bar)) store('toolbarFull', bar);
  } else if (sane(frame)) {
    store('toolbarHeight', frame);
  }
  const bar = [stored('toolbarFull'), stored('toolbarHeight'), 90].find(sane);
  topInset = hidden ? bar : 0;
  document.documentElement.style.setProperty('--top-inset', topInset + 'px');
}
measureInset();

// Height of the board, the part of the window notes live in.
const boardH = () => innerHeight - topInset;

function place(el, note) {
  el.style.left = Math.min(Math.max(note.fx * innerWidth, 0), innerWidth - 40) + 'px';
  el.style.top = Math.min(Math.max(note.fy * boardH(), 0), boardH() - 30) + 'px';
}

function preview(note) {
  const tmp = document.createElement('div');
  tmp.innerHTML = note.html || '';
  const first = (tmp.textContent || '').split('\n').find(l => l.trim()) || '';
  return first.trim().slice(0, 34) || (tmp.querySelector('img') ? 'Image' : 'Empty note');
}

// With no title typed, a collapsed note shows its first line in the title's place, and an
// open one shows nothing there.
function placeholder(note) {
  return note.collapsed ? preview(note) : '';
}

// The character boundary in an input nearest to a screen x, for placing the caret by hand.
const measure = document.createElement('canvas').getContext('2d');
function offsetAt(input, clientX) {
  const cs = getComputedStyle(input);
  measure.font = cs.font;
  const x = clientX - input.getBoundingClientRect().left - parseFloat(cs.paddingLeft) + input.scrollLeft;
  const v = input.value;
  let best = 0, gap = Infinity;
  for (let i = 0; i <= v.length; i++) {
    const d = Math.abs(measure.measureText(v.slice(0, i)).width - x);
    if (d < gap) { gap = d; best = i; }
  }
  return best;
}

function renderAll() {
  const active = document.activeElement;
  const focusId = active && active.classList?.contains('note-body')
    ? active.closest('.note')?.dataset.id : null;

  board.textContent = '';
  for (const note of notes) render(note);

  if (focusId) board.querySelector(`[data-id="${focusId}"] .note-body`)?.focus();
}

function render(note) {
  const fg = textOn(note.color);

  const el = document.createElement('div');
  el.className = 'note' + (note.collapsed ? ' collapsed' : '') + (note.expanded ? ' expanded' : '');
  el.dataset.id = note.id;
  el.style.width = note.w + 'px';
  el.style.height = note.collapsed ? '' : note.h + 'px';
  el.style.background = note.color;
  el.style.color = fg;
  el.style.setProperty('--link', linkColor(note.color));
  el.style.zIndex = note.z;
  place(el, note);

  const bar = document.createElement('div');
  bar.className = 'note-bar';

  const fold = document.createElement('button');
  fold.textContent = note.collapsed ? '▸' : '▾';
  fold.title = note.collapsed ? 'Expand' : 'Collapse';

  const line = document.createElement('input');
  line.className = 'note-preview';
  line.spellcheck = false;
  line.value = note.title || '';
  line.placeholder = placeholder(note);

  const grow = document.createElement('button');
  grow.className = 'note-grow';
  dressGrow(grow, note);

  const clip = document.createElement('button');
  clip.innerHTML = CLIP_ICON;
  clip.title = 'Attach a file';

  const paint = document.createElement('button');
  paint.textContent = '●';
  paint.title = 'Color';

  const del = document.createElement('button');
  del.textContent = '×';
  del.title = 'Delete';

  bar.append(fold, line, grow, clip, paint, del);

  const body = document.createElement('div');
  body.className = 'note-body';
  body.contentEditable = 'true';
  body.spellcheck = false;
  body.innerHTML = sanitize(note.html || '');
  dressChips(body);
  ensureTrailingLine(body);

  const pal = document.createElement('div');
  pal.className = 'palette';
  for (const c of COLORS) {
    const sw = document.createElement('button');
    sw.style.background = c;
    sw.addEventListener('click', () => {
      note.color = c;
      el.style.background = c;
      el.style.color = textOn(c);
      el.style.setProperty('--link', linkColor(c));
      pal.classList.remove('open');
      save(note);
    });
    pal.appendChild(sw);
  }

  el.append(bar, body, pal);
  for (const c of ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se']) {
    const g = document.createElement('div');
    g.className = 'grip ' + c;
    g.addEventListener('pointerdown', e => startResize(e, note, el, c));
    el.appendChild(g);
  }
  board.appendChild(el);

  /* behavior */

  const store = () => {
    undo.record();
    const html = trimTrailingLine(sanitize(body.innerHTML));
    if (html === note.html) return; // a blur with nothing typed is not an edit
    note.html = html;
    line.placeholder = placeholder(note);
    save(note);
  };

  const undo = body.undo = makeUndo(body, () => {
    if (selectedImg && body.contains(selectedImg)) clearImageHandles();
    dressChips(body);
    ensureTrailingLine(body);
    store();
  });
  undo.reset();

  let enterFromText = false;
  body.addEventListener('beforeinput', e => {
    // The Edit menu's Undo and Redo, and anything else that asks the browser for its own.
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      if (e.inputType === 'historyUndo') undo.undo(); else undo.redo();
      return;
    }
    enterFromText = e.inputType === 'insertParagraph' && !caretOnTail(body);
    undo.before(runOf(e));
  });

  body.addEventListener('input', e => {
    if (selectedImg && body.contains(selectedImg)) clearImageHandles();
    dressChips(body);
    ensureTrailingLine(body);
    if (e.inputType === 'insertParagraph' && enterFromText) settleEnter(body);
    if (!inserting) {
      // Any edit landing inside a link drops it to plain text first.
      unlinkAtCaret(body);
      if (endsWord(e)) autolink(body, () => undo.record());
    }
    store();
  });

  // No linkifying on blur: a url you deliberately broke must stay broken. Links form only
  // when a space or Enter finishes the word, or when one is pasted on its own.
  body.addEventListener('blur', () => { ensureTrailingLine(body, true); store(); });

  body.addEventListener('pointerdown', () => front(note, el));

  // Cmd/Ctrl + B, I, U, Shift+X for strikethrough (as in Google Docs) and nothing else.
  // styleWithCSS off keeps them as tags, not inline styles. Cmd+Z and Cmd+Shift+Z go through
  // the note's own undo.
  body.addEventListener('keydown', e => {
    const chip = body.querySelector('a.chip-selected');
    if (chip && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      removeChip(chip, body, store);
      return;
    }
    if (chip && !(e.metaKey || e.ctrlKey || e.altKey) && e.key.length === 1) deselectChips();
    // An image with its handles showing: Delete removes it, Enter starts a line below it.
    if (selectedImg && body.contains(selectedImg) && !(e.metaKey || e.ctrlKey || e.altKey)) {
      const img = selectedImg;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        clearImageHandles();
        const [at, offset] = removeFromNote(img, body);
        const r = document.createRange();
        r.setStart(at, offset);
        r.collapse(true);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        ensureTrailingLine(body);
        store();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        clearImageHandles();
        // Images are blocks, so a break right after one is an empty line of its own: the
        // caret goes there, and whatever followed the image moves down a line.
        const br = document.createElement('br');
        img.after(br);
        caretBeside(br, false);
        store();
        return;
      }
    }
    if (!(e.metaKey || e.ctrlKey)) return;

    const k = e.key.toLowerCase();
    if (k === 'z' || (k === 'y' && e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      if (k === 'z' && !e.shiftKey) undo.undo(); else undo.redo();
      return;
    }

    const cmd = e.shiftKey ? (k === 'x' ? 'strikeThrough' : null) : { b: 'bold', i: 'italic', u: 'underline' }[k];
    if (!cmd || e.altKey) return;
    e.preventDefault();
    document.execCommand(cmd, false, null);
    store();
  });

  body.addEventListener('paste', async e => {
    e.preventDefault();
    const dt = e.clipboardData;

    const files = [...(dt.files || [])];
    if (files.length) {
      await attachFiles(body, store, files);
      return;
    }

    const text = dt.getData('text/plain') || dt.getData('text/uri-list') || '';
    const trimmed = text.trim();
    undo.before(null);
    if (trimmed && isLink(trimmed.slice(...trimToken(trimmed)))) {
      insertPasted(body, linkifyText(trimmed));
    } else if (dt.getData('text/html')) {
      insertPasted(body, pastedLines(dt.getData('text/html')));
    } else {
      insertPasted(body, linkifyText(text));
    }
    dressChips(body);
    ensureTrailingLine(body);
    leaveLink(body);
    store();
  });

  // Images and files dragged in from the desktop land where they are dropped.
  body.addEventListener('dragover', e => {
    if ([...(e.dataTransfer?.items || [])].some(i => i.kind === 'file')) e.preventDefault();
  });

  body.addEventListener('drop', async e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    body.focus();
    caretAtDrop(body, e.clientX, e.clientY);
    await attachFiles(body, store, files);
  });

  body.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && a.href) {
      e.preventDefault();
      if (a.dataset.file !== undefined) selectChip(a, body, store);
      else if (e.metaKey || e.ctrlKey) window.open(a.href, '_blank', 'noreferrer');
      else location.href = a.href;
      return;
    }
    selectImage(e.target.tagName === 'IMG' ? e.target : null, el, body, store);
  });

  body.addEventListener('dblclick', e => {
    if (e.target.tagName !== 'IMG') return;
    e.preventDefault();
    openImage(e.target);
  });

  fold.addEventListener('click', () => {
    note.collapsed = !note.collapsed;
    // A full screen note folds back to its own place.
    if (note.collapsed && note.expanded) {
      note.expanded = false;
      el.classList.remove('expanded');
      dressGrow(grow, note);
    }
    el.classList.toggle('collapsed', note.collapsed);
    el.style.height = note.collapsed ? '' : note.h + 'px';
    fold.textContent = note.collapsed ? '▸' : '▾';
    fold.title = note.collapsed ? 'Expand' : 'Collapse';
    line.placeholder = placeholder(note);
    pal.classList.remove('open');
    // Expanding raises it too, or the grown note comes back under whatever was put over it.
    if (!note.collapsed && note.z !== topZ) {
      note.z = ++topZ;
      el.style.zIndex = note.z;
    }
    save(note);
  });

  // Its place and size stay as they were, so shrinking puts it back exactly there.
  grow.addEventListener('click', () => {
    note.expanded = !note.expanded;
    if (note.expanded) {
      shrinkOthers(note.id);
      note.collapsed = false;
      if (note.z !== topZ) note.z = ++topZ;
    }
    pal.classList.remove('open');
    patch(note);
    save(note);
  });

  // The caret must stay where it is: the file lands there once picked.
  clip.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
  clip.addEventListener('click', e => {
    e.stopPropagation();
    pickerTarget = { body, store };
    filePicker.click();
  });

  body.addEventListener('mouseover', e => {
    const a = e.target.closest('a[data-file]');
    if (a) showChipTools(a, body, store);
  });
  body.addEventListener('mouseout', e => {
    if (e.target.closest('a[data-file]')) scheduleHideChipTools();
  });

  paint.addEventListener('click', e => {
    e.stopPropagation();
    const open = pal.classList.contains('open');
    closePalettes();
    pal.classList.toggle('open', !open);
  });

  del.addEventListener('click', () => remove(note, el));

  line.addEventListener('input', () => {
    note.title = line.value;
    save(note);
  });
  line.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (note.collapsed) line.blur();
      else body.focus();
    } else if (e.key === 'Escape') {
      line.blur();
    }
  });
  line.addEventListener('blur', () => {
    // Spaces alone are no title, so the first line shows again.
    if (line.value.trim() || !line.value) return;
    line.value = note.title = '';
    save(note);
  });

  // The title stays part of the handle even while typing in it: pressing and moving drags the
  // note, a click puts the caret there. Only with text already selected does a press select.
  bar.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    if (note.expanded) { front(note, el); return; } // a full screen note does not move
    const onTitle = e.target === line;
    if (onTitle && document.activeElement === line && line.selectionStart !== line.selectionEnd) return;
    const x = el.offsetLeft, y = el.offsetTop;
    const at = onTitle ? offsetAt(line, e.clientX) : 0;
    startDrag(e, note, el);
    if (onTitle) addEventListener('pointerup', () => {
      if (el.offsetLeft !== x || el.offsetTop !== y) return;
      line.focus();
      line.setSelectionRange(at, at);
    }, { once: true });
  });
  line.addEventListener('dblclick', () => {
    const at = line.selectionStart, v = line.value;
    let a = at, b = at;
    while (a > 0 && /\S/.test(v[a - 1])) a--;
    while (b < v.length && /\S/.test(v[b])) b++;
    line.setSelectionRange(a, b);
  });

  return el;
}

// Only one note is full screen at a time. Touching, typing in or making any other note sends the
// full screen one back to its place, and so does putting another one full screen.
function shrinkOthers(id) {
  for (const n of notes) {
    if (!n.expanded || n.id === id) continue;
    n.expanded = false;
    patch(n);
    save(n);
  }
}
for (const type of ['pointerdown', 'focusin']) {
  board.addEventListener(type, e => {
    const el = e.target.closest && e.target.closest('.note');
    if (el) shrinkOthers(el.dataset.id);
  }, true);
}

function closePalettes() {
  for (const p of board.querySelectorAll('.palette.open')) p.classList.remove('open');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.palette, .note-bar button')) closePalettes();
});

function front(note, el) {
  if (note.z === topZ) return;
  note.z = ++topZ;
  el.style.zIndex = note.z;
  save(note);
}

function startDrag(e, note, el) {
  if (e.button !== 0) return;
  e.preventDefault();
  front(note, el);

  const dx = e.clientX - el.offsetLeft;
  const dy = e.clientY - el.offsetTop;

  const move = ev => {
    el.style.left = Math.min(Math.max(ev.clientX - dx, 0), innerWidth - 40) + 'px';
    el.style.top = Math.min(Math.max(ev.clientY - dy, 0), boardH() - 30) + 'px';
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    const fx = el.offsetLeft / innerWidth;
    const fy = el.offsetTop / boardH();
    if (fx === note.fx && fy === note.fy) return; // a click on the bar, not a move
    note.fx = fx;
    note.fy = fy;
    save(note);
  };

  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

function startResize(e, note, el, corner) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  front(note, el);

  const sx = e.clientX, sy = e.clientY;
  const sw = el.offsetWidth, sh = el.offsetHeight;
  const sl = el.offsetLeft, st = el.offsetTop;

  const move = ev => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    let w = sw, h = sh, l = sl, t = st;

    if (corner.includes('e')) w = sw + dx;
    if (corner.includes('s')) h = sh + dy;
    if (corner.includes('w')) { w = sw - dx; l = sl + dx; }
    if (corner.includes('n')) { h = sh - dy; t = st + dy; }

    if (w < MIN_W) { if (corner.includes('w')) l = sl + sw - MIN_W; w = MIN_W; }
    if (h < MIN_H) { if (corner.includes('n')) t = st + sh - MIN_H; h = MIN_H; }

    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.left = Math.max(l, 0) + 'px';
    el.style.top = Math.max(t, 0) + 'px';
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    note.w = el.offsetWidth;
    note.h = el.offsetHeight;
    note.fx = el.offsetLeft / innerWidth;
    note.fy = el.offsetTop / boardH();
    save(note);
  };

  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

function create(x, y) {
  const note = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    fx: Math.min(Math.max(x, 0), innerWidth - DEFAULT_W) / innerWidth,
    fy: Math.min(Math.max(y, 0), boardH() - DEFAULT_H) / boardH(),
    w: DEFAULT_W,
    h: DEFAULT_H,
    color: COLORS[notes.length % 8],
    html: '',
    collapsed: false,
    z: ++topZ,
  };
  notes.push(note);
  if (hidden) { hidden = false; applyHidden(); }
  render(note).querySelector('.note-body').focus();
  save(note);
}

function remove(note, el) {
  const i = notes.indexOf(note);
  if (i < 0) return;
  notes.splice(i, 1);
  el.remove();
  // The server keeps the text with the tombstone, so a delete is never the end of the data.
  const u = window.NoteSync ? NoteSync.stamp(note.u) : Date.now();
  tombs[note.id] = u;
  if (sync) sync.queue({ ...note, deleted: true, u });
  save();

  undoState = { note, i };
  toastText.textContent = 'Note deleted';
  document.getElementById('undo').hidden = false;
  toast.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { toast.hidden = true; undoState = null; }, 6000);
}

document.getElementById('undo').addEventListener('click', () => {
  if (!undoState) return;
  const { note } = undoState;
  // From the delete's time, so the stamp in save(note) lands after it.
  note.u = Math.max(note.u || 0, tombs[note.id] || 0);
  delete tombs[note.id];
  notes.splice(undoState.i, 0, note);
  render(note);
  save(note);
  toast.hidden = true;
  undoState = null;
});

/* ---------------- rail ---------------- */

function applyHidden() {
  board.classList.toggle('hidden', hidden);
  toggleBtn.children[0].textContent = hidden ? 'Show' : 'Hide';
  toggleBtn.title = hidden ? 'Show all notes' : 'Hide all notes';
}

function applyRail() {
  rail.classList.toggle('collapsed', railCollapsed);
  rail.title = railCollapsed ? 'Expand' : 'Collapse';
  // Measured after the class change, so the collapsed height is the one used.
  const h = rail.offsetHeight;
  rail.style.top = topInset + Math.min(Math.max(railY * boardH(), 0), boardH() - h) + 'px';
}

document.getElementById('new-note').addEventListener('click', () => {
  const n = notes.length;
  create(140 + (n % 6) * 26, 90 + (n % 6) * 26);
});

toggleBtn.addEventListener('click', () => {
  hidden = !hidden;
  applyHidden();
  save();
});

function toggleRail() {
  railCollapsed = !railCollapsed;
  applyRail();
  save();
}

// A drag that ends over a button must not also press it. This runs in the capture phase,
// before anything else sees the click, and applies to the buttons and the collapse alike.
let railDragged = false;

rail.addEventListener('click', e => {
  if (!railDragged) return;
  railDragged = false;
  e.stopImmediatePropagation();
  e.preventDefault();
}, true);

// Anywhere that is not one of the two buttons collapses or expands the rail.
rail.addEventListener('click', e => {
  if (e.target.closest('.rail-btn')) return;
  toggleRail();
});

// Drag from anywhere on the rail, vertically only. A few pixels of slop so that a click on
// a button is still a click.
rail.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const startY = e.clientY;
  const offset = e.clientY - rail.offsetTop;
  let dragging = false;

  const move = ev => {
    if (!dragging && Math.abs(ev.clientY - startY) < 4) return;
    if (!dragging) { dragging = true; rail.classList.add('dragging'); }
    ev.preventDefault();
    const h = rail.offsetHeight;
    rail.style.top = Math.min(Math.max(ev.clientY - offset, topInset), innerHeight - h) + 'px';
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (!dragging) return;
    rail.classList.remove('dragging');
    railDragged = true; // swallowed by the capture listener above
    railY = (rail.offsetTop - topInset) / boardH();
    save();
  };

  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

document.addEventListener('dblclick', e => {
  if (e.target.closest('.note, .tile, #search, #rail, #toast, #customize, #attribution, #history-panel')) return;
  create(e.clientX - 12, e.clientY - 12 - topInset);
});

addEventListener('resize', () => {
  measureInset();
  for (const n of notes) {
    const el = board.querySelector(`[data-id="${n.id}"]`);
    if (el) place(el, n);
  }
  applyRail();
});

document.execCommand('styleWithCSS', false, false);

/* ---------------- history ---------------- */

// Deleted notes and text taken out of notes, from every device, in a panel off the rail.
// history.js draws the list; sync.js decides what goes in it.
const historyPanel = document.createElement('aside');
historyPanel.id = 'history-panel';
historyPanel.setAttribute('aria-label', 'History');
historyPanel.innerHTML = `
  <div class="hp-head">
    <h2>History</h2>
    <button class="hp-close" title="Close" aria-label="Close">
      <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </button>
  </div>
  <div class="hp-box"></div>`;
document.body.appendChild(historyPanel);

const hist = window.NoteHistory ? NoteHistory.mount(historyPanel.querySelector('.hp-box'), {
  sync: () => sync,
  current: id => notes.find(n => n.id === id) || (id in tombs ? { deleted: true } : null),
  restore: restoreEntry,
}) : null;

function openHistory(on) {
  historyPanel.classList.toggle('open', on);
  document.getElementById('history-btn')?.classList.toggle('on', on);
  if (on && hist) hist.refresh();
}

document.getElementById('history-btn')?.addEventListener('click', () => {
  openHistory(!historyPanel.classList.contains('open'));
});
historyPanel.querySelector('.hp-close').addEventListener('click', () => openHistory(false));
addEventListener('keydown', e => { if (e.key === 'Escape') openHistory(false); });
// Notes stay usable with the panel open, to compare. Anywhere else closes it.
document.addEventListener('pointerdown', e => {
  if (historyPanel.classList.contains('open') &&
      !e.target.closest('#history-panel, #history-btn, .note, .chip-tools, #toast')) openHistory(false);
});

// A deleted note comes back where it was; a note still here gets its earlier text back, and
// what it said until now goes to history.
function restoreEntry(e) {
  const snap = e.snap || {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  let note = notes.find(n => n.id === e.note_id);
  if (note) {
    note.html = e.html;
    patch(note);
    save(note);
  } else {
    note = {
      id: e.note_id, html: e.html, color: snap.color || COLORS[0],
      fx: num(snap.fx, 0.1), fy: num(snap.fy, 0.1), w: snap.w || DEFAULT_W, h: snap.h || DEFAULT_H,
      collapsed: !!snap.collapsed, title: snap.title || '', ord: snap.ord || 0, pinned: !!snap.pinned, z: ++topZ,
      u: tombs[e.note_id] || 0,
    };
    delete tombs[note.id];
    notes.push(note);
    render(note);
    save(note);
  }
  if (hidden) { hidden = false; applyHidden(); save(); }
  const el = noteEl(note.id);
  if (el) {
    front(note, el);
    el.classList.remove('flash');
    void el.offsetWidth; // restart the flash if it is still running
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }
  notice(e.kind === 'deleted' ? 'Note restored' : 'Earlier version restored');
}

/* ---------------- new-tab lookalike ---------------- */

document.getElementById('search').addEventListener('submit', e => {
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const isUrl = /^(https?:\/\/|localhost[:/]|[\w-]+(\.[\w-]+)+([:/]|$))/i.test(q) && !/\s/.test(q);
  location.href = isUrl
    ? (/^https?:\/\//i.test(q) ? q : 'https://' + q)
    : 'https://www.google.com/search?q=' + encodeURIComponent(q);
});

// Chrome's own new-tab settings, copied to theme.json by sync-chrome-theme.py.
// The extension cannot read chrome://newtab or Chrome's prefs, so this is the closest
// source of truth available: the same values the real page renders from.
async function theme() {
  let t = null;
  try {
    t = await (await fetch('theme.json?t=' + Date.now())).json();
  } catch {
    console.warn('[sticky] no theme.json; run: python3 sync-chrome-theme.py');
    return null;
  }

  const logo = document.getElementById('logo');
  logo.style.backgroundImage = 'url("assets/logo.png")';

  const dark = !!(t.mainColor && textOn(t.mainColor) === '#ffffff');

  // The Customize pill takes Chrome's theme color, so it sits on the photo the way the real
  // one does. It appears only when Chrome's own footer is off, which already carries one.
  if (t.mainColor) {
    document.documentElement.style.setProperty('--surface', t.mainColor);
    document.documentElement.style.setProperty('--on-surface', textOn(t.mainColor));
  }
  if (t.footerVisible === false) document.getElementById('customize').hidden = false;
  void doodle(logo, dark); // async, never blocks the wordmark

  if (t.background && t.background.file) {
    // Painted on body itself. A separate fixed layer at z-index -1 would sit behind
    // body's own opaque background and never be seen.
    document.body.classList.add('has-bg');
    const v = encodeURIComponent(t.syncedAt || "");
    document.body.style.backgroundImage = `url("${t.background.file}?v=${v}")`;
    if (t.mainColor) document.body.style.backgroundColor = t.mainColor;

    // White logo over a dark photo, matching what Chrome does.
    if (t.mainColor && textOn(t.mainColor) === '#ffffff') logo.classList.add('invert');

    const a = document.getElementById('attribution');
    const lines = [t.background.attribution1, t.background.attribution2].filter(Boolean);
    if (lines.length) {
      document.getElementById('attribution-text').textContent = lines.join('\n');
      if (t.background.actionUrl) a.href = t.background.actionUrl;
      a.hidden = false;
    }
  }

  return t;
}

// The endpoint Chrome itself calls for the new tab doodle. Sent without cookies.
// It returns an empty object unless the request carries a browser User-Agent, which a
// fetch from this page does automatically.
//
// The payload embeds the artwork as a data URI, so there is no second request and nothing
// to cache. Google ships a light and a dark cut; the dark one carries the box color Chrome
// paints behind it over a photo background.
async function doodle(logo, dark) {
  try {
    const res = await fetch('https://www.google.com/async/ddljson?async=ntp:2', {
      credentials: 'omit',
    });
    const d = JSON.parse((await res.text()).replace(/^\)\]\}'\s*/, '')).ddljson;
    if (!d || !d.alt_text) return; // no doodle today, the usual case

    const img = (dark ? d.dark_large_image : d.large_image) || d.large_image || {};
    const src = (dark ? d.dark_data_uri : d.data_uri) || d.data_uri || img.url;
    if (!src) return;

    logo.style.backgroundImage = `url("${src}")`;
    logo.classList.remove('invert'); // a doodle is its own artwork
    document.body.classList.add('has-doodle');

    // logo.css caps a tightly boxed doodle at 156px tall; width follows the payload's ratio.
    const h = Math.min(156, img.height || 156);
    const w = img.width && img.height ? Math.round((img.width * h) / img.height) : 390;
    logo.style.width = w + 'px';
    logo.style.height = h + 'px';

    if (img.background_color) {
      document.documentElement.style.setProperty('--doodle-box-color', img.background_color);
    }

    const box = document.getElementById('doodle-box');
    box.title = d.alt_text;
    const href = d.target_url || d.search_url;
    if (href) {
      box.addEventListener('click', () => {
        location.href = new URL(href, 'https://www.google.com').href;
      });
    }
  } catch {
    /* offline, or the shape changed. The wordmark is already showing. */
  }
}

// chrome://newtab is the alias this extension overrides. chrome://new-tab-page is Chrome's own
// NTP WebUI, reachable directly, and its app.ts reads a `customize` URL param
// (CUSTOMIZE_URL_PARAM) whose values come from customize_dialog_types.ts: backgrounds,
// shortcuts, modules, themes, wallpaper_search.
//
// So the button opens Chrome's real page with the panel already on the backgrounds section.
// Nothing is disabled, nothing has to be turned back on, and the launchd agent picks up
// whatever you change within a few seconds.
document.getElementById('customize').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://new-tab-page/?customize=backgrounds' });
});

async function tiles(t) {
  // Chrome lets you switch shortcuts off entirely. Respect that.
  if (t && t.shortcutsVisible === false) return;

  let sites = ((t && t.shortcuts) || []).filter(s => s.url);
  if (!sites.length) {
    if (!chrome.topSites) return;
    try { sites = await chrome.topSites.get(); } catch { return; }
  }

  const frag = document.createDocumentFragment();
  for (const site of sites.slice(0, 10)) {
    const a = document.createElement('a');
    a.className = 'tile';
    a.href = site.url;

    const icon = document.createElement('div');
    icon.className = 'tile-icon';
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(site.url)}&size=32`);
    img.addEventListener('error', () => {
      img.remove();
      icon.textContent = (site.title || site.url).replace(/^\W+/, '').charAt(0).toUpperCase();
    });
    icon.appendChild(img);

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = site.title || new URL(site.url).hostname;

    a.append(icon, label);
    frag.appendChild(a);
  }
  document.getElementById('tiles').appendChild(frag);
}

load();
theme().then(tiles);
