// Milestone 0: contested seats. Each browser context is one guest's phone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server.js';

const dir = mkdtempSync(join(tmpdir(), 'cinestack-'));
const errors = [];
let browser;
let app; // five-minute holds
let quick; // holds that run out in a second and a half, to watch expiry

async function start(name, options = {}) {
  const server = await createApp({ db: join(dir, `${name}.db`), cache: false, secret: 'test', ...options });
  await new Promise((done) => server.listen(0, done));
  const base = `http://localhost:${server.address().port}`;
  // Auditorium 1 is the big room (220 seats); its first showing is the one under test.
  const showing = server.boxOffice.showings().find((s) => s.auditorium === '1');
  return { server, base, showing: showing.id, path: `/show/${showing.id}` };
}
const stop = (server) => {
  server.closeAllConnections?.();
  return new Promise((done) => server.close(done));
};

before(async () => {
  app = await start('app');
  quick = await start('quick', { holdMs: 1500, sweepMs: 200 });
  // Playwright's own Chromium when it is installed; otherwise the machine's Chrome.
  const system = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((path) => existsSync(path));
  browser = await chromium.launch().catch(() => chromium.launch({ executablePath: process.env.CHROME ?? system }));
});
after(async () => {
  await browser?.close();
  await stop(app.server);
  await stop(quick.server);
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, [], 'no page errors in any browser');
});

/** A guest's phone on `site`'s showing. */
async function phone(site, name, { javaScriptEnabled = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  page.on('console', (message) => message.type() === 'error' && !/403/.test(message.text()) && errors.push(`${name}: ${message.text()}`));
  await page.goto(site.base + site.path);
  if (javaScriptEnabled) {
    await page.waitForFunction(() => customElements.get('seat-cell') && customElements.get('seat-map'));
    await page.waitForTimeout(400); // documents loaded, live stream open
  }
  /** Post the choose action the way the page's own fetch does. */
  const choose = async (form) => {
    const response = await context.request.post(`${site.base}/_zb/action/seat-map/choose`, {
      form: { showing: site.showing, ...form },
      headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' },
      maxRedirects: 0,
    });
    return { status: response.status(), body: await response.json().catch(() => null) };
  };
  return { context, page, choose, seat: (id) => page.locator(`input[name=seat][value=${id}]`) };
}

/** A seat nobody has, from the server's own view. */
function freeSeats(site, count, row) {
  const taken = site.server.boxOffice.taken(site.showing);
  const hall = site.server.boxOffice.hall('1');
  const all = hall.layout.filter((r) => !row || r.label === row).flatMap((r) => r.cells.filter((cell) => !cell.gap).map((cell) => cell.id));
  const free = all.filter((id) => !taken.has(id));
  assert.ok(free.length >= count, 'enough free seats');
  return free.slice(0, count);
}

test('without JavaScript: tick seats, press the button, and they are held', async () => {
  const guest = await phone(app, 'no-js', { javaScriptEnabled: false });
  assert.equal(await guest.page.locator('input[name=seat]').count(), 220);
  const [a, b] = freeSeats(app, 2, 'C');
  await guest.seat(a).check({ force: true });
  await guest.seat(b).check({ force: true });
  await guest.page.click('button.apply');
  await guest.page.waitForURL(app.base + app.path);
  assert.ok(await guest.seat(a).isChecked());
  assert.ok(await guest.seat(b).isChecked());
  assert.match(await guest.page.locator('.hold').innerText(), new RegExp(`Seats ${a}, ${b}`));

  // Someone else sees them taken, also without JavaScript.
  const other = await phone(app, 'no-js other', { javaScriptEnabled: false });
  assert.ok(await other.seat(a).isDisabled());

  // Unticking one and pressing the button lets it go.
  await guest.seat(b).uncheck({ force: true });
  await guest.page.click('button.apply');
  await guest.page.waitForURL(app.base + app.path);
  assert.ok(!(await guest.seat(b).isChecked()));
  await other.page.reload();
  assert.ok(!(await other.seat(b).isDisabled()));

  // A seat that went while the page sat open: nothing changes, and the page says why.
  const [c] = freeSeats(app, 1, 'D');
  await guest.seat(c).check({ force: true });
  assert.equal((await other.choose({ toggle: c })).body.ok, true);
  await guest.page.click('button.apply');
  await guest.page.waitForURL(app.base + app.path);
  assert.match(await guest.page.locator('.notice').innerText(), new RegExp(`Seat ${c} was just taken`));
  assert.ok(await guest.seat(c).isDisabled());
  assert.ok(await guest.seat(a).isChecked(), 'the seats already held are kept');
  await guest.context.close();
  await other.context.close();
});

test('the same seat, at the same moment: one guest gets it', async () => {
  const guests = await Promise.all(Array.from({ length: 6 }, (_, i) => phone(app, `racer ${i}`, { javaScriptEnabled: false })));
  const [seat] = freeSeats(app, 1, 'E');
  const results = await Promise.all(guests.map((guest) => guest.choose({ toggle: seat })));
  assert.equal(results.filter((r) => r.body?.ok).length, 1, 'exactly one winner');
  assert.equal(results.filter((r) => r.body?.error === `Seat ${seat} was just taken.`).length, 5);
  assert.equal(app.server.boxOffice.taken(app.showing).get(seat).state, 'held');
  await Promise.all(guests.map((guest) => guest.context.close()));
});

test('a tap is seen on every phone, and only that seat changes', async () => {
  const ann = await phone(app, 'ann');
  const ben = await phone(app, 'ben');
  const annTab = await ann.context.newPage();
  await annTab.goto(app.base + app.path);
  await annTab.waitForFunction(() => customElements.get('seat-map'));
  await annTab.waitForTimeout(400);
  const [seat, second] = freeSeats(app, 2, 'F');

  // Watch what the DOM does on Ben's phone while Ann taps.
  await ben.page.evaluate(() => {
    window.touched = new Set();
    window.structural = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') window.structural++;
        const cell = (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest('seat-cell');
        window.touched.add(cell ? cell.querySelector('input').value : 'outside a seat');
      }
    }).observe(document.querySelector('seat-map .rows'), { subtree: true, childList: true, attributes: true, characterData: true });
  });

  await ann.seat(seat).click({ force: true });
  await ben.page.waitForFunction((id) => document.querySelector(`input[name=seat][value=${id}]`).disabled, seat);
  assert.ok(await ann.seat(seat).isChecked());
  assert.deepEqual(await ben.page.evaluate(() => [...window.touched]), [seat], 'only the tapped seat was touched');
  assert.equal(await ben.page.evaluate(() => window.structural), 0, 'no nodes were added or removed');

  // Ann's summary, with a countdown, here and in her other tab.
  await ann.page.waitForFunction(() => /\d:\d\d/.test(document.querySelector('seat-map .hold').innerText));
  assert.match(await ann.page.locator('.hold').innerText(), new RegExp(`Seat ${seat}`));
  await annTab.waitForFunction((id) => document.querySelector('seat-map .hold').innerText.includes(`Seat ${id}`), seat);
  assert.ok(await annTab.locator(`input[name=seat][value=${seat}]`).isChecked());

  // Ben can't have it, even asking the server directly.
  assert.equal((await ben.choose({ toggle: seat })).body.error, `Seat ${seat} was just taken.`);

  // Ben takes the next seat; Ann taps it a moment later from a page that hasn't heard yet.
  assert.equal((await ben.choose({ toggle: second })).body.ok, true);
  await ann.page.evaluate((id) => {
    const input = document.querySelector(`input[name=seat][value=${id}]`);
    input.disabled = false; // as if the news hadn't arrived
    input.click();
  }, second);
  await ann.page.waitForFunction(() => document.querySelector('seat-map .problem'));
  assert.match(await ann.page.locator('.problem').innerText(), new RegExp(`Seat ${second} was just taken`));
  assert.ok(!(await ann.seat(second).isChecked()));

  // Ann taps her seat again to let it go; Ben's phone frees it.
  await ann.seat(seat).click({ force: true });
  await ben.page.waitForFunction((id) => !document.querySelector(`input[name=seat][value=${id}]`).disabled, seat);
  await ann.page.waitForFunction(() => document.querySelector('seat-map .hold').innerText.includes('Choose your seats'));
  await ann.context.close();
  await ben.context.close();
});

test('a hold runs out on the server, and every phone sees the seat come back', async () => {
  const ann = await phone(quick, 'ann (quick)');
  const ben = await phone(quick, 'ben (quick)');
  const [seat] = freeSeats(quick, 1, 'G');
  await ann.seat(seat).click({ force: true });
  await ben.page.waitForFunction((id) => document.querySelector(`input[name=seat][value=${id}]`).disabled, seat);
  // Nobody does anything. A second and a half later the server lets it go.
  await ben.page.waitForFunction((id) => !document.querySelector(`input[name=seat][value=${id}]`).disabled, seat, { timeout: 5000 });
  await ann.page.waitForFunction((id) => !document.querySelector(`input[name=seat][value=${id}]`).checked, seat, { timeout: 5000 });
  await ann.page.waitForFunction(() => document.querySelector('seat-map .hold').innerText.includes('Choose your seats'));
  assert.equal(quick.server.boxOffice.taken(quick.showing).has(seat), false);
  // And a third guest can take it.
  const cy = await phone(quick, 'cy (quick)', { javaScriptEnabled: false });
  assert.equal((await cy.choose({ toggle: seat })).body.ok, true);
  await Promise.all([ann, ben, cy].map((guest) => guest.context.close()));
});

test('guests cannot write seats themselves, and the server code stays on the server', async () => {
  const guest = await phone(app, 'writer', { javaScriptEnabled: false });
  const push = await guest.context.request.post(`${app.base}/_zb/sync/push`, {
    data: { changes: [{ collection: 'seats', key: `${app.showing}/A2`, field: 'state', value: 'free', clock: `${String(Date.now() + 60_000).padStart(15, '0')}-00000-me` }] },
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(push.status(), 403);
  const module = await (await guest.context.request.get(`${app.base}/_zubra/components/seat-map.js`)).text();
  assert.ok(module.length > 500);
  assert.ok(!module.includes('boxOffice'), 'the server function body is not in the browser module');
  await guest.context.close();
});
