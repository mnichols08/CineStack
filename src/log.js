// The Sync log, kept as the current value of every field instead of every change ever made.
//
// @zubra/sync's server takes any `{ append, after }` log. Seats are held and let go all evening,
// so an append-only log would grow with every tap and every new phone would replay all of it.
// This one keeps one row per field (the write with the latest clock, the rule every device
// applies) and gives each accepted write the next sequence number. A device asking for what came
// after its cursor gets each field's latest value once, which is all last-writer-wins needs.
//
// Because the rows are the documents, the server reads current state straight from here, and
// `apply` is synchronous: a check followed by a write, with no `await` between, can't be
// interleaved with another request.
import { DatabaseSync } from 'node:sqlite';

export function fieldLog(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS fields (
      collection TEXT NOT NULL,
      key TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT,
      clock TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (collection, key, field)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fields_seq ON fields (seq);
  `);
  let seq = Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM fields').get().seq);
  const known = db.prepare('SELECT clock FROM fields WHERE collection = ? AND key = ? AND field = ?');
  const upsert = db.prepare(`INSERT INTO fields (collection, key, field, value, clock, seq) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (collection, key, field) DO UPDATE SET value = excluded.value, clock = excluded.clock, seq = excluded.seq`);
  const since = db.prepare('SELECT collection, key, field, value, clock, seq FROM fields WHERE seq > ? ORDER BY seq LIMIT ?');
  const one = db.prepare('SELECT field, value FROM fields WHERE collection = ? AND key = ?');
  const under = db.prepare('SELECT key, field, value FROM fields WHERE collection = ? AND substr(key, 1, ?) = ? ORDER BY key');
  const whole = db.prepare('SELECT key, field, value FROM fields WHERE collection = ? ORDER BY key');
  const latestClock = db.prepare('SELECT COALESCE(MAX(clock), \'\') AS clock FROM fields');

  /** Take one change if it is newer than what is stored. True when it was taken. */
  function apply({ collection, key, field, value, clock }) {
    const stored = known.get(collection, key, field);
    if (stored && stored.clock >= clock) return false;
    upsert.run(collection, key, field, JSON.stringify(value ?? null), clock, ++seq);
    return true;
  }

  const gather = (rows) => {
    const docs = new Map();
    for (const { key, field, value } of rows) {
      if (!docs.has(key)) docs.set(key, { key });
      docs.get(key)[field] = JSON.parse(value);
    }
    return [...docs.values()];
  };

  return {
    apply,
    async append(changes) {
      for (const change of changes) apply(change);
      return seq;
    },
    async after(cursor, limit = 1000) {
      const from = Number(cursor) || 0;
      const rows = since.all(from, limit);
      return {
        changes: rows.map(({ collection, key, field, value, clock }) => ({ collection, key, field, value: JSON.parse(value), clock })),
        cursor: rows.length ? Number(rows[rows.length - 1].seq) : from,
      };
    },
    /** One document's fields, or null. */
    get(collection, key) {
      const rows = one.all(collection, key);
      return rows.length ? Object.fromEntries(rows.map(({ field, value }) => [field, JSON.parse(value)])) : null;
    },
    /** Every document in `collection` whose key starts with `prefix`, as `{ key, ...fields }`. */
    under: (collection, prefix = '') => gather(prefix ? under.all(collection, prefix.length, prefix) : whole.all(collection)),
    /** The latest clock stored, so the server's own clock starts after it. */
    latestClock: () => latestClock.get().clock,
    get size() {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM fields').get().n);
    },
    close: () => db.close(),
  };
}
