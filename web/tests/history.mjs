import path from 'node:path';
// History end to end: the new tab (extension), the desktop site and the phone site, against
// notes_test and notes_test_history only. Serves the site locally itself while it runs, see serve.mjs.
import { chromium, webkit, devices } from 'playwright';
import { SITE, serve, TEST_CONFIG, SECRET } from './serve.mjs';
const stop = await serve();
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
const S = fs.mkdtempSync(os.tmpdir() + '/notes-hist-');
fs.mkdirSync(S + '/shots');
console.log('screenshots in', S + '/shots');
const EXT = `${S}/ext-copy`;
execSync(`rsync -a --exclude backups --exclude seed.json --exclude restore.json "${path.resolve(import.meta.dirname, '../../extension')}/" "${EXT}/"`);
fs.writeFileSync(`${EXT}/config.js`, fs.readFileSync(`${EXT}/config.js`, 'utf8').replace(/^};/m, TEST_CONFIG));
const NT = 'chrome-extension://immpedeolbogdgdccglolkeikbocjnlo/newtab.html';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 9000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await wait(150); } return false; }

const cfg = fs.readFileSync(`${EXT}/config.js`, 'utf8');
const SURL = cfg.match(/url: '([^']+)'/)[1], SKEY = SECRET;
for (const t of ['notes_test', 'notes_test_history']) {
  await fetch(`${SURL}/rest/v1/${t}?id=neq.x`, { method: 'DELETE', headers: { apikey: SKEY } });
}

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(`${S}/prof-`), {
  channel: 'chromium', headless: true, viewport: { width: 1440, height: 860 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const cb = await chromium.launch();
const dctx = await cb.newContext({ viewport: { width: 1280, height: 800 } });
const wb = await webkit.launch();
const wctx = await wb.newContext({ ...devices['iPhone 13'] });
for (const c of [dctx, wctx]) {
  await c.route('**/config.js', async r => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace('};', TEST_CONFIG) }); });
}
const E = await ctx.newPage(); const D = await dctx.newPage(); const W = await wctx.newPage();
for (const [n, p] of [['E', E], ['D', D], ['W', W]]) {
  p.on('pageerror', e => console.log(`[${n} pageerror]`, e.message));
  p.on('console', m => { if (m.type() === 'error') console.log(`[${n} error]`, m.text()); });
}
await E.goto(NT); await D.goto(SITE + 'desktop.html'); await W.goto(SITE);
check('E live', await until(() => E.evaluate(() => sync && sync.status === 'live')));
check('D live', await until(() => D.evaluate(() => sync && sync.status === 'live')));
check('W live', await until(() => W.evaluate(() => document.body.dataset.sync === 'live')));

const histTexts = p => p.evaluate(sel => [...document.querySelectorAll(sel + ' .nh-item:not(.nh-leaving)')].map(li => li.textContent), p === W ? '#history-pane' : '#history-panel');
const hasEntry = (p, needle) => histTexts(p).then(t => t.some(x => x.includes(needle)));

// Empty state on every surface
await E.click('#history-btn');
check('E panel opens', await until(() => E.evaluate(() => document.getElementById('history-panel').classList.contains('open'))));
check('E empty state', await E.isVisible('#history-panel .nh-empty'));
await W.tap('#history-btn');
check('W history page opens', await until(() => W.evaluate(() => document.body.classList.contains('history') && location.hash === '#history')));
await wait(350);
await W.screenshot({ path: `${S}/shots/w-empty.png` });
await W.goBack();
check('W back closes history', await until(() => W.evaluate(() => !document.body.classList.contains('history'))));
await E.click('.hp-close');

// E writes a note with three lines and takes the middle one out
await E.click('#new-note');
await E.keyboard.type('TEST-hist groceries');
await E.keyboard.press('Enter');
await E.keyboard.type('remove this whole line please');
await E.keyboard.press('Enter');
await E.keyboard.type('keep this line');
check('W has the note', await until(() => W.evaluate(() => [...document.querySelectorAll('.card-text')].some(e => e.textContent.includes('remove this whole line')))));
await wait(4500); // the typing run ends, nothing removed: no history
check('typing alone makes no history', !(await hasEntry(E, 'remove this')));
await E.evaluate(() => {
  const b = [...document.querySelectorAll('.note-body')].find(b => b.textContent.includes('TEST-hist'));
  b.focus();
  const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
  let t; while (w.nextNode()) if (w.currentNode.nodeValue.includes('remove this')) t = w.currentNode;
  const r = document.createRange(); r.selectNodeContents(t); getSelection().removeAllRanges(); getSelection().addRange(r);
});
await E.keyboard.press('Backspace');
check('line gone on W', await until(() => W.evaluate(() => [...document.querySelectorAll('.card-text')].some(e => e.textContent.includes('TEST-hist') && !e.textContent.includes('remove this')))));
await E.click('#history-btn');
check('E history shows removed line', await until(() => hasEntry(E, 'remove this whole line please'), 9000));
const label = await E.evaluate(() => document.querySelector('#history-panel .nh-kind')?.textContent);
check('E entry labelled', label === 'Removed text', label);
check('D gets it live', await until(() => D.evaluate(() => [...document.querySelectorAll('#history-panel .nh-item')].some(li => li.textContent.includes('remove this whole line')))));
await W.tap('#history-btn');
check('W gets it live', await until(() => hasEntry(W, 'remove this whole line please')));
await wait(350);
await W.screenshot({ path: `${S}/shots/w-removed.png` });
await E.screenshot({ path: `${S}/shots/e-removed.png` });

// Show note: the earlier version with the removed line marked
await E.click('#history-panel .nh-more');
const marked = await E.evaluate(() => document.querySelector('#history-panel .nh-text mark')?.textContent);
check('E show note marks it', marked === 'remove this whole line please', marked);

// W restores that version; E's note gets the line back, and what it said goes to history
await W.tap('#history-pane .nh-item:has-text("remove this whole line") .nh-restore');
check('W opens the restored note', await until(() => W.evaluate(() => document.body.classList.contains('editing') && document.querySelector('#editor').textContent.includes('remove this whole line'))));
check('E note has the line back', await until(() => E.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('remove this whole line')))));
await W.goBack();
check('W back returns to history', await until(() => W.evaluate(() => document.body.classList.contains('history'))));
const restoredBtn = await W.evaluate(() => [...document.querySelectorAll('#history-pane .nh-item')].find(li => li.textContent.includes('remove this whole line'))?.querySelector('.nh-restore').disabled);
check('W restore button says done', restoredBtn === true);

// W deletes the note from its editor; every surface lists a deleted note
await W.goBack();
await W.tap('.card:has-text("TEST-hist")');
await W.tap('#delete');
check('E note gone', await until(() => E.evaluate(() => ![...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('TEST-hist')))));
check('E lists deleted note', await until(() => E.evaluate(() => [...document.querySelectorAll('#history-panel .nh-item')].some(li => li.querySelector('.nh-kind').textContent === 'Deleted note' && li.textContent.includes('TEST-hist')))));
check('D lists deleted note', await until(() => D.evaluate(() => [...document.querySelectorAll('#history-panel .nh-item')].some(li => li.querySelector('.nh-kind').textContent === 'Deleted note'))));
await D.click('#history-btn');
await wait(300);
await D.screenshot({ path: `${S}/shots/d-panel.png` });

// D restores it; it comes back on E and W, and the deleted entry goes everywhere
await D.click('#history-panel .nh-item:has(.nh-kind:text-is("Deleted note")) .nh-restore');
check('D board has it back', await until(() => D.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('TEST-hist')))));
check('E has it back', await until(() => E.evaluate(() => [...document.querySelectorAll('.note-body')].some(b => b.textContent.includes('TEST-hist')))));
check('W list has it back', await until(() => W.evaluate(() => [...document.querySelectorAll('.card-text')].some(e => e.textContent.includes('TEST-hist')))));
check('deleted entry gone on E', await until(() => E.evaluate(() => ![...document.querySelectorAll('#history-panel .nh-kind')].some(k => k.textContent === 'Deleted note'))));
check('deleted entry gone on W', await until(() => W.evaluate(() => ![...document.querySelectorAll('#history-pane .nh-kind')].some(k => k.textContent === 'Deleted note'))));

// A second removal, on the phone this time, so there are two entries
await W.evaluate(() => { if (document.body.classList.contains('history')) document.getElementById('history-back').click(); });
await until(() => W.evaluate(() => !document.body.classList.contains('history')));
await wait(400);
await W.tap('.card:has-text("TEST-hist")');
await W.evaluate(() => {
  const e = document.querySelector('#editor'); e.focus();
  const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
  let t; while (w.nextNode()) if (w.currentNode.nodeValue.includes('keep this')) t = w.currentNode;
  const r = document.createRange(); r.selectNodeContents(t); getSelection().removeAllRanges(); getSelection().addRange(r);
});
await W.keyboard.press('Backspace');
await W.evaluate(() => document.querySelector('#editor').blur());
check('E gets the phone removal', await until(() => E.evaluate(() => sync.entries().some(e => e.kind === 'removed' && e.removed.includes('keep this line'))), 12000));
check('E label follows the note', await E.evaluate(() => [...document.querySelectorAll('#history-panel .nh-restore')].every(b => b.textContent !== 'Restore note')));
await W.tap('#back');
await W.tap('#history-btn');

// E removes one entry with its x; it leaves W too
check('W shows both', await until(async () => (await histTexts(W)).length === 2));
const before = (await histTexts(W)).length;
await E.click('#history-panel .nh-item .nh-x');
check('W loses that entry', await until(async () => (await histTexts(W)).length === before - 1), `${before} before`);

// Server matches the lists
const rows = await (await fetch(`${SURL}/rest/v1/notes_test_history?select=id`, { headers: { apikey: SKEY } })).json();
check('server rows match', rows.length === before - 1, `${rows.length} rows`);

// Clear all from W
W.on('dialog', d => d.accept());
await W.tap('#history-btn').catch(() => {});
await W.evaluate(() => document.body.classList.contains('history') || document.getElementById('history-btn').click());
if ((await histTexts(W)).length) {
  await W.tap('#history-pane .nh-clear');
  check('E list empties', await until(async () => (await histTexts(E)).length === 0));
  const left = await (await fetch(`${SURL}/rest/v1/notes_test_history?select=id`, { headers: { apikey: SKEY } })).json();
  check('server empty', left.length === 0, `${left.length} rows`);
}

for (const t of ['notes_test', 'notes_test_history']) {
  await fetch(`${SURL}/rest/v1/${t}?id=neq.x`, { method: 'DELETE', headers: { apikey: SKEY } });
}
await ctx.close(); await cb.close(); await wb.close();
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await stop();
process.exit(failed ? 1 : 0);
