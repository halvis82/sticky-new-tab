import path from 'node:path';
// End to end, against the real Supabase project but only its notes_test table.
// Serves the site locally itself while it runs, see serve.mjs.
import { chromium, webkit, devices } from 'playwright';
import { SITE, serve, TEST_CONFIG, SECRET, NORMAL_WINDOW } from './serve.mjs';
const stop = await serve();
import fs from 'node:fs';
import os from 'node:os';
import fsx from 'node:fs';
const S = fsx.mkdtempSync(os.tmpdir() + '/notes-e2e-');
fsx.mkdirSync(S + '/shots');
console.log('screenshots in', S + '/shots');
// A copy of the installed extension, pointed at notes_test, with no seed to import.
import { execSync } from 'node:child_process';
const EXT = `${S}/ext-copy`;
execSync(`rsync -a --exclude backups --exclude seed.json --exclude restore.json "${path.resolve(import.meta.dirname, '../../extension')}/" "${EXT}/"`);
fsx.writeFileSync(`${EXT}/config.js`, fsx.readFileSync(`${EXT}/config.js`, 'utf8').replace(/^};/m, TEST_CONFIG));
const ID = 'immpedeolbogdgdccglolkeikbocjnlo';
const NT = `chrome-extension://${ID}/newtab.html`;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 7000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await wait(150); } return false; }

const cfg = fs.readFileSync(`${EXT}/config.js`, 'utf8');
const SURL = cfg.match(/url: '([^']+)'/)[1], SKEY = SECRET;
await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: { apikey: SKEY } });

const prof = fs.mkdtempSync(`${S}/prof-`);
const ctx = await chromium.launchPersistentContext(prof, {
  channel: 'chromium', headless: true, viewport: { width: 1440, height: 860 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await ctx.addInitScript(NORMAL_WINDOW);
const wb = await webkit.launch();
const wctx = await wb.newContext({ ...devices['iPhone 13'] });
await wctx.route('**/config.js', async r => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace('};', TEST_CONFIG) }); });

const E1 = await ctx.newPage(); const E2 = await ctx.newPage(); const W = await wctx.newPage();
for (const [n, p] of [['E1', E1], ['E2', E2], ['W', W]]) {
  p.on('pageerror', e => console.log(`[${n} pageerror]`, e.message));
  p.on('console', m => { if (m.type() === 'error') console.log(`[${n} error]`, m.text()); });
}
await E1.goto(NT); await E2.goto(NT); await W.goto(SITE);
check('ext sync live', await until(() => E1.evaluate(() => sync && sync.status === 'live')));
check('web live', await until(() => W.evaluate(() => document.body.dataset.sync === 'live')));

// E1 makes a sticky note with New note
await E1.click('#new-note');
await E1.keyboard.type('TEST-ext note');
check('E2 gets it via storage', await until(() => E2.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('TEST-ext note')))));
check('W gets it via server', await until(() => W.evaluate(() => [...document.querySelectorAll('.card-text')].some(b => b.textContent.includes('TEST-ext note')))));

// W edits it, E1 is focused in it and keeps its caret
await E1.evaluate(() => { const b = [...document.querySelectorAll('.note-body')].find(b => b.textContent.includes('TEST-ext')); b.focus(); const t = b.firstChild; const r = document.createRange(); r.setStart(t, 4); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
await W.tap('.card:has-text("TEST-ext note")');
// At the end of the text itself: the end of the editor is the empty trailing line every note shows.
await W.evaluate(() => { const e = document.querySelector('#editor'); e.focus(); const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let t = null; while (w.nextNode()) if (w.currentNode.nodeValue.trim()) t = w.currentNode; const r = document.createRange(); if (t) r.setStart(t, t.length); else { r.selectNodeContents(e); r.collapse(false); } getSelection().removeAllRanges(); getSelection().addRange(r); });
await W.keyboard.type(' plus phone');
const t0 = Date.now();
check('E1 shows phone text', await until(() => E1.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('plus phone')))), `${Date.now() - t0}ms`);
check('E2 shows phone text', await until(() => E2.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('plus phone')))));
const caret = await E1.evaluate(() => { const s = getSelection(); return document.activeElement.className + '@' + s.anchorOffset; });
check('E1 caret kept', caret === 'note-body@4', caret);
check('E1 open bar blank', await E1.evaluate(() => [...document.querySelectorAll('.note:not(.collapsed) .note-preview')].every(p => !p.value && !p.placeholder)));
check('E1 preview updated', await E1.evaluate(() => notes.some(n => placeholder({ ...n, collapsed: true }).includes('TEST-ext note plus'))));

// E1 types in the middle while phone is open on it
await E1.keyboard.type('_E1_');
check('W sees E1 typing', await until(async () => (await W.textContent('#editor')).includes('TEST_E1_-ext')));

// bold in the extension, shows bold on phone
await E1.evaluate(() => { const b = document.activeElement; const t = b.firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 4); getSelection().removeAllRanges(); getSelection().addRange(r); });
await E1.keyboard.press('Meta+b');
check('W sees bold', await until(async () => (await W.innerHTML('#editor')).includes('<b>TEST</b>')), await W.innerHTML('#editor'));

// color change in extension
const noteEl = '.note:has(.note-body:text-matches("TEST_E1_"))';
await E1.click(`${noteEl} .note-bar button[title="Color"]`);
await E1.click(`${noteEl} .palette button:nth-child(7)`);
check('W sees color', await until(() => W.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--note').trim() === '#a8e6b8')));

// phone makes a new note with an image
await W.tap('#back');
await W.tap('#new');
await W.keyboard.type('TEST-from web');
await W.setInputFiles('#file', new URL('../icon-192.png', import.meta.url).pathname);
check('E1 new sticky from web', await until(() => E1.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('TEST-from web')))));
check('E1 image https', await until(() => E1.evaluate(() => [...document.querySelectorAll('.note-body img')].some(i => NoteSync.storedUrl(i.src).includes('supabase.co') && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)), 10000));
check('E2 image https', await until(() => E2.evaluate(() => [...document.querySelectorAll('.note-body img')].some(i => NoteSync.storedUrl(i.src).includes('supabase.co') && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)), 10000));

// extension pastes an image: data URI swapped for URL, phone gets it
await E1.bringToFront();
await E1.evaluate(async () => {
  const b = [...document.querySelectorAll('.note-body')].find(b => b.textContent.includes('TEST_E1_'));
  b.focus();
  const r = document.createRange(); r.selectNodeContents(b); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
  const c = document.createElement('canvas'); c.width = 40; c.height = 30; const g = c.getContext('2d'); g.fillStyle = '#c00'; g.fillRect(0, 0, 40, 30);
  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));
  b.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
check('E1 pasted image uploaded', await until(() => E1.evaluate(() => [...document.querySelectorAll('.note-body img')].filter(i => NoteSync.storedUrl(i.src).includes('supabase.co') && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0).length >= 2), 10000));
await W.tap('#back');
await W.tap('.card:has-text("TEST_E1_")');
check('W sees ext image', await until(() => W.evaluate(() => [...document.querySelectorAll('#editor img')].some(i => NoteSync.storedUrl(i.src).includes('supabase.co') && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)), 8000));
// Storage is written on a short debounce, so give it a moment rather than reading it once.
const storedNotes = () => E1.evaluate(async () => JSON.stringify((await chrome.storage.local.get('notes')).notes));
check('no data URI left in storage', await until(async () => !(await storedNotes()).includes('data:image')), (await storedNotes()).length + ' bytes');

// resize and move in the extension syncs geometry
const box = await E1.locator(noteEl).boundingBox();
await E1.mouse.move(box.x + 60, box.y + 10); await E1.mouse.down(); await E1.mouse.move(box.x + 260, box.y + 110, { steps: 5 }); await E1.mouse.up();
check('E2 sees move', await until(async () => { const b2 = await E2.locator(noteEl).boundingBox(); return b2 && Math.abs(b2.x - (box.x + 200)) < 3; }));

// the title in the bar: a click types in it, it syncs, and the bar still drags while typing
const title = E1.locator(noteEl).locator('.note-preview');
const tb = await title.boundingBox();
await E1.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
check('E1 title focused by click', await title.evaluate(t => document.activeElement === t));
await E1.keyboard.type('TEST title');
check('E2 sees title', await until(() => E2.locator(noteEl).locator('.note-preview').evaluate(t => t.value === 'TEST title')));
const b3 = await E1.locator(noteEl).boundingBox();
await E1.mouse.move(tb.x + 20, tb.y + 5); await E1.mouse.down(); await E1.mouse.move(tb.x + 70, tb.y + 45, { steps: 5 }); await E1.mouse.up();
check('drag works while typing title', await until(async () => { const b = await E1.locator(noteEl).boundingBox(); return Math.abs(b.x - (b3.x + 50)) < 3; }));
check('title kept its text', await title.evaluate(t => t.value === 'TEST title' && !t.placeholder));
const tb2 = await title.boundingBox();
await E1.mouse.click(tb2.x + 6, tb2.y + tb2.height / 2);
check('click puts caret at the start', await title.evaluate(t => t.selectionStart === 0 && t.selectionEnd === 0));
await E1.mouse.dblclick(tb2.x + 8, tb2.y + tb2.height / 2);
check('double click selects word', await title.evaluate(t => t.value.slice(t.selectionStart, t.selectionEnd) === 'TEST'));

// delete on phone, gone in both tabs; undo on phone restores
await W.tap('#delete');
check('E1 note removed', await until(() => E1.evaluate(() => ![...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('TEST_E1_')))));
check('E2 note removed', await until(() => E2.evaluate(() => ![...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('TEST_E1_')))));
await W.tap('#toast-action');
check('E1 undo restores', await until(() => E1.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('TEST_E1_')))));

// delete in extension (with its own undo), phone list updates
await E1.click('.note:has-text("TEST-from web") .note-bar button[title="Delete"]');
check('W list drops ext-deleted', await until(() => W.evaluate(() => ![...document.querySelectorAll('.card-text')].some(b => b.textContent.includes('TEST-from web')))));
await E1.click('#undo');
check('W list gets undo', await until(() => W.evaluate(() => [...document.querySelectorAll('.card-text')].some(b => b.textContent.includes('TEST-from web')))));

// a third, fresh new tab loads everything
const E3 = await ctx.newPage(); await E3.goto(NT);
check('E3 has both notes', await until(() => E3.evaluate(() => document.querySelectorAll('.note').length === 2)));
await wait(1200);
await E3.screenshot({ path: `${S}/shots/ext-newtab.png` });

// offline edit in extension, then reconnect
await ctx.setOffline(true);
await E3.evaluate(() => { const b = [...document.querySelectorAll('.note-body')].find(b => b.textContent.includes('TEST-from web')); b.focus(); const r = document.createRange(); r.selectNodeContents(b); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
await E3.keyboard.type(' offline-edit');
await wait(2500);
await ctx.setOffline(false);
await E3.evaluate(() => dispatchEvent(new Event('online')));
check('offline edit reaches phone', await until(() => W.evaluate(() => [...document.querySelectorAll('.card-text')].some(b => b.textContent.includes('offline-edit'))), 40000));

await ctx.close(); await wb.close();
await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: { apikey: SKEY } });
console.log(`\n${results.filter(x => !x).length} failures of ${results.length}`);
await stop();
process.exit(results.filter(x => (Array.isArray(x) ? x[0] === 'FAIL' : !x)).length ? 1 : 0);
