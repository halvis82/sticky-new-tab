// Pinned notes on top of the phone list and the drawer, synced, and full screen notes on the
// desktop board, synced and remembered. Only touches notes_test, see serve.mjs.
import { chromium, webkit, devices } from 'playwright';
import { SITE, serve, TEST_CONFIG, SECRET, NORMAL_WINDOW } from './serve.mjs';
import os from 'node:os';
import fs from 'node:fs';
const stop = await serve();
const S = fs.mkdtempSync(os.tmpdir() + '/notes-pins-');
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
const row = (id, ord, html, fx) => ({ id, html, ord, u: then, edited: then, color: '#fff5a5', fx, fy: 0.5, w: 220, h: 200, z: 1 });
await fetch(`${SURL}/rest/v1/notes_test`, { method: 'POST', headers: H, body: JSON.stringify([
  row('t-p1', 3000, 'TEST-p1', 0.15), row('t-p2', 2000, 'TEST-p2', 0.4), row('t-p3', 1000, 'TEST-p3', 0.65),
]) });
const server = async id => (await (await fetch(`${SURL}/rest/v1/notes_test?id=eq.${id}&select=pinned,expanded,fx,fy,w,h`, { headers: H })).json())[0];

const cb = await chromium.launch();
const wb = await webkit.launch();
const route = c => c.route('**/config.js', async r => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace('};', TEST_CONFIG) }); });
const ctxW = await wb.newContext({ ...devices['iPhone 13'] });
const ctxP = await cb.newContext({ ...devices['Pixel 7'] });
const ctxD = await cb.newContext({ viewport: { width: 1400, height: 900 } });
for (const c of [ctxW, ctxP, ctxD]) await route(c);
await ctxD.addInitScript(NORMAL_WINDOW);
const W = await ctxW.newPage();
const P = await ctxP.newPage();
const D = await ctxD.newPage();
for (const [n, p] of [['W', W], ['P', P], ['D', D]]) p.on('pageerror', e => console.log(`[${n} pageerror]`, e.message));
await W.goto(SITE); await P.goto(SITE); await D.goto(SITE + 'desktop.html');

const order = (p, sel = '.card') => p.evaluate(s => [...document.querySelectorAll(s)].map(c => c.dataset.id).join(','), sel);
const is = (p, want, sel) => until(async () => (await order(p, sel)) === want);
const pinOn = (p, id, sel = '.card-pin') => p.evaluate(([i, s]) => document.querySelector(`[data-id="${i}"] ${s}`)?.classList.contains('on'), [id, sel]);

check('W order', await is(W, 't-p1,t-p2,t-p3'), await order(W));
check('W pin starts outlined', (await pinOn(W, 't-p3')) === false);

// pin the last note on the phone
await W.tap('.card[data-id="t-p3"] .card-pin');
check('W pinned goes on top', await is(W, 't-p3,t-p1,t-p2'), await order(W));
check('W pin filled', await pinOn(W, 't-p3'));
check('W tap on pin does not open', await W.evaluate(() => !document.body.classList.contains('editing')));
check('server pinned', await until(async () => (await server('t-p3')).pinned === true));
check('P follows pin', await is(P, 't-p3,t-p1,t-p2'), await order(P));
check('P pin filled', await until(() => pinOn(P, 't-p3')));
await D.click('#drawer-btn');
check('D drawer follows pin', await is(D, 't-p3,t-p1,t-p2', '.drawer-card'), await order(D, '.drawer-card'));
check('D drawer pin filled', await until(() => pinOn(D, 't-p3', '.drawer-pin')));
await W.screenshot({ path: `${S}/w-pinned.png` });

// a new note goes below the pins
await W.tap('#new');
await W.keyboard.type('TEST-p4 new');
await wait(500);
const newId = await W.evaluate(() => location.hash.slice(1));
await W.tap('#back');
check('W new note below pin', await is(W, `t-p3,${newId},t-p1,t-p2`), await order(W));
check('P new note below pin', await is(P, `t-p3,${newId},t-p1,t-p2`), await order(P));

// dragging an unpinned note above the pin lands it at the top of the unpinned ones
const cdp = await ctxP.newCDPSession(P);
const box = async (p, id, sel = '.card') => p.locator(`${sel}[data-id="${id}"]`).boundingBox();
async function touchDrag(from, toY, hold = 450) {
  const x = from.x + from.width / 2, y = from.y + from.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await wait(hold);
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (toY - y) * i / 12 }] });
    await wait(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
await touchDrag(await box(P, 't-p2'), (await box(P, 't-p3')).y + 5);
check('P drag above pin stays below pins', await is(P, `t-p3,t-p2,${newId},t-p1`), await order(P));
check('W follows drag', await is(W, `t-p3,t-p2,${newId},t-p1`), await order(W));

// unpin in the drawer: it goes back among the rest by its order
await D.click('.drawer-card[data-id="t-p3"] .drawer-pin');
check('D drawer stays open after pin click', await D.evaluate(() => document.getElementById('drawer').classList.contains('open')));
check('W unpinned goes back', await is(W, `t-p2,${newId},t-p1,t-p3`), await order(W));
check('W pin outlined again', await until(async () => (await pinOn(W, 't-p3')) === false));
await D.click('#drawer-btn');

// full screen on the desktop board
const nbox = (p, id) => p.locator(`.note[data-id="${id}"]`).boundingBox();
const before = await nbox(D, 't-p1');
await D.click('.note[data-id="t-p1"] .note-bar button[title="Full screen"]');
await wait(100);
const big = await nbox(D, 't-p1');
const near = (a, b) => Math.abs(a - b) <= 2;
check('D full screen inset 5%', near(big.x, 70) && near(big.y, 45) && near(big.width, 1260) && near(big.height, 810), JSON.stringify(big));
check('D full screen button flips', await D.locator('.note[data-id="t-p1"] .note-bar button[title="Exit full screen"]').count() === 1);
check('D full screen on top', await D.evaluate(() => {
  const z = el => Number(el.style.zIndex);
  const me = document.querySelector('.note[data-id="t-p1"]');
  return [...document.querySelectorAll('.note')].every(n => n === me || z(n) < z(me));
}));
check('server expanded', await until(async () => (await server('t-p1')).expanded === true));
const s1 = await server('t-p1');
check('server keeps place and size', near(s1.fx, 0.15) && near(s1.w, 220) && near(s1.h, 200), JSON.stringify(s1));
await D.screenshot({ path: `${S}/d-full.png` });

// dragging the bar of a full screen note moves nothing
await D.mouse.move(big.x + big.width / 2, big.y + 10);
await D.mouse.down();
await D.mouse.move(big.x + big.width / 2 - 200, big.y + 200, { steps: 8 });
await D.mouse.up();
const still = await nbox(D, 't-p1');
check('D full screen does not drag', near(still.x, big.x) && near(still.y, big.y), JSON.stringify(still));
check('D full screen no grips', await D.evaluate(() => getComputedStyle(document.querySelector('.note[data-id="t-p1"] .grip.se')).display === 'none'));

// another tab and a reload both show it full screen
const D2 = await ctxD.newPage();
await D2.goto(SITE + 'desktop.html');
check('D2 other tab full screen', await until(async () => { const b = await nbox(D2, 't-p1'); return b && near(b.width, 1260); }));
await D.reload();
check('D reload full screen', await until(async () => { const b = await nbox(D, 't-p1'); return b && near(b.width, 1260); }));
check('phone list ignores it', await is(W, `t-p2,${newId},t-p1,t-p3`), await order(W));

// shrink: back exactly where it was, in this tab and the other
await D.click('.note[data-id="t-p1"] .note-bar button[title="Exit full screen"]');
await wait(100);
const after = await nbox(D, 't-p1');
check('D back to place and size', near(after.x, before.x) && near(after.y, before.y) && near(after.width, before.width) && near(after.height, before.height), JSON.stringify([before, after]));
check('D2 follows shrink', await until(async () => { const b = await nbox(D2, 't-p1'); return b && near(b.width, before.width) && near(b.x, before.x); }));
check('server not expanded', await until(async () => (await server('t-p1')).expanded === false));

// folding a full screen note puts it back too
await D.click('.note[data-id="t-p2"] .note-bar button[title="Full screen"]');
await D.click('.note[data-id="t-p2"] .note-bar button[title="Collapse"]');
check('fold leaves full screen', await D.evaluate(() => { const n = document.querySelector('.note[data-id="t-p2"]'); return n.classList.contains('collapsed') && !n.classList.contains('expanded'); }));

// only one full screen note: any action on another note shrinks it
const isBig = (p, id) => p.evaluate(i => document.querySelector(`.note[data-id="${i}"]`).classList.contains('expanded'), id);
await D.click('.note[data-id="t-p3"] .note-bar button[title="Full screen"]');
check('one full screen p3', await isBig(D, 't-p3'));
await D.evaluate(() => { // p2 sits under the full screen note here, so press it by hand
  const b = document.querySelector('.note[data-id="t-p2"] .note-bar button[title="Expand"]');
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.click();
});
check('unfold other shrinks p3', !(await isBig(D, 't-p3')));
check('server p3 shrunk', await until(async () => (await server('t-p3')).expanded === false));
check('D2 follows only-one', await until(async () => !(await isBig(D2, 't-p3'))));
await D.click('.note[data-id="t-p3"] .note-bar button[title="Full screen"]');
await D.evaluate(() => document.querySelector('.note[data-id="t-p1"] .note-body').focus());
check('focus other shrinks', !(await isBig(D, 't-p3')));
await D.click('.note[data-id="t-p3"] .note-bar button[title="Full screen"]');
await D.evaluate(() => document.querySelector('.note[data-id="t-p1"] .note-bar button[title="Full screen"]').click()); // keyboard style, no press
check('full screen other swaps', (await isBig(D, 't-p1')) && !(await isBig(D, 't-p3')));
check('one at a time', await D.evaluate(() => document.querySelectorAll('.note.expanded').length === 1));
await D.dblclick('body', { position: { x: 20, y: 880 } });
check('new note shrinks', await until(async () => !(await isBig(D, 't-p1'))));
await D.click('.note[data-id="t-p1"] .note-bar button[title="Full screen"]');
await D.click('.note[data-id="t-p1"] .note-body');
check('own note stays full screen', await isBig(D, 't-p1'));

await cb.close(); await wb.close();
await fetch(`${SURL}/rest/v1/notes_test?id=neq.x`, { method: 'DELETE', headers: H });
console.log('\n' + results.filter(r => r[0] === 'FAIL').length + ' failures of ' + results.length);
await stop();
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
