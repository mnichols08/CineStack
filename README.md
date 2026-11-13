# CineStack

A movie theatre on one small Node server: showtimes, seats, tickets and the door, and (next) snacks and the manager's admin panel. Built with [Zubra](https://github.com/journey-to-code-org/zubra).

The first theatre configured in it is a concept for Garrett 8 Cinemas. It is not the theatre's website, and nothing in it is really for sale.

## What works today

Choosing seats for a showing, paying for them, getting a ticket, and being let in at the door.

- Every seat is a real checkbox in a form, so it works without JavaScript, with a keyboard and with a screen reader.
- With JavaScript, a tap holds the seat at once, and everyone else looking at the showing sees it go without reloading.
- Two people who tap the same seat at the same moment: the server gives it to one and tells the other.
- A hold lasts five minutes. When it runs out, the server lets the seat go and every phone sees it come back.
- Held seats show a **Book** button with the total. Paying is one form (test mode: no money moves; card `4000 0000 0000 0002` is declined). Once paid, the seats are sold for everyone, and the guest gets a ticket page with a QR code for the door.
- A declined card books nothing and keeps the seats held, to try another card. A hold that runs out before paying books nothing.
- **The door** (`/staff/door`) scans a ticket once. A photo of the ticket's code (on a phone, the photo picker opens the camera) is decoded in the browser by symbology's WebAssembly decoder, or the code can be typed, with or without JavaScript. The door sees what to let in: the film, time, auditorium and seats, never who booked. A second scan says when the ticket was first used, and two doors scanning at the same moment let it in once. The guest's ticket page shows "Used at 7:41 PM" as it happens.
- **Staff accounts** are the Potomac kit's `staff` and `staff/pages`. A new theatre prints a one-time link for its first owner when the server starts; the owner invites the rest from **People**, with a link for each that works once. Passwords are hashed with scrypt, sessions can be ended, five wrong passwords lock an email for fifteen minutes, and none of it is ever in a page's Sync scope.
- A page reads only what it shows: every showing's seats and holds, and the guest's own tickets. Bookings, payments and other guests' tickets (with their names and emails) never leave the server.
- Every seat costs $11.00 for now. Price rules (adult, child, matinee, discount day, 3D) come in the prices milestone.

## Try it

`npm install`, then `npm start`, and open http://localhost:3000. Two browser windows side by side (one of them private, so it's another guest) show the live parts best.

1. **Pick a showing** from Tonight. Tap a few seats. In the other window, open the same showing: your seats show as taken there, and change as you tap.
2. **Book.** The bar under the map says what you hold and the total. Press **Book**, fill in a name and email, and pay with any card number (`4000 0000 0000 0002` is declined, to see that). You get a ticket with a QR code, and your seats are sold for everyone.
3. **Find it again.** Your tickets are listed at the top of Tonight.
4. **At the door.** In the other window, open **The door (staff)** from the footer and sign in with the owner account (set it up from the link the server printed at start). Type the code from the ticket's address (`/ticket/<code>`), or, on a phone, choose a photo and take one of the ticket. It says **Admit**, and the guest's ticket says **Used at** without a reload. Scan it again: **Already used**, with the time.
5. **Without JavaScript** (turn it off in the browser's settings), seats are checkboxes with a button, and booking and the door work the same.

Every seat is $11.00 for now. Prices, snacks, trailers, the lobby boards and the manager's admin are the next milestones (`plan/roadmap-theatre.md` in the planning project).

## How it is put together

| Piece | Job |
| --- | --- |
| `@zubra/server` | Renders each page, seats included, before any JavaScript runs |
| `@zubra/actions` | `choose` in `seat-chart.zb` is a `'use server'` function: a plain form post, or a fetch |
| `@zubra/sync` | Each seat is a document only the server writes; phones follow it live |
| [Potomac kit](https://github.com/Potomac-Solutions/kit) (private) | `hold` (who gets a seat, and when a hold ends), `reserve` (seats held at a showing as a draft, priced, then paid once and sold), `pay` (charged at most once; its test provider) and `stages` (a ticket: booked, then scanned). The payment page is the kit's `checkout-form`, loaded from the package |
| [symbology](https://github.com/journey-to-code-org/symbology) | Draws the ticket's QR code (the ticket's key) on the server, and decodes it at the door in the browser (`src/door.js`) |
| `src/box-office.js` | The theatre's side: which seats and showings exist, the guest's draft, and the words |
| `src/log.js` | The Sync log in one SQLite table, one row per field |
| `src/seed.js` | The theatre, its auditoriums and their seat layouts, as data |

## Run it

```sh
npm install      # needs read access to the private Potomac-Solutions/kit repository
npm start        # http://localhost:3000
npm test         # needs Chrome or Playwright's Chromium
```

Node 22.13 or later. `SESSION_SECRET` is required in production; `DATA_DIR` says where the database file goes. Behind a proxy (Railway, Fly, a load balancer), set `TRUST_PROXIES` to how many add to `X-Forwarded-For` (usually `1`), so a wrong-password lockout falls on the device guessing and not on everyone; left unset, no header is trusted and every sign-in counts as the proxy's address.

Relative component imports work on Windows from Zubra 5.10.2 (the compiler keyed them by `/` paths only; CineStack patched it until the fix shipped).

To check every showing link and its seat components without a browser:

```sh
node --test test/navigation.test.js
```
