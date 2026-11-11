// The box office: what the server knows, and the things only the server may decide.
//
// A seat is the most contested thing in the building, so guests never write seat state. They ask
// (a 'use server' function), and the box office checks and writes in one step. What it writes are
// Sync documents, so every phone looking at the showing follows without reloading:
//
//   seats/<showing>/<seat>   { state: 'held' | 'sold' | 'free', by, until }
//   holds/<showing>/<guest>  { seats: [...], until }      the guest's own summary
//
// `by` and <guest> are the guest's public name (session.js), never their cookie id.
import { createHash } from 'node:crypto';
import { createSyncServer } from '@zubra/sync/server';
import { fieldLog } from './log.js';
import { theatre, auditoriums, films, showings as seedShowings } from './seed.js';

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

  const seatOf = (key) => key.slice(key.lastIndexOf('/') + 1);
  /** A seat document as it stands now: a hold past its time counts as free. */
  const current = (doc, now) => (doc?.state === 'held' && doc.until <= now ? { state: 'free', by: '', until: 0 } : { state: doc?.state ?? 'free', by: doc?.by ?? '', until: doc?.until ?? 0 });

  /** Every seat of a showing that isn't free, by seat id. */
  function taken(showing, now = Date.now()) {
    const seats = new Map();
    for (const doc of log.under('seats', `${showing}/`)) {
      const seat = current(doc, now);
      if (seat.state !== 'free') seats.set(seatOf(doc.key), seat);
    }
    return seats;
  }

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

  /** Let go of every hold whose time is up, and tell everyone. */
  async function sweep(now = Date.now()) {
    const lapsed = log.under('seats').filter((doc) => doc.state === 'held' && doc.until <= now);
    if (!lapsed.length) return 0;
    const writes = [];
    const guests = new Set();
    for (const doc of lapsed) {
      guests.add(`${doc.key.slice(0, doc.key.lastIndexOf('/'))}/${doc.by}`);
      writes.push(write('seats', doc.key, { state: 'free', by: '', until: 0 }));
    }
    for (const key of guests) writes.push(write('holds', key, { seats: [], until: 0 }));
    await Promise.all(writes);
    return lapsed.length;
  }
  const timer = sweepMs ? setInterval(() => sweep().catch((error) => console.error(error)), sweepMs) : null;
  timer?.unref?.();

  return {
    sync,
    theatre,
    holdMs,
    sweep,
    showings: () => [...showings.values()],
    showing: (id) => showings.get(id) ?? null,
    hall: (id) => halls.get(id) ?? null,
    film: (id) => filmsById.get(id) ?? null,
    taken,

    /** A guest's seats in a showing, and when the hold runs out. */
    held(guest, showing, now = Date.now()) {
      const seats = [...taken(showing, now)].filter(([, seat]) => seat.state === 'held' && seat.by === guest.pub);
      return { seats: seats.map(([id]) => id).sort(bySeat), until: seats.length ? Math.max(...seats.map(([, seat]) => seat.until)) : 0 };
    },

    /**
     * A guest chooses seats. With `toggle`, that one seat is taken or let go (a tap, with
     * JavaScript). Without it, the guest's seats become exactly the ticked ones (the plain form).
     * All or nothing: if any seat they want has gone, nothing changes. Nothing here awaits before
     * the writes are stored, so two guests asking for the same seat can't both get it.
     */
    async choose(guest, formData) {
      if (!guest) return { error: 'Open the showing again to choose seats.' };
      const showing = showings.get(String(formData.get('showing') ?? ''));
      if (!showing) return { error: 'That showing is gone.' };
      const valid = seatIds.get(showing.auditorium);
      const now = Date.now();
      const seats = taken(showing.id, now);
      const mine = new Set([...seats].filter(([, seat]) => seat.state === 'held' && seat.by === guest.pub).map(([id]) => id));

      const toggle = String(formData.get('toggle') ?? '');
      let want;
      if (toggle) {
        if (!valid.has(toggle)) return { error: 'No such seat.', seat: toggle };
        want = new Set(mine);
        if (!want.delete(toggle)) want.add(toggle);
      } else {
        want = new Set(formData.getAll('seat').map(String));
        for (const seat of want) if (!valid.has(seat)) return { error: 'No such seat.', seat };
      }
      if (want.size > MAX_SEATS) return { error: `You can hold up to ${MAX_SEATS} seats at once.`, seat: toggle };
      for (const seat of want) {
        if (!mine.has(seat) && seats.has(seat)) return { error: `Seat ${seat} was just taken.`, seat };
      }

      const until = want.size ? now + holdMs : 0;
      const writes = [];
      for (const seat of want) writes.push(write('seats', `${showing.id}/${seat}`, { state: 'held', by: guest.pub, until }));
      for (const seat of mine) if (!want.has(seat)) writes.push(write('seats', `${showing.id}/${seat}`, { state: 'free', by: '', until: 0 }));
      const list = [...want].sort(bySeat);
      writes.push(write('holds', `${showing.id}/${guest.pub}`, { seats: list, until }));
      await Promise.all(writes);
      return { ok: true, seats: list, until };
    },

    close() {
      clearInterval(timer);
      log.close();
    },
  };
}
