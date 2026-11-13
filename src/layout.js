// The page around the components: the theatre's frame, and the connection to the Sync log.
export const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
  :root {
    --background: #14161b; --foreground: #eceef3; --card: #20232b; --border: #333847; --muted-foreground: #9299ab;
    --accent: #ffd166; --seat-mine: var(--accent);
    --primary: var(--accent); --primary-foreground: #1a1c22; --ring: var(--accent); --input: var(--border); --muted: #2a2e38; --radius: 0.75rem;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 1.0625rem; line-height: 1.5; background: var(--background); color: var(--foreground); }
  a { color: inherit; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .concept { margin: 0; padding: 0.45rem 1rem; background: var(--accent); color: #1a1c22; font-size: 0.85rem; font-weight: 600; text-align: center; }
  .site-head { display: flex; align-items: baseline; gap: 1rem; padding: 1rem clamp(1rem, 4vw, 2.5rem); border-bottom: 1px solid var(--border); }
  .site-head a { font-size: 1.35rem; font-weight: 800; letter-spacing: 0.01em; text-decoration: none; }
  .site-head span { color: var(--muted-foreground); font-size: 0.9rem; }
  @media (max-width: 30rem) { .site-head span { display: none; } }
  main { width: min(64rem, 100% - 2 * clamp(1rem, 4vw, 2.5rem)); margin: 0 auto; padding: 2rem 0 5rem; display: grid; gap: 2rem; }
  h1 { margin: 0; font-size: clamp(1.9rem, 5vw, 2.75rem); line-height: 1.1; }
  h2 { margin: 0; font-size: 1.3rem; }
  .lede { margin: 0.4rem 0 0; color: var(--muted-foreground); }
  .films { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); padding: 0; margin: 0; list-style: none; }
  .film { display: grid; gap: 0.6rem; padding: 1.1rem 1.2rem; border-radius: 0.75rem; background: var(--card); box-shadow: 0 0 0 1px var(--border); }
  .film p { margin: 0; color: var(--muted-foreground); font-size: 0.9rem; }
  .tag { color: var(--accent); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .times { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 0; margin: 0; list-style: none; }
  .times a { display: grid; padding: 0.4rem 0.75rem; border-radius: 0.5rem; box-shadow: 0 0 0 1px var(--border); text-decoration: none; font-weight: 700; line-height: 1.25; }
  .times a:hover { box-shadow: 0 0 0 1px var(--accent); }
  .times small { font-weight: 400; color: var(--muted-foreground); }
  .specs { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0; margin: 0.6rem 0 0; list-style: none; }
  .specs li { padding: 0.15rem 0.6rem; border-radius: 999px; box-shadow: 0 0 0 1px var(--border); font-size: 0.85rem; color: var(--muted-foreground); }
  .back { color: var(--muted-foreground); font-size: 0.9rem; }
  .ticket { display: grid; gap: 0.75rem; justify-items: start; }
  .ticket .seats { margin: 0; font-size: 1.15rem; }
  .ticket .qr { width: min(18rem, 100%); padding: 0.75rem; border-radius: 0.75rem; background: #fff; color: #000; }
  .ticket .qr svg { display: block; width: 100%; height: auto; }
  .photo { display: inline-grid; gap: 0.35rem; font-weight: 600; }
  .notice-text:empty { display: none; }
  .notice-text { margin: 0; color: #ffd9dc; }
  .start { font: inherit; font-weight: 700; padding: 0.7rem 1.2rem; border: 0; border-radius: 0.5rem; background: var(--accent); color: #1a1c22; cursor: pointer; }
  .mine { display: grid; gap: 0.6rem; padding: 1rem 1.2rem; border-radius: 0.75rem; background: var(--card); box-shadow: 0 0 0 1px var(--accent); }
  .mine h2 { margin: 0; font-size: 1.1rem; }
  .mine ul { display: grid; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
  .mine a { text-decoration: none; }
  .mine a:hover strong { color: var(--accent); }
  .site-foot { padding: 1.5rem clamp(1rem, 4vw, 2.5rem) 2.5rem; color: var(--muted-foreground); font-size: 0.9rem; }
  .notice { margin: 0; padding: 0.6rem 0.9rem; border-radius: 0.5rem; background: #4a1f24; color: #ffd9dc; }
  /* The kit's staff pages: sign-in, links, people, passwords. */
  .panel { display: grid; gap: 0.9rem; align-content: start; padding: 1.1rem 1.2rem; border-radius: var(--radius); background: var(--card); box-shadow: 0 0 0 1px var(--border); }
  .panel table { width: 100%; border-collapse: collapse; }
  .panel td, .panel th { padding: 0.5rem 0.4rem; border-top: 1px solid var(--border); text-align: left; vertical-align: top; }
  .panel .done { opacity: 0.55; }
  .ok { margin: 0; padding: 0.6rem 0.9rem; border-radius: 0.5rem; background: #183a26; color: #c9f2d8; }
  .bulletin { margin: 0; padding: 0.6rem 0.9rem; border-radius: 0.5rem; background: var(--muted); }
  .hint { margin: 0; color: var(--muted-foreground); font-size: 0.9rem; }
  .row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .inline { display: inline; }
  .panel label { display: grid; gap: 0.3rem; font-weight: 600; }
  .panel input, .panel select { font: inherit; padding: 0.55rem 0.7rem; border-radius: 0.5rem; border: 1px solid var(--border); background: var(--muted); color: inherit; }
  .panel button, .button { font: inherit; font-weight: 700; padding: 0.6rem 1.1rem; border: 0; border-radius: 0.5rem; background: var(--accent); color: #1a1c22; cursor: pointer; text-decoration: none; justify-self: start; }
  .button.light { background: var(--muted); color: var(--foreground); padding: 0.3rem 0.7rem; }
`;

export function layout({ title, theatre, body, actionsScript = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escape(title)} · ${escape(theatre.name)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <p class="concept">${escape(theatre.concept)}</p>
  <header class="site-head"><a href="/">${escape(theatre.name)}</a><span>${escape(theatre.town)}</span></header>
  <main>
    ${body}
  </main>
  <footer class="site-foot"><a href="/">Tonight</a> · <a href="/staff/door">The door (staff)</a></footer>
  ${actionsScript}
  <script type="module">
    import { connect } from '@zubra/sync/connect';
    connect();
  </script>
</body>
</html>`;
}
