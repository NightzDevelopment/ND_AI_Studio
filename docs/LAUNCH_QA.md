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

## Local verification

Node 24.19.0, Python 3.12, Playwright 1.62.0 and system Chromium were used. The full 250-test Node suite and all 22 real local API browser journeys also passed on the minimum supported Node 22.16.0. Its 23 production assets are byte-identical to the Node 24 build. The CI workflow selects Node 22; local compatibility checks do not establish a hosted CI pass. No separate lint or type-check command is configured.

| Check | Result |
| --- | --- |
| Node regression suite | 250 passed, zero failed or skipped |
| Account/brief Chromium fixtures | 24 passed |
| Workspace Chromium fixtures | 37 passed |
| Model/credit Chromium fixtures | 12 passed |
| Real local HTTP/SQLite browser journeys | 22 passed |
| Production asset build | Passed |
| Deployment shell syntax, browser Python syntax, workflow YAML, whitespace review | Passed |

Browser journeys cover profile save/reload/export; brief creation, editing, deletion, ownership and lost acknowledgements; project/file creation, invalid paths, editing, conflicts, history, restore and ZIPs; successful builds, known-zero failure, concurrent source changes, cancellation and owner reconciliation; current-price reconfirmation, catalog persistence and internal credit adjustments; expired sessions, unavailable draft storage, permission denial, transient failure and retry; and desktop/tablet/mobile navigation. Representative widths include 320, 390, 834 and 1440 pixels. The fixture suites also check 768 and 1024 pixels. All four policy draft routes were inspected at mobile width.

The launch runner starts the supported static preview and actual account/Studio API with a separate private temporary SQLite database for each journey. Discord identity/avatar images, AI output and rootless validation are explicit test doubles. Tests do not contact a paid provider or execute generated projects. HTTP/SQLite persistence, session/CSRF processing, job state and internal credit settlement are real local paths. These results do not establish live Discord access, provider authorization, provider billing, rootless enforcement or FiveM/Discord runtime behavior.

The runner records page exceptions, console errors, failed requests, HTTP statuses, server logs and screenshots. Unexpected errors fail the checks. Deliberate 400/401/403/404/409/502/503 cases and verified browser download handoffs are distinguished from unexpected failures. See [browser setup and commands](BROWSER_TESTS.md). The verification workflow now runs all four browser suites and retains launch evidence.

## Remote and release limits

The latest inspected main-branch [GitHub run](https://github.com/NightzDevelopment/ND_AI_Studio/actions/runs/40244897266) did not start its job because the repository account is locked for a billing issue. This is a pre-existing infrastructure failure, not a passing CI run. The active cloud proxy also denied `api.github.com`, despite the saved environment configuration listing that host. Git access to `github.com` remains available; API-based PR, protection and CI operations must be restored before a verified merge can be claimed. The visible verification workflow contains no deployment step. External deployment hooks and branch rules were not verified through the blocked API.

For a later approved rollout, upgrade the API before or with the frontend: older APIs reject the new optional brief request field. The receipt table is additive, preserves the existing schema version and is included in ordinary SQLite backups. Upgrade the worker and rebuild/pin its validator image because `worker/check.cjs` changed. Existing pinned images do not acquire the new hook restrictions automatically. Follow the existing backup and deployment instructions; this document does not authorize production deployment.

Public launch remains blocked on working CI, approved deployment and live acceptance, and the unresolved operator/contact/retention/deletion facts in [the policy review](legal/REVIEW.md). The existing co-located worker remains suitable only for the documented owner-testing scope; use the separately isolated build host described in [the deployment guide](../deploy/STUDIO.md) before wider untrusted use. No payment system or other planned catalog engine was added or declared ready.
