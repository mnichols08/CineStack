import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

for (const cache of [true, false]) {
  test(`showing links render seats and serve browser modules (cache: ${cache})`, async (t) => {
    const app = await createApp({ db: ':memory:', secret: 'test', cache });
    t.after(async () => {
      app.closeAllConnections();
      await new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;

    const home = await fetch(base);
    assert.equal(home.status, 200);
    const html = await home.text();
    const paths = [...new Set([...html.matchAll(/href="(\/show\/[^"]+)"/g)].map((match) => match[1]))];
    assert.equal(paths.length, app.boxOffice.showings().length);
    assert.ok(paths.length > 0);

    for (const path of paths) {
      const response = await fetch(base + path);
      const body = await response.text();
      assert.equal(response.status, 200, `${path}: ${body}`);
      const showing = app.boxOffice.showing(path.slice('/show/'.length));
      const hall = app.boxOffice.hall(showing.auditorium);
      const seats = hall.layout.flatMap((row) => row.cells.filter((cell) => !cell.gap));
      assert.equal([...body.matchAll(/name="seat"/g)].length, seats.length, path);
      assert.match(body, /<seat-map\b/);
      assert.match(body, /<seat-cell\b/);
      assert.match(body, /href="\/"/);
    }

    for (const name of ['seat-map', 'seat-cell']) {
      const response = await fetch(`${base}/_zubra/components/${name}.js`);
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(response.headers.get('content-type'), /text\/javascript/);
      assert.match(body, new RegExp(name));
    }

    const again = await fetch(base + paths[0]);
    assert.equal(again.status, 200, await again.text());
  });
}
