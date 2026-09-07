/**
 * Writer for the /thumbs capture page. Renders happen in the browser — only a
 * GL context can run the two-tone shaders — so this exists purely to put the
 * PNGs the page produces on disk.
 *
 *   node tools/2_thumbs.mjs
 *   open http://localhost:3000/thumbs
 *
 * Deliberately not a Next route handler: `next.config.mjs` switches on
 * `output: 'export'` for the Pages build, and a route handler has no static
 * form, so adding one there would break the deploy. A throwaway server on its
 * own port keeps the app exportable.
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.PORT ?? 4321);
const OUT = resolve(process.env.OUT ?? 'public/image/thumbs');

// The page is served from another origin (:3000), so the POST needs to survive
// preflight.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/save')) {
    res.writeHead(404, CORS).end('nope');
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  try {
    const { name, dataUrl } = JSON.parse(Buffer.concat(chunks).toString());
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`bad name: ${name}`);

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    if (base64 === dataUrl) throw new Error('not a png data url');

    const bytes = Buffer.from(base64, 'base64');
    await mkdir(OUT, { recursive: true });
    const path = join(OUT, `${name}.png`);
    await writeFile(path, bytes);

    console.log(`wrote ${path} (${bytes.length} bytes)`);
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ path, bytes: bytes.length }));
  } catch (err) {
    console.error(err);
    res.writeHead(400, CORS).end(String(err));
  }
});

server.listen(PORT, () => console.log(`thumb writer on :${PORT} -> ${OUT}`));
