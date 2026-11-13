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
import { staffPages } from '@potomac-solutions/kit/staff/pages';
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

export async function createApp({ db = join(process.env.DATA_DIR ?? here, 'cinestack.db'), cache = true, secret = process.env.SESSION_SECRET, holdMs, sweepMs, staffCost } = {}) {
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
  const zubra = createZubra({ components, cache, packages: ['@potomac-solutions/kit/components'] });
  const qr = await loadQr();
  const actions = await createActions({
    components,
    context: ({ request }) => ({ boxOffice, guest: session.fromRequest(request), staff: onShift(request) }),
  });
  boxOffice.identify((request) => session.fromRequest(request));
  const served = files();

  function send(res, status, html) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  const back = (res, location) => (res.writeHead(303, { location }), res.end());
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;

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
  function bookPage(p, showing, booking, problem) {
    const film = boxOffice.film(showing.film);
    const cart = { lines: booking.units.map((seat, i) => ({ item: seat, qty: 1, name: `Seat ${seat}`, total: booking.lines[i]?.cents ?? 0 })), cents: booking.cents, ready: booking.state === 'held' || booking.state === 'failed' };
    return `<section>
  <a class="back" href="/show/${showing.id}">Back to the seats</a>
  <h1>${escape(film.title)}</h1>
  <p class="lede">${time(showing.starts)} · ${escape(boxOffice.hall(showing.auditorium).name)} · held for you until ${time(booking.until)}</p>
</section>
${p.render('checkout-form', { cart, place: `/book/${showing.id}`, checkout: booking.key, problem, testMode: true })}`;
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
  const page = (res, p, title, body) => send(res, 200, p.finish(layout({ title, theatre: boxOffice.theatre, body, actionsScript: actions.script() })));
  const pages = staffPages({ staff, home: '/staff/door', business: boxOffice.theatre.name, secure: production, render: (res, title, body) => page(res, zubra.page(), title, body) });

  function home(p, guest) {
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
    return `${tickets}<section><h1>Tonight</h1><p class="lede">Pick a time to choose your seats.</p></section><ul class="films">${cards.join('')}</ul>`;
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
        const done = await boxOffice.book(session.read(req.headers.cookie ?? ''), booking[1], form);
        return back(res, done.ok ? `/ticket/${done.ticket}` : `/book/${booking[1]}?problem=${encodeURIComponent(done.error)}`);
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      if (await pages.handle(req, res, url, null)) return;
      const guest = session.ensure(req, res);
      // Without JavaScript, an action's answer comes back once in a cookie.
      const result = actions.result(req, (name, value) => res.appendHeader(name, value));
      const problem = result?.value?.error ?? (result?.error ? 'That didn’t go through. Try again.' : '');
      const p = zubra.page();

      if (url.pathname === '/') return page(res, p, 'Tonight', home(p, guest));
      const match = url.pathname.match(/^\/show\/([\w-]+)$/);
      const showing = match && boxOffice.showing(match[1]);
      if (showing) return page(res, p, boxOffice.film(showing.film).title, show(p, showing, guest, problem));
      const paying = booking && boxOffice.showing(booking[1]);
      if (paying) {
        const held = boxOffice.booking(guest, paying.id);
        if (!held) return back(res, `/show/${paying.id}`);
        return page(res, p, 'Book', bookPage(p, paying, held, (url.searchParams.get('problem') ?? '').slice(0, 200)));
      }
      if (url.pathname === '/staff/door') {
        const who = staff.session(req);
        if (!staff.can(who, 'staff')) return page(res, p, 'Sign in', pages.signIn(url));
        return page(res, p, 'Door', pages.bar(who) + doorPage(p, result?.value ?? (result?.error ? { error: 'That didn’t go through. Try again.' } : null)));
      }
      const ticketMatch = url.pathname.match(/^\/ticket\/([\w-]+)$/);
      const ticket = ticketMatch && boxOffice.ticket(guest, ticketMatch[1]);
      if (ticket) return page(res, p, 'Your ticket', ticketPage(p, ticket));
      send(res, 404, 'Not found');
    } catch (error) {
      console.error(error);
      if (!res.headersSent) send(res, 500, 'Something went wrong.');
      else res.end();
    }
  });

  server.on('close', () => boxOffice.close());
  return Object.assign(server, { boxOffice, staff });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const server = await createApp();
  server.listen(port, '0.0.0.0', () => console.log(`CineStack on http://localhost:${port}`));
  if (server.staff.needsOwner()) console.log(`Set up the first owner (works once, for a day): http://localhost:${port}/staff/accept?token=${await server.staff.setup()}`);
}
