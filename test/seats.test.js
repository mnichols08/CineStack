// Milestone 0: contested seats. Each browser context is one guest's phone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { loadQr } from '@journey-to-code/symbology';

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
    await page.waitForFunction(() => customElements.get('seat-cell') && customElements.get('seat-chart'));
    await page.waitForTimeout(400); // documents loaded, live stream open
  }
  /** Post the choose action the way the page's own fetch does. */
  const choose = async (form) => {
    const response = await context.request.post(`${site.base}/_zb/action/seat-chart/choose`, {
      form: { showing: site.showing, ...form },
      headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' },
      maxRedirects: 0,
    });
    return { status: response.status(), body: await response.json().catch(() => null) };
  };
  /** The payment page's form, filled, as the guest would post it. */
  const checkout = async (card = '4242 4242 4242 4242') => {
    const html = await (await context.request.get(`${site.base}/book/${site.showing}`)).text();
    const key = /name="checkout" value="([\w-]+)"/.exec(html)?.[1];
    return { checkout: key ?? '', name: name, email: 'guest@example.com', card };
  };
  /** Post the payment form; where the server sends the guest. */
  const pay = async (form, headers = {}) => {
    const response = await context.request.post(`${site.base}/book/${site.showing}`, { form, headers, maxRedirects: 0 });
    return { status: response.status(), location: decodeURIComponent(response.headers().location ?? '') };
  };
  return { context, page, choose, checkout, pay, seat: (id) => page.locator(`input[name=seat][value=${id}]`) };
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
  await annTab.waitForFunction(() => customElements.get('seat-chart'));
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
    }).observe(document.querySelector('seat-chart .rows'), { subtree: true, childList: true, attributes: true, characterData: true });
  });

  await ann.seat(seat).click({ force: true });
  await ben.page.waitForFunction((id) => document.querySelector(`input[name=seat][value=${id}]`).disabled, seat);
  assert.ok(await ann.seat(seat).isChecked());
  assert.deepEqual(await ben.page.evaluate(() => [...window.touched]), [seat], 'only the tapped seat was touched');
  assert.equal(await ben.page.evaluate(() => window.structural), 0, 'no nodes were added or removed');

  // Ann's summary, with a countdown, here and in her other tab.
  await ann.page.waitForFunction(() => /\d:\d\d/.test(document.querySelector('seat-chart .hold').innerText));
  assert.match(await ann.page.locator('.hold').innerText(), new RegExp(`Seat ${seat}`));
  await annTab.waitForFunction((id) => document.querySelector('seat-chart .hold').innerText.includes(`Seat ${id}`), seat);
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
  await ann.page.waitForFunction(() => document.querySelector('seat-chart .problem'));
  assert.match(await ann.page.locator('.problem').innerText(), new RegExp(`Seat ${second} was just taken`));
  assert.ok(!(await ann.seat(second).isChecked()));

  // Ann taps her seat again to let it go; Ben's phone frees it.
  await ann.seat(seat).click({ force: true });
  await ben.page.waitForFunction((id) => !document.querySelector(`input[name=seat][value=${id}]`).disabled, seat);
  await ann.page.waitForFunction(() => document.querySelector('seat-chart .hold').innerText.includes('Choose your seats'));
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
  await ann.page.waitForFunction(() => document.querySelector('seat-chart .hold').innerText.includes('Choose your seats'));
  assert.equal(quick.server.boxOffice.taken(quick.showing).has(seat), false);
  // And a third guest can take it.
  const cy = await phone(quick, 'cy (quick)', { javaScriptEnabled: false });
  assert.equal((await cy.choose({ toggle: seat })).body.ok, true);
  await Promise.all([ann, ben, cy].map((guest) => guest.context.close()));
});

test('without JavaScript: hold seats, pay, and get a ticket; the seats are sold for everyone', async () => {
  const guest = await phone(app, 'buyer', { javaScriptEnabled: false });
  const [a, b] = freeSeats(app, 2, 'F');
  await guest.seat(a).check({ force: true });
  await guest.seat(b).check({ force: true });
  await guest.page.click('button.apply');
  await guest.page.waitForURL(app.base + app.path);
  assert.match(await guest.page.locator('seat-chart a.book').innerText(), /Book all 2 · \$22\.00/);
  await guest.page.click('seat-chart a.book');
  await guest.page.waitForURL(`${app.base}/book/${app.showing}`);
  assert.match(await guest.page.locator('checkout-form').innerText(), new RegExp(`Seat ${a}[\\s\\S]*Seat ${b}[\\s\\S]*\\$22\\.00`));
  await guest.page.fill('checkout-form input[name=name]', 'Rosa');
  await guest.page.fill('checkout-form input[name=email]', 'rosa@example.com');
  await guest.page.fill('checkout-form input[name=card]', '4242 4242 4242 4242');
  await guest.page.click('checkout-form button[type=submit]');
  await guest.page.waitForURL(/\/ticket\/b[a-z0-9]+$/);
  assert.match(await guest.page.locator('.ticket').innerText(), new RegExp(`Seats ${a}, ${b} · \\$22\\.00[\\s\\S]*Booked by Rosa`));
  // The code is the ticket's key, drawn by symbology, and reads back as it.
  const url = guest.page.url();
  const qr = await loadQr();
  const key = url.split('/').pop();
  const code = qr.encode(key);
  assert.equal(qr.svg(code, { title: `Ticket ${key}` }).replace(/<rect([^>]*)\/>/, '<rect$1></rect>').replace(/<path([^>]*)\/>/, '<path$1></path>'), await guest.page.locator('.ticket .qr').innerHTML());
  const scale = 4;
  const side = (code.size + 8) * scale;
  const luma = new Uint8Array(side * side).fill(255);
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.modules[y * code.size + x]) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) luma[((y + 4) * scale + dy) * side + (x + 4) * scale + dx] = 0;
  assert.equal(qr.decodeText({ width: side, height: side, luma }), key);

  // Sold, not held: for this guest's map and everyone else's.
  for (const seat of [a, b]) assert.equal(app.server.boxOffice.taken(app.showing).get(seat).state, 'sold');
  const other = await phone(app, 'after the sale', { javaScriptEnabled: false });
  assert.ok(await other.seat(a).isDisabled());
  // Someone else's ticket isn't theirs to see, and the paid booking can't be paid again.
  assert.equal((await other.context.request.get(url)).status(), 404);
  await guest.page.goto(`${app.base}/book/${app.showing}`);
  assert.equal(guest.page.url(), app.base + app.path, 'nothing held: back to the seats');
  await guest.context.close();
  await other.context.close();
});

test('a declined card books nothing: the seats stay held, to try another card', async () => {
  const guest = await phone(app, 'declined', { javaScriptEnabled: false });
  const [a, b] = freeSeats(app, 2, 'G');
  assert.equal((await guest.choose({ toggle: a })).body.ok, true);
  assert.equal((await guest.choose({ toggle: b })).body.ok, true);
  const form = await guest.checkout('4000 0000 0000 0002');
  assert.match(form.checkout, /^b[a-z0-9]+$/);
  assert.equal((await guest.pay(form)).location, `/book/${app.showing}?problem=That card was declined. Try another.`);
  assert.equal(app.server.boxOffice.taken(app.showing).get(a).state, 'held', 'still held');

  // Another guest can't pay for these seats with this guest's checkout, and another site can't post at all.
  const other = await phone(app, 'not theirs', { javaScriptEnabled: false });
  assert.equal((await other.pay({ ...form, card: '4242' })).location, `/book/${app.showing}?problem=Your seats aren’t held any more. Choose them again.`);
  assert.equal((await guest.pay({ ...form, card: '4242' }, { 'sec-fetch-site': 'cross-site' })).status, 403);

  const paid = await guest.pay({ ...form, card: '4242 4242 4242 4242' });
  assert.match(paid.location, /^\/ticket\/b[a-z0-9]+$/);
  assert.equal(paid.location, `/ticket/${form.checkout}`, 'the same booking, paid on the second try');
  assert.equal(app.server.boxOffice.taken(app.showing).get(b).state, 'sold');

  // A new seat is a new booking: the old payment form can't pay for it.
  const [c] = freeSeats(app, 1, 'G');
  assert.equal((await guest.choose({ toggle: c })).body.ok, true);
  assert.equal((await guest.pay(form)).location, `/book/${app.showing}?problem=Your seats aren’t held any more. Choose them again.`);
  assert.equal(app.server.boxOffice.taken(app.showing).get(c).state, 'held');
  // Letting go of every seat ends the booking: there's nothing to pay for.
  assert.equal((await guest.choose({ toggle: c })).body.ok, true);
  assert.equal((await guest.context.request.get(`${app.base}/book/${app.showing}`, { maxRedirects: 0 })).headers().location, `/show/${app.showing}`);
  await guest.context.close();
  await other.context.close();
});

test('a hold that runs out before paying books nothing', async () => {
  const guest = await phone(quick, 'too slow', { javaScriptEnabled: false });
  const [seat] = freeSeats(quick, 1, 'H');
  assert.equal((await guest.choose({ toggle: seat })).body.ok, true);
  const form = await guest.checkout();
  await new Promise((done) => setTimeout(done, 2000));
  const late = await guest.pay(form);
  assert.ok(late.location.startsWith(`/book/${quick.showing}?problem=`), late.location);
  assert.notEqual(quick.server.boxOffice.taken(quick.showing).get(seat)?.state, 'sold');
  await guest.context.close();
});

/** A guest who has bought `count` seats in `row`: their phone, and the ticket's key. */
async function ticketHolder(site, name, row, count = 1) {
  const guest = await phone(site, name, { javaScriptEnabled: false });
  for (const seat of freeSeats(site, count, row)) assert.equal((await guest.choose({ toggle: seat })).body.ok, true);
  const paid = await guest.pay(await guest.checkout());
  assert.match(paid.location, /^\/ticket\/b[a-z0-9]+$/);
  return { ...guest, key: paid.location.split('/').pop() };
}

/** A door-shift device. */
async function door(site, name, { javaScriptEnabled = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  page.on('console', (message) => message.type() === 'error' && errors.push(`${name}: ${message.text()}`));
  await page.goto(`${site.base}/staff/door`);
  await page.click('button.start');
  await page.waitForURL(`${site.base}/staff/door`);
  if (javaScriptEnabled) await page.waitForFunction(() => customElements.get('door-scanner'));
  const scan = async (ticket) => {
    const response = await context.request.post(`${site.base}/_zb/action/door-scanner/scan`, { form: { ticket }, headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' } });
    return response.json();
  };
  return { context, page, scan };
}

test("the door scans a ticket once, from a photo of it; the guest's ticket says so live", async () => {
  const guest = await ticketHolder(app, 'at the door', 'J', 2);
  const ticket = await browser.newPage({ storageState: await guest.context.storageState() });
  ticket.on('pageerror', (error) => errors.push(`ticket: ${error.message}`));
  await ticket.goto(`${app.base}/ticket/${guest.key}`);
  await ticket.waitForFunction(() => customElements.get('ticket-status'));
  await ticket.waitForTimeout(400); // the live stream open
  assert.equal(await ticket.locator('ticket-status').innerText(), 'Show this at the door.');
  const photo = await ticket.locator('.ticket .qr').screenshot();

  // The door photographs the code; the page decodes it (symbology, in the browser) and scans it.
  const staff = await door(app, 'door');
  await staff.page.setInputFiles('#ticket-photo', { name: 'ticket.png', mimeType: 'image/png', buffer: photo });
  const admit = staff.page.locator('door-scanner .admit');
  await admit.waitFor({ timeout: 5000 });
  assert.match(await admit.innerText(), /Admit 2[\s\S]*Auditorium 1[\s\S]*Seats J\d+, J\d+/);
  assert.doesNotMatch(await admit.innerText(), /guest@example\.com|at the door/, 'the door sees the seats, not the guest');

  // The guest's ticket follows, with no reload.
  await ticket.locator('ticket-status .used').waitFor({ timeout: 5000 });
  assert.match(await ticket.locator('ticket-status').innerText(), /^Used at \d{1,2}:\d{2} [AP]M$/);

  // The same code again: refused, with when it was first used.
  await staff.page.setInputFiles('#ticket-photo', { name: 'ticket.png', mimeType: 'image/png', buffer: photo });
  const refused = staff.page.locator('door-scanner .refuse');
  await refused.waitFor({ timeout: 5000 });
  assert.match(await refused.innerText(), /Already used\.[\s\S]*First used at \d{1,2}:\d{2} [AP]M/);

  // A photo with no code in it says so, and scans nothing.
  await staff.page.setInputFiles('#ticket-photo', { name: 'blank.png', mimeType: 'image/png', buffer: await ticket.locator('h1').screenshot() });
  await staff.page.locator('#photo-problem:has-text("No ticket code found")').waitFor({ timeout: 5000 });
  await ticket.close();
  await staff.context.close();
  await guest.context.close();
});

test('only a door-shift device scans; two doors at once let a ticket in once', async () => {
  const guest = await ticketHolder(app, 'two doors', 'K');
  // Not on a shift: the action refuses, and the page offers to start one.
  const outsider = await phone(app, 'outsider', { javaScriptEnabled: false });
  const tried = await outsider.context.request.post(`${app.base}/_zb/action/door-scanner/scan`, { form: { ticket: guest.key }, headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' } });
  assert.deepEqual(await tried.json(), { error: 'Start a door shift to scan tickets.' });
  assert.match(await (await outsider.context.request.get(`${app.base}/staff/door`)).text(), /Start a door shift/);
  assert.equal((await outsider.context.request.post(`${app.base}/staff/start`, { headers: { 'sec-fetch-site': 'cross-site' }, maxRedirects: 0 })).status(), 403);

  const [a, b] = await Promise.all([door(app, 'door a'), door(app, 'door b')]);
  const answers = await Promise.all([a.scan(guest.key), b.scan(guest.key)]);
  assert.equal(answers.filter((answer) => answer.ok).length, 1, JSON.stringify(answers));
  assert.equal(answers.filter((answer) => answer.error === 'Already used.').length, 1);
  // The door's answer says what to let in, and nothing about who booked it.
  assert.deepEqual(Object.keys(answers.find((answer) => answer.ok).admit).sort(), ['film', 'hall', 'seats', 'starts', 'ticket']);
  assert.deepEqual(await a.scan('b0000000000'), { error: 'That isn’t one of our tickets.' });
  assert.deepEqual(await a.scan('../../seats/x'), { error: 'That isn’t one of our tickets.' });
  await Promise.all([a.context.close(), b.context.close(), outsider.context.close(), guest.context.close()]);
});

test('without JavaScript: the door types a code and sees the answer', async () => {
  const guest = await ticketHolder(app, 'typed', 'L');
  const staff = await door(app, 'door no-js', { javaScriptEnabled: false });
  await staff.page.fill('door-scanner input[name=ticket]', guest.key);
  await staff.page.click('door-scanner button[type=submit]');
  await staff.page.waitForURL(`${app.base}/staff/door`);
  assert.match(await staff.page.locator('door-scanner .admit').innerText(), /Admit 1/);
  await staff.page.fill('door-scanner input[name=ticket]', guest.key);
  await staff.page.click('door-scanner button[type=submit]');
  assert.match(await staff.page.locator('door-scanner .refuse').innerText(), /Already used/);
  await staff.context.close();
  await guest.context.close();
});

test("a page reads the seats and its own tickets, never bookings, payments or anyone else's ticket", async () => {
  const owner = await ticketHolder(app, 'reader', 'B');
  const other = await phone(app, 'nosy', { javaScriptEnabled: false });
  /** Everything a page is sent, following the cursor to the end. */
  const pull = async (person, scope = '') => {
    const all = [];
    for (let since = 0, i = 0; i < 200; i++) {
      const page = await (await person.context.request.get(`${app.base}/_zb/sync/pull?since=${encodeURIComponent(since)}${scope}`)).json();
      all.push(...(page.changes ?? []));
      if (!page.changes?.length || page.cursor === since) break;
      since = page.cursor;
    }
    return all;
  };
  const theirs = await pull(owner);
  const seen = await pull(other);
  assert.ok(seen.some((change) => change.collection === 'seats'), 'the seats are public');
  for (const change of seen) assert.ok(['seats', 'holds'].includes(change.collection), `${change.collection} isn't sent to another guest`);
  assert.deepEqual([...new Set(theirs.map((change) => change.collection))].sort(), ['holds', 'seats', 'tickets']);
  assert.deepEqual([...new Set(theirs.filter((change) => change.collection === 'tickets').map((change) => change.key))], [owner.key], 'only their own ticket');
  // A page can't widen it by asking.
  assert.deepEqual(await pull(other, `&scope=${encodeURIComponent(JSON.stringify({ tickets: true, bookings: true, payments: true }))}`), []);
  await owner.context.close();
  await other.context.close();
});

test('guests cannot write seats themselves, and the server code stays on the server', async () => {
  const guest = await phone(app, 'writer', { javaScriptEnabled: false });
  const push = await guest.context.request.post(`${app.base}/_zb/sync/push`, {
    data: { changes: [{ collection: 'seats', key: `${app.showing}/A2`, field: 'state', value: 'free', clock: `${String(Date.now() + 60_000).padStart(15, '0')}-00000-me` }] },
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(push.status(), 403);
  const module = await (await guest.context.request.get(`${app.base}/_zubra/components/seat-chart.js`)).text();
  assert.ok(module.length > 500);
  assert.ok(!module.includes('boxOffice'), 'the server function body is not in the browser module');
  // A browser asks for a favicon on its own; the theatre has none yet, and that isn't an error.
  assert.equal((await guest.context.request.get(`${app.base}/favicon.ico`)).status(), 204);
  await guest.context.close();
});
