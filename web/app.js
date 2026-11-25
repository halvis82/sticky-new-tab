'use strict';

/* The same notes as the Chrome new tab page, as a phone-first editor.

   Formatting matches the extension exactly (bold, italic, underline, links, images, and
   nothing else) because the extension sanitizes to that set: anything richer made here would
   be stripped the moment a new tab saved the note. */

const COLORS = [
  '#fff5a5', '#ffd08a', '#ff9aa2', '#f4b6d2', '#c9b6f7', '#a8d8ff',
  '#a8e6b8', '#e0e0e0', '#1a73e8', '#8e24aa', '#c62828', '#2d2d2d',
];

const MAX_IMAGE_PX = 1600;
const CACHE_KEY = 'notes-cache-v1';
const WIDE = matchMedia('(min-width: 800px)');

const $ = id => document.getElementById(id);
const list = $('list');
const editor = $('editor');
const titleIn = $('title');
const pane = $('editor-pane');
const toolbar = $('toolbar');
const palette = $('palette');
const menu = $('menu');
const fileInput = $('file');

const records = new Map(); // id -> note, tombstones included
let openId = null;
let query = '';
let sync = null;
let createdHere = null; // a note made here and still untouched, dropped if left empty

/* ---------------- color ---------------- */

function luminance(hex) {
  const ch = i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

function textOn(hex) {
  return luminance(hex) > 0.4 ? '#1a1a1a' : '#ffffff';
}

function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Same rule as the extension: blue links, red when blue would vanish into the note.
function linkColor(bg) {
  const dark = textOn(bg) === '#ffffff';
  const blue = dark ? '#8ab4f8' : '#1a73e8';
  const red = dark ? '#f28b82' : '#c5221f';
  return contrast(blue, bg) >= 3.2 || contrast(blue, bg) >= contrast(red, bg) ? blue : red;
}

/* ---------------- rich text (mirrors newtab.js) ---------------- */

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
  for (const img of tpl.content.querySelectorAll('img')) {
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

// Plain text with the line breaks a reader sees: <br> and each block start a new line.
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
  return out.replace(/ /g, ' ').replace(/\n+$/, '');
}

function firstImage(html) {
  const m = /<img[^>]+src="(https:[^"]+)"/i.exec(html || '');
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

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

/* ---------------- links (mirrors newtab.js) ---------------- */

const LINK_RE = /^(https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?)$/i;
const TLD_RE = /\.(com|org|net|edu|gov|mil|int|io|co|dev|app|ai|no|uk|de|me|tv|info|xyz|be|ly|gg|to|us|ca|fr|se|dk|fi|it|es|nl|ch|eu|au|nz|jp|kr|cn|in|br|ru|pl|cz|at|ie|is|sh|cc|fm|so|re|page|site|online|store|tech|blog|cloud|news|shop|pro|biz|club|design|studio|space|live|life|world|today|wiki|zone|run|fun|art|gl|id|ws)(\/|$|:|\?|#)/i;

const hrefFor = word => (/^https?:\/\//i.test(word) ? word : /^mailto:/i.test(word) ? word : 'https://' + word);

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
      `<a href="${escapeHtml(hrefFor(word))}">${escapeHtml(word)}</a>` +
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
  a.href = hrefFor(word);
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

// Typing inside a link turns it back into plain text, as in the extension. The link's text and
// formatting stay; only the link goes.
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


/* ---------------- trailing line and file chips (mirrors newtab.js) ---------------- */

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

/* ---------------- pasting, Enter at the end, undo (mirrors newtab.js) ---------------- */

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

function caretBeside(node, after) {
  const r = document.createRange();
  if (after) r.setStartAfter(node);
  else r.setStartBefore(node);
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
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

/* ---------------- caret that survives a remote update ---------------- */

// Positions counted in characters, with <br> and <img> as one each, so the same position can
// be found again after the note's HTML is replaced by a newer copy from another device.
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

function saveCaret(root) {
  const sel = getSelection();
  if (!sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  return {
    start: pointToOffset(root, r.startContainer, r.startOffset),
    end: pointToOffset(root, r.endContainer, r.endOffset),
  };
}

function restoreCaret(root, c) {
  if (!c) return;
  const r = document.createRange();
  r.setStart(...offsetToPoint(root, c.start));
  r.setEnd(...offsetToPoint(root, c.end));
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------------- images ---------------- */

// Same cap as the extension. Photos stay JPEG so a phone picture is not a 4 MB PNG.
function imageToDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_PX / Math.max(img.width, img.height));
        if (scale === 1 && file.size < 3e6) return resolve(reader.result);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const photo = /jpe?g|heic|heif/i.test(file.type);
        resolve(photo ? c.toDataURL('image/jpeg', 0.88) : c.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function insertImages(files) {
  const imgs = [...files].filter(f => f.type.startsWith('image/'));
  if (!imgs.length) return false;
  for (const f of imgs) {
    try {
      insertHtml(`<img src="${await imageToDataUri(f)}">`);
    } catch {
      toast('Could not read that image');
    }
  }
  store(true);
  return true;
}

const MAX_FILE = 25 * 1024 * 1024;

// Images go in as before. Anything else is uploaded first and then put in as a chip.
async function attachFiles(files) {
  for (const f of [...files]) {
    restoreSelection();
    if (f.type.startsWith('image/')) {
      await insertImages([f]);
      continue;
    }
    if (f.size > MAX_FILE) { toast(`${f.name} is over 25 MB`); continue; }
    if (!sync) { toast('Not connected'); continue; }
    toast(`Uploading ${f.name}…`);
    try {
      const url = await sync.uploadFile(f);
      restoreSelection();
      insertAtCaret(editor, fileChip(url, f.name, f.size) + '&nbsp;');
      dressChips(editor);
      ensureTrailingLine(editor);
      store(true);
      toast(`Attached ${f.name}`);
    } catch {
      toast(`Could not upload ${f.name}`);
    }
  }
}

/* ---------------- storage ---------------- */

function loadCache() {
  try {
    for (const r of JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')) records.set(r.id, r);
  } catch {
    /* private mode or a corrupt entry. The server has everything. */
  }
}

let cacheTimer = null;
function saveCache(now) {
  clearTimeout(cacheTimer);
  const write = () => {
    cacheTimer = null;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify([...records.values()]));
    } catch {
      /* over quota, most likely an image still waiting to upload. The server keeps it. */
    }
  };
  if (now) write();
  else cacheTimer = setTimeout(write, 300);
}

const liveNotes = () => [...records.values()].filter(r => !r.deleted);

// Every local change goes through here: stamp it, keep it, send it.
function edit(rec) {
  rec.u = NoteSync.stamp(rec.u);
  saveCache();
  sync && sync.queue(rec);
  renderListSoon();
  if (rec.id === openId) showEdited(rec);
}

function applyRemote(recs) {
  // A keystroke still inside the debounce is newer than anything arriving. Commit it first
  // so the comparison below sees it.
  if (storeTimer) store(true);

  let changed = false;
  for (const inc of recs) {
    const cur = records.get(inc.id);
    if (cur && (cur.u || 0) >= inc.u) continue;
    if (cur) {
      Object.assign(cur, inc);
      if (!inc.deleted) delete cur.deleted;
    } else {
      records.set(inc.id, inc);
    }
    changed = true;
    if (inc.id === openId) refreshOpen();
  }
  if (changed) {
    saveCache();
    renderListSoon();
  }
}

function onRewrite(id, map) {
  if (id === openId) {
    for (const img of editor.querySelectorAll('img')) {
      const url = map[img.getAttribute('src')];
      if (url) img.setAttribute('src', url);
    }
  }
  saveCache();
  renderListSoon();
}

function setStatus(s) {
  document.body.dataset.sync = s;
  const label = { live: 'Live, synced', connecting: 'Connecting…', offline: 'Offline, will sync when back' }[s];
  for (const d of document.querySelectorAll('.dot')) d.title = label;
}

/* ---------------- list ---------------- */

function ago(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return 'Just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  const d = new Date(ms);
  const days = Math.floor(s / 86400);
  if (days < 1.5) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

let listFrame = 0;
function renderListSoon() {
  if (listFrame) return;
  listFrame = requestAnimationFrame(() => {
    listFrame = 0;
    renderList();
    // Restore buttons say what they would do to the note as it is now.
    if (document.body.classList.contains('history')) hist.refresh();
  });
}

const COPY_ICON = '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
const FOLD_ICON = '<svg viewBox="0 0 24 24"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>';

// Cards folded down to their title (or first line), per device, kept between visits.
const FOLD_KEY = 'folded-cards-v1';
const folded = new Set();
try { for (const id of JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')) folded.add(id); } catch {}

function toggleFold(id) {
  if (!folded.delete(id)) folded.add(id);
  for (const x of folded) if (!records.has(x)) folded.delete(x); // notes gone for good
  try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch {}
}

// Where a note sits in the list, highest first. New notes get the newest, dragging changes it.
// Pinned notes sit above the rest.
const orderOf = r => r.ord || r.u || 0;
const byOrder = NoteCards.sorter(orderOf);

let shown = [];      // the notes as the list shows them, for working out a drop
let reorder = null;

function renderList() {
  if (reorder && reorder.active()) return; // drawn again when the card is dropped
  const q = query.trim().toLowerCase();
  const notes = liveNotes()
    .map(n => ({ n, text: htmlToText(n.html || '') }))
    .filter(x => !q || x.text.toLowerCase().includes(q) || (x.n.title || '').toLowerCase().includes(q))
    .sort((a, b) => byOrder(a.n, b.n));
  shown = notes.map(x => x.n);

  const frag = document.createDocumentFragment();
  for (const { n, text } of notes) {
    const li = document.createElement('li');
    const img = firstImage(n.html);
    const hasText = !!text.trim();
    const foldable = hasText || !!img;
    const isFolded = foldable && folded.has(n.id);
    li.className = 'card' + (n.id === openId ? ' active' : '') + (n.pinned ? ' pinned' : '')
      + (isFolded ? ' folded' : '');
    li.dataset.id = n.id;
    li.style.background = n.color;
    li.style.color = textOn(n.color);

    const main = document.createElement('div');
    main.className = 'card-main';

    const title = (n.title || '').trim();
    if (title) {
      const h = document.createElement('div');
      h.className = 'card-title';
      h.textContent = title;
      main.appendChild(h);
    }

    const p = document.createElement('div');
    p.className = 'card-text' + (title ? '' : ' lead');
    if (hasText) {
      p.innerHTML = NoteCards.preview(sanitize(n.html));
    } else if (!title) {
      p.textContent = img ? 'Image' : 'Empty note';
      p.classList.add('empty');
    }

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = ago(n.edited || n.u);
    if (foldable) {
      const f = document.createElement('button');
      f.className = 'card-fold';
      f.title = isFolded ? 'Show preview' : 'Hide preview';
      f.setAttribute('aria-label', f.title);
      f.setAttribute('aria-expanded', isFolded ? 'false' : 'true');
      f.innerHTML = FOLD_ICON;
      meta.prepend(f);
    }

    main.append(p, meta);
    li.appendChild(main);

    if (img) {
      const t = document.createElement('img');
      t.className = 'card-thumb';
      t.src = img;
      t.alt = '';
      t.loading = 'lazy';
      li.appendChild(t);
    }

    li.appendChild(NoteCards.pinButton(n, 'card-pin'));

    if (hasText) {
      const c = document.createElement('button');
      c.className = 'card-copy';
      c.title = 'Copy note';
      c.setAttribute('aria-label', 'Copy note');
      c.innerHTML = COPY_ICON;
      li.appendChild(c);
    }

    frag.appendChild(li);
  }

  list.textContent = '';
  if (!notes.length) {
    const e = document.createElement('li');
    e.className = 'empty-list';
    e.textContent = q ? 'No notes match.' : 'No notes yet. Tap + to make one.';
    list.appendChild(e);
  } else {
    list.appendChild(frag);
  }
}

list.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  const rec = records.get(card.dataset.id);
  if (!rec) return;
  if (e.target.closest('.card-copy')) {
    copyNote(rec);
    return;
  }
  if (e.target.closest('.card-fold')) {
    toggleFold(rec.id);
    renderList();
    return;
  }
  if (e.target.closest('.card-pin')) {
    rec.pinned = !rec.pinned;
    edit(rec);
    renderList();
    return;
  }
  openNote(rec.id);
});

// Hold a card (or drag it with the mouse) to move it in the list. The order syncs.
reorder = NoteCards.reorderable(list, {
  item: '.card',
  scroller: () => (WIDE.matches ? $('list-pane') : null),
  onDrop: (id, _above, _below, ids) => {
    const { above, below, group } = NoteCards.groupNeighbors(shown, ids, id);
    if (!above && !below) return; // the only note of its kind, it stays where it is
    for (const { note, ord } of NoteCards.place(group, orderOf, id, above, below)) {
      if (note.ord === ord) continue;
      note.ord = ord;
      edit(note);
    }
  },
  onEnd: renderListSoon,
});

$('search').addEventListener('input', e => {
  query = e.target.value;
  renderList();
});

// Relative times go stale while the page sits open.
setInterval(() => { if (document.visibilityState === 'visible') renderListSoon(); }, 60000);

/* ---------------- editor ---------------- */

function paintEditor(rec) {
  const s = document.documentElement.style;
  s.setProperty('--note', rec.color);
  s.setProperty('--note-fg', textOn(rec.color));
  s.setProperty('--note-link', linkColor(rec.color));
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = rec.color;
}

function unpaintEditor() {
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.content = m.media.includes('dark') ? '#1b1b1d' : '#f6f5f1';
  }
}

function showEdited(rec) {
  const at = rec.edited || rec.u;
  $('edited').textContent = at ? 'Edited ' + ago(at).toLowerCase() : '';
}

function openNote(id, { history: how = 'push', focus = false } = {}) {
  const rec = records.get(id);
  if (!rec || rec.deleted) return;
  if (openId && openId !== id) leaveNote();

  openId = id;
  closePops();
  paintEditor(rec);
  editor.innerHTML = sanitize(rec.html || '');
  dressChips(editor);
  ensureTrailingLine(editor);
  titleIn.value = rec.title || '';
  undo.reset();
  showEdited(rec);
  document.body.classList.add('editing', 'has-note');

  if (how !== 'none') {
    const state = { id };
    if (how === 'push' && !WIDE.matches) history.pushState(state, '', '#' + id);
    else history.replaceState(state, '', '#' + id);
  }

  if (!WIDE.matches) { scrollTo(0, 0); document.body.classList.remove('history'); }
  else $('sheet').scrollTop = 0;
  renderListSoon();

  if (focus) {
    editor.focus();
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }
  placeToolbar();
}

// Leaving a note made here and never written in removes it, so a stray + leaves nothing behind.
function leaveNote() {
  store(true);
  const rec = records.get(openId);
  if (rec && createdHere === rec.id && !htmlToText(rec.html || '').trim() && !/<img/i.test(rec.html || '') &&
    !(rec.title || '').trim()) {
    rec.deleted = true;
    edit(rec);
  }
  createdHere = null;
}

function closeNote({ history: how = 'replace' } = {}) {
  if (!openId) return;
  leaveNote();
  openId = null;
  closePops();
  editor.blur();
  editor.innerHTML = '';
  document.body.classList.remove('editing', 'has-note', 'typing');
  unpaintEditor();
  if (how === 'replace') history.replaceState(null, '', location.pathname);
  renderList();
  if (!WIDE.matches) scrollTo(0, listScroll);
}

let listScroll = 0;
addEventListener('scroll', () => {
  if (!document.body.classList.contains('editing')) listScroll = scrollY;
}, { passive: true });

$('back').addEventListener('click', () => {
  if (history.state && history.state.id) history.back();
  else closeNote();
});

addEventListener('popstate', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id === 'history') {
    closeNote({ history: 'none' });
    showHistory(true, 'none');
    return;
  }
  if (!WIDE.matches) showHistory(false, 'none');
  if (id && records.has(id)) openNote(id, { history: 'none' });
  else closeNote({ history: 'none' });
});

// A remote copy of the open note arrived. Keep the caret where it was.
function refreshOpen() {
  const rec = records.get(openId);
  if (!rec) return;
  if (rec.deleted) {
    closeNote();
    toast('This note was deleted on another device');
    return;
  }
  paintEditor(rec);
  showEdited(rec);
  if (document.activeElement !== titleIn) titleIn.value = rec.title || '';
  const html = trimTrailingLine(sanitize(rec.html || ''));
  if (trimTrailingLine(sanitize(editor.innerHTML)) === html) return;
  const focused = document.activeElement === editor;
  const caret = focused ? saveCaret(editor) : null;
  editor.innerHTML = html;
  dressChips(editor);
  if (focused) restoreCaret(editor, caret);
  ensureTrailingLine(editor);
  undo.reset(); // undo must not bring back what the other device just changed
  selectedImg = null;
}

// The title, typed above the text. Synced as you type, like the note bar's on the new tab.
titleIn.addEventListener('input', () => {
  const rec = records.get(openId);
  if (!rec) return;
  rec.title = titleIn.value;
  if (createdHere === rec.id && rec.title.trim()) createdHere = null;
  edit(rec);
});
titleIn.addEventListener('blur', () => {
  const rec = records.get(openId);
  // Spaces alone are no title.
  if (rec && rec.title && !rec.title.trim()) {
    titleIn.value = rec.title = '';
    edit(rec);
  }
});
titleIn.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  editor.focus();
  const r = document.createRange();
  r.setStart(editor, 0);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
});

let storeTimer = null;
function store(now) {
  if (openId) undo.record();
  clearTimeout(storeTimer);
  storeTimer = null;
  const commit = () => {
    storeTimer = null;
    const rec = records.get(openId);
    if (!rec) return;
    const html = trimTrailingLine(sanitize(editor.innerHTML));
    if (html === rec.html) return;
    rec.html = html;
    if (createdHere === rec.id && htmlToText(html).trim()) createdHere = null;
    edit(rec);
  };
  if (now) commit();
  else storeTimer = setTimeout(commit, 150);
}

const undo = makeUndo(editor, () => {
  selectedImg = null;
  closePops();
  dressChips(editor);
  ensureTrailingLine(editor);
  store(true);
  updateToolbar();
});

let enterFromText = false;
editor.addEventListener('beforeinput', e => {
  // Undo from the Edit menu or a shake of the phone.
  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
    e.preventDefault();
    if (e.inputType === 'historyUndo') undo.undo(); else undo.redo();
    return;
  }
  enterFromText = e.inputType === 'insertParagraph' && !caretOnTail(editor);
  undo.before(runOf(e));
});

// Input that ends a word: a space (or a whole suggestion ending in one), Enter, or a line
// break from any keyboard, including the ones that send Enter only as a newline character.
function endsWord(e) {
  if (e.isComposing) return false;
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') return true;
  if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') {
    return !e.data || /\s$/.test(e.data);
  }
  return false;
}

editor.addEventListener('input', e => {
  dressChips(editor);
  ensureTrailingLine(editor);
  if (e.inputType === 'insertParagraph' && enterFromText) settleEnter(editor);
  if (!inserting) {
    unlinkAtCaret(editor);
    if (endsWord(e)) autolink(editor, () => undo.record());
  }
  store();
});

// A suggestion accepted on a phone keyboard often arrives as composition, not as typed text.
editor.addEventListener('compositionend', () => {
  if (!inserting && autolink(editor, () => undo.record())) store();
});

// Cmd+Z and Cmd+Shift+Z go through the note's own undo. Cmd+Shift+X is strikethrough, as in
// Google Docs.
editor.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();

  if (k === 'z' || (k === 'y' && e.ctrlKey && !e.metaKey)) {
    e.preventDefault();
    run(k === 'z' && !e.shiftKey ? 'undo' : 'redo');
    return;
  }

  const cmd = e.shiftKey ? (k === 'x' ? 'strikeThrough' : null) : { b: 'bold', i: 'italic', u: 'underline', k: 'link' }[k];
  if (!cmd || e.altKey) return;
  e.preventDefault();
  run(cmd);
});

editor.addEventListener('focus', () => {
  document.body.classList.add('typing');
  placeToolbar();
});

editor.addEventListener('blur', () => {
  ensureTrailingLine(editor, true);
  store(true);
  // The toolbar is being tapped: keep the typing state so it does not jump.
  setTimeout(() => {
    if (document.activeElement !== editor) {
      document.body.classList.remove('typing');
      placeToolbar();
    }
  }, 150);
});

editor.addEventListener('paste', async e => {
  const dt = e.clipboardData;
  if (!dt) return;
  e.preventDefault();

  const files = [...(dt.files || [])];
  if (files.length) {
    await attachFiles(files);
    return;
  }

  // A copied address on iOS can come as a URL only, with no plain text.
  const text = dt.getData('text/plain') || dt.getData('text/uri-list') || '';
  const trimmed = text.trim();
  undo.before(null);
  if (trimmed && isLink(trimmed.slice(...trimToken(trimmed)))) {
    insertPasted(editor, linkifyText(trimmed));
  } else if (dt.getData('text/html')) {
    insertPasted(editor, pastedLines(dt.getData('text/html')));
  } else {
    insertPasted(editor, linkifyText(text));
  }
  dressChips(editor);
  ensureTrailingLine(editor);
  leaveLink(editor);
  store(true);
});

// Images and files dragged in from the desktop.
editor.addEventListener('dragover', e => {
  if ([...(e.dataTransfer?.items || [])].some(i => i.kind === 'file')) e.preventDefault();
});

editor.addEventListener('drop', async e => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  editor.focus({ preventScroll: true });
  caretAtDrop(editor, e.clientX, e.clientY);
  await attachFiles(files);
});

/* ---------------- links and images: tap for options ---------------- */

let selectedImg = null;

editor.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (a && a.href) {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) {
      window.open(a.href, '_blank', 'noopener');
      return;
    }
    if (a.dataset.file !== undefined) fileMenu(a);
    else linkMenu(a);
    return;
  }
  if (e.target.tagName === 'IMG') {
    // On a phone the keyboard would sit on top of the menu.
    if (!WIDE.matches && document.activeElement === editor) editor.blur();
    imageMenu(e.target);
    return;
  }
  closePops();
});

function fileMenu(a) {
  const name = a.dataset.file;
  const size = +a.dataset.size;
  showMenu(a, [
    ['Open', () => NoteSync.open(a.href)],
    ['Download', () => downloadUrl(a.href, name)],
    ['Remove', () => { removeFromNote(a, editor); ensureTrailingLine(editor); store(true); }, true],
  ], size ? `${name} · ${fmtSize(size)}` : name);
}

function showMenu(anchor, items, url) {
  menu.textContent = '';
  if (url) {
    const u = document.createElement('div');
    u.className = 'menu-url';
    u.textContent = url;
    menu.appendChild(u);
  }
  for (const [label, fn, danger] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    if (danger) b.className = 'danger';
    b.addEventListener('pointerdown', ev => ev.preventDefault()); // keep the keyboard up
    b.addEventListener('click', () => { closePops(); fn(); });
    menu.appendChild(b);
  }
  menu.hidden = false;

  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.left + scrollX + r.width / 2 - mw / 2;
  left = Math.max(scrollX + 10, Math.min(left, scrollX + innerWidth - mw - 10));
  let top = r.bottom + scrollY + 8;
  if (r.bottom + mh + 8 > innerHeight - 60 && r.top - mh - 8 > 0) top = r.top + scrollY - mh - 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function linkMenu(a) {
  showMenu(a, [
    ['Open', () => window.open(a.href, '_blank', 'noopener')],
    ['Copy link', () => copyText(a.href, 'Link copied')],
    ['Edit', () => editLink(a)],
    ['Remove link', () => { a.replaceWith(document.createTextNode(a.textContent)); store(true); }],
  ], a.href);
}

function editLink(a) {
  const url = prompt('Link address', a.getAttribute('href'));
  if (url === null) return;
  if (!url.trim()) a.replaceWith(document.createTextNode(a.textContent));
  else a.setAttribute('href', hrefFor(url.trim()));
  store(true);
}

// A name for a saved image: the stored one's own, or by type for one not uploaded yet.
function imageName(img) {
  const src = NoteSync.storedUrl(img.getAttribute('src') || '');
  if (src.startsWith('data:')) return 'image.' + ((src.match(/^data:image\/(\w+)/) || [])[1] || 'png').replace('jpeg', 'jpg');
  try { return decodeURIComponent(new URL(src).pathname.split('/').pop()) || 'image'; } catch { return 'image'; }
}

function imageMenu(img) {
  selectedImg?.classList.remove('selected');
  selectedImg = img;
  img.classList.add('selected');

  const resize = f => {
    const full = editor.clientWidth;
    const w = Math.round(Math.min(full, Math.max(40, img.getBoundingClientRect().width * f)));
    if (w >= full - 2) img.removeAttribute('width');
    else img.setAttribute('width', w);
    store(true);
  };

  showMenu(img, [
    ['Smaller', () => resize(0.75)],
    ['Larger', () => resize(1.33)],
    ['Full width', () => { img.removeAttribute('width'); store(true); }],
    ['Open', () => NoteSync.open(img.src)],
    ['Download', () => downloadUrl(img.src, imageName(img))],
    ['Copy', () => copyImage(img)],
    ['Remove', () => { removeFromNote(img, editor); selectedImg = null; ensureTrailingLine(editor); store(true); }, true],
  ]);
}

function closePops() {
  menu.hidden = true;
  palette.hidden = true;
  selectedImg?.classList.remove('selected');
  selectedImg = null;
}

document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.pop, #color, #editor img, #editor a')) closePops();
});

addEventListener('keydown', e => { if (e.key === 'Escape') closePops(); });

/* ---------------- toolbar ---------------- */

// Tapping a toolbar button must not take the selection away from the text.
let savedRange = null;
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
    ensureTrailingLine(editor);
  }
  updateToolbar();
});

function restoreSelection() {
  if (document.activeElement !== editor) editor.focus({ preventScroll: true });
  const sel = getSelection();
  if (savedRange && editor.contains(savedRange.startContainer) &&
      !(sel.rangeCount && editor.contains(sel.anchorNode))) {
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
}

toolbar.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });
toolbar.addEventListener('mousedown', e => e.preventDefault());
toolbar.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) run(b.dataset.cmd);
});

function run(cmd) {
  if (!openId) return;
  closePops();

  if (cmd === 'done') { editor.blur(); return; }
  if (cmd === 'image') { restoreSelection(); fileInput.click(); return; }
  if (cmd === 'undo' || cmd === 'redo') {
    store(true);
    if (cmd === 'undo') undo.undo(); else undo.redo();
    return;
  }

  restoreSelection();

  if (cmd === 'link') {
    toggleLink();
  } else if (cmd === 'clear') {
    document.execCommand('removeFormat', false, null);
    document.execCommand('unlink', false, null);
  } else {
    document.execCommand(cmd, false, null);
  }
  store(true);
  updateToolbar();
}

function linkAtSelection() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const n = sel.anchorNode;
  const el = n && (n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement);
  return el ? el.closest('#editor a') : null;
}

function toggleLink() {
  const a = linkAtSelection();
  if (a) {
    a.replaceWith(document.createTextNode(a.textContent));
    return;
  }
  const sel = getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const picked = sel.toString().trim();
  const guess = isLink(picked) ? hrefFor(picked) : 'https://';
  const url = prompt('Link address', guess);
  if (!url || !url.trim() || url.trim() === 'https://') return;

  editor.focus({ preventScroll: true });
  if (range) { sel.removeAllRanges(); sel.addRange(range); }
  const href = hrefFor(url.trim());
  if (!range || range.collapsed) {
    insertHtml(`<a href="${escapeHtml(href)}">${escapeHtml(url.trim())}</a>`);
    leaveLink(editor);
  } else {
    document.execCommand('createLink', false, href);
  }
}

function updateToolbar() {
  const inside = document.activeElement === editor;
  for (const b of toolbar.querySelectorAll('button[data-cmd]')) {
    const c = b.dataset.cmd;
    let on = false;
    if (inside && (c === 'bold' || c === 'italic' || c === 'underline' || c === 'strikeThrough')) {
      try { on = document.queryCommandState(c); } catch { /* not supported */ }
    } else if (inside && c === 'link') {
      on = !!linkAtSelection();
    }
    b.classList.toggle('on', on);
  }
}

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (!files.length) return;
  await attachFiles(files);
});

// Phones: keep the toolbar on top of the keyboard. position: fixed alone leaves it behind
// the keyboard on iOS, so it follows the visual viewport instead.
function placeToolbar() {
  if (WIDE.matches) return;
  const vv = window.visualViewport;
  const h = vv ? vv.height : innerHeight;
  const top = vv ? vv.offsetTop : 0;
  const keyboard = innerHeight - h > 120;
  const root = document.documentElement.style;
  root.setProperty('--tool-pad', keyboard ? '0px' : 'env(safe-area-inset-bottom)');
  const th = toolbar.offsetHeight;
  root.setProperty('--tool-y', Math.round(top + h - th) + 'px');
}

if (window.visualViewport) {
  visualViewport.addEventListener('resize', placeToolbar);
  visualViewport.addEventListener('scroll', placeToolbar);
}
addEventListener('resize', placeToolbar);
WIDE.addEventListener('change', () => { placeToolbar(); renderList(); });

/* ---------------- history ---------------- */

// On a phone the history is a page of its own, so Back (and the swipe) leaves it. On a wide
// screen it sits in the list's column next to the open note.
function showHistory(on, how = 'push') {
  document.body.classList.toggle('history', on);
  if (on) {
    closePops();
    hist.refresh();
    if (how === 'push' && !WIDE.matches) history.pushState({ history: true }, '', '#history');
  } else if (how === 'replace' && location.hash === '#history') {
    history.replaceState(null, '', location.pathname);
  }
}

$('history-btn').addEventListener('click', () => showHistory(!document.body.classList.contains('history')));
$('history-back').addEventListener('click', () => {
  if (history.state && history.state.history) history.back();
  else showHistory(false, 'replace');
});
addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('history') && WIDE.matches) showHistory(false);
});

// Put a note back the way an entry has it: a deleted note returns where it was, a note that
// is still here gets its earlier text back (what it said until now goes to history).
function restoreEntry(e) {
  store(true);
  const snap = e.snap || {};
  let rec = records.get(e.note_id);
  if (!rec) {
    rec = {
      id: e.note_id, html: '', color: snap.color || COLORS[0],
      fx: Number.isFinite(snap.fx) ? snap.fx : 0.1, fy: Number.isFinite(snap.fy) ? snap.fy : 0.1,
      w: snap.w || 220, h: snap.h || 200, collapsed: !!snap.collapsed, title: snap.title || '', ord: snap.ord || 0,
      pinned: !!snap.pinned, u: 0,
    };
    records.set(rec.id, rec);
  }
  const wasGone = !!rec.deleted || !rec.html;
  if (rec.deleted) {
    delete rec.deleted;
    if (snap.color) rec.color = snap.color;
  }
  if (wasGone) rec.z = liveNotes().reduce((m, r) => Math.max(m, r.z || 1), 1) + 1;
  rec.html = e.html;
  if (createdHere === rec.id) createdHere = null;
  edit(rec);
  if (openId === rec.id) {
    editor.innerHTML = sanitize(rec.html);
    dressChips(editor);
    ensureTrailingLine(editor);
    paintEditor(rec);
  } else {
    openNote(rec.id);
  }
  toast(e.kind === 'deleted' || wasGone ? 'Note restored' : 'Earlier version restored');
}

const hist = NoteHistory.mount($('history-box'), {
  sync: () => sync,
  current: id => records.get(id) || null,
  restore: restoreEntry,
});

/* ---------------- note actions ---------------- */

$('new').addEventListener('click', newNote);

function newNote() {
  const n = liveNotes().length;
  const topZ = liveNotes().reduce((m, r) => Math.max(m, r.z || 1), 1);
  const rec = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    html: '',
    color: COLORS[n % 8],
    // Where the extension's own New note button puts one on a typical laptop screen.
    fx: (140 + (n % 6) * 26) / 1512,
    fy: (90 + (n % 6) * 26) / 860,
    w: 220,
    h: 200,
    z: topZ + 1,
    collapsed: false,
  };
  records.set(rec.id, rec);
  edit(rec);
  openNote(rec.id, { focus: true }); // leaves the previous note first, which resets createdHere
  createdHere = rec.id;
}

$('color').addEventListener('click', e => {
  e.stopPropagation();
  if (!palette.hidden) { palette.hidden = true; return; }
  const rec = records.get(openId);
  palette.textContent = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.style.background = c;
    b.title = c;
    if (rec && rec.color === c) b.className = 'on';
    b.addEventListener('pointerdown', ev => ev.preventDefault());
    b.addEventListener('click', () => {
      const r = records.get(openId);
      if (!r) return;
      r.color = c;
      paintEditor(r);
      edit(r);
      palette.hidden = true;
    });
    palette.appendChild(b);
  }
  palette.hidden = false;
  const r = $('color').getBoundingClientRect();
  const pw = palette.offsetWidth;
  palette.style.left = Math.max(10, Math.min(r.right - pw, innerWidth - pw - 10)) + 'px';
  palette.style.top = r.bottom + 6 + 'px';
});

$('delete').addEventListener('click', () => {
  const rec = records.get(openId);
  if (!rec) return;
  store(true);
  createdHere = null;
  rec.deleted = true;
  edit(rec);
  if (history.state && history.state.id && !WIDE.matches) history.back();
  else closeNote();
  toast('Note deleted', 'Undo', () => {
    delete rec.deleted;
    edit(rec);
    openNote(rec.id);
  });
});

$('copy-all').addEventListener('click', () => {
  store(true);
  const rec = records.get(openId);
  if (rec) copyNote(rec);
});

/* ---------------- clipboard ---------------- */

async function copyNote(rec) {
  const html = rec.html || '';
  const text = htmlToText(html);
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    toast(text.length > 2000 ? `Copied ${text.length.toLocaleString()} characters` : 'Copied');
  } catch {
    legacyCopy(text) ? toast('Copied') : toast('Copy failed');
  }
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg || 'Copied');
  } catch {
    legacyCopy(text) ? toast(msg || 'Copied') : toast('Copy failed');
  }
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copyImage(img) {
  try {
    // Safari wants the ClipboardItem built synchronously inside the tap, holding a promise.
    const blob = fetch(img.src, { mode: 'cors' })
      .then(r => r.blob())
      .then(b => (b.type === 'image/png' ? b : toPng(b)));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied');
  } catch {
    copyText(img.src, 'Image link copied');
  }
}

function toPng(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('png'))), 'image/png');
    };
    im.onerror = reject;
    im.src = url;
  });
}

/* ---------------- toast ---------------- */

let toastTimer = null;
function toast(text, actionLabel, action) {
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || '';
  btn.onclick = () => { $('toast').hidden = true; action && action(); };
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, actionLabel ? 6000 : 1800);
}

/* ---------------- start ---------------- */

addEventListener('pagehide', () => { store(true); saveCache(true); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { store(true); saveCache(true); }
});

document.execCommand('styleWithCSS', false, false);
document.execCommand('defaultParagraphSeparator', false, 'div');

loadCache();
renderList();

const startId = decodeURIComponent(location.hash.slice(1));
if (startId === 'history') showHistory(true, 'none');
else if (startId && records.has(startId)) openNote(startId, { history: 'replace' });
else if (startId) history.replaceState(null, '', location.pathname);

sync = new NoteSync({
  url: NOTES_CONFIG.url,
  key: NOTES_CONFIG.key,
  email: NOTES_CONFIG.email,
  password: NOTES_CONFIG.password,
  table: NOTES_CONFIG.table,
  local: () => [...records.values()],
  onRemote: recs => {
    applyRemote(recs);
    // A link to a note this device had not seen yet can open once it arrives.
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && !openId && records.has(id) && !records.get(id).deleted) openNote(id, { history: 'replace' });
  },
  onRewrite,
  onStatus: setStatus,
  onHistory: list => hist.render(list),
});
sync.start();
placeToolbar();
