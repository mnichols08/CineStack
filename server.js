// CineStack: a movie theatre on one small Node server.
//
// - Pages are rendered here by @zubra/server and hydrated in the browser.
// - Seats are Sync documents (@zubra/sync) that only the server writes, so every phone looking
//   at a showing sees a seat change the moment it happens.
// - Choosing seats is a 'use server' function (@zubra/actions): a plain form post, with or
//   without JavaScript. The box office (src/box-office.js) decides who gets a seat.
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { createActions } from '@zubra/actions';
import { createBoxOffice } from './src/box-office.js';
import { sessions } from './src/session.js';
import { layout, escape } from './src/layout.js';

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, 'src', 'components');

const time = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export async function createApp({ db = join(process.env.DATA_DIR ?? here, 'cinestack.db'), cache = true, secret = process.env.SESSION_SECRET, holdMs, sweepMs } = {}) {
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new Error('Set SESSION_SECRET.');
    secret = 'cinestack-development-only';
  }
  const boxOffice = createBoxOffice({ db, holdMs, sweepMs });
  const session = sessions({ secret });
  const zubra = createZubra({ components, cache });
  const actions = await createActions({
    components,
    context: ({ request }) => ({ boxOffice, guest: session.fromRequest(request) }),
  });

  function send(res, status, html) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  const page = (res, p, title, body) => send(res, 200, p.finish(layout({ title, theatre: boxOffice.theatre, body, actionsScript: actions.script() })));

  function home(p) {
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
    return `<section><h1>Tonight</h1><p class="lede">Pick a time to choose your seats.</p></section><ul class="films">${cards.join('')}</ul>`;
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
${p.render('seat-map', { showing: showing.id, me: guest.pub, rows, seatsNow: held.seats, untilNow: held.until, holdMinutes: Math.round(boxOffice.holdMs / 60_000) })}`;
  }

  const server = createServer(async (req, res) => {
    try {
      if (await boxOffice.sync.handle(req, res)) return;
      if (await actions.handle(req, res)) return;
      if (zubra.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      const guest = session.ensure(req, res);
      // Without JavaScript, an action's answer comes back once in a cookie.
      const result = actions.result(req, (name, value) => res.appendHeader(name, value));
      const problem = result?.value?.error ?? (result?.error ? 'That didn’t go through. Try again.' : '');
      const p = zubra.page();

      if (url.pathname === '/') return page(res, p, 'Tonight', home(p));
      const match = url.pathname.match(/^\/show\/([\w-]+)$/);
      const showing = match && boxOffice.showing(match[1]);
      if (showing) return page(res, p, boxOffice.film(showing.film).title, show(p, showing, guest, problem));
      send(res, 404, 'Not found');
    } catch (error) {
      console.error(error);
      if (!res.headersSent) send(res, 500, 'Something went wrong.');
      else res.end();
    }
  });

  server.on('close', () => boxOffice.close());
  return Object.assign(server, { boxOffice });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const server = await createApp();
  server.listen(port, '0.0.0.0', () => console.log(`CineStack on http://localhost:${port}`));
}
