# CineStack

A movie theatre on one small Node server: showtimes, seats, and (next) snacks, tickets and the manager's admin panel. Built with [Zubra](https://github.com/journey-to-code-org/zubra).

The first theatre configured in it is a concept for Garrett 8 Cinemas. It is not the theatre's website, and nothing in it is really for sale.

## What works today

Choosing seats for a showing.

- Every seat is a real checkbox in a form, so it works without JavaScript, with a keyboard and with a screen reader.
- With JavaScript, a tap holds the seat at once, and everyone else looking at the showing sees it go without reloading.
- Two people who tap the same seat at the same moment: the server gives it to one and tells the other.
- A hold lasts five minutes. When it runs out, the server lets the seat go and every phone sees it come back.

## How it is put together

| Piece | Job |
| --- | --- |
| `@zubra/server` | Renders each page, seats included, before any JavaScript runs |
| `@zubra/actions` | `choose` in `seat-map.zb` is a `'use server'` function: a plain form post, or a fetch |
| `@zubra/sync` | Each seat is a document only the server writes; phones follow it live |
| `src/box-office.js` | The rules: who gets a seat, and when a hold ends |
| `src/log.js` | The Sync log in one SQLite table, one row per field |
| `src/seed.js` | The theatre, its auditoriums and their seat layouts, as data |

## Run it

```sh
npm install
npm start        # http://localhost:3000
npm test         # needs Chrome or Playwright's Chromium
```

Node 22.13 or later. `SESSION_SECRET` is required in production; `DATA_DIR` says where the database file goes.
