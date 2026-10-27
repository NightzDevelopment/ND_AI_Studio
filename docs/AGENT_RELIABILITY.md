# Agent failure diagnostics and workbench controls

Baseline: main `69b1ccb2f3aff395e64001140a579a172ec364a2`.

## Reproduced failure paths

The Responses action schema permits an empty string for nullable `path` and `query` fields. The original server validated every non-null value, including unused empty arguments. Eight new regression cases failed against the baseline. A non-file action could therefore be rejected after a paid response, then reported as a generic provider API failure.

Neutral empty arguments are now normalized only when unused by that action. Required file paths and search queries, complete write contents, supported fields, path traversal protection, protected files and exact plan authorization remain enforced. The worker and API use the same pure argument validator.

This reproduces a real local defect, not the root cause of a specific production screenshot. Production task records, worker logs and the original provider request were not available in this development checkout. Existing failures without retained diagnostics cannot be reconstructed from their generic message alone. Do not rotate credentials, increase budgets or repeat paid tasks on that evidence.

The baseline also accepted a streamed Quick build after a project agent task had been authorized while its request body was arriving. A real HTTP regression observed HTTP 202 instead of 409. The ordinary build now rechecks the shared project writer boundary inside its reservation transaction. The original optimistic source revision checks remain in place.

## Safe diagnostics and accounting

- Authentication, access, request/schema rejection, rate limits, quota, provider availability, timeout/network interruption, incomplete/refused/malformed output, invalid actions, local approval/permission conflicts, budget limits, infrastructure failure and uncertain usage have distinct categories and fixed next steps.
- Provider HTTP bodies are bounded and discarded after extracting an allowlisted error code. Only supported HTTP status, code, request ID and response ID formats are retained. Raw messages, source, prompts, credentials and headers are never included in failure diagnostics.
- Diagnostics are persisted in the existing job result and immutable failure receipt, then shown in Task overview. No schema migration or parallel billing system is added.
- A lost dispatch acknowledgement still cannot authorize another paid POST. Only immutable result/failure/validation receipt delivery is retried. Ambiguous delivery stays subject to durable recovery.
- API-failed tasks release all customer credit holds exactly once. Provider exposure remains separate. Uncertain failures retain at least the captured reservation and never discard a larger independently known minimum.
- Shared Quick build cache-write accounting already preserves usable validated output when only cache-write lifetime allocation or configured rates are missing. This behavior is retained. The agent preserves the returned action/staged work and blocks further paid steps while its usage is unreconciled. Unknown costs are not treated as zero and no rates or lifetime allocations are invented.

No subscription prices, Stripe products, commercial terms, historical charges, enabled models or provider selection were changed.

## Focused verification

The integrated agent domain, worker, contract, diagnostics, real HTTP/SQLite, subscription, source-writer, release packaging and asset checks pass locally: 98 tests on Node 24.18.0. JavaScript syntax, worker-installer Bash syntax and patch whitespace checks passed.

The original full `npm test` run on Windows failed on symlink permissions and attempted removal of an open SQLite fixture, then timed out. It is not a passing full-suite result. Full regression/browser results and platform limits must be recorded separately before release. No Docker client or WSL Linux runtime is available in this development environment, so real rootless container checks remain blocked here.

The standalone local diagnostics browser check uses an isolated Playwright module, not an application runtime dependency:

```bash
ND_PLAYWRIGHT_MODULE=/path/to/isolated/node_modules/playwright node tests/agent-reliability-browser.mjs
```

It exercises normal localhost navigation, the actual API and SQLite, persistent failure details, no duplicate dispatch and the five required viewport widths. Provider transport, identity and validator remain explicit fixtures. A command in this document is not a claim that its browser checks have passed.

## Upgrade requirements

Drain or explicitly stop active tasks first. Preserve private environments and take the existing database backup. Upgrade the website before the worker: older APIs do not understand the new optional diagnostic field or the invalid-action failure reason. Older workers remain compatible with the updated API.

Website, from the existing root deployment session after review and merge:

```bash
cd /home/nd-ai-studio
git status --short
git pull --ff-only origin main
npm test
bash deploy/setup-studio.sh
node deploy/verify-accounts.mjs backend
node deploy/verify-accounts.mjs proxy
node deploy/verify-accounts.mjs frontend
```

Stop on unexpected modifications or failed checks. The existing installer copies the new server modules and publishes frontend assets. Do not deploy only frontend assets for the diagnostics change.

Enter the worker account with `machinectl shell nd-ai-worker@ /bin/bash -l`, then:

```bash
cd /home/nd-ai-worker/nd-ai-studio
git status --short
git pull --ff-only origin main
npm test
bash deploy/setup-worker.sh
systemctl --user status nd-ai-worker.service --no-pager --full
```

The worker installer now includes both pure agent helper modules in its private release. A packaging regression imports the actual installed worker dependency graph without contacting a provider. Keep rootless Docker, the pinned validator image, non-root container user, cgroup bounds, no-network validation and read-only source mounts unchanged. Do not restart rootful Docker or unrelated services.

Keep the co-located deployment owner-only. This work does not deploy to the VPS or establish live provider, rootless Docker, FiveM, Discord or Stripe acceptance. The isolated interactive preview, imports, configurable commercial presets and remaining live-agent milestones are still separate stages, not functioning features implied by this patch.
