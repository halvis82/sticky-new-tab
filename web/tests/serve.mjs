// Serves web/ on localhost:5173 for the length of one test run, then stops with it.
// Nothing is started when SITE points somewhere else, like the live site.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.txt': 'text/plain',
};

export const SITE = process.env.SITE || 'http://localhost:5173/';

// The notes account's password and the server key, from .env.local (never committed).
const ENV = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .split('\n').filter(l => l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
// What the tests add to config.js: their own table, and the password so no one has to type it.
export const TEST_CONFIG = `  table: 'notes_test',\n  password: ${JSON.stringify(ENV.NOTES_PASSWORD)},\n};`;
// Clears test rows past row level security.
export const SECRET = ENV.SUPABASE_SECRET_KEY;

export async function serve() {
  if (process.env.SITE) return () => {};
  const server = http.createServer((req, res) => {
    let file = path.join(ROOT, decodeURIComponent(new URL(req.url, SITE).pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
    });
  });
  await new Promise((ok, fail) => server.once('error', fail).listen(5173, 'localhost', ok));
  return () => new Promise(ok => server.close(ok));
}

// Headless Chromium reports the window as tall as the page and the screen, which is what Chrome
// full screen with a hidden toolbar looks like, and the board would leave room for a toolbar.
// Tests that want a normal window give the context this.
export const NORMAL_WINDOW = () => {
  Object.defineProperty(window, 'outerHeight', { get: () => innerHeight + 87 });
};
