# Launch reliability verification, 26 October 2026

This update improves the existing release 0.3. No production deployment, provider purchase, live payment, real communication or destructive production migration was performed.

## Behavior changed

- Account, brief, project and administrative writes revalidate the original session, CSRF and current permissions after asynchronous work and before committing. Revocation, suspension and permission changes cannot finish an already-open stale write.
- Brief creation accepts an optional account-scoped request ID. Durable receipts prevent duplicate creation after a lost acknowledgement, preserve later edits and prevent deleted briefs from returning on retry. Existing imports and clients without request IDs retain their behavior.
- Cancellation settles credits using the current queued/running state. The worker checks cancellation before paid dispatch, reports known zero usage for preparation failures, and preserves conservative holds for unknown outcomes after dispatch. An ended lease no longer makes a healthy worker appear unavailable.
- Validator infrastructure and malformed responses never authorize paid source repair. Diagnostics remain bounded, and generated bot manifests cannot include the ten npm installation/dependency lifecycle hooks checked by the validator.
- Editor dialogs and asynchronous responses stay bound to their original account, project, revision and draft generation. Newer typing, recovered drafts and changes in another project survive delayed acknowledgements. Full browser storage and expired sessions retain an explicit local draft download.
- Profiles, briefs, model catalogs, credit adjustments and admin tabs preserve current inputs and ignore stale responses. Earlier-session 401s do not sign out a recovered session. Quotes retain the exact model and credit snapshot shown for confirmation. Invalid role-map keys reach server validation instead of disappearing during serialization.
- Overview highlights the two implemented coding workflows; the tool library keeps all 24 definitions and honest planned-engine labels. Mobile navigation, keyboard focus, touch targets, forms, spacing and restrained surfaces preserve the ND branding. Resolved errors clear on explicit retry. The static preview permits the same trusted Discord avatar host as the account deployment.
- Live coding adds a separate unvalidated preview, OpenAI source streaming, DeepSeek complete-response candidates and a mobile preview shortcut. Saved revisions synchronize between tabs without replacing local drafts or resetting unchanged editor text. See [live coding behavior and upgrade notes](LIVE_CODING.md).

## Local verification

Node 24.19.0, Python 3.12, Playwright 1.62.0 and system Chromium were used. The current 309-test Node suite passes on the minimum supported Node 22.16.0 as well as Node 24.19.0. The 26 real local API browser journeys also passed on Node 22.16.0 for the preceding live-coding release. Its 23 production assets are byte-identical to the Node 24 build. The CI workflow selects Node 22; local compatibility checks do not establish a hosted CI pass. No separate lint or type-check command is configured.

| Check | Result |
| --- | --- |
| Node regression suite | 309 passed on Node 22 and 24, zero failed or skipped |
| Account/brief Chromium fixtures | 24 passed |
| Workspace Chromium fixtures | 57 passed |
| Model/credit Chromium fixtures | 12 passed |
| Real local HTTP/SQLite browser journeys | 26 passed |
| Production asset build | Passed |
| Deployment shell syntax, browser Python syntax, workflow YAML, whitespace review | Passed |

Browser journeys cover profile save/reload/export; brief creation, editing, deletion, ownership and lost acknowledgements; project/file creation, invalid paths, editing, conflicts, history, restore and ZIPs; successful builds, known-zero failure, concurrent source changes, cancellation and owner reconciliation; current-price reconfirmation, catalog persistence and internal credit adjustments; expired sessions, unavailable draft storage, permission denial, transient failure and retry; and desktop/tablet/mobile navigation. Representative widths include 320, 390, 834 and 1440 pixels. The fixture suites also check 768 and 1024 pixels. All four policy draft routes were inspected at mobile width.

The launch runner starts the supported static preview and actual account/Studio API with a separate private temporary SQLite database for each journey. Discord identity/avatar images, provider responses and rootless validation are explicit test doubles. Live-preview journeys use the production provider adapter, SSE decoder, partial JSON parser, worker publisher, API and browser with a mocked provider SSE transport. They verify changing previews before any saved revision or charge, finalization once, draft protection, tab synchronization, cursor/scroll preservation and mobile cancellation. Tests do not contact a paid provider or execute generated projects. HTTP/SQLite persistence, session/CSRF processing, job state and internal credit settlement are real local paths. These results do not establish live Discord access, provider authorization, provider billing, rootless enforcement or FiveM/Discord runtime behavior.

The runner records page exceptions, console errors, failed requests, HTTP statuses, server logs and screenshots. Unexpected errors fail the checks. Deliberate 400/401/403/404/409/502/503 cases and verified browser download handoffs are distinguished from unexpected failures. See [browser setup and commands](BROWSER_TESTS.md). The verification workflow now runs all four browser suites and retains launch evidence.

## Cache-write accounting follow-up

A real OpenAI build reported aggregate cache writes without lifetime counts. Earlier fixtures covered the enriched lifetime split and expected unknown billing to discard all output; the official SDK usage schemas permit aggregate counts without that split. The worker now keeps bounded authoritative source for normal validation when only cache-write allocation or captured prices are missing. It records unreconciled accounting, retains the full captured reservation, and prevents another paid repair. Known token costs above the remaining budget still fail without saving source, including prior usage, context multipliers and known write buckets. Missing or invalid core usage, unsafe output and incomplete streams remain failures.

New JSON/SSE and HTTP/SQLite regressions cover saved output, conflict ZIPs, known-minimum budget failures, fixed-credit settlement, restart and immutable receipt replay. Chromium checks cover both accounting reasons, delivered and failed results, refresh persistence, micro-dollar minimum display, and unchanged ordinary estimates. Desktop 1280px and mobile 390px notices were visually inspected: no horizontal overflow or unexpected browser/network errors, readable notices, working comparison controls and normal vertical log scrolling on mobile. These integrations use mocked provider transport and validator results; no live provider charge or generated-project runtime test was performed.

The first browser runs exposed two existing fixture assumptions: a save-conflict test raced automatic source synchronization, and a navigation test assumed the saved file remained first in the returned list. The tests now capture the original write before the concurrent revision and explicitly select the saved path after reopening. Recovery, persisted content and revision assertions remain intact.

Upgrade the website before the worker so the optional accounting receipt is accepted. No database migration or existing job/credit rewrite is needed. Previously discarded output cannot be recovered by this change, and it does not automatically retry a failed paid request.

## Remote and release limits

The latest inspected main-branch [GitHub run](https://github.com/NightzDevelopment/ND_AI_Studio/actions/runs/40258624345) did not start its job because the repository account is locked for a billing issue. This is a pre-existing infrastructure failure, not a passing CI run. The active cloud proxy also denied `api.github.com`, despite the saved environment configuration listing that host. Git access to `github.com` remains available; API-based PR, protection and CI operations must be restored before a verified merge can be claimed. The visible verification workflow contains no deployment step. External deployment hooks and branch rules were not verified through the blocked API.

For a later approved rollout, upgrade the API before or with the frontend: older APIs reject the new optional brief request field. The receipt table is additive, preserves the existing schema version and is included in ordinary SQLite backups. Upgrade the worker and rebuild/pin its validator image because `worker/check.cjs` changed. Existing pinned images do not acquire the new hook restrictions automatically. Follow the existing backup and deployment instructions; this document does not authorize production deployment.

Public launch remains blocked on working CI, approved deployment and live acceptance, and the unresolved operator/contact/retention/deletion facts in [the policy review](legal/REVIEW.md). The existing co-located worker remains suitable only for the documented owner-testing scope; use the separately isolated build host described in [the deployment guide](../deploy/STUDIO.md) before wider untrusted use. No payment system or other planned catalog engine was added or declared ready.
