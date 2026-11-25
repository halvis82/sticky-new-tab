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

// The board in a normal window and in Chrome full screen. The page is 900 tall in every case.
// frame: outer minus inner height. screen: screen height. store: localStorage to start with.
async function board({ frame, screen: sh, store = {} }) {
  const ctx = await cb.newContext({ viewport: { width: 1400, height: 900 } });
  await route(ctx);
  await ctx.addInitScript(([frame, sh, store]) => {
    for (const [k, v] of Object.entries(store)) localStorage.setItem(k, String(v));
    Object.defineProperty(window, 'outerHeight', { get: () => innerHeight + frame });
    Object.defineProperty(screen, 'height', { get: () => sh });
  }, [frame, sh, store]);
  const D = await ctx.newPage();
  D.on('pageerror', e => console.log('[D pageerror]', e.message));
  await D.goto(SITE + 'desktop.html');
  await until(() => D.locator('.note[data-id="t-f1"]').count());
  await wait(300);
  const r = await D.evaluate(() => ({
    top: document.querySelector('.note[data-id="t-f1"]').getBoundingClientRect().top,
    mid: document.querySelector('.note[data-id="t-f2"]').getBoundingClientRect().top,
    ls: { ...localStorage },
  }));
  await ctx.close();
  return r;
}
const show = r => JSON.stringify({ top: r.top, mid: r.mid, bar: r.ls.toolbarHeight, full: r.ls.toolbarFull, page: r.ls.fullPageHeight });

const win = await board({ frame: 87, screen: 1050 });
check('window: no inset', win.top === 0 && win.mid === 450, show(win));
check('window: frame remembered', win.ls.toolbarHeight === '87', show(win));

const hid = await board({ frame: 0, screen: 900, store: { toolbarHeight: 100 } });
check('full screen, toolbar hidden: top note below the toolbar', hid.top === 100, show(hid));
check('full screen, toolbar hidden: page height remembered', hid.ls.fullPageHeight === '900', show(hid));

const notch = await board({ frame: 0, screen: 938, store: { toolbarHeight: 100 } });
check('notch, toolbar hidden: top note below the toolbar', notch.top === 100, show(notch));

// Toolbar always shown: in macOS full screen it is an overlay, so the frame still reads 0, but
// the page is shorter than the screen by the toolbar (93) plus the notch (38).
const shown = await board({ frame: 0, screen: 900 + 93 + 38, store: { toolbarHeight: 100, fullPageHeight: 993 } });
check('notch, toolbar shown: no inset', shown.top === 0 && shown.mid === 450, show(shown));
check('notch, toolbar shown: real toolbar height learned', shown.ls.toolbarFull === '93', show(shown));

// Hidden again with the learned height: a note sits at the same spot on screen as when shown.
const hidden993 = await (async () => {
  const ctx = await cb.newContext({ viewport: { width: 1400, height: 993 } });
  await route(ctx);
  await ctx.addInitScript(() => {
    localStorage.setItem('toolbarFull', '93');
    Object.defineProperty(window, 'outerHeight', { get: () => innerHeight });
    Object.defineProperty(screen, 'height', { get: () => 1031 });
  });
  const D = await ctx.newPage();
  await D.goto(SITE + 'desktop.html');
  await until(() => D.locator('.note[data-id="t-f2"]').count());
  await wait(300);
  const r = await D.evaluate(() => ['t-f1', 't-f2'].map(i => document.querySelector(`.note[data-id="${i}"]`).getBoundingClientRect().top));
  await ctx.close();
  return r;
})();
// Shown: the page starts 93 below the hidden page's top, so add 93 to compare on screen.
check('hidden vs shown: top note at the same screen spot', hidden993[0] === shown.top + 93, `${hidden993[0]} vs ${shown.top + 93}`);
check('hidden vs shown: middle note at the same screen spot', Math.abs(hidden993[1] - (shown.mid + 93)) < 1, `${hidden993[1]} vs ${shown.mid + 93}`);

await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: H });
await cb.close(); await wb.close(); stop();
const bad = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
