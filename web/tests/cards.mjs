// Note cards: titles and formatting in the phone list and the desktop drawer, and dragging
// cards to reorder, by touch on the phone and by mouse in the drawer, synced between them.
// Only touches notes_test, see serve.mjs.
import { chromium, webkit, devices } from 'playwright';
import { SITE, serve, TEST_CONFIG, SECRET } from './serve.mjs';
import os from 'node:os';
import fs from 'node:fs';
const stop = await serve();
const S = fs.mkdtempSync(os.tmpdir() + '/notes-cards-');
console.log('screenshots in', S);
const results = [];
const check = (name, ok, extra = '') => { results.push([ok ? 'PASS' : 'FAIL', name, extra]); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await wait(150); } return false; }

const cfg = await (await fetch(SITE + 'config.js')).text();
const SURL = cfg.match(/url: '([^']+)'/)[1];
const H = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: H });
const then = Date.now() - 3 * 3600e3; // seeded as written three hours ago
const row = (id, ord, html, title = '') => ({ id, html, title, ord, u: then, edited: then, color: '#fff5a5', fx: 0.1, fy: 0.1, w: 220, h: 200, z: 1 });
await fetch(`${SURL}/rest/v1/notes_test`, { method: 'POST', headers: H, body: JSON.stringify([
  row('t-c1', 3000, 'TEST-c1 plain'),
  row('t-c2', 2000, 'TEST-c2 first <b>bold</b><div><i>slanted</i> and <a href="https://example.com">a link</a></div>', 'My title'),
  row('t-c3', 1000, 'TEST-c3 <u>under</u>'),
]) });

const cb = await chromium.launch();
const wb = await webkit.launch();
const route = c => c.route('**/config.js', async r => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace('};', TEST_CONFIG) }); });
const ctxW = await wb.newContext({ ...devices['iPhone 13'] });
const ctxP = await cb.newContext({ ...devices['Pixel 7'] });
const ctxD = await cb.newContext({ viewport: { width: 1400, height: 900 } });
for (const c of [ctxW, ctxP, ctxD]) await route(c);
const W = await ctxW.newPage();
const P = await ctxP.newPage();
const D = await ctxD.newPage();
for (const [n, p] of [['W', W], ['P', P], ['D', D]]) p.on('pageerror', e => console.log(`[${n} pageerror]`, e.message));
await W.goto(SITE); await P.goto(SITE); await D.goto(SITE + 'desktop.html');

const order = (p, sel = '.card') => p.evaluate(s => [...document.querySelectorAll(s)].map(c => c.dataset.id).filter(id => id.startsWith('t-')).join(','), sel);
const is = (p, want, sel) => until(async () => (await order(p, sel)) === want);

check('W shows by ord', await is(W, 't-c1,t-c2,t-c3'), await order(W));
check('W card title', await W.evaluate(() => document.querySelector('.card[data-id="t-c2"] .card-title')?.textContent === 'My title'));
const c2 = await W.evaluate(() => document.querySelector('.card[data-id="t-c2"] .card-text').innerHTML);
check('W card keeps bold and italics', c2.includes('<b>bold</b>') && c2.includes('<i>slanted</i>'), c2);
check('W card link not clickable', !c2.includes('<a') && c2.includes('class="link"'), c2);
check('W card underline', (await W.evaluate(() => document.querySelector('.card[data-id="t-c3"] .card-text').innerHTML)).includes('<u>under</u>'));
const weight = await W.evaluate(() => getComputedStyle(document.querySelector('.card[data-id="t-c2"] .card-text b')).fontWeight);
check('W bold renders bold', Number(weight) >= 700, weight);
await W.screenshot({ path: `${S}/w-list.png` });

// the title in the editor, typed on the phone, reaches the desktop drawer
await W.tap('.card[data-id="t-c2"]');
check('W editor title', await until(async () => (await W.inputValue('#title')) === 'My title'));
await W.tap('#title');
await W.keyboard.press('End');
await W.keyboard.type(' two');
await D.click('#drawer-btn');
check('D drawer title synced', await until(() => D.evaluate(() => document.querySelector('.drawer-card[data-id="t-c2"] .drawer-title')?.textContent === 'My title two')));
check('D drawer formatting', (await D.evaluate(() => document.querySelector('.drawer-card[data-id="t-c2"] .drawer-text').innerHTML)).includes('<b>bold</b>'));
await W.screenshot({ path: `${S}/w-editor.png` });
await W.tap('#back');

// P: hold the last card and drag it to the top
const cdp = await ctxP.newCDPSession(P);
const box = async (p, id, sel = '.card') => p.locator(`${sel}[data-id="${id}"]`).boundingBox();
async function touchDrag(from, toY, hold = 450) {
  const x = from.x + from.width / 2, y = from.y + from.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await wait(hold);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (toY - y) * i / steps }] });
    await wait(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
check('P shows by ord', await is(P, 't-c1,t-c2,t-c3'), await order(P));
const top = await box(P, 't-c1');
await touchDrag(await box(P, 't-c3'), top.y + 5);
check('P drag to top', await is(P, 't-c3,t-c1,t-c2'), await order(P));
await wait(400);
check('P drop does not open', await P.evaluate(() => !document.body.classList.contains('editing')));
check('W follows P', await is(W, 't-c3,t-c1,t-c2'), await order(W));
const meta = (p, id) => p.evaluate(i => document.querySelector(`.card[data-id="${i}"] .card-meta`)?.textContent, id);
check('P move keeps edited time', (await meta(P, 't-c3')) === '3 h ago', await meta(P, 't-c3'));
check('W move keeps edited time', await until(async () => (await meta(W, 't-c3')) === '3 h ago'), await meta(W, 't-c3'));
check('W title edit is an edit', (await meta(W, 't-c2')) === 'Just now', await meta(W, 't-c2'));
check('D follows P', await is(D, 't-c3,t-c1,t-c2', '.drawer-card'), await order(D, '.drawer-card'));

// a quick swipe without the hold is a scroll, nothing moves
await touchDrag(await box(P, 't-c2'), top.y, 0);
await wait(500);
check('P swipe does not reorder', (await order(P)) === 't-c3,t-c1,t-c2', await order(P));

// D: drag a card in the drawer with the mouse, to the bottom
const d1 = await box(D, 't-c1', '.drawer-card');
const d2 = await box(D, 't-c2', '.drawer-card');
await D.mouse.move(d1.x + d1.width / 2, d1.y + d1.height / 2);
await D.mouse.down();
for (let i = 1; i <= 10; i++) { await D.mouse.move(d1.x + d1.width / 2, d1.y + d1.height / 2 + (d2.y + d2.height - d1.y) * i / 10); await wait(16); }
await D.mouse.up();
check('D drag to bottom', await is(D, 't-c3,t-c2,t-c1', '.drawer-card'), await order(D, '.drawer-card'));
check('D drawer stays open', await D.evaluate(() => document.getElementById('drawer').classList.contains('open')));
check('W follows D', await is(W, 't-c3,t-c2,t-c1'), await order(W));
check('P follows D', await is(P, 't-c3,t-c2,t-c1'), await order(P));
check('D move keeps edited time', await until(async () => (await meta(P, 't-c1')) === '3 h ago'), await meta(P, 't-c1'));
check('D drawer move keeps edited time', await D.evaluate(() => document.querySelector('.drawer-card[data-id="t-c1"] .drawer-meta').textContent !== 'Just now'));

// a new note goes on top, above the reordered ones
await W.tap('#new');
await W.keyboard.type('TEST-c4 new');
await wait(500);
const newId = await W.evaluate(() => location.hash.slice(1));
await W.tap('#back');
check('W new note on top', await until(async () => (await W.evaluate(() => document.querySelector('.card')?.dataset.id)) === newId));
check('P new note on top', await until(async () => (await P.evaluate(() => document.querySelector('.card')?.dataset.id)) === newId));
await W.screenshot({ path: `${S}/w-list-final.png` });

await cb.close(); await wb.close();
await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: H });
console.log('\n' + results.filter(r => r[0] === 'FAIL').length + ' failures of ' + results.length);
await stop();
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
