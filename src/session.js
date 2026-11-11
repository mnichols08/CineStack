// Who a guest is, without an account: a random id in a signed cookie, set on their first page.
// Seats are held for that id. Other guests only ever see `pub`, a one-way name for it, so nobody
// can act as someone else by reading the seat map.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'cs_guest';

export function sessions({ secret }) {
  const mac = (value) => createHmac('sha256', secret).update(value).digest('base64url');
  const pub = (id) => createHmac('sha256', secret).update(`pub:${id}`).digest('hex').slice(0, 12);

  function read(cookieHeader = '') {
    const raw = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!raw) return null;
    const [id, sig] = decodeURIComponent(raw).split('.');
    if (!id || !sig) return null;
    const expected = Buffer.from(mac(id));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { id, pub: pub(id) };
  }

  return {
    read,
    /** The guest on a fetch-style Request (actions, sync). */
    fromRequest: (request) => read(request.headers.get('cookie') ?? ''),
    /** The guest on a Node request; a new one gets a cookie through `setHeader`. */
    ensure(req, res) {
      const known = read(req.headers.cookie ?? '');
      if (known) return known;
      const id = randomBytes(12).toString('base64url');
      res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(`${id}.${mac(id)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
      return { id, pub: pub(id) };
    },
  };
}
