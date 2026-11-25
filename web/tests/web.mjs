// End to end, against the real Supabase project but only its notes_test table.
// Serves the site locally itself while it runs, see serve.mjs.
import { chromium, webkit, devices } from 'playwright';
import { SITE, serve, TEST_CONFIG, SECRET } from './serve.mjs';
const stop = await serve();
import os from 'node:os';
import fsx from 'node:fs';
const S = fsx.mkdtempSync(os.tmpdir() + '/notes-e2e-');
fsx.mkdirSync(S + '/shots');
console.log('screenshots in', S + '/shots');
const results = [];
const check = (name, ok, extra = '') => { results.push([ok ? 'PASS' : 'FAIL', name, extra]); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await wait(150); } return false; }

const cb = await chromium.launch();
const wb = await webkit.launch();
const ctxA = await cb.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const ctxB = await wb.newContext({ ...devices['iPhone 13'] });
for (const c of [ctxA, ctxB]) await c.route('**/config.js', async r => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace('};', TEST_CONFIG) }); });
const A = await ctxA.newPage();
const B = await ctxB.newPage();
for (const [n, p] of [['A', A], ['B', B]]) {
  p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${n} ${m.type()}]`, m.text()); });
  p.on('pageerror', e => console.log(`[${n} pageerror]`, e.message));
}
// wipe leftovers from earlier runs
const cfg = await (await fetch(SITE + 'config.js')).text();
const SURL = cfg.match(/url: '([^']+)'/)[1], SKEY = SECRET;
await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: { apikey: SKEY } });
await A.goto(SITE + '?classic'); await B.goto(SITE);
check('A live', await until(() => A.evaluate(() => document.body.dataset.sync === 'live')));
check('B live', await until(() => B.evaluate(() => document.body.dataset.sync === 'live')));
await B.screenshot({ path: `${S}/shots/b-list-empty.png` });

// A creates and formats
await A.click('#new');
await A.keyboard.type('TEST-hello world');
await A.evaluate(() => { const t = document.querySelector('#editor').firstChild; const r = document.createRange(); r.setStart(t, 5); r.setEnd(t, 10); getSelection().removeAllRanges(); getSelection().addRange(r); });
await A.click('[data-cmd=bold]');
check('A bold applied', (await A.innerHTML('#editor')).includes('<b>hello</b>'), await A.innerHTML('#editor'));
check('A bold button on', await A.evaluate(() => document.querySelector('[data-cmd=bold]').classList.contains('on')));
await A.keyboard.press('End');
await A.keyboard.type(' and google.com ');
check('A autolink', (await A.innerHTML('#editor')).includes('<a href="https://google.com">google.com</a>'), await A.innerHTML('#editor'));

// the desktop board (the extension's own page, served here) shows the same note
const D = await ctxA.newPage();
D.on('pageerror', e => console.log('[D pageerror]', e.message));
await D.goto(SITE + 'desktop.html');
check('D board shows note', await until(() => D.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('TEST-hello')))));
check('D note keeps bold', await until(() => D.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.innerHTML.includes('<b>hello</b>')))));
// expanding a collapsed note brings it over whatever was raised meanwhile
const dNote = D.locator('.note', { hasText: 'TEST-hello' });
await dNote.locator('.note-bar button').first().click();
await D.evaluate(() => { topZ += 5; });
await dNote.locator('.note-bar button').first().click();
const dz = await D.evaluate(() => [Number(document.querySelector('.note:not(.collapsed) .note-body b')?.closest('.note').style.zIndex), topZ]);
check('D expand brings to front', dz[0] === dz[1], `${dz}`);
await D.click('#drawer-btn');
check('D drawer lists it', await until(() => D.evaluate(() => [...document.querySelectorAll('.drawer-text')].some(e => e.textContent.includes('TEST-hello')))));
await D.screenshot({ path: `${S}/shots/d-board.png` });
await D.close();

// B sees it in list
check('B list shows note', await until(() => B.evaluate(() => [...document.querySelectorAll('.card-text')].some(e => e.textContent.includes('TEST-hello')))));
await B.screenshot({ path: `${S}/shots/b-list.png` });
await B.tap('.card:has-text("TEST-hello")');
check('B editor has bold', await until(async () => (await B.innerHTML('#editor')).includes('<b>hello</b>')));
await B.screenshot({ path: `${S}/shots/b-editor.png` });

// B types at end, A sees live while focused
await B.tap('#editor');
await B.evaluate(() => { const e = document.querySelector('#editor'); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
await B.keyboard.type(' from phone');
await A.evaluate(() => { const e = document.querySelector('#editor'); e.focus(); const t = e.querySelector('b').firstChild; const r = document.createRange(); r.setStart(t, 2); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
const t0 = Date.now();
const got = await until(async () => (await A.innerHTML('#editor')).includes('from phone'));
check('A receives phone edit', got, `${Date.now() - t0}ms`);
const caret = await A.evaluate(() => { const s = getSelection(); return s.anchorNode && s.anchorNode.textContent + '@' + s.anchorOffset; });
check('A caret preserved', caret === 'hello@2', caret);

// A types in the middle while focused, B sees
await A.keyboard.type('XX');
check('B receives A edit', await until(async () => (await B.innerHTML('#editor')).includes('heXXllo')));

// italic + underline via shortcuts on A
await A.keyboard.press('End');
await A.keyboard.press('Enter');
await A.keyboard.press('Meta+i'); await A.keyboard.type('ital'); await A.keyboard.press('Meta+i');
await A.keyboard.press('Meta+u'); await A.keyboard.type('under'); await A.keyboard.press('Meta+u');
const ah = await A.innerHTML('#editor');
check('A italic+underline', ah.includes('<i>ital</i>') && ah.includes('<u>under</u>'), ah);
check('B sees italic', await until(async () => (await B.innerHTML('#editor')).includes('<i>ital</i>')));

// image from phone via file input
await B.evaluate(() => { const e = document.querySelector('#editor'); e.focus(); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
await B.setInputFiles('#file', new URL('../icon-512.png', import.meta.url).pathname);
check('B image inserted', await until(() => B.evaluate(() => !!document.querySelector('#editor img'))));
check('B image uploaded (https src)', await until(() => B.evaluate(() => [...document.querySelectorAll('#editor img')].some(i => NoteSync.storedUrl(i.src).includes('supabase.co') && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)), 10000), await B.evaluate(() => document.querySelector('#editor img')?.src.slice(0, 80)));
check('A gets image', await until(() => A.evaluate(() => [...document.querySelectorAll('#editor img')].some(i => NoteSync.storedUrl(i.src).includes('supabase.co') && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0)), 8000));
await wait(800);
await B.screenshot({ path: `${S}/shots/b-editor-image.png` });
await A.screenshot({ path: `${S}/shots/a-desktop.png` });

// image menu on phone
await B.tap('#editor img');
check('B image menu', await B.isVisible('#menu'));
await B.screenshot({ path: `${S}/shots/b-image-menu.png` });
await B.click('#menu button:text("Smaller")');
check('B image resized', await B.evaluate(() => !!document.querySelector('#editor img[width]')));
check('A gets width', await until(() => A.evaluate(() => !!document.querySelector('#editor img[width]'))));
// What is stored is the storage address, never the private copy a page shows.
const storedHtml = async () => (await (await fetch(`${SURL}/rest/v1/notes_test?select=html`, { headers: { apikey: SKEY } })).json()).map(r => r.html).join('');
check('server keeps image address', await until(async () => { const h = await storedHtml(); return h.includes('object/public/images/') && h.includes('width='); }));
check('server has no blob: URL', !(await storedHtml()).includes('blob:'));
const imgUrl = (await storedHtml()).match(/src="(https:[^"]+)"/)[1];
check('image link alone is refused', (await fetch(imgUrl)).status >= 400);

// link menu
await B.tap('#editor a');
check('B link menu', await B.isVisible('#menu') && (await B.textContent('#menu')).includes('Open'));
await B.screenshot({ path: `${S}/shots/b-link-menu.png` });
await B.evaluate(() => document.querySelector('#menu').hidden = true);

// color from phone
await B.tap('#color');
await B.screenshot({ path: `${S}/shots/b-palette.png` });
await B.tap('#palette button:nth-child(6)');
check('A color changed', await until(() => A.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--note').trim() === '#a8d8ff')));

// copy button (A, chromium clipboard)
await A.click('#copy-all');
await until(() => A.evaluate(() => !document.querySelector('#toast').hidden)); // the write is async
const clip = await A.evaluate(() => navigator.clipboard.readText());
check('copy all text', clip.includes('TEST-heXXllo world') && clip.includes('\nital'), JSON.stringify(clip));

// large text
const big = 'TEST-big ' + 'lorem ipsum dolor sit amet '.repeat(8000);
await A.evaluate(t => { const e = document.querySelector('#editor'); e.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, t); }, big);
check('B gets 200KB note', await until(async () => (await B.evaluate(() => document.querySelector('#editor').textContent.length)) > 200000, 10000));

// new note on phone, delete from desktop
await B.tap('#back');
await B.tap('#new');
await B.keyboard.type('TEST-second note');
await B.screenshot({ path: `${S}/shots/b-new-typing.png` });
check('A list gets second', await until(() => A.evaluate(() => [...document.querySelectorAll('.card-text')].some(e => e.textContent.includes('TEST-second')))));
await A.click('.card:has-text("TEST-second")');
await A.click('#delete');
check('B told note deleted', await until(() => B.evaluate(() => !document.body.classList.contains('editing') && document.querySelector('#toast-text').textContent.includes('deleted'))));
await B.screenshot({ path: `${S}/shots/b-after-delete.png` });
await A.click('#toast-action');
check('undo restores on B', await until(() => B.evaluate(() => [...document.querySelectorAll('.card-text')].some(e => e.textContent.includes('TEST-second')))));

// empty new note is dropped
const before = await A.evaluate(() => document.querySelectorAll('.card').length);
await A.click('#new'); await A.click('.card:has-text("TEST-second")');

check('empty note dropped', await until(async () => (await A.evaluate(() => document.querySelectorAll('.card').length)) === before), `${before}`);

// reload B keeps state and reconnects
await B.reload();
check('B reload live', await until(() => B.evaluate(() => document.body.dataset.sync === 'live')));
check('B reload list', await B.evaluate(() => document.querySelectorAll('.card').length) >= 2);
await B.setViewportSize({ width: 390, height: 844 });
await B.screenshot({ path: `${S}/shots/b-list-final.png` });

await cb.close(); await wb.close();
// clean up once no page is left to send its copies back
await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: { apikey: SKEY } });
console.log('\n' + results.filter(r => r[0] === 'FAIL').length + ' failures of ' + results.length);
await stop();
process.exit(results.filter(x => (Array.isArray(x) ? x[0] === 'FAIL' : !x)).length ? 1 : 0);
