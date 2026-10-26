# Live coding agent: owner preview

Review baseline: `df081a1d73fa6ec8359db51c24718ff55ca66744`.
Scope: `ai.nightz.dev` only. This is the first working increment of the approved live-agent design, not completion of the entire specification and not a production deployment.

## Implemented workflow

Open `/agent.html` or the Live agent / owner preview footer link. Choose an existing coding project, create a named conversation, select an enabled model, and authorize the displayed task allowance. Ask is read-only. Plan & build and Debug first inspect permitted context and propose a plan. The owner must approve the exact plan before source changes. Successful validated source saves as one new revision without a second Apply action.

The model chooses one bounded action per turn: list files, read a file, search text, write a complete file, delete a file, request validation, propose a plan, ask a question, or finish. The server executes the action and provides its real result for the next turn. This is an adaptive action loop, not a single resource-generation call hidden behind progress animations. It uses the existing compatible Responses providers with structured JSON actions, rather than introducing another model SDK or unrestricted shell.

Named conversations, messages, task state, staged source, action results, plans, approvals, usage receipts and pauses are persisted in SQLite. Project instructions and permission presets are versioned. Protected files are excluded from model reads and searches. The owner-preview tools cannot execute project code on the host, install dependencies, access arbitrary URLs, write to GitHub, or deploy.

The workbench provides chat, saved/staged code, and a plan/checks panel. It uses the supplied ND artwork, custom dropdowns and responsive Chat/Code/Plan tabs. Current source edits remain separate from agent staging. Browser drafts are account/project scoped in sessionStorage, with an explicit comparison before saving over a newer revision and a local draft download. The existing workspace remains available for source history, restores, project creation and normal builds.

## Approval and safety boundaries

- Source-writing tools require a captured plan hash and exact file operations. Read existing staged content before modifying it. Unlisted files, protected paths and prohibited operations are rejected server-side.
- Package metadata and SQL source changes derive dependency/migration permissions from their paths. Approval does not authorize package installation or a live database migration.
- Changing instructions invalidates an active task's permissions. Stale plan versions and stale source revisions cannot be approved silently.
- Each project has at most one active agent task in this increment. Additional messages can be queued but do not start paid tasks automatically. Separate conversations share source, not separate unchecked writers.
- Queue does not alter a running task. Pause and discuss pauses at a safe checkpoint. Redirect supplies new user input and requires a revised approved plan. Resume is explicit.
- Disconnect grace defaults to 60 seconds and can be set from 30 to 300 seconds. An authorized same-project tab maintains presence. The next safe checkpoint pauses after absence; an in-flight paid response is preserved rather than silently repeated. Finish current task is an explicit override.
- An original session ending, owner access loss, suspension, archive, disabled model/tool, changed permissions or revoked subscription allowance prevents further authorized work. Stop remains available to release a nonterminal task's hold.
- Provider dispatch acknowledgements are not retried to authorize another paid call. Lost response uncertainty fails safely on lease expiry. Immutable result and validation receipts can be retried without duplicating tools, source revisions or credit settlement.
- Validation is bound to the exact staged source hash. A later edit invalidates the result. Source conflicts and source quotas preserve validated staged output for export instead of overwriting newer source.
- Undo task restores the pre-task source as a new revision only when the task's applied revision is still current. Newer manual work blocks whole-task undo. Selective undo is not included yet.
- Existing path/content limits, the private staging parent, rootless Docker, non-root container user, read-only mount, network restrictions and cgroup limits remain unchanged. No generated project entry point is executed by this work.

The agent can author a complete replacement for an approved file. It is not a semantic proof that every edit matches the human goal. Review important changes and perform real FiveM or Discord runtime acceptance separately.

## Pricing and refunds

Every task captures one selected model/provider, the catalog rate snapshot, maximum provider estimate, maximum model-call count and the applicable customer credit quote. Planning, Ask, coding and repairs are paid model work within that allowance. Source-plan approval is separate from the initial paid read-only allowance authorization. There is no automatic model switching or paid fallback.

This increment integrates both existing billing paths without changing subscription prices, checkout, invoices, Stripe configuration or customer subscriptions:

- With existing fixed catalog credits, a delivered task consumes the captured fixed quote once.
- With existing subscription metering enabled, the task reserves the model allowance, charges recorded priced usage on delivery, and tracks provider expense separately.
- Failed and stopped owner-preview tasks release all customer credit/allowance holds. Provider API failures always receive this full task-credit release. No payment-card or provider invoice refund is attempted.
- Provider usage that cannot be priced reliably retains a conservative provider reservation and stops additional paid steps. It is not presented as a confirmed invoice. Subscription settlement does not charge unpriced delivered usage.
- Both normal recovery paths skip the explicit nonterminal `agent` status, so planning/approval/pause cannot accidentally release an active reservation. The agent's own durable terminal path handles settlement.

The current recovery preset is Stop and refund. Configurable refund/recovery presets, one free recovery attempt, automatic verified rate updates, margin controls and model recommendations are still pending. Existing subscription metering is not claimed as all of the proposed smart-pricing specification.

## Additive integration

`server/agent.mjs` is mounted before the existing Studio router using the existing session, origin and CSRF helpers. It shares pure catalog and subscription accounting operations but never exposes a second payment router or sends a Stripe request. The original account, models, billing and source APIs remain in place.

Upgraded workers advertise agent protocol 1 in an authenticated header. Only those workers can claim agent tasks. Ordinary builds retain their existing pipeline. An unavailable provider's queued agent task does not prevent the normal queue from being checked.

The new tables retain the existing SQLite user_version. Agent state is attached to ordinary job IDs for shared account/provider budgets and billing history. The existing setup scripts already copy the new server/worker modules. Build, static preview, publisher and HTTPS byte probes now include the three agent assets alongside billing.js, for 27 published files.

## Verification actually performed

- Focused Node tests cover domain lifecycle, server-side permissions, source conflicts, paid dispatch receipts, API refunds, HTTP/session/CSRF boundaries, subscription metering, original worker entrypoint behavior and asset integration.
- Real local HTTP and SQLite are exercised. Provider transport, Discord identities and validator outcomes are explicit fixtures. No live model request or payment was made.
- Eight browser interaction journeys passed using `tests/agent-browser-bridge.py`. Chromium administrator policy blocks normal navigation in this environment. The bridge injects actual HTML/CSS/JS into about:blank and substitutes only test fetch and opaque-origin storage; it sends actions to the real local HTTP/SQLite fixture. No administrator policy was changed. These checks are not normal browser-network, production cookie or storage acceptance.
- Desktop and mobile screenshots come from the actual owner-preview interface with fixture data. They are not production activity or generated mockups.
- JavaScript syntax, Python test syntax and the modified publisher's Bash syntax were checked.

Not claimed: the complete pre-existing repository regression suite, the complete production asset build, normal browser-network acceptance, real rootless container execution, live Discord/provider/Stripe access, hosted CI, FiveM behavior, or VPS deployment. Run the full suite from a complete checkout before merging. The selective local working copy does not contain all original test/build inputs.

Commands from a full development checkout:

```bash
npm test
npm run build
node --test tests/agent-domain.test.mjs tests/agent-worker.test.mjs tests/agent-http.test.mjs tests/agent-subscriptions.test.mjs tests/agent-assets.test.mjs tests/worker-entrypoint.test.mjs
python3 tests/agent-browser.py
```

The browser check needs the existing isolated Playwright development environment and Chromium. `CHROMIUM_PATH` can specify its executable. It uses a local fixture only; no production identity endpoint is added. The optional bridge is a diagnostic aid, not a substitute for the normal browser acceptance test.

## Upgrade after review and merge

Do not update a live service while paid builds are running. Keep this increment owner-only on the currently co-located worker. Preserve existing secrets and billing settings. Do not roll an API back to pre-agent code while agent tasks or reservations remain active; stop/drain them first and retain the database backup.

Website, in the existing root deployment session:

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

Stop if local changes or test failures are present. Upgrade the website before the worker. The normal installer snapshots the database and manages releases and rollback. No new environment secret is needed.

Enter the worker from root:

```bash
machinectl shell nd-ai-worker@ /bin/bash -l
```

Then, as the non-root worker user:

```bash
cd /home/nd-ai-worker/nd-ai-studio
git status --short
git pull --ff-only origin main
npm test
bash deploy/setup-worker.sh
systemctl --user status nd-ai-worker.service --no-pager --full
```

Verify a real owner task against a disclosed small allowance: plan without source edits, approve, inspect real action cards, validate and save once, then export. Verify Pause/Resume, disconnect pause, a concurrent manual draft, a saved-source conflict and the single credit settlement. Stop at failures instead of repeating paid tasks blindly.

## Remaining approved milestones

Interactive NUI execution and simulated callbacks; agent-driven browser tests/screenshots; ZIP/file/GitHub imports; context attachment chips and visual element selection; official-documentation tools; selective undo/recovery panel; approved multi-task queues; model recommendation; configurable smart pricing/refund/recovery presets; optional notifications; and a safe member rollout remain unimplemented here. They must not be advertised as available or represented by fake success events.

No subagents were launched in the authoring environment because no subagent execution facility was exposed. No production service was changed.
