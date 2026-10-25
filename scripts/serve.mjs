import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const root = new URL('../dist/', import.meta.url);
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'], '/data.js': ['data.js', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css'], '/catalog.json': ['catalog.json', 'application/json'],
  '/account.js': ['account.js', 'text/javascript'], '/account.css': ['account.css', 'text/css'],
  '/controls.js': ['controls.js', 'text/javascript'], '/workspace.html': ['workspace.html', 'text/html'],
  '/workspace.js': ['workspace.js', 'text/javascript'], '/workspace.css': ['workspace.css', 'text/css'],
  '/models.js': ['models.js', 'text/javascript'], '/models.css': ['models.css', 'text/css'],
  '/branding.css': ['branding.css', 'text/css'], '/legal.css': ['legal.css', 'text/css'],
  '/policies.html': ['policies.html', 'text/html'], '/terms.html': ['terms.html', 'text/html'],
  '/privacy.html': ['privacy.html', 'text/html'], '/acceptable-use.html': ['acceptable-use.html', 'text/html'],
  '/nd-logo.webp': ['nd-logo.webp', 'image/webp'], '/favicon.png': ['favicon.png', 'image/png'],
  '/favicon.ico': ['favicon.ico', 'image/vnd.microsoft.icon'] };
const port = Number(process.env.PORT ?? 3080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
  }
  const path = (request.url ?? '/').split('?')[0];
  if (!Object.hasOwn(files, path)) { response.writeHead(404); response.end(); return; }
  try {
    const [name, type] = files[path];
    const content = await readFile(new URL(name, root));
    response.writeHead(200, { 'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8`, 'Content-Length': content.length });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(503); response.end('Frontend files are unavailable. Run npm run build.');
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Frontend preview: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
