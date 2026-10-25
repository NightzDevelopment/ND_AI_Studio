# Model selection, internal credits and validator permissions

This update keeps the existing application, database and worker deployment layout. It does not add checkout, subscriptions, credit purchases, a cash exchange rate or automatic provider-price synchronization.

## Validator failure and repair

The worker systemd unit uses UMask=0077. Previously, writeFile(mode=0644) created source files with effective permissions 0600 and mkdir(mode=0755) created nested directories with effective permissions 0700. The read-only validator runs as container UID/GID 65534, which cannot read those host-owned files. The generic inspection error was incorrectly treated as a source error and caused an unnecessary paid repair attempt.

Staging now uses a private 0700 host parent and a separately mounted workspace. Explicit permissions are applied to the inner workspace, every nested directory and each source file. Only the inner workspace is mounted read-only. The parent remains inaccessible to other ordinary host accounts. No umask, container user, network restriction, capability or cgroup limit is weakened.

Before a paid generation request, a small trusted fixture checks the actual validator path, including nested files and parsers. Infrastructure failures stop the build rather than being sent to an AI model for repair. Known provider usage is retained when a returned proposal cannot be parsed or validated. This does not refund charges for past API calls.

## Available models

Control room > Models & credits lets the owner configure up to 40 exact model IDs, display names, tiers, availability, input/cached-input/output token prices, output limits, request timeouts, call limits, per-build API estimate caps and fixed credits per completed proposal.

Only enable text/code models that support the selected provider's documented Responses and JSON-schema contract and are accessible to the worker's API account. OpenAI and DeepSeek have distinct constrained endpoints and worker keys. DeepSeek omits the undocumented OpenAI strict flag; all returned changes still undergo local schema/path/size checks and the same isolated validation. Image, audio, embedding, realtime, moderation and incompatible legacy endpoints are separate pipelines. The compatibility checkbox is an owner confirmation, not a live model-access probe.

The owner can import five documented presets without replacing the existing catalog or default. All imported presets start disabled and unconfirmed. Their verified reference prices and limits, editable suggested credits and source links are shown before enabling. An existing configured single model remains available as a legacy fallback until the owner saves the new catalog. After that save, use the catalog rather than the legacy single-model fields. Current reference documentation:

- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/pricing
- https://api-docs.deepseek.com/quick_start/pricing/
- https://api-docs.deepseek.com/guides/responses_api

See [the provider verification record](PROVIDER_RESEARCH.md) for exact IDs and rates. The new OpenAI profiles disable prompt caching using supported explicit mode without breakpoints. Accounting also understands nonoverlapping cached reads and 30-minute/12-hour writes, and applies the documented whole-request long-context price bands. Unknown positive write meters or missing write prices fail conservatively instead of being treated as free. DeepSeek estimates use peak prices and provider-managed hit/miss caching; actual off-peak charges can be lower. Existing job profiles retain their captured policy and rates.

Every submitted job captures the provider, selected model, caching policy, prices, pricing version and limits. Editing the catalog does not silently reprice an existing job. A stale browser quote is rejected before enqueue. Unexpected client pricing fields are rejected. Provider cost calculations validate token subsets and do not add reasoning tokens a second time to output_tokens. A worker advertises which provider keys are configured, without reporting their values. A model without a matching healthy worker is rejected before job/credit reservation; a queued job keeps its provider snapshot and is never silently rerouted.

## Internal Studio credits

Credit enforcement is off by default. Existing users receive no invented balance. The owner can grant or adjust credits for registered Discord accounts with a required reason, revision check and idempotent request ID. The ledger records every reserve, release, pending hold, charge and adjustment.

When enabled, the selected model's fixed credits are reserved atomically with the job. A successfully delivered validated result is charged once. Automatic saving and replaying a completion do not add another charge. Validated output retained because a newer revision or source quota blocks saving is still delivered output and has the same credit treatment as the earlier proposal workflow. A queued cancellation or known zero-usage failure releases the reservation. Failed, expired or interrupted jobs with possible provider usage remain pending for explicit owner reconciliation. Pending holds cannot be spent twice. A released Studio credit hold is not a refund from OpenAI.

The owner can release a pending hold or finalize its charge in Models & credits. Keep this as owner-only testing and settle customer-facing billing, failure/refund, expiration and other terms before selling credits. There is no payment collection, invoice, purchased-credit entitlement or legal-compliance claim in this update.

## Deploy both halves

Allow active builds to finish before upgrading. Upgrade the website first so it accepts the new provider heartbeat, then upgrade the worker. Do not rotate existing credentials or disable Docker restrictions. The worker needs at least one privately configured provider key: OPENAI_API_KEY, DEEPSEEK_API_KEY, or both. Credentials remain under the dedicated worker account; never enter them in the model catalog or copy them into source.

Website, in the root SSH session:

```bash
cd /home/nd-ai-studio
git pull --ff-only origin main
bash deploy/setup-studio.sh
```

Worker, in the existing nd-ai-worker session:

```bash
cd /home/nd-ai-worker/nd-ai-studio
git pull --ff-only origin main
node --test tests/worker.test.mjs tests/worker-entrypoint.test.mjs tests/validator-permissions.test.mjs
bash deploy/setup-worker.sh
systemctl --user status nd-ai-worker.service --no-pager
```

The worker installer rebuilds and pins the updated validator image. The website installer copies all server modules, including studio-models.mjs, and publishes the new model interface assets. Both reuse existing private environments. The additive tables keep the original user_version and preserve existing accounts, source history and jobs.

Then open /workspace.html#admin, select Models & credits, confirm each model and its pricing, choose a default and save the catalog. Credit enforcement can remain off while validating generation. To test credit charging, grant a real test allowance to your account and enable enforcement. Keep the tool in Owner testing on the co-located worker.

A live end-to-end generation and actual rootless Docker validation still need to be verified on the configured host. Automated tests use provider and Docker fixtures; POSIX permission tests exercise actual file modes and, when run as root, reads from an unprivileged UID.
