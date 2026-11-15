// The admin pages: tonight at a glance, every ticket, guests' accounts, reports and settings.
//
// Staff see the overview, tonight's showings, tickets and guests. Managers (owners) also see
// reports, the seat price and the outbox, and can turn an account off. Plain HTML and forms.
import { series, totals, breakdown, csv } from '@potomac-solutions/kit/reports';
import { barChart, rankBars } from '@potomac-solutions/kit/charts';
import { escape } from './layout.js';
import { money } from './account.js';

const DAY = 86_400_000;
const PAGE = 25;

export const RANGES = {
  '30d': { label: 'Last 30 days', days: 30, by: 'day' },
  '13w': { label: 'Last 13 weeks', days: 91, by: 'week' },
};

export function createAdmin({ boxOffice, customers, sent, now = Date.now }) {
  const zone = boxOffice.theatre.timeZone;
  const dateTime = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }) : '');
  const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
  const short = (start, by) => new Date(`${start}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + (by === 'month' ? '' : '');
  const option = (v, words, current) => `<option value="${escape(v)}"${current === v ? ' selected' : ''}>${escape(words)}</option>`;
  const pageOf = (url) => Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pager = (url, base, count, page) => {
    const pages = Math.max(1, Math.ceil(count / PAGE));
    const at = (n) => {
      const next = new URLSearchParams(url.searchParams);
      next.set('page', String(n));
      return `${base}?${next}`;
    };
    return pages > 1 ? `<p class="pager">${page > 1 ? `<a href="${escape(at(page - 1))}">Newer</a>` : ''}<span>Page ${page} of ${pages}</span>${page < pages ? `<a href="${escape(at(page + 1))}">Older</a>` : ''}</p>` : '';
  };
  const seats = (ticket) => (ticket.units ?? []).length;
  const percent = (share) => `${Math.round(share * 100)}%`;
  const soldAt = (ticket) => ticket.booked ?? ticket.at ?? ticket.starts;

  function nav(here, owner) {
    const link = (href, words) => `<a href="${href}"${here === href ? ' aria-current="page"' : ''}>${words}</a>`;
    return `<nav class="admin-nav" aria-label="Admin"><small>Theatre</small>${link('/admin', 'Tonight')}${link('/admin/tickets', 'Tickets')}${link('/admin/guests', 'Guests')}${link('/staff/door', 'The door')}${
      owner ? `<small>Manager</small>${link('/admin/reports', 'Reports')}${link('/admin/settings', 'Settings')}${link('/staff/people', 'Staff')}${link('/admin/outbox', 'Outbox')}` : ''
    }</nav>`;
  }
  const frame = (here, owner, bar, body) => `<div class="admin">${nav(here, owner)}<div class="admin-body">${bar}${body}</div></div>`;
  const ticketRows = (list) =>
    list.length
      ? `<div class="table-wrap"><table><thead><tr><th scope="col">Showing</th><th scope="col">Film</th><th scope="col">Seats</th><th scope="col">Guest</th><th scope="col">Status</th><th scope="col" class="num">Paid</th></tr></thead><tbody>${list
          .map((ticket) => `<tr><td>${dateTime(ticket.starts)}<br><small class="muted">${escape(ticket.hall?.name ?? '')}</small></td><td>${escape(ticket.film?.title ?? '')}</td><td>${escape((ticket.units ?? []).join(', '))}</td><td>${escape(ticket.name || 'Guest')}${ticket.customer ? ` <a class="muted" href="/admin/guests/${escape(ticket.customer)}">(account)</a>` : ''}<br><small class="muted">${escape(ticket.email ?? '')}</small></td><td><span class="badge ${ticket.status === 'scanned' ? 'past' : 'booked'}">${ticket.status === 'scanned' ? `In at ${clock(ticket.scanned)}` : 'Booked'}</span></td><td class="num">${money(ticket.cents ?? 0)}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '<p>None.</p>';

  function filterTickets(url) {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
    const film = url.searchParams.get('film') ?? '';
    const when = url.searchParams.get('when') ?? 'tonight';
    return boxOffice.allTickets().filter((ticket) => (!film || ticket.film?.id === film) && (when === 'all' || (when === 'tonight' ? ticket.tonight : !ticket.tonight)) && (!q || [ticket.key, ticket.name, ticket.email, ...(ticket.units ?? [])].some((field) => String(field ?? '').toLowerCase().includes(q))));
  }

  return {
    dashboard({ who, owner, bar }) {
      const at = now();
      const all = boxOffice.allTickets();
      const tonight = boxOffice.occupancy();
      const capacity = tonight.reduce((n, one) => n + one.seats, 0);
      const sold = tonight.reduce((n, one) => n + one.sold, 0);
      const last30 = all.filter((ticket) => soldAt(ticket) > at - 30 * DAY);
      const before30 = all.filter((ticket) => soldAt(ticket) <= at - 30 * DAY && soldAt(ticket) > at - 60 * DAY);
      const revenue = totals(last30, { amount: (ticket) => ticket.cents ?? 0 }).amount;
      const earlier = totals(before30, { amount: (ticket) => ticket.cents ?? 0 }).amount;
      const tonightTickets = all.filter((ticket) => ticket.tonight);
      const days = series(all, { at: soldAt, amount: (ticket) => ticket.cents ?? 0, by: 'day', zone, from: at - 29 * DAY, to: at });
      const activity = boxOffice.activity(8);
      return frame(
        '/admin',
        owner,
        bar,
        `<section><h1>Tonight</h1><p class="lede">${escape(boxOffice.theatre.name)}. Good to see you, ${escape(who.name.split(' ')[0])}.</p></section>
<div class="tiles">
  <div class="tile"><span>Seats sold tonight</span><strong>${sold}</strong><small>${percent(capacity ? sold / capacity : 0)} of ${capacity}</small></div>
  <div class="tile"><span>Through the door</span><strong>${tonightTickets.filter((ticket) => ticket.status === 'scanned').length}</strong><small>of ${tonightTickets.length} tickets booked online</small></div>
  <div class="tile"><span>Box office, last 30 days</span><strong>${money(revenue)}</strong><small>${earlier ? `${revenue >= earlier ? '▲' : '▼'} ${Math.abs(Math.round(((revenue - earlier) / earlier) * 100))}% on the 30 days before` : `${last30.length} tickets`}</small></div>
  <div class="tile"><span>Seat price</span><strong>${money(boxOffice.seatPrice())}</strong></div>
  <div class="tile"><span>Guest accounts</span><strong>${customers.list().length}</strong><small>${customers.list().filter((one) => one.at > at - 30 * DAY).length} new in 30 days</small></div>
</div>
<section class="panel"><h2>Tonight’s showings</h2><div class="table-wrap"><table><thead><tr><th scope="col">Time</th><th scope="col">Film</th><th scope="col">Auditorium</th><th scope="col" class="num">Sold</th><th scope="col" class="num">Held</th><th scope="col">Full</th></tr></thead><tbody>${tonight
          .map((one) => `<tr><td><a href="/show/${one.id}">${clock(one.starts)}</a></td><td>${escape(one.film.title)}</td><td>${escape(one.hall.name)}</td><td class="num">${one.sold} of ${one.seats}</td><td class="num">${one.held}</td><td style="min-width:8rem"><span class="rank-track" style="display:block"><span class="rank-bar" style="width:${((one.sold / one.seats) * 100).toFixed(1)}%"></span></span></td></tr>`)
          .join('')}</tbody></table></div></section>
<section class="panel"><h2>Box office by day, last 30 days</h2>${barChart(days.map((b) => ({ label: short(b.start, 'day'), value: b.amount, tip: `${short(b.start, 'day')}: ${money(b.amount)} from ${b.count} ticket${b.count === 1 ? '' : 's'}` })), { name: 'Box office', format: money })}${owner ? '<p><a href="/admin/reports">All reports</a></p>' : ''}</section>
<section class="panel"><h2>Staff activity</h2>${activity.length ? `<ul>${activity.map((one) => `<li><strong>${escape(one.by)}</strong> ${escape(one.what)} <small class="muted">${dateTime(one.at)}</small></li>`).join('')}</ul>` : '<p>Nothing yet.</p>'}</section>`,
      );
    },

    tickets({ url, owner, bar }) {
      const list = filterTickets(url);
      const page = pageOf(url);
      const when = url.searchParams.get('when') ?? 'tonight';
      const query = new URLSearchParams(url.searchParams);
      query.delete('page');
      return frame(
        '/admin/tickets',
        owner,
        bar,
        `<section><h1>Tickets</h1><p class="lede">${list.length} ticket${list.length === 1 ? '' : 's'}, ${list.reduce((n, ticket) => n + seats(ticket), 0)} seats, ${money(totals(list, { amount: (ticket) => ticket.cents ?? 0 }).amount)}.</p></section>
<form class="panel filters" method="get" action="/admin/tickets">
  <label>Search<input name="q" value="${escape(url.searchParams.get('q') ?? '')}" placeholder="Name, email, seat or code"></label>
  <label>When<select name="when">${option('tonight', 'Tonight', when)}${option('past', 'Earlier', when)}${option('all', 'All', when)}</select></label>
  <label>Film<select name="film">${option('', 'Any', url.searchParams.get('film') ?? '')}${boxOffice.films().map((film) => option(film.id, film.title, url.searchParams.get('film'))).join('')}</select></label>
  <button type="submit">Show</button>
  <a class="button light" href="/admin/tickets.csv?${escape(String(query))}">Download CSV</a>
</form>
<section class="panel">${ticketRows(list.slice((page - 1) * PAGE, page * PAGE))}${pager(url, '/admin/tickets', list.length, page)}</section>`,
      );
    },

    ticketsCsv(url) {
      return csv(filterTickets(url), [
        { key: 'key', label: 'Ticket' },
        { key: 'starts', label: 'Showing', value: (ticket) => new Date(ticket.starts).toISOString() },
        { key: 'film', label: 'Film', value: (ticket) => ticket.film?.title },
        { key: 'hall', label: 'Auditorium', value: (ticket) => ticket.hall?.name },
        { key: 'units', label: 'Seats', value: (ticket) => (ticket.units ?? []).join(' ') },
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'status', label: 'Status' },
        { key: 'cents', label: 'Paid (USD)', value: (ticket) => (ticket.cents ?? 0) / 100 },
      ]);
    },

    guests({ url, owner, bar }) {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
      const all = boxOffice.allTickets();
      const list = customers.list().filter((one) => !q || one.name.toLowerCase().includes(q) || one.email.includes(q));
      const page = pageOf(url);
      return frame(
        '/admin/guests',
        owner,
        bar,
        `<section><h1>Guests</h1><p class="lede">${customers.list().length} with accounts. Anyone can also book without one.</p></section>
<form class="panel filters" method="get" action="/admin/guests"><label>Search<input name="q" value="${escape(url.searchParams.get('q') ?? '')}" placeholder="Name or email"></label><button type="submit">Show</button><a class="button light" href="/admin/guests.csv">Download CSV</a></form>
<section class="panel"><div class="table-wrap"><table><thead><tr><th scope="col">Guest</th><th scope="col">Joined</th><th scope="col" class="num">Visits</th><th scope="col" class="num">Spent</th></tr></thead><tbody>${list
          .slice((page - 1) * PAGE, page * PAGE)
          .map((one) => {
            const theirs = all.filter((ticket) => ticket.customer === one.customer);
            return `<tr><td><a href="/admin/guests/${escape(one.customer)}">${escape(one.name)}</a>${one.disabled ? ' <span class="badge off">Off</span>' : ''}<br><small class="muted">${escape(one.email)}</small></td><td>${dateTime(one.at)}</td><td class="num">${theirs.length}</td><td class="num">${money(totals(theirs, { amount: (ticket) => ticket.cents ?? 0 }).amount)}</td></tr>`;
          })
          .join('')}</tbody></table></div>${pager(url, '/admin/guests', list.length, page)}</section>`,
      );
    },

    guestsCsv() {
      const all = boxOffice.allTickets();
      return csv(customers.list(), [
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'at', label: 'Joined', value: (one) => new Date(one.at).toISOString() },
        { key: 'disabled', label: 'Turned off', value: (one) => (one.disabled ? 'yes' : 'no') },
        { key: 'visits', label: 'Visits', value: (one) => all.filter((ticket) => ticket.customer === one.customer).length },
      ]);
    },

    guest({ one, owner, bar, said }) {
      const tickets = boxOffice.allTickets().filter((ticket) => ticket.customer === one.customer);
      return frame(
        '/admin/guests',
        owner,
        bar,
        `<section><a href="/admin/guests">All guests</a><h1>${escape(one.name)}</h1><p class="lede">${escape(one.email)} · joined ${dateTime(one.at)}${one.disabled ? ' · <span class="badge off">Turned off</span>' : ''}</p></section>
${said}
<div class="tiles"><div class="tile"><span>Visits</span><strong>${tickets.length}</strong></div><div class="tile"><span>Spent</span><strong>${money(totals(tickets, { amount: (ticket) => ticket.cents ?? 0 }).amount)}</strong></div><div class="tile"><span>Saw most</span><strong>${escape(breakdown(tickets, { key: (ticket) => ticket.film?.title ?? '' })[0]?.key ?? '—')}</strong></div></div>
<section class="panel"><h2>Tickets</h2>${ticketRows(tickets)}</section>
${
  owner
    ? `<section class="panel"><h2>Account</h2><p>Turning an account off signs it out everywhere; its tickets stay valid at the door.</p><div class="filters"><form method="post" action="/admin/guests/${escape(one.customer)}/disabled"><input type="hidden" name="disabled" value="${one.disabled ? 'no' : 'yes'}"><button type="submit" class="${one.disabled ? '' : 'button light'}">${one.disabled ? 'Turn back on' : 'Turn off'}</button></form>${one.disabled ? '' : `<form method="post" action="/admin/guests/${escape(one.customer)}/reset"><button class="button light" type="submit">Email a reset link</button></form>`}</div></section>`
    : ''
}`,
      );
    },

    report(url) {
      const key = RANGES[url.searchParams.get('range')] ? url.searchParams.get('range') : '30d';
      const { days, by, label } = RANGES[key];
      const to = now();
      const from = to - (days - 1) * DAY;
      const tickets = boxOffice.allTickets().filter((ticket) => ticket.starts >= from && ticket.starts <= to);
      return { key, by, label, from, to, tickets, buckets: series(tickets, { at: (ticket) => ticket.starts, amount: (ticket) => ticket.cents ?? 0, by, zone, from, to }) };
    },

    reports({ url, owner, bar }) {
      const r = this.report(url);
      const sum = totals(r.tickets, { amount: (ticket) => ticket.cents ?? 0 });
      const seatCount = r.tickets.reduce((n, ticket) => n + seats(ticket), 0);
      const byFilm = breakdown(r.tickets, { key: (ticket) => ticket.film?.title ?? '?', amount: (ticket) => ticket.cents ?? 0 }).sort((a, b) => b.amount - a.amount);
      const byHall = breakdown(r.tickets, { key: (ticket) => ticket.hall?.name ?? '?', amount: (ticket) => seats(ticket) });
      const slots = ['Matinee (before 5 pm)', 'Early evening (5 to 8 pm)', 'Late (after 8 pm)'];
      const slotOf = (ms) => {
        const hour = Number(new Date(ms).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: zone }));
        return hour < 17 ? slots[0] : hour < 20 ? slots[1] : slots[2];
      };
      const bySlot = slots.map((label) => ({ label, value: r.tickets.filter((ticket) => slotOf(ticket.starts) === label).reduce((n, ticket) => n + seats(ticket), 0) }));
      const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, i) => ({ label, value: r.tickets.filter((ticket) => new Date(ticket.starts).toLocaleDateString('en-US', { weekday: 'short', timeZone: zone }) === label).reduce((n, ticket) => n + seats(ticket), 0) }));
      const capacityPerNight = boxOffice.occupancy().reduce((n, one) => n + one.seats, 0);
      const nights = Math.max(1, Math.round((r.to - r.from) / DAY));
      return frame(
        '/admin/reports',
        owner,
        bar,
        `<section><h1>Reports</h1><p class="lede">${r.label}, by ${r.by}, in the theatre’s time (${escape(zone)}). Counted on the night of each showing.</p></section>
<div class="panel filters" role="group" aria-label="Range">${Object.entries(RANGES).map(([k, one]) => `<a class="button${k === r.key ? '' : ' light'}" href="?range=${k}"${k === r.key ? ' aria-current="true"' : ''}>${one.label}</a>`).join('')}</div>
<div class="tiles">
  <div class="tile"><span>Box office</span><strong>${money(sum.amount)}</strong></div>
  <div class="tile"><span>Tickets</span><strong>${sum.count}</strong><small>${seatCount} seats</small></div>
  <div class="tile"><span>Seats per booking</span><strong>${sum.count ? (seatCount / sum.count).toFixed(1) : '—'}</strong></div>
  <div class="tile"><span>Booked online</span><strong>${percent(capacityPerNight ? seatCount / (capacityPerNight * nights) : 0)}</strong><small>of every seat, every showing; walk-ups not counted</small></div>
</div>
<section class="panel"><h2>Box office by ${r.by}</h2>${barChart(r.buckets.map((b) => ({ label: short(b.start, r.by), value: b.amount, tip: `${short(b.start, r.by)}: ${money(b.amount)} from ${b.count} tickets` })), { name: 'Box office', format: money })}<p><a class="button light" href="/admin/reports.csv?range=${r.key}">Download CSV</a></p></section>
<section class="two">
  <div class="panel"><h2>By film</h2>${byFilm.length ? rankBars(byFilm.map((row) => ({ label: row.key, value: row.amount })), { format: money }) : '<p>None.</p>'}<h2>Seats by auditorium</h2>${byHall.length ? rankBars(byHall.map((row) => ({ label: row.key, value: row.amount }))) : '<p>None.</p>'}</div>
  <div class="panel"><h2>Seats by time of night</h2>${rankBars(bySlot)}<h2>Seats by day of the week</h2>${rankBars(weekday)}</div>
</section>`,
      );
    },

    reportCsv(url) {
      const r = this.report(url);
      return csv(r.buckets, [
        { key: 'start', label: r.by === 'day' ? 'Night' : 'Week starting' },
        { key: 'count', label: 'Tickets' },
        { key: 'amount', label: 'Box office (USD)', value: (b) => b.amount / 100 },
      ]);
    },

    settings({ owner, bar, said }) {
      return frame(
        '/admin/settings',
        owner,
        bar,
        `<section><h1>Settings</h1><p class="lede">The seat price applies to seats chosen from now on; tickets already bought keep theirs.</p></section>
${said}
<form class="panel" method="post" action="/admin/settings"><h2>Seat price</h2><label>Every seat, every showing ($)<input name="price" inputmode="decimal" required value="${(boxOffice.seatPrice() / 100).toFixed(2)}"></label><button type="submit">Save</button></form>`,
      );
    },

    outbox({ owner, bar }) {
      const list = [...sent].reverse();
      return frame(
        '/admin/outbox',
        owner,
        bar,
        `<section><h1>Outbox</h1><p class="lede">This demo sends no real email. What it would have sent since the server started is here, newest first.</p></section>
<section class="panel">${list.length ? list.map((message) => `<article class="stack" style="border-top:1px solid var(--border);padding-top:0.75rem"><p><strong>${escape(message.subject)}</strong><br><small class="muted">To ${escape(message.to)}</small></p><pre style="white-space:pre-wrap;margin:0">${escape(message.body)}</pre></article>`).join('') : '<p>Nothing sent yet.</p>'}</section>`,
      );
    },
  };
}
