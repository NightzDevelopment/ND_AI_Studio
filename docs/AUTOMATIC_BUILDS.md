# Automatic build completion

New builds normally finish by saving validated source as a new project revision. Opening a review dialog or clicking Apply is not part of a normal successful build.

```text
queue -> preflight -> generate -> validate -> bounded repair when needed
      -> package -> save revision -> refresh explorer/editor -> ZIP
```

Syntax and packaging validation do not test FiveM runtime behavior or start a Discord bot. Saving generated source does not deploy it, install its dependencies or execute it on a live server.

## Completion and recovery

The API captures `applicationMode` and the base project revision when a job is created. Omitted mode means `automatic`; API clients can explicitly request `review`. Additive migration defaults pre-existing jobs to `review`, including previously queued work, so an upgrade does not silently change an accepted job's behavior.

For a validated automatic build, one SQLite transaction checks the active lease and current account/project/tool access, saves the source revision, stores the terminal job and completion receipt, and settles Studio credits. Public jobs expose `applicationMode`, `appliedVersion` and `applicationError`.

- `applied` means the validated files were saved. `appliedVersion` identifies that historical revision even if later edits exist.
- `review` with `applicationError` means automatic saving was blocked by a newer saved revision, revision limit or source-storage quota. The result and its ZIP remain available. Existing source is retained.
- `review` without an application error is an explicitly selected or pre-upgrade review job. Its manual Apply action still requires the original saved revision.
- Failed, cancelled, expired or access-revoked work cannot save source through completion. Existing conservative spending/credit holds remain in effect.

An identical completion can be acknowledged again using the original lease proof and normalized result/cost. The receipt survives an API restart. A different proof or changed receipt is rejected. Replaying completion or Apply cannot create another source revision or credit debit. Applying an already saved job returns the current project snapshot rather than replacing newer editor contents with an older revision.

The worker prepares one result, stops lease progress heartbeats and delivers that immutable result. Network and transient HTTP acknowledgement failures get at most three delivery attempts with bounded delays. Delivery retries do not call the provider, rerun generation, replace a successful result with an error, or change the files being delivered. If all acknowledgement attempts fail, inspect API/job state before a new build; a committed completion may already be present. A worker process that dies before delivering its result can still leave an expired job with uncertain usage, as before.

## Browser drafts

Polling fetches incoming saved source and updates the explorer/editor after completion without depending on the browser being open during generation. Reopening a project reads its latest saved revision.

Local drafts keep their original base content and revision. A generated edit or deletion does not silently replace that text. Conflicted drafts offer saved/local comparison and an explicit save or discard action. A file removed from saved source can still appear as a local draft for recovery. Unrelated changes do not require discarding a draft.

Account/project-scoped `sessionStorage` recovery keeps drafts across reloads and navigation in the same browser tab. Saved or explicitly discarded drafts are removed. Closing the tab or clearing browser storage may remove recovery copies. Storage failures produce a warning and retain current in-memory text; keep a separate copy before closing or reloading if recovery storage is unavailable. This storage is a convenience, not an independent backup of project history.

## Studio credit treatment

Provider cost estimates and internal Studio credits remain separate. A successfully delivered validated result is charged once, including output preserved for a source conflict or quota. This preserves the previous delivered-proposal rule. Applying or retrying that result does not add a charge.

Known zero-usage failures and queued cancellations release reservations. Potentially billed failures, cancellation after work starts and expired leases retain pending holds for explicit owner reconciliation. Releasing Studio credits is not a refund from the provider.

## Upgrade website and worker separately

Merge the reviewed feature branch into `main` first. Let active builds finish before upgrading. Upgrade the website before the worker, since the worker's new provider advertisements require the updated API. Use the existing private environments and backup/rollback installers; do not copy environment files or rotate only one side of the worker token.

Website, in the existing root deployment session:

```bash
cd /home/nd-ai-studio
git status --short
git pull --ff-only origin main
bash deploy/setup-studio.sh
node deploy/verify-accounts.mjs backend
node deploy/verify-accounts.mjs proxy
node deploy/verify-accounts.mjs frontend
```

Stop and preserve unexpected local changes before pulling. The website installer snapshots the database and handles backend/frontend readiness and rollback. New database columns are additive and preserve existing accounts, projects, revisions, jobs and credit ledger entries.

Enter the dedicated worker session from root:

```bash
machinectl shell nd-ai-worker@ /bin/bash -l
```

Then run as `nd-ai-worker`, not root:

```bash
cd /home/nd-ai-worker/nd-ai-studio
git status --short
git pull --ff-only origin main
node --test tests/worker.test.mjs tests/worker-completion.test.mjs tests/worker-entrypoint.test.mjs tests/validator-permissions.test.mjs
bash deploy/setup-worker.sh
systemctl --user status nd-ai-worker.service --no-pager --full
```

The current owner test worker is co-located on the website VPS under a dedicated non-root account. Preserve its rootless daemon, immutable validator image and cgroup limits. Do not restart unrelated website, Discord, PostgreSQL, Redis or rootful Docker services. Keep generation in Owner testing on this installation.

OpenAI and DeepSeek keys are optional individually; the worker requires at least one. Keep OPENAI_API_KEY and DEEPSEEK_API_KEY only in its private environment. The installer reuses either saved key and preserves other settings. A provider-specific model can only queue while a matching healthy worker advertises its key presence. This is not a paid access probe or automatic fallback. Import new disabled presets in Control room, confirm their source/prices and API access, then choose availability and Studio credit charges deliberately.

## Validation and live acceptance

Development checks:

```bash
npm test
npm run build
find deploy -name '*.sh' -print0 | xargs -0 -r -n1 bash -n
python3 tests/workspace-browser.py
```

The browser command requires Python Playwright and Chromium. Use the [isolated browser-test setup](BROWSER_TESTS.md) before running it on another machine, and use the virtual environment's Python in place of `python3` above. These are development fixtures, separate from production service requirements and live deployment checks. The runner detects system Chromium or Playwright's downloaded browser; `CHROMIUM_PATH` selects an explicit executable. No live Discord login or paid provider calls are made.

Tests include HTTP API/SQLite plus worker orchestration with fixture provider and validator implementations. A lost successful acknowledgement followed by API restart must still create one revision and one credit debit. These fixtures do not establish live provider access or rootless Docker enforcement.

After deploying both components, use one owner test project with a disclosed build budget. Confirm a successful build saves without Apply, opens source files and exports a ZIP. Confirm history/diffs and restore work. Keep a local unsaved draft during a build, reload and compare after completion. Save a newer revision during a build and confirm the generated ZIP remains available while the newer source stays intact. Reconnect or close the tab during a build and inspect the saved result later. Inspect the credit ledger for a single settlement. Do not represent these live checks as passed until actually executed on the configured host.

Provider expansion remains separately tracked in [provider verification status](PROVIDER_RESEARCH.md).
