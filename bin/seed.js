// Demo data: a manager and a door hand, forty guest accounts, thirteen weeks of past showings'
// tickets, and tonight's tickets bought the real way, so every admin page and report has
// something to show.
//
//   npm run seed            add to an empty theatre (refuses if it has staff)
//   npm run seed -- --fresh start over: delete the database first
//
// Earlier nights' tickets are written as finished records (scanned at the door). Tonight's go
// through the real box office (seats held, then paid), so the seat maps show them sold.
// The names are made up and every address is @example.com. Run it with the server stopped.
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { showings as showingsOn, auditoriums, SEAT_CENTS } from '../src/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const db = join(process.env.DATA_DIR ?? join(here, '..'), 'cinestack.db');
if (process.argv.includes('--fresh')) for (const file of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(file)) rmSync(file);

export const DEMO = {
  owner: { email: 'manager@example.com', name: 'Iris Holloway', password: 'hemlock-manager-demo' },
  staff: { email: 'door@example.com', name: 'Theo Barnes', password: 'hemlock-door-demo' },
  customer: { email: 'riley@example.com', name: 'Riley Morgan', password: 'hemlock-guest-demo' },
};

let seed = 20261115;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const FIRST = ['Avery', 'Blake', 'Casey', 'Drew', 'Emerson', 'Finley', 'Harper', 'Jamie', 'Kendall', 'Logan', 'Morgan', 'Noah', 'Parker', 'Quinn', 'Reese', 'Sawyer', 'Taylor', 'Peyton', 'Rowan', 'Skyler', 'Elliot', 'Hayden', 'Jordan', 'Kai', 'Lane', 'Micah', 'Sasha', 'Tatum', 'Wren', 'Ari'];
const LAST = ['Abbott', 'Barnes', 'Calloway', 'Dunmore', 'Ellison', 'Fairbanks', 'Garrett', 'Holloway', 'Iverson', 'Jessup', 'Kessler', 'Lowry', 'Marsh', 'Nolan', 'Oakley', 'Pruitt', 'Ramsey', 'Sutton', 'Thayer', 'Underwood', 'Vance', 'Whitaker', 'Yates', 'Zeller'];
const person = () => {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  return { name, email: `${name.toLowerCase().replace(' ', '.')}${Math.floor(random() * 90 + 10)}@example.com` };
};
const DAY = 86_400_000;
const NOW = Date.now();

const server = await createApp({ db, cache: false });
const { boxOffice, staff, customers } = server;
if (!staff.needsOwner()) {
  console.log(`The theatre in ${db} already has staff. Run \`npm run seed -- --fresh\` to start over.`);
  process.exit(1);
}

await staff.accept(await staff.setup(), DEMO.owner);
const manager = staff.list().find((one) => one.email === DEMO.owner.email);
await staff.accept((await staff.invite(manager, { email: DEMO.staff.email, name: DEMO.staff.name, roles: ['staff'] })).token, DEMO.staff);
const door = staff.list().find((one) => one.email === DEMO.staff.email);
const accounts = [];
const riley = await customers.signUp(DEMO.customer);
accounts.push({ id: riley.customer, ...DEMO.customer, at: NOW - 95 * DAY });
for (let i = 0; i < 40; i++) {
  const one = person();
  const made = await customers.signUp({ ...one, password: `demo-password-${i}-${Math.floor(random() * 1e6)}` });
  if (made.ok) accounts.push({ id: made.customer, ...one, at: NOW - Math.floor(random() * 95 + 1) * DAY });
}
for (const one of accounts) await boxOffice.write('customers', one.id, { at: one.at });
await customers.setDisabled(accounts.at(-1).id, true);

// Thirteen weeks of earlier nights: busier at weekends and in the evening, seats in groups.
const seatsIn = new Map(auditoriums.map((a) => [a.id, a.layout.flatMap((row) => row.cells.filter((cell) => !cell.gap).map((cell) => cell.id))]));
let tickets = 0;
for (let back = 91; back >= 1; back--) {
  const day = new Date(NOW - back * DAY);
  const weekend = [0, 5, 6].includes(day.getDay());
  for (const showing of showingsOn(day)) {
    const hour = new Date(showing.starts).getHours();
    const all = seatsIn.get(showing.auditorium);
    const share = (weekend ? 0.04 : 0.018) * (hour >= 18 ? 1.5 : 0.6) * (0.5 + random());
    let want = Math.round(all.length * share);
    let next = Math.floor(random() * all.length);
    while (want > 0) {
      const size = Math.min(want, 1 + Math.floor(Math.pow(random(), 1.6) * 4));
      const units = Array.from({ length: size }, (_, i) => all[(next + i) % all.length]);
      next = (next + size + Math.floor(random() * 6)) % all.length;
      want -= size;
      const booked = showing.starts - Math.floor(random() * 3 * DAY * random()) - 30 * 60_000;
      const known = accounts.slice(0, -1).filter((one) => one.at < booked);
      const who = known.length && random() < 0.4 ? (random() < 0.05 ? accounts[0] : pick(known)) : { ...person(), id: '' };
      const key = `b${booked.toString(36)}${tickets.toString(36)}`;
      await boxOffice.write('tickets', key, {
        holder: `seed-${key}`, customer: who.id ?? '', name: who.name, email: who.email,
        showing: `past-${showing.id}`, film: showing.film, starts: showing.starts, auditorium: showing.auditorium,
        pools: [`past-${showing.id}`], units, lines: units.map((unit) => ({ pool: `past-${showing.id}`, unit, base: SEAT_CENTS, cents: SEAT_CENTS, applied: [] })), cents: units.length * SEAT_CENTS,
        status: random() < 0.97 ? 'scanned' : 'booked', booked, scanned: showing.starts - Math.floor(random() * 25) * 60_000,
      });
      tickets++;
    }
  }
}

// Tonight, the real way: seats held, then paid.
let tonight = 0;
const showings = boxOffice.showings();
for (let i = 0; i < 60; i++) {
  const showing = pick(showings);
  const free = seatsIn.get(showing.auditorium).filter((seat) => !boxOffice.taken(showing.id).has(seat));
  if (free.length < 4) continue;
  const start = Math.floor(random() * (free.length - 4));
  const units = free.slice(start, start + 1 + Math.floor(random() * 3));
  const who = random() < 0.45 ? { ...(i === 3 ? accounts[0] : pick(accounts.slice(0, -1))), account: true } : person();
  const guest = { id: `seed-guest-${i}`, pub: `seedguest${i}`, customer: who.account ? who.id : undefined };
  const form = new URLSearchParams([['showing', showing.id], ...units.map((seat) => ['seat', seat])]);
  const held = await boxOffice.choose(guest, form);
  if (!held.ok) continue;
  const draft = boxOffice.booking(guest, showing.id);
  const done = await boxOffice.book(guest, showing.id, new URLSearchParams({ checkout: draft.key, name: who.name, email: who.email, card: '4242 4242 4242 4242' }));
  if (done.ok) tonight++;
}
await boxOffice.audit(manager, `set the seat price to $${(SEAT_CENTS / 100).toFixed(2)}`);
await boxOffice.audit(door, 'signed in at the door');

console.log(`Seeded ${db}:
  ${accounts.length} guest accounts, ${tickets} tickets from the last thirteen weeks, ${tonight} for tonight.

Sign in (this machine only; these are demo passwords):
  Manager  ${DEMO.owner.email} / ${DEMO.owner.password}   → /admin
  Door     ${DEMO.staff.email} / ${DEMO.staff.password}        → /admin, /staff/door
  Guest    ${DEMO.customer.email} / ${DEMO.customer.password}      → /account

Then: npm start`);
boxOffice.close();
process.exit(0);
