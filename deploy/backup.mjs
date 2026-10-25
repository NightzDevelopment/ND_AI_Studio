import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
process.umask(0o077);
const source = '/var/lib/nd-ai-studio/studio.sqlite';
if (existsSync(source)) {
  mkdirSync('/root/nd-ai-studio-backups', { recursive: true, mode: 0o700 });
  const target = `/root/nd-ai-studio-backups/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`;
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); chmodSync(target, 0o600); console.log(`Database snapshot: ${target}`); }
  finally { db.close(); }
}
