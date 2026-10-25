import { readFileSync } from 'node:fs';
import { readConfig } from './config.mjs';
import { Store } from './store.mjs';
import { createApp } from './app.mjs';

process.umask(0o077);
const config = readConfig();
const store = new Store(config.database);
const catalog = JSON.parse(readFileSync(new URL('../config/tools.json', import.meta.url), 'utf8'));
const server = createApp({ config, store, catalog });
server.on('error', () => { console.error('Studio API could not start. Check the port and database permissions.'); process.exitCode = 1; store.close(); });
server.listen(config.port, '127.0.0.1', () => console.log(`Studio API listening on 127.0.0.1:${config.port}`));
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => { server.closeAllConnections(); }, 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
