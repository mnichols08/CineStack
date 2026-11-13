// The box office: what the server knows, and the things only the server may decide.
//
// A seat is the most contested thing in the building, so guests never write seat state. They ask
// (a 'use server' function), and the box office checks and writes in one step. What it writes are
// Sync documents, so every phone looking at the showing follows without reloading:
//
//   seats/<showing>/<seat>   { state: 'held' | 'sold' | 'free', by, until }
//   holds/<showing>/<guest>  { seats: [...], until }      the guest's own summary
//   bookings/<key>           the kit's `reserve` draft: seats held at a showing, priced, then paid
//   tickets/<key>            a paid booking, from the kit's `stages`: booked, then scanned at the door
//
// `by` and <guest> are the guest's public name (session.js), never their cookie id.
import { createHash } from 'node:crypto';
import { createSyncServer } from '@zubra/sync/server';
import { createHolds } from '@potomac-solutions/kit/hold';
import { createReserve } from '@potomac-solutions/kit/reserve';
import { createPay, testProvider } from '@potomac-solutions/kit/pay';
import { createStages } from '@potomac-solutions/kit/stages';
import { fieldLog } from './log.js';
import { theatre, auditoriums, films, showings as seedShowings, SEAT_CENTS } from './seed.js';

const pad = (number, width) => String(number).padStart(width, '0');

/** A hybrid logical clock for the server's writes (the same shape the devices use). */
function serverClock(startAfter = '') {
  let last = Number(startAfter.slice(0, 15)) || 0;
  let counter = 0;
  return () => {
    const now = Math.max(Date.now(), last);
    counter = now === last ? counter + 1 : 0;
    last = now;
    return `${pad(now, 15)}-${pad(counter, 5)}-server`;
  };
}

export const MAX_SEATS = 8;

/** Seats in the order people say them: by row, then by number (C8 before C10). */
const bySeat = (a, b) => a.replace(/\d+$/, '').localeCompare(b.replace(/\d+$/, '')) || parseInt(a.match(/\d+$/)[0], 10) - parseInt(b.match(/\d+$/)[0], 10);

export function createBoxOffice({ db = ':memory:', holdMs = 5 * 60_000, sweepMs = 1000, today = new Date() } = {}) {
  const log = fieldLog(db);
  const tick = serverClock(log.latestClock());
  const showings = new Map(seedShowings(today).map((showing) => [showing.id, showing]));
  const halls = new Map(auditoriums.map((auditorium) => [auditorium.id, auditorium]));
  const filmsById = new Map(films.map((film) => [film.id, film]));
  const seatIds = new Map(auditoriums.map((a) => [a.id, new Set(a.layout.flatMap((row) => row.cells.filter((cell) => !cell.gap).map((cell) => cell.id)))]));

  // The server's own pushes go through the Sync server so they reach the live streams. Only they
  // may write; membership of a WeakSet of Request objects can't be forged by a client.
  const internal = new WeakSet();
  const sync = createSyncServer({
    log,
    authorize({ request, write }) {
      if (!write) return true;
      if (internal.has(request)) return true;
      // Presence (who else is looking at a showing) stores nothing; anyone may join.
      const path = new URL(request.url).pathname;
      return path.endsWith('/presence') || path.endsWith('/signal');
    },
  });

  /** Write fields as the server. Stored before this returns; the promise is the broadcast. */
  function write(collection, key, fields) {
    const changes = Object.entries(fields).map(([field, value]) => ({ collection, key, field, value, clock: tick() }));
    for (const change of changes) log.apply(change);
    const request = new Request('http://cinestack.internal/_zb/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ changes }),
    });
    internal.add(request);
    return sync.fetch(request).then((response) => {
      if (!response?.ok) throw new Error(`The log refused a server write (${response?.status})`);
    });
  }

  // Who has what, and for how long, is the kit's `hold` module. The box office only says which
  // seats exist and puts the answers into words.
  const holds = createHolds({
    store: { get: log.get, under: log.under, write },
    holdMs,
    sweepMs,
    max: MAX_SEATS,
    names: { units: 'seats', holders: 'holds', list: 'seats', taken: 'sold' },
    order: bySeat,
  });
  const { taken, sweep } = holds;

  // Booking is the kit's `reserve`: the seats a guest holds at a showing are a draft, priced;
  // booking pays for it once (the kit's test provider: no money moves) and confirms the seats
  // as sold. A paid booking is a ticket, which the door will scan (`stages`).
  const store = { get: log.get, under: log.under, write };
  const tickets = createStages({ store, collection: 'tickets', steps: ['booked', 'scanned'] });
  const reserve = createReserve({
    store,
    holds,
    pay: createPay({ provider: testProvider(), store }),
    stages: tickets,
    base: SEAT_CENTS,
    pools: (pool) => showings.has(pool),
  });

  /** The guest's booking in progress at a showing (held, or tried and declined), or null. */
  const draft = (guest, showing) =>
    log
      .under('bookings')
      .filter((booking) => booking.holder === guest.pub && booking.pools?.[0] === showing && (booking.state === 'held' || booking.state === 'failed'))
      .sort((a, b) => b.at - a.at)[0] ?? null;
  const bookingKey = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  // A fresh theatre has a few seats already sold in each showing, so the map looks lived in.
  if (!log.size) {
    for (const showing of showings.values()) {
      const ids = [...seatIds.get(showing.auditorium)];
      const order = (id) => createHash('sha1').update(`${showing.id}/${id}`).digest('hex');
      for (const seat of ids.sort((a, b) => (order(a) < order(b) ? -1 : 1)).slice(0, Math.floor(ids.length / 6))) {
        write('seats', `${showing.id}/${seat}`, { state: 'sold', by: '', until: 0 });
      }
    }
  }

  return {
    sync,
    theatre,
    holdMs,
    seatCents: SEAT_CENTS,
    sweep,
    showings: () => [...showings.values()],
    showing: (id) => showings.get(id) ?? null,
    hall: (id) => halls.get(id) ?? null,
    film: (id) => filmsById.get(id) ?? null,
    taken,

    /** A guest's seats in a showing, and when the hold runs out. */
    held(guest, showing, now = Date.now()) {
      const { units, until } = holds.held(guest.pub, showing, now);
      return { seats: units, until };
    },

    /**
     * A guest chooses seats. With `toggle`, that one seat is taken or let go (a tap, with
     * JavaScript). Without it, the guest's seats become exactly the ticked ones (the plain form).
     * All or nothing: if any seat they want has gone, nothing changes.
     */
    async choose(guest, formData) {
      if (!guest) return { error: 'Open the showing again to choose seats.' };
      const showing = showings.get(String(formData.get('showing') ?? ''));
      if (!showing) return { error: 'That showing is gone.' };
      const toggle = String(formData.get('toggle') ?? '');
      const had = holds.held(guest.pub, showing.id).units;
      const units = toggle ? (had.includes(toggle) ? had.filter((seat) => seat !== toggle) : [...had, toggle]) : formData.getAll('seat').map(String);
      const before = draft(guest, showing.id);
      if (!units.length) {
        // Nothing chosen: let go of the draft's seats (or of a hold with no draft behind it).
        if (before) await reserve.release(guest.pub, before.key);
        else await holds.choose(guest.pub, showing.id, { units: [] });
        return { ok: true, seats: [], until: 0 };
      }
      const answer = await reserve.hold(guest.pub, { key: before?.key ?? bookingKey(), pools: [showing.id], units, valid: seatIds.get(showing.auditorium) });
      if (answer.ok) return { ok: true, seats: answer.units, until: answer.until };
      const words = {
        unknown: 'No such seat.',
        limit: `You can hold up to ${MAX_SEATS} seats at once.`,
        taken: `Seat ${answer.unit} was just taken.`,
        'in-progress': 'Your booking is going through. Wait a moment.',
      };
      return { error: words[answer.error] ?? 'Those seats could not be held.', seat: answer.unit ?? '' };
    },

    /** The guest's draft at a showing, ready to pay for: seats, lines and total. Null if none. */
    booking(guest, showing) {
      const found = draft(guest, showing);
      return found && found.units?.length ? found : null;
    },

    /**
     * Pay for the guest's held seats. Once paid, they're sold and the booking is a ticket. A
     * declined card books nothing; the seats stay held while the hold lasts, to try again.
     */
    async book(guest, showingId, form) {
      if (!guest) return { error: 'Open the showing again to choose seats.' };
      const showing = showings.get(showingId);
      const found = showing && draft(guest, showing.id);
      if (!found || String(form.get('checkout') ?? '') !== found.key) return { error: 'Your seats aren’t held any more. Choose them again.' };
      const done = await reserve.book(guest.pub, found.key, {
        method: { card: String(form.get('card') ?? '') },
        fields: { showing: showing.id, name: String(form.get('name') ?? '').trim().slice(0, 100), email: String(form.get('email') ?? '').trim().slice(0, 200) },
        description: 'CineStack tickets (test mode)',
      });
      if (done.ok) return { ok: true, ticket: found.key };
      const words = {
        declined: 'That card was declined. Try another.',
        lapsed: 'Your hold ran out and a seat went to someone else. Choose your seats again.',
        'in-progress': 'Your booking is already going through.',
        'lapsed-after-payment': 'Your hold ran out while the payment went through. The theatre will refund it.',
      };
      return { error: words[done.error] ?? 'That didn’t go through. Try again.' };
    },

    /** A ticket the guest owns, with what it's for, or null. */
    ticket(guest, key) {
      const record = log.get('tickets', key);
      if (!record || !guest || record.holder !== guest.pub) return null;
      const showing = showings.get(record.showing);
      return { key, ...record, showing, film: filmsById.get(showing?.film), hall: halls.get(showing?.auditorium) };
    },

    close() {
      holds.close();
      log.close();
    },
  };
}
