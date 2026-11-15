// CineStack: a movie theatre on one small Node server.
//
// - Pages are rendered here by @zubra/server and hydrated in the browser.
// - Seats are Sync documents (@zubra/sync) that only the server writes, so every phone looking
//   at a showing sees a seat change the moment it happens.
// - Choosing seats is a 'use server' function (@zubra/actions): a plain form post, with or
//   without JavaScript. The box office (src/box-office.js) decides who gets a seat.
// - Holding, paying and the ticket are the Potomac kit's reserve, pay and stages; the payment
//   page is the kit's checkout-form, from the package. The ticket's QR code is symbology's.
// - The people who work the door are the kit's staff accounts: an owner, and the staff they invite.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { createActions } from '@zubra/actions';
import { createStaff } from '@potomac-solutions/kit/staff';
import { staffPages, clientAddress } from '@potomac-solutions/kit/staff/pages';
import { createCustomers } from '@potomac-solutions/kit/customers';
import { createNotify, outbox } from '@potomac-solutions/kit/notify';
import * as accountPages from './src/account.js';
import { createAdmin } from './src/admin.js';
import { createNotices } from '@potomac-solutions/kit/notice';
import { loadQr } from '@journey-to-code/symbology';
import { createBoxOffice } from './src/box-office.js';
import { sessions } from './src/session.js';
import { layout, escape } from './src/layout.js';

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, 'src', 'components');

/** The door's camera script and symbology's decoder, which the door page loads. */
function files() {
  // The package exports its WebAssembly file; its loader sits beside it.
  const symbology = dirname(fileURLToPath(import.meta.resolve('@journey-to-code/symbology/symbology.wasm')));
  return new Map([
    ['/scripts/door.js', ['text/javascript; charset=utf-8', readFileSync(join(here, 'src', 'door.js'))]],
    ['/vendor/symbology/qr.js', ['text/javascript; charset=utf-8', readFileSync(join(symbology, 'qr.js'))]],
    ['/vendor/symbology/symbology.wasm', ['application/wasm', readFileSync(join(symbology, 'symbology.wasm'))]],
  ]);
}

const time = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export async function createApp({ db = join(process.env.DATA_DIR ?? here, 'cinestack.db'), cache = true, secret = process.env.SESSION_SECRET, holdMs, sweepMs, staffCost, now = Date.now } = {}) {
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new Error('Set SESSION_SECRET.');
    secret = 'cinestack-development-only';
  }
  const boxOffice = createBoxOffice({ db, holdMs, sweepMs });
  const session = sessions({ secret });
  // The theatre's people, in its own log; sign-in, links, people and passwords are the kit's pages.
  const production = process.env.NODE_ENV === 'production';
  const staff = createStaff({ store: boxOffice.store, secure: production, ...(staffCost ? { cost: staffCost } : {}) });
  const onShift = (from) => staff.can(staff.session(from), 'staff');
  // Guests who make an account (kit/customers), in the theatre's own log. A guest is their
  // browser's public name and, signed in, their account: tickets follow either.
  const customers = createCustomers({ store: boxOffice.store, secure: production, now, ...(staffCost ? { cost: staffCost } : {}) });
  const withAccount = (guest, from) => guest && { ...guest, customer: customers.session(from)?.customer };
  const mail = outbox();
  const notify = createNotify({
    send: mail.send,
    templates: {
      reset: ({ name, link }) => ({ subject: `Reset your ${boxOffice.theatre.name} password`, body: `Hi ${name},\n\nThis link sets a new password. It works once, for an hour:\n${link}\n\nIf it wasn’t you, ignore this email.` }),
      tickets: ({ name, film, when, hall, seats, total, link }) => ({ subject: `Your tickets: ${film}`, body: `Hi ${name},\n\n${film}, ${when}, ${hall}. Seats ${seats}. ${total}, paid (test mode).\n\nShow the code at the door: ${link}` }),
    },
  });
  const proxies = Number(process.env.TRUST_PROXIES ?? 0);
  const origin = (req) => process.env.PUBLIC_URL || `http://${req.headers.host ?? 'localhost'}`;
  const admin = createAdmin({ boxOffice, customers, sent: mail.sent, now });
  const zubra = createZubra({ components, cache, packages: ['@potomac-solutions/kit/components'] });
  const qr = await loadQr();
  const actions = await createActions({
    components,
    context: ({ request }) => ({ boxOffice, guest: withAccount(session.fromRequest(request), request), staff: onShift(request) }),
  });
  boxOffice.identify((request) => withAccount(session.fromRequest(request), request));
  const served = files();

  function send(res, status, html) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  // A message in an address shows only if the server signed it (kit/notice), so a link can't put
  // its own words in a page's alert.
  const notices = createNotices({ secret });
  const back = (res, location) => (res.writeHead(303, { location: notices.sign(location) }), res.end());
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const withDone = (path, words) => `${path}?done=${encodeURIComponent(words)}`;
  const withProblem = (path, words) => `${path}?problem=${encodeURIComponent(words)}`;
  const said = (url) => {
    const { problem, done } = notices.read(url);
    return `${problem ? `<p class="notice" role="alert">${escape(problem)}</p>` : ''}${done ? `<p class="ok" role="status">${escape(done)}</p>` : ''}`;
  };
  const downloadCsv = (res, name, text) => (res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' }), res.end(text));

  /** A small urlencoded form, or null when it's bigger than any of CineStack's forms. */
  async function readForm(req) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4000) return null;
    }
    return new URLSearchParams(body);
  }

  /** Paying for held seats: the kit's checkout-form, one line per seat. */
  function bookPage(p, showing, booking, problem, account) {
    const film = boxOffice.film(showing.film);
    const cart = { lines: booking.units.map((seat, i) => ({ item: seat, qty: 1, name: `Seat ${seat}`, total: booking.lines[i]?.cents ?? 0 })), cents: booking.cents, ready: booking.state === 'held' || booking.state === 'failed' };
    return `<section>
  <a class="back" href="/show/${showing.id}">Back to the seats</a>
  <h1>${escape(film.title)}</h1>
  <p class="lede">${time(showing.starts)} · ${escape(boxOffice.hall(showing.auditorium).name)} · held for you until ${time(booking.until)}</p>
</section>
${p.render('checkout-form', { cart, place: `/book/${showing.id}`, checkout: booking.key, problem, testMode: true, name: account?.name ?? '', email: account?.email ?? '' })}`;
  }

  /** The door: scan a ticket's code, from a photo or typed. For a door-shift device. */
  function doorPage(p, result) {
    return `<section>
  <h1>Door</h1>
  <p class="lede">Scan each ticket once. A ticket that has been used says when.</p>
</section>
<label class="photo">Scan with the camera <input type="file" id="ticket-photo" accept="image/*" capture="environment"></label>
<p id="photo-problem" class="notice-text" role="alert"></p>
${p.render('door-scanner', { resultNow: result ?? {}, timeZone: boxOffice.theatre.timeZone })}
<script type="module" src="/scripts/door.js"></script>`;
  }

  /**
   * A ticket: what it's for, and the code the door scans. The code is the ticket's key, which is
   * all the door needs to look it up, and carries no address that could be wrong for the host.
   */
  function ticketPage(p, ticket) {
    const code = qr.svg(qr.encode(ticket.key), { title: `Ticket ${ticket.key}` });
    return `<section class="ticket">
  <p class="tag">Ticket · test mode</p>
  <h1>${escape(ticket.film.title)}</h1>
  <p class="lede">${time(ticket.showing.starts)} · ${escape(ticket.hall.name)}</p>
  <p class="seats">${ticket.units.length === 1 ? 'Seat' : 'Seats'} <strong>${escape(ticket.units.join(', '))}</strong> · ${money(ticket.cents)}</p>
  <div class="qr">${code}</div>
  ${p.render('ticket-status', { ticket: ticket.key, statusNow: ticket.status, scannedNow: ticket.scanned ?? 0, timeZone: boxOffice.theatre.timeZone })}
  ${ticket.name ? `<p class="lede">Booked by ${escape(ticket.name)}.</p>` : ''}
</section>`;
  }
  const page = (res, p, title, body, options = {}) => send(res, options.status ?? 200, p.finish(layout({ title, theatre: boxOffice.theatre, body, actionsScript: actions.script(), ...options })));
  const pages = staffPages({ staff, notices, proxies: Number(process.env.TRUST_PROXIES ?? 0), home: '/staff/door', business: boxOffice.theatre.name, secure: production, render: (res, title, body) => page(res, zubra.page(), title, body) });

  function home(p, guest, account) {
    const mine = boxOffice.ticketsFor(guest);
    const tickets = mine.length
      ? `<section class="mine"><h2>Your tickets</h2><ul>${mine
          .map((ticket) => `<li><a href="/ticket/${ticket.key}"><strong>${escape(ticket.film.title)}</strong> ${time(ticket.showing.starts)} · ${escape(ticket.hall.name)} · ${ticket.units.length === 1 ? 'Seat' : 'Seats'} ${escape(ticket.units.join(', '))}${ticket.status === 'scanned' ? ' · used' : ''}</a></li>`)
          .join('')}</ul></section>`
      : '';
    const byFilm = new Map();
    for (const showing of boxOffice.showings()) {
      if (!byFilm.has(showing.film)) byFilm.set(showing.film, []);
      byFilm.get(showing.film).push(showing);
    }
    const cards = [...byFilm].map(([id, list]) => {
      const film = boxOffice.film(id);
      const times = list
        .sort((a, b) => a.starts - b.starts)
        .map((showing) => `<li><a href="/show/${showing.id}">${time(showing.starts)}<small>${escape(boxOffice.hall(showing.auditorium).name)}</small></a></li>`)
        .join('');
      return `<li class="film">${film.label ? `<span class="tag">${escape(film.label)}</span>` : ''}<h2>${escape(film.title)}</h2><p>${escape(film.rating)} · ${film.minutes} min</p><ul class="times">${times}</ul></li>`;
    });
    return `<section class="hero"><h1>${escape(boxOffice.theatre.name)}</h1><p class="lede">Eight screens in ${escape(boxOffice.theatre.town)}: laser projection, Dolby Atmos and heated recliners. Choose your own seats, pay on your phone, and show the code at the door.</p><div class="actions"><a class="go" href="#tonight">See what’s on tonight</a>${account ? '<a class="button light" href="/account">Your tickets</a>' : '<a class="button light" href="/account/sign-up">Make an account</a>'}</div></section>
${tickets}<section id="tonight"><h1>Tonight</h1><p class="lede">Pick a time to choose your seats.</p></section><ul class="films">${cards.join('')}</ul>
<section class="two"><div class="panel"><h2>How it works</h2><ol><li>Pick a showing and tap the seats you want; they’re held for you for ${Math.round(boxOffice.holdMs / 60_000)} minutes.</li><li>Pay once; your ticket is a code on your phone.</li><li>Show it at the door. Each ticket gets in once.</li></ol></div><div class="panel"><h2>Visit</h2><dl class="facts"><dt>Where</dt><dd>${escape(boxOffice.theatre.address)}</dd><dt>Seats</dt><dd>${money(boxOffice.seatPrice())} each</dd></dl></div></section>`;
  }

  function show(p, showing, guest, problem) {
    const hall = boxOffice.hall(showing.auditorium);
    const film = boxOffice.film(showing.film);
    const taken = boxOffice.taken(showing.id);
    const rows = hall.layout.map((row) => ({
      label: row.label,
      cells: row.cells.map((cell) => (cell.gap ? cell : { ...cell, ...(taken.get(cell.id) ?? { state: 'free', by: '', until: 0 }) })),
    }));
    const held = boxOffice.held(guest, showing.id);
    return `<section>
  <a class="back" href="/">All showings</a>
  <h1>${escape(film.title)}</h1>
  <p class="lede">${time(showing.starts)} · ${escape(hall.name)} · ${escape(film.rating)} · ${film.minutes} min</p>
  <ul class="specs">${hall.specs.map((spec) => `<li>${escape(spec)}</li>`).join('')}</ul>
</section>
${problem ? `<p class="notice" role="alert">${escape(problem)}</p>` : ''}
${p.render('seat-chart', { showing: showing.id, me: guest.pub, rows, seatsNow: held.seats, untilNow: held.until, holdMinutes: Math.round(boxOffice.holdMs / 60_000), seatCents: boxOffice.seatCents })}`;
  }

  const server = createServer(async (req, res) => {
    try {
      if (await boxOffice.sync.handle(req, res)) return;
      if (await actions.handle(req, res)) return;
      if (zubra.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
      const file = served.get(url.pathname);
      if (file) {
        res.writeHead(200, { 'content-type': file[0], 'cache-control': 'public, max-age=3600' });
        return res.end(file[1]);
      }

      const account = customers.session(req);
      const who = staff.session(req);
      const atDesk = staff.can(who, 'staff');
      const owner = staff.can(who, 'owner');
      const nav = { customer: account, staff: atDesk };
      const paint = (p, title, body, options = {}) => page(res, p, title, body, { nav, ...options });
      if (url.pathname.startsWith('/account') || url.pathname.startsWith('/admin')) res.setHeader('cache-control', 'no-store');

      // A guest's account, and the admin's changes: plain form posts. Another site's post is refused.
      if ((url.pathname.startsWith('/account/') || url.pathname.startsWith('/admin/')) && req.method === 'POST') {
        if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, 'Forbidden');
        const form = await readForm(req);
        if (!form) return send(res, 413, 'Too large');
        const guest = withAccount(session.ensure(req, res), req);
        const p = zubra.page();
        const problem = (words) => `<p class="notice" role="alert">${escape(words)}</p>`;
        if (url.pathname === '/account/sign-up') {
          const made = await customers.signUp({ email: form.get('email'), name: form.get('name'), password: form.get('password') });
          if (made.error) return paint(p, 'Make an account', accountPages.signUp({ problem: problem(made.error), form }), { status: 422 });
          await boxOffice.claim(guest, made.customer);
          res.appendHeader('set-cookie', made.cookie);
          return back(res, withDone('/account', 'Welcome. Your account is ready.'));
        }
        if (url.pathname === '/account/sign-in') {
          const signed = await customers.signIn(form.get('email'), form.get('password'), { client: clientAddress(req, { proxies }) });
          if (signed.error) return paint(p, 'Sign in', accountPages.signIn({ problem: problem(signed.error === 'locked' ? 'Too many tries. Wait 15 minutes, or reset your password.' : 'That email and password don’t match.'), email: String(form.get('email') ?? '') }), { status: 401 });
          await boxOffice.claim(guest, signed.customer);
          res.appendHeader('set-cookie', signed.cookie);
          return back(res, '/account');
        }
        if (url.pathname === '/account/sign-out') {
          res.appendHeader('set-cookie', (await customers.signOut(req)).cookie);
          return back(res, '/');
        }
        if (url.pathname === '/account/forgot') {
          const email = String(form.get('email') ?? '').trim().toLowerCase();
          const raw = await customers.resetToken(email);
          const one = raw && customers.list().find((c) => c.email === email);
          if (one) {
            const link = `${origin(req)}/account/reset?token=${raw}`;
            await notify.notify({ email: one.email }, 'reset', { name: one.name, link });
            if (!production) console.log(`Password reset for ${one.email}: ${link}`);
          }
          return paint(p, 'Reset your password', accountPages.forgot({ sent: true }));
        }
        if (url.pathname === '/account/reset') {
          const raw = String(form.get('token') ?? '');
          const reset = await customers.reset(raw, form.get('password'));
          if (reset.error) return paint(p, 'Choose a new password', accountPages.reset({ token: raw, problem: problem(reset.error), works: customers.peek(raw) }), { status: 422 });
          res.appendHeader('set-cookie', reset.cookie);
          return back(res, withDone('/account', 'Your new password is saved.'));
        }
        if (url.pathname === '/account/profile') {
          if (!account) return back(res, '/account/sign-in');
          const renamed = await customers.rename(account.customer, form.get('name'));
          return back(res, renamed.ok ? withDone('/account', 'Saved.') : withProblem('/account', renamed.error));
        }
        if (url.pathname.startsWith('/admin/')) {
          if (!owner) return back(res, '/admin');
          const action = url.pathname.match(/^\/admin\/guests\/(c[a-z0-9]+)\/(disabled|reset)$/);
          const one = action && customers.get(action[1]);
          if (one && action[2] === 'disabled') {
            const off = form.get('disabled') === 'yes';
            await customers.setDisabled(one.customer, off);
            await boxOffice.audit(who, `${off ? 'turned off' : 'turned back on'} ${one.name}’s account`, one.customer);
            return back(res, withDone(`/admin/guests/${one.customer}`, off ? 'Turned off and signed out everywhere.' : 'Turned back on.'));
          }
          if (one) {
            const raw = await customers.resetToken(one.email);
            if (!raw) return back(res, withProblem(`/admin/guests/${one.customer}`, 'That account is turned off.'));
            await notify.notify({ email: one.email }, 'reset', { name: one.name, link: `${origin(req)}/account/reset?token=${raw}` });
            await boxOffice.audit(who, `emailed ${one.name} a reset link`, one.customer);
            return back(res, withDone(`/admin/guests/${one.customer}`, 'Sent. It’s in the outbox.'));
          }
          if (url.pathname === '/admin/settings') {
            const saved = await boxOffice.setSeatPrice(form);
            if (saved.error) return back(res, withProblem('/admin/settings', saved.error));
            await boxOffice.audit(who, `set the seat price to ${money(saved.cents)}`);
            return back(res, withDone('/admin/settings', 'Saved. Seats chosen from now on cost that.'));
          }
          return send(res, 404, 'Not found');
        }
        return send(res, 404, 'Not found');
      }

      // Sign-in, links, people and passwords: the kit's staff pages. Another site's post is refused.
      if (url.pathname.startsWith('/staff/') && req.method === 'POST') {
        if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, 'Forbidden');
        const form = await readForm(req);
        if (!form) return send(res, 413, 'Too large');
        if (await pages.handle(req, res, url, form)) return;
        return send(res, 404, 'Not found');
      }

      // Paying for held seats: the kit's checkout-form posts here. A post another site sends is
      // refused (the guest cookie is SameSite=Lax as well).
      const booking = url.pathname.match(/^\/book\/([\w-]+)$/);
      if (booking && req.method === 'POST') {
        if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, 'Forbidden');
        const form = await readForm(req);
        if (!form) return send(res, 413, 'Too large');
        const done = await boxOffice.book(withAccount(session.read(req.headers.cookie ?? ''), req), booking[1], form);
        if (done.ok) {
          const ticket = boxOffice.ticket(withAccount(session.read(req.headers.cookie ?? ''), req), done.ticket);
          const email = String(form.get('email') ?? '').trim();
          if (ticket && email) await notify.notify({ email }, 'tickets', { name: String(form.get('name') ?? '').trim() || 'there', film: ticket.film.title, when: time(ticket.showing.starts), hall: ticket.hall.name, seats: ticket.units.join(', '), total: money(ticket.cents), link: `${origin(req)}/ticket/${done.ticket}` });
        }
        return back(res, done.ok ? `/ticket/${done.ticket}` : `/book/${booking[1]}?problem=${encodeURIComponent(done.error)}`);
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      if (await pages.handle(req, res, url, null)) return;
      const guest = withAccount(session.ensure(req, res), req);
      // Without JavaScript, an action's answer comes back once in a cookie.
      const result = actions.result(req, (name, value) => res.appendHeader(name, value));
      const problem = result?.value?.error ?? (result?.error ? 'That didn’t go through. Try again.' : '');
      const p = zubra.page();

      if (url.pathname === '/') return paint(p, 'Tonight', home(p, guest, account), { here: '/' });

      // A guest's account pages.
      if (url.pathname === '/account') return account ? paint(p, 'Your account', accountPages.account({ boxOffice, customer: account, guest, said: said(url) }), { here: '/account' }) : back(res, '/account/sign-in');
      if (url.pathname === '/account/sign-in') return account ? back(res, '/account') : paint(p, 'Sign in', accountPages.signIn({ problem: said(url) }), { here: '/account/sign-in' });
      if (url.pathname === '/account/sign-up') return account ? back(res, '/account') : paint(p, 'Make an account', accountPages.signUp());
      if (url.pathname === '/account/forgot') return paint(p, 'Reset your password', accountPages.forgot());
      if (url.pathname === '/account/reset') {
        const raw = url.searchParams.get('token') ?? '';
        return paint(p, 'Choose a new password', accountPages.reset({ token: raw, works: customers.peek(raw) }));
      }

      // The admin: staff only; reports, settings and the outbox for managers.
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        if (!atDesk) return paint(p, 'Sign in', pages.signIn(url));
        const bar = pages.bar(who);
        const wide = { wide: true, here: '/admin' };
        if (url.pathname === '/admin') return paint(p, 'Tonight', admin.dashboard({ who, owner, bar }), wide);
        if (url.pathname === '/admin/tickets') return paint(p, 'Tickets', admin.tickets({ url, owner, bar }), wide);
        if (url.pathname === '/admin/tickets.csv') return downloadCsv(res, 'tickets.csv', admin.ticketsCsv(url));
        if (url.pathname === '/admin/guests') return paint(p, 'Guests', admin.guests({ url, owner, bar }), wide);
        if (url.pathname === '/admin/guests.csv') return downloadCsv(res, 'guests.csv', admin.guestsCsv());
        const oneGuest = url.pathname.match(/^\/admin\/guests\/(c[a-z0-9]+)$/);
        const one = oneGuest && customers.get(oneGuest[1]);
        if (one) return paint(p, one.name, admin.guest({ one, owner, bar, said: said(url) }), wide);
        if (['/admin/reports', '/admin/reports.csv', '/admin/settings', '/admin/outbox'].includes(url.pathname) && !owner) return paint(p, 'Managers only', '<section><h1>Managers only</h1><p class="lede">Ask a manager to see this page.</p><p><a href="/admin">Back to tonight</a></p></section>', { status: 403 });
        if (url.pathname === '/admin/reports') return paint(p, 'Reports', admin.reports({ url, owner, bar }), wide);
        if (url.pathname === '/admin/reports.csv') return downloadCsv(res, 'box-office.csv', admin.reportCsv(url));
        if (url.pathname === '/admin/settings') return paint(p, 'Settings', admin.settings({ owner, bar, said: said(url) }), wide);
        if (url.pathname === '/admin/outbox') return paint(p, 'Outbox', admin.outbox({ owner, bar }), wide);
        return send(res, 404, 'Not found');
      }
      const match = url.pathname.match(/^\/show\/([\w-]+)$/);
      const showing = match && boxOffice.showing(match[1]);
      if (showing) return paint(p, boxOffice.film(showing.film).title, show(p, showing, guest, problem));
      const paying = booking && boxOffice.showing(booking[1]);
      if (paying) {
        const held = boxOffice.booking(guest, paying.id);
        if (!held) return back(res, `/show/${paying.id}`);
        return paint(p, 'Book', bookPage(p, paying, held, notices.read(url).problem, account));
      }
      if (url.pathname === '/staff/door') {
        const who = staff.session(req);
        if (!staff.can(who, 'staff')) return paint(p, 'Sign in', pages.signIn(url));
        return paint(p, 'Door', pages.bar(who) + doorPage(p, result?.value ?? (result?.error ? { error: 'That didn’t go through. Try again.' } : null)));
      }
      const ticketMatch = url.pathname.match(/^\/ticket\/([\w-]+)$/);
      const ticket = ticketMatch && boxOffice.ticket(guest, ticketMatch[1]);
      if (ticket) return paint(p, 'Your ticket', ticketPage(p, ticket));
      send(res, 404, 'Not found');
    } catch (error) {
      console.error(error);
      if (!res.headersSent) send(res, 500, 'Something went wrong.');
      else res.end();
    }
  });

  server.on('close', () => boxOffice.close());
  return Object.assign(server, { boxOffice, staff, customers, sent: mail.sent });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const server = await createApp();
  server.listen(port, '0.0.0.0', () => console.log(`CineStack on http://localhost:${port}`));
  if (server.staff.needsOwner()) console.log(`Set up the first owner (works once, for a day): http://localhost:${port}/staff/accept?token=${await server.staff.setup()}`);
}
