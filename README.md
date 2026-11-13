# CineStack

A movie theatre on one small Node server: showtimes, seats and tickets, and (next) snacks, the door and the manager's admin panel. Built with [Zubra](https://github.com/journey-to-code-org/zubra).

The first theatre configured in it is a concept for Garrett 8 Cinemas. It is not the theatre's website, and nothing in it is really for sale.

## What works today

Choosing seats for a showing, paying for them, and getting a ticket.

- Every seat is a real checkbox in a form, so it works without JavaScript, with a keyboard and with a screen reader.
- With JavaScript, a tap holds the seat at once, and everyone else looking at the showing sees it go without reloading.
- Two people who tap the same seat at the same moment: the server gives it to one and tells the other.
- A hold lasts five minutes. When it runs out, the server lets the seat go and every phone sees it come back.
- Held seats show a **Book** button with the total. Paying is one form (test mode: no money moves; card `4000 0000 0000 0002` is declined). Once paid, the seats are sold for everyone, and the guest gets a ticket page with a QR code for the door.
- A declined card books nothing and keeps the seats held, to try another card. A hold that runs out before paying books nothing.
- Every seat costs $11.00 for now. Price rules (adult, child, matinee, discount day, 3D) come in the prices milestone.

## How it is put together

| Piece | Job |
| --- | --- |
| `@zubra/server` | Renders each page, seats included, before any JavaScript runs |
| `@zubra/actions` | `choose` in `seat-chart.zb` is a `'use server'` function: a plain form post, or a fetch |
| `@zubra/sync` | Each seat is a document only the server writes; phones follow it live |
| [Potomac kit](https://github.com/Potomac-Solutions/kit) (private) | `hold` (who gets a seat, and when a hold ends), `reserve` (seats held at a showing as a draft, priced, then paid once and sold), `pay` (charged at most once; its test provider) and `stages` (a ticket: booked, then scanned). The payment page is the kit's `checkout-form`, loaded from the package |
| [symbology](https://github.com/journey-to-code-org/symbology) | Draws the ticket's QR code (the ticket's key) on the server |
| `src/box-office.js` | The theatre's side: which seats and showings exist, the guest's draft, and the words |
| `src/log.js` | The Sync log in one SQLite table, one row per field |
| `src/seed.js` | The theatre, its auditoriums and their seat layouts, as data |

## Run it

```sh
npm install      # needs read access to the private Potomac-Solutions/kit repository
npm start        # http://localhost:3000
npm test         # needs Chrome or Playwright's Chromium
```

Node 22.13 or later. `SESSION_SECRET` is required in production; `DATA_DIR` says where the database file goes.

Relative component imports work on Windows from Zubra 5.10.2 (the compiler keyed them by `/` paths only; CineStack patched it until the fix shipped).

To check every showing link and its seat components without a browser:

```sh
node --test test/navigation.test.js
```
