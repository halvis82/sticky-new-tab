// Folding cards in the phone list (per device, remembered), and the board staying below Chrome's
// toolbar in full screen. Only touches notes_test, see serve.mjs.
import { chromium, webkit, devices } from 'playwright';
import { SITE, serve, TEST_CONFIG, SECRET } from './serve.mjs';
import os from 'node:os';
import fs from 'node:fs';
const stop = await serve();
const S = fs.mkdtempSync(os.tmpdir() + '/notes-fold-');
console.log('screenshots in', S);
const results = [];
const check = (name, ok, extra = '') => { results.push([ok ? 'PASS' : 'FAIL', name, extra]); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await wait(150); } return false; }

const cfg = await (await fetch(SITE + 'config.js')).text();
const SURL = cfg.match(/url: '([^']+)'/)[1];
const H = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: H });
const then = Date.now() - 3 * 3600e3;
const lines = Array.from({ length: 8 }, (_, i) => `<div>line ${i + 1}</div>`).join('');
const row = (id, ord, html, title, fy) => ({ id, html, title, ord, u: then, edited: then, color: '#fff5a5', fx: 0.3, fy, w: 220, h: 200, z: 1 });
await fetch(`${SURL}/rest/v1/notes_test`, { method: 'POST', headers: H, body: JSON.stringify([
  row('t-f1', 3000, 'TEST-f1 first' + lines, '', 0), row('t-f2', 2000, 'body' + lines, 'Titled', 0.5),
]) });

const cb = await chromium.launch();
const wb = await webkit.launch();
const route = c => c.route('**/config.js', async r => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace('};', TEST_CONFIG) }); });
const ctxW = await wb.newContext({ ...devices['iPhone 13'] });
await route(ctxW);
const W = await ctxW.newPage();
W.on('pageerror', e => console.log('[W pageerror]', e.message));
await W.goto(SITE);
check('W cards', await until(() => W.locator('.card').count().then(n => n === 2)));

const h = id => W.evaluate(i => document.querySelector(`.card[data-id="${i}"]`).offsetHeight, id);
const f1 = await h('t-f1'), f2 = await h('t-f2');
await W.tap('.card[data-id="t-f1"] .card-fold');
await W.tap('.card[data-id="t-f2"] .card-fold');
await wait(300);
check('W tap on fold does not open', await W.evaluate(() => !document.body.classList.contains('editing')));
const g1 = await h('t-f1'), g2 = await h('t-f2');
check('W untitled card folds to one line', g1 < f1 - 60, `${f1} -> ${g1}`);
check('W titled card folds to its title', g2 < f2 - 60, `${f2} -> ${g2}`);
check('W titled fold hides the body', await W.evaluate(() => getComputedStyle(document.querySelector('[data-id="t-f2"] .card-text')).display === 'none'));
check('W untitled fold keeps first line', await W.locator('[data-id="t-f1"] .card-text').isVisible());
await W.screenshot({ path: `${S}/w-folded.png` });
await W.reload();
await until(() => W.locator('.card').count().then(n => n === 2));
check('W fold remembered after reload', await W.evaluate(() => ['t-f1', 't-f2'].every(i => document.querySelector(`[data-id="${i}"]`).classList.contains('folded'))));
await W.tap('.card[data-id="t-f1"] .card-fold');
check('W unfold', await until(async () => (await h('t-f1')) === f1), String(await h('t-f1')));
await W.reload();
await until(() => W.locator('.card').count().then(n => n === 2));
check('W unfold remembered', await W.evaluate(() => !document.querySelector('[data-id="t-f1"]').classList.contains('folded') && document.querySelector('[data-id="t-f2"]').classList.contains('folded')));

// Board in Chrome full screen with the toolbar hidden: the window is the whole screen.
async function board(full, bar) {
  const ctx = await cb.newContext({ viewport: { width: 1400, height: 900 } });
  await route(ctx);
  await ctx.addInitScript(([full, bar]) => {
    if (bar) localStorage.setItem('toolbarHeight', String(bar));
    Object.defineProperty(window, 'outerHeight', { get: () => innerHeight + (full ? 0 : 87) });
    Object.defineProperty(screen, 'height', { get: () => 900 + (full ? 0 : 60) });
  }, [full, bar]);
  const D = await ctx.newPage();
  D.on('pageerror', e => console.log('[D pageerror]', e.message));
  await D.goto(SITE + 'desktop.html');
  await until(() => D.locator('.note[data-id="t-f1"]').count());
  await wait(300);
  const r = await D.evaluate(() => ({
    top: document.querySelector('.note[data-id="t-f1"]').getBoundingClientRect().top,
    mid: document.querySelector('.note[data-id="t-f2"]').getBoundingClientRect().top,
    stored: localStorage.getItem('toolbarHeight'),
  }));
  await D.screenshot({ path: `${S}/board-${full ? 'full' : 'window'}.png` });
  await ctx.close();
  return r;
}
const win = await board(false, 0);
check('window: note at the top stays at 0', win.top === 0, JSON.stringify(win));
check('window: toolbar height remembered', win.stored === '87', win.stored);
const full = await board(true, 100);
check('full screen: top note below the toolbar', full.top === 106, JSON.stringify(full));
check('full screen: middle note scaled into the rest', Math.abs(full.mid - (106 + 0.5 * (900 - 106))) < 1, String(full.mid));

await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: H });
await cb.close(); await wb.close(); stop();
const bad = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
