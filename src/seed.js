// The theatre CineStack starts with. Everything here is data a manager will edit from the admin
// panel (a later milestone); nothing else in the app knows how many auditoriums there are.
//
// Modelled on Garrett 8 Cinemas' public details. Seat counts, layouts and equipment are not
// published, so those are placeholders, and so are the film titles until the film lookup exists.

/**
 * A seat layout as a grid: rows of cells, where a cell is a seat or a gap (an aisle).
 * `rows`: how many; `seats`: seats per row; `aisles`: seat numbers an aisle follows;
 * `wheelchair`: seat ids that are wheelchair spaces; `companion`: the seats beside them;
 * `recliners`: row labels that are recliners.
 */
export function grid({ rows, seats, aisles = [], wheelchair = [], companion = [], recliners = [] }) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, as on real seat plans
  return Array.from({ length: rows }, (_, r) => {
    const label = letters[r];
    const cells = [];
    for (let n = 1; n <= seats; n++) {
      const id = `${label}${n}`;
      const kind = wheelchair.includes(id) ? 'wheelchair' : companion.includes(id) ? 'companion' : recliners.includes(label) ? 'recliner' : 'standard';
      cells.push({ id, number: n, kind });
      if (aisles.includes(n)) cells.push({ id: `${label}-aisle-${n}`, gap: true });
    }
    return { label, cells };
  });
}

export const theatre = {
  id: 'garrett8',
  name: 'Garrett 8 Cinemas',
  town: 'Deep Creek Lake, Maryland',
  address: '19741 Garrett Highway, Deep Creek Lake, MD 21550',
  concept: 'Concept for Garrett 8 Cinemas by Potomac Solutions. Not the theatre’s website; nothing here is really for sale.',
};

export const auditoriums = [
  { id: '1', name: 'Auditorium 1', specs: ['Laser projection', 'Dolby Atmos'], layout: grid({ rows: 11, seats: 20, aisles: [5, 15], wheelchair: ['L5', 'L16'], companion: ['L4', 'L17'], recliners: ['J', 'K'] }) },
  { id: '2', name: 'Auditorium 2', specs: ['Heated recliners', '7.1 surround'], layout: grid({ rows: 6, seats: 10, aisles: [5], wheelchair: ['F1'], companion: ['F2'], recliners: ['A', 'B', 'C', 'D', 'E', 'F'] }) },
  { id: '3', name: 'Auditorium 3', specs: ['3D', '7.1 surround'], layout: grid({ rows: 9, seats: 16, aisles: [4, 12], wheelchair: ['J4', 'J13'], companion: ['J3', 'J14'] }) },
  { id: '4', name: 'Auditorium 4', specs: ['Laser projection', 'Dolby Atmos'], layout: grid({ rows: 9, seats: 16, aisles: [4, 12], wheelchair: ['J4', 'J13'], companion: ['J3', 'J14'] }) },
  { id: '5', name: 'Auditorium 5', specs: ['5.1 surround'], layout: grid({ rows: 8, seats: 14, aisles: [7], wheelchair: ['H1', 'H14'], companion: ['H2', 'H13'] }) },
  { id: '6', name: 'Auditorium 6', specs: ['5.1 surround'], layout: grid({ rows: 8, seats: 14, aisles: [7], wheelchair: ['H1', 'H14'], companion: ['H2', 'H13'] }) },
  { id: '7', name: 'Auditorium 7', specs: ['5.1 surround'], layout: grid({ rows: 7, seats: 12, aisles: [6], wheelchair: ['G1'], companion: ['G2'] }) },
  { id: '8', name: 'Auditorium 8', specs: ['Screening room', 'Private hire'], layout: grid({ rows: 5, seats: 8, aisles: [4], wheelchair: ['E1'], companion: ['E2'] }) },
];

// Placeholder programme. Real titles, posters and trailers arrive with the film lookup.
export const films = [
  { id: 'night-ferry', title: 'Night Ferry', rating: 'PG-13', minutes: 112, label: 'Staff Pick' },
  { id: 'paper-lanterns', title: 'Paper Lanterns', rating: 'PG', minutes: 98, label: '' },
  { id: 'the-quiet-mile', title: 'The Quiet Mile', rating: 'R', minutes: 127, label: '' },
  { id: 'backbone-mountain', title: 'Backbone Mountain', rating: 'NR', minutes: 84, label: 'Local Filmmaker Spotlight' },
];

/** Tonight's showings: each auditorium runs one film at three times. */
export function showings(day = new Date()) {
  const date = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
  const times = [
    [16, 0],
    [18, 45],
    [21, 30],
  ];
  return auditoriums.flatMap((auditorium, a) =>
    times.map(([hour, minute], t) => {
      const starts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute + a * 5);
      return {
        id: `${date}-${auditorium.id}-${String(hour).padStart(2, '0')}${String(minute + a * 5).padStart(2, '0')}`,
        auditorium: auditorium.id,
        film: films[(a + t) % films.length].id,
        starts: starts.getTime(),
      };
    }),
  );
}
