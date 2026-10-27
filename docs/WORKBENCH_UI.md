# Project workbench interface refresh

Baseline: main `02a0cc54ebeca70e2ae6fcbd6c0a6eed029c0d3d`, including merged live-agent PR #8.

## Scope

This is a frontend presentation update for the existing source workspace and the live-agent owner preview. It preserves the separate authenticated routes and the original Nightz Development branding. It does not change source storage, agent policy, plan approval, model selection rules, credit accounting, subscriptions, provider requests, worker isolation or database schema.

## Source and quick-build workspace

- Add a visible Live agent navigation entry, project-specific Open live agent action, and Live agent / Source & builds mode links. The links carry only a validated local project ID. Navigation is explicit rather than an automatic redirect; existing unsaved-draft/beforeunload protection remains in the source controller.
- Keep the existing one-request generator as Quick build. Its model controls, form, generated-source preview, revisions, comparison, cancellation and ZIP actions remain intact.
- Use available project-page width, improve editor type size and spacing, and add synchronized line numbers, bounded 12-20 px text controls and desktop Focus code mode. Default source text is 14 px. No browser zoom setting is changed.
- Add case-insensitive file filtering and an empty-result state without changing the selected file or its contents.
- Collapse recent builds and technical logs. Summarize the existing selected build state using fixed descriptions. A newly observed failed state reveals the log; subsequent renders respect a user's decision to collapse it. No credit refund or success is inferred from log text.
- Keep non-project routes and the existing source-controller DOM IDs and form contracts.

## Live-agent workbench

- Give Chat, Source workspace and Task overview distinct panels, with mobile/tablet tabs and keyboard panel navigation.
- Show the actual project name, shared source link, instructions/permissions, conversation controls and existing task state.
- Put the request field before model controls and collapse continuation/message/call-limit settings into Task options. Existing paid-planning and exact-plan approval confirmations still run.
- Add the same file filter, line numbers and display controls. Existing Save, draft recovery/comparison, staged-source selection, plan editing, checkpoints, Stop/Pause/Resume, exports and task history remain wired to their original client.
- Keep technical action history collapsed and check results separate from plan text. The NUI execution/browser-testing section remains explicitly unavailable. No iframe, simulated interactive preview or fabricated testing result is introduced.

`web/workbench-ui.js` is a presentation module. It does not make API requests or assign editor source contents. It stores only bounded display preferences in localStorage; failure to store those preferences does not prevent editing. Existing agent events notify it about file/project changes. The small `agent.js` changes expose current project/state metadata, report successful project synchronization, and restrict tab-button handling to actual mobile-tab controls.

Both new assets are included in build, static preview, publish and HTTPS-byte verification lists. The production asset count becomes 29. The content security policy is unchanged.

## Checks performed for this patch

- 20 focused Node tests passed on Node 22.16.0, zero failures or skips: the new workbench display/static regressions plus existing agent asset/integration wiring tests.
- 15 diagnostic Chromium UI journeys passed using the real HTML, CSS, shared controls, live-agent client and new presentation module. They cover links, filters, focus/font controls, scroll-aligned line numbers, preserved source/selection, log disclosure, unchanged approval confirmation, explicit file saving, unavailable preference storage and keyboard tabs.
- Both surfaces were checked at 1920, 1280, 1180, 1024, 834, 768, 720, 700, 390 and 320 px. No horizontal document overflow or unexpected page exceptions were observed. Inactive panels were checked for invisibility.
- Desktop and mobile screenshots were inspected visually. Screenshots contain explicit test project/model/usage data, not production account or provider activity.
- Modified JavaScript syntax, browser-test Python syntax, publisher Bash syntax and patch whitespace were checked.

These browser journeys use an about:blank DOM fixture with injected assets, an in-memory API and storage doubles. The real agent client performs its normal UI requests against that fixture. The legacy source workspace controller is not executed by this diagnostic runner; its normal editor state and panel handlers are supplied as fixtures. Normal loopback navigation was blocked by the environment's Chromium administrator policy; that policy was not changed. These checks are not ordinary browser-network, authentication, cookie, CSP, backend or deployment acceptance.

The authoring checkout was selective rather than a complete clone. Full application regression, the complete production build, the ordinary existing browser suites, hosted CI, provider calls, Docker execution and VPS deployment are not claimed. Run the complete suite/build and ordinary browser checks before release.

Focused commands from a complete checkout:

```bash
node --test tests/workbench-ui.test.mjs tests/agent-assets.test.mjs
python3 tests/workbench-ui-browser.py
```

The browser command requires the existing isolated Playwright environment. `CHROMIUM_PATH` selects an installed Chromium executable. `ND_QA_ARTIFACTS` chooses the screenshot/results destination. No keys or live services are required. The fixture does not alter browser policies.

Before release, also run the ordinary existing workspace and agent browser suites with real loopback navigation and the existing account/API fixture setup. Verify legacy model changes, source saves, comparison, history, exports and cancellation from the newly collapsed panels.

## Deployment after review and merge

This patch itself is frontend-only. It needs no new secrets, environment edits, database migration or worker restart.

In the root website deployment session, preserve unexpected local changes, update `/home/nd-ai-studio`, run the full tests and production build, publish with the existing release-pointer script, and verify all frontend bytes:

```bash
cd /home/nd-ai-studio
git status --short
git pull --ff-only origin main
npm test
npm run build
bash deploy/publish.sh
node deploy/verify-accounts.mjs frontend
```

Stop before pulling if unexpected local changes are present and stop on any failed command. Follow the existing rollback procedure if publication verification fails. This sequence does not upgrade the account API or worker.

The live-agent API and worker from PR #8 must already be deployed for `/agent.html` to function. Merging code or publishing these assets alone does not activate those backend features. When that prerequisite rollout is outstanding, use the full website installer first and worker installer second as documented in `LIVE_AGENT.md`, with active tasks drained and backups retained. Keep the co-located worker and agent in owner testing.

Do not change unrelated Nginx sites, rootful Docker, Discord services, Stripe settings or customer data for this interface patch. The original build workspace remains available at `/workspace.html#project/<project-id>`; Open live agent links to `/agent.html#project/<project-id>`.
