// Runs relay.js as a local Node.js server: for testing before deploying to
// Cloudflare, or permanently on the streaming PC or another always-on machine.
//
//   node relay/server.mjs                  -> port 8788, all interfaces
//   node relay/server.mjs 9000             -> another port
//   node relay/server.mjs 8788 127.0.0.1   -> this machine only
//
// It also serves ../overlay, so a machine running the relay can host the page
// too: OBS then loads http://<host>:8788/ and needs no local copy. A local copy
// is more robust, since it still shows Twitch chat while this server is down.
// Node 18+.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import relay from './relay.js';

const PORT = Number(process.argv[2] ?? 8788);
const HOST = process.argv[3] ?? '0.0.0.0';

const OVERLAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'overlay');
const RELAY_ROUTES = new Set(['/open', '/poll', '/diag']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
};

// Addresses other machines on the network cannot connect to are not listed:
// adapters of virtual machines, WSL and containers, and self-assigned
// 169.254.x addresses of adapters that got none from the router.
const VIRTUAL_ADAPTER = /^(vEthernet|docker|br-|veth|virbr|vmnet|VirtualBox|VMware|Hyper-V|WSL)/i;

function networkAddresses() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL_ADAPTER.test(name))
    .flatMap(([name, addresses]) => (addresses ?? [])
      .filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.'))
      .map((a) => ({ address: a.address, name })));
}

function serveOverlay(res, pathname) {
  const file = path.join(OVERLAY_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));

  // A plain prefix check would also accept sibling folders such as overlay-old/.
  const inside = path.relative(OVERLAY_DIR, file);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (!RELAY_ROUTES.has(url.pathname)) {
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    serveOverlay(res, url.pathname);
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const request = new Request(url.href, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
  });

  const response = await relay.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  console.log(`${req.method} ${req.url.slice(0, 60)} -> ${response.status}`);
}

// Every request is handled inside try/catch: an uncaught error, e.g. from a
// malformed URL, would otherwise stop the whole server.
http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    const status = err instanceof URIError || err instanceof TypeError ? 400 : 500;
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(status === 400 ? 'bad request' : 'internal error');
    console.log(`${req.method} ${String(req.url).slice(0, 60)} -> ${status} ${err.message}`);
  }
}).listen(PORT, HOST, () => {
  // 0.0.0.0 means "all interfaces" and cannot be opened in a browser, so the
  // addresses that can are printed instead, labelled with their adapter.
  const entries = HOST === '0.0.0.0' || HOST === '::'
    ? [{ url: `http://localhost:${PORT}`, label: 'if OBS runs on this computer' },
        ...networkAddresses().map(({ address, name }) => ({
          url: `http://${address}:${PORT}`,
          label: `if OBS runs on another computer (${name})`
        }))]
    : [{ url: `http://${HOST}:${PORT}`, label: '' }];

  const width = Math.max(...entries.map((e) => e.url.length));
  console.log(`Chat relay running on port ${PORT}.`);
  console.log(`Set youtube.relayUrl in overlay/config.js to ${entries.length > 1 ? 'the matching address' : 'this address'}:`);
  for (const { url, label } of entries) console.log(`  ${url.padEnd(width)}  ${label}`.trimEnd());
});
