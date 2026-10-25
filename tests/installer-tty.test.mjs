import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/installer-pty.py', import.meta.url));
const cases = [
  ['studio-interactive', 'Studio setup accepts an owner ID and hidden bot token through a real terminal'],
  ['studio-skip-bot', 'Studio setup permits a blank optional bot token'],
  ['studio-existing-owner', 'Studio setup preserves saved owner and worker settings'],
  ['studio-saved', 'Studio setup reuses complete settings without requiring a terminal'],
  ['studio-no-terminal', 'Studio setup without a terminal fails before changing configuration'],
  ['studio-cancel', 'Studio setup cancellation restores echo and preserves configuration'],
  ['studio-invalid-owner', 'Studio setup rejects an invalid owner without changing configuration'],
  ['worker-interactive', 'Worker setup accepts two hidden credentials through a real terminal'],
  ['worker-existing-token', 'Worker setup preserves the saved worker token'],
  ['worker-saved', 'Worker setup reuses complete settings without requiring a terminal'],
  ['worker-no-terminal', 'Worker setup without a terminal fails before changing configuration'],
  ['worker-cancel', 'Worker setup cancellation restores echo and preserves configuration'],
];

for (const [scenario, name] of cases) {
  test(name, { skip: process.platform !== 'linux', timeout: 15000 }, () => {
    const result = spawnSync('python3', [fixture, root, scenario], { encoding: 'utf8', timeout: 12000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
