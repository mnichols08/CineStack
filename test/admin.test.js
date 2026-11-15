// Guest accounts and the theatre's admin, over plain HTTP (no browser needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

const COST = { N: 2 ** 10, r: 8, p: 1 };
const OWNER = { email: 'owner@example.com', name: 'Test Owner', password: 'test owner password' };
const STAFF = { email: 'door@example.com', name: 'Door Hand', password: 'door hand password' };
const dir = mkdtempSync(join(tmpdir(), 'cinestack-admin-'));
let server;
let base;

before(async () => {
  server = await createApp({ staffCost: COST, db: join(dir, 'shop.db'), cache: false, secret: 'test' });
  await server.staff.accept(await server.staff.setup(), OWNER);
  const owner = server.staff.list().find((one) => one.email === OWNER.email);
  await server.staff.accept((await server.staff.invite(owner, { email: STAFF.email, name: STAFF.name, roles: ['staff'] })).token, STAFF);
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
});

function browser() {
  const jar = new Map();
  const remember = (response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      if (pair.slice(at + 1)) jar.set(pair.slice(0, at), pair.slice(at + 1));
      else jar.delete(pair.slice(0, at));
    }
    return response;
  };
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const where = (response) => decodeURIComponent((response.headers.get('location') ?? '').replace(/&sig=[\w-]+/, '').replaceAll('+', ' '));
  return {
    async get(path) {
      const response = remember(await fetch(`${base}${path}`, { headers: { cookie: cookie() }, redirect: 'manual' }));
      return { status: response.status, type: response.headers.get('content-type'), location: where(response), text: await response.text() };
    },
    async post(path, form) {
      const response = remember(await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), redirect: 'manual' }));
      return { status: response.status, location: where(response), text: await response.text() };
    },
    /** An action, as a page with JavaScript calls it. */
    async act(path, form) {
      const response = remember(await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams(form), redirect: 'manual' }));
      return response.status;
    },
    /** Every change the live log would send this browser, asking for `collections`. */
    async pull(collections) {
      const scope = encodeURIComponent(JSON.stringify(Object.fromEntries(collections.map((one) => [one, true]))));
      const response = await fetch(`${base}/_zb/sync/pull?since=0&scope=${scope}`, { headers: { cookie: cookie() } });
      return { status: response.status, text: await response.text() };
    },
  };
}
async function signInStaff(who) {
  const b = browser();
  await b.get('/');
  assert.equal((await b.post('/staff/sign-in', { email: who.email, password: who.password })).location, '/staff/door');
  return b;
}

/** `n` seats nobody has at the first showing. */
function freeSeats(n) {
  const showing = server.boxOffice.showings()[0];
  const taken = server.boxOffice.taken(showing.id);
  return server.boxOffice.hall(showing.auditorium).layout.flatMap((row) => row.cells).filter((cell) => !cell.gap && !taken.has(cell.id)).slice(0, n).map((cell) => cell.id);
}

/** Hold `seats` at the first showing and pay: the ticket's key. */
async function buy(b, seats, { name = 'Pat Quill', email = 'pat@example.com' } = {}) {
  const showing = server.boxOffice.showings()[0].id;
  const form = new URLSearchParams([['showing', showing], ...seats.map((seat) => ['seat', seat])]);
  const status = await b.act('/_zb/action/seat-chart/choose', form);
  assert.ok(status < 300, `choosing seats: ${status}`);
  const html = (await b.get(`/book/${showing}`)).text;
  const checkout = /name="checkout" value="(b[a-z0-9]+)"/.exec(html)?.[1];
  assert.ok(checkout, 'the payment page has the booking');
  const paid = await b.post(`/book/${showing}`, { checkout, name, email, card: '4242 4242 4242 4242' });
  const key = /^\/ticket\/(b[a-z0-9]+)$/.exec(paid.location)?.[1];
  assert.ok(key, paid.location);
  return { key, html };
}

test('the home page leads with the theatre, then tonight; no admin link for a guest', async () => {
  const page = (await browser().get('/')).text;
  assert.match(page, /class="hero"[\s\S]*See what’s on tonight[\s\S]*id="tonight"[\s\S]*How it works/);
  assert.ok(!page.includes('>Admin</a>'));
});

test('a guest signs up after buying; the ticket joins the account and opens on another device', async () => {
  const phone = browser();
  await phone.get('/');
  const seats = freeSeats(2);
  const { key } = await buy(phone, seats);
  assert.match(server.sent.at(-1).subject, /Your tickets/);
  assert.equal((await phone.post('/account/sign-up', { name: 'Pat Quill', email: 'pat@example.com', password: 'pat quill password' })).location, '/account?done=Welcome. Your account is ready.');
  assert.match((await phone.get('/account')).text, new RegExp(`Tonight[\\s\\S]*/ticket/${key}`));

  const laptop = browser();
  await laptop.get('/');
  assert.equal((await laptop.get(`/ticket/${key}`)).status, 404);
  assert.equal((await laptop.post('/account/sign-in', { email: 'pat@example.com', password: 'pat quill password' })).location, '/account');
  assert.match((await laptop.get(`/ticket/${key}`)).text, new RegExp(seats.join(', ')));
  // Signed in, the payment page knows who's paying, and the ticket is the account's.
  const second = await buy(laptop, freeSeats(1));
  assert.match(second.html, /value="Pat Quill"[\s\S]*value="pat@example.com"/);
  assert.equal(server.boxOffice.store.get('tickets', second.key).customer, server.customers.list()[0].customer);
  assert.equal((await laptop.post('/account/sign-out', {})).location, '/');
  assert.equal((await laptop.get(`/ticket/${key}`)).status, 404);
});

test('no page can read accounts, sessions, tokens, settings or the admin’s activity from the live log', async () => {
  const b = browser();
  await b.get('/');
  await b.post('/account/sign-up', { name: 'Nosy Parker', email: 'nosy@example.com', password: 'nosy parker password' });
  const pulled = await b.pull(['customers', 'customer-sessions', 'customer-tokens', 'accounts', 'staff-sessions', 'staff-tokens', 'audit', 'settings']);
  assert.ok(!/nosy@example\.com|scrypt|Door Hand|seatCents/.test(pulled.text), pulled.text.slice(0, 200));
});

test('a forgotten password: the same page either way, and the emailed link works once', async () => {
  const b = browser();
  await b.get('/');
  await b.post('/account/sign-up', { name: 'Lee Forgets', email: 'lee@example.com', password: 'lee first password' });
  const nobody = (await b.post('/account/forgot', { email: 'nobody@example.com' })).text.match(/<main[\s\S]*<\/main>/)[0];
  const lee = (await b.post('/account/forgot', { email: 'lee@example.com' })).text.match(/<main[\s\S]*<\/main>/)[0];
  assert.equal(nobody, lee);
  const token = /\/account\/reset\?token=([\w-]{43})/.exec(server.sent.at(-1).body)[1];
  assert.equal((await b.post('/account/reset', { token, password: 'lee second password' })).location, '/account?done=Your new password is saved.');
  assert.match((await b.post('/account/reset', { token, password: 'lee third password' })).text, /expired/);
});

test('the admin is for staff; reports, settings and the outbox for managers', async () => {
  const guest = browser();
  await guest.get('/');
  for (const path of ['/admin', '/admin/tickets', '/admin/reports', '/admin/tickets.csv']) {
    const page = await guest.get(path);
    assert.ok(!/Seats sold tonight|text\/csv/.test(`${page.text}${page.type}`), path);
  }
  assert.equal((await guest.post('/admin/settings', { price: '1' })).location, '/admin');
  const hand = await signInStaff(STAFF);
  assert.match((await hand.get('/admin')).text, /Seats sold tonight[\s\S]*Tonight’s showings/);
  for (const path of ['/admin/reports', '/admin/settings', '/admin/outbox']) assert.equal((await hand.get(path)).status, 403, path);
  await hand.post('/admin/settings', { price: '1' });
  assert.equal(server.boxOffice.seatPrice(), 1100);
  const owner = await signInStaff(OWNER);
  for (const path of ['/admin/reports', '/admin/settings', '/admin/outbox']) assert.equal((await owner.get(path)).status, 200, path);
});

test('a manager changes the seat price: new holds pay it, tickets already bought keep theirs', async () => {
  const before = server.boxOffice.allTickets()[0];
  const owner = await signInStaff(OWNER);
  assert.match((await owner.post('/admin/settings', { price: 'free' })).location, /seat price/);
  assert.equal((await owner.post('/admin/settings', { price: '12.50' })).location, '/admin/settings?done=Saved. Seats chosen from now on cost that.');
  const b = browser();
  await b.get('/');
  const { key } = await buy(b, freeSeats(2), { email: 'price@example.com' });
  assert.equal(server.boxOffice.store.get('tickets', key).cents, 2500);
  assert.equal(server.boxOffice.store.get('tickets', before.key).cents, before.cents);
  assert.match((await browser().get('/')).text, /\$12\.50 each/);
  await owner.post('/admin/settings', { price: '11' });
});

test('tickets search and download; the report adds up; a name can’t become a formula', async () => {
  const b = browser();
  await b.get('/');
  const [seat] = freeSeats(1);
  await buy(b, [seat], { name: '=HYPERLINK("http://evil.example")', email: 'sheet@example.com' });
  const owner = await signInStaff(OWNER);
  assert.match((await owner.get('/admin/tickets?q=sheet%40example')).text, new RegExp(`<td>${seat}</td>`));
  const at = Date.now();
  const total = server.boxOffice.allTickets().filter((ticket) => ticket.starts >= at - 29 * 86_400_000 && ticket.starts <= at).reduce((sum, ticket) => sum + ticket.cents, 0);
  const rows = (await owner.get('/admin/reports.csv?range=30d')).text.trim().split('\r\n');
  assert.equal(rows[0], 'Night,Tickets,Box office (USD)');
  assert.equal(Math.round(rows.slice(1).reduce((sum, row) => sum + Number(row.split(',')[2]), 0) * 100), total);
  assert.match((await owner.get('/admin/tickets.csv')).text, /"'=HYPERLINK\(""http:\/\/evil\.example""\)"/);
});

test('a manager turns a guest’s account off; staff can’t turn it back on', async () => {
  const b = browser();
  await b.get('/');
  await b.post('/account/sign-up', { name: 'Off Switch', email: 'off@example.com', password: 'off switch password' });
  const id = server.customers.list().find((c) => c.email === 'off@example.com').customer;
  const owner = await signInStaff(OWNER);
  assert.match((await owner.post(`/admin/guests/${id}/disabled`, { disabled: 'yes' })).location, /Turned off/);
  assert.equal((await b.get('/account')).location, '/account/sign-in');
  const hand = await signInStaff(STAFF);
  await hand.post(`/admin/guests/${id}/disabled`, { disabled: 'no' });
  assert.equal(server.customers.get(id).disabled, true);
});
