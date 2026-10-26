# Model selection, internal credits and validator permissions

This document describes the legacy fixed-price testing-credit system. Optional monthly subscriptions now have a separate usage allowance, checkout and cancellation flow described in [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md). Subscriptions are disabled by default; historical wallet balances retain their original units. Automatic provider-price synchronization is not implemented.

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

See [the provider verification record](PROVIDER_RESEARCH.md) for exact IDs, earlier reference rates and the later SDK accounting review. The new OpenAI profiles disable prompt caching using supported explicit mode without breakpoints. Accounting understands nonoverlapping cached reads, optional 30-minute/12-hour write breakdowns and the configured whole-request long-context price bands. DeepSeek estimates use peak prices and provider-managed hit/miss caching; actual off-peak charges can be lower. Existing job profiles retain their captured policy and rates. The earlier rate tables were not freshly verified during the later review because the OpenAI guide and model-page requests returned proxy HTTP 403.

Official [Python](https://github.com/openai/openai-python/blob/5d72315876ffd8b72b958623ef4db26da3fb1e61/src/openai/types/responses/response_usage.py#L8-L18) and [Node](https://github.com/openai/openai-node/blob/7562cd29af87561ccce4e1ec4b873c2c04c97f87/src/resources/responses/responses.ts#L9385-L9400) Responses schemas allow aggregate `cache_write_tokens` without lifetime counts. An optional breakdown must have valid counts summing to that aggregate before its captured rates can be applied exactly. Missing lifetime allocation or a needed write price leaves provider accounting unreconciled; it does not mean the writes were free or that returned source is invalid. Custom models using `provider-default` caching with null write prices do not acquire a TTL or rate from their names.

For that unreconciled case, the worker retains the full existing job budget reservation and records `result.accounting` metadata for owner reconciliation, while bounded source proceeds through offline validation and delivery. If independently known token costs already exceed the remaining budget, the build fails and records that known minimum instead of delivering over-budget output. It does not make another paid repair call to recover billing detail. The retained budget or known minimum is an estimate, not a provider invoice or a proven upper bound. Other invalid usage counts still cannot support an exact calculation.

Every submitted job captures the provider, selected model, caching policy, prices, pricing version and limits. Editing the catalog does not silently reprice an existing job. A stale browser quote is rejected before enqueue. Unexpected client pricing fields are rejected. Provider cost calculations validate token subsets and do not add reasoning tokens a second time to output_tokens. A worker advertises which provider keys are configured, without reporting their values. A model without a matching healthy worker is rejected before job/credit reservation; a queued job keeps its provider snapshot and is never silently rerouted.

## Internal Studio credits

Credit enforcement is off by default. Existing users receive no invented balance. The owner can grant or adjust credits for registered Discord accounts with a required reason, revision check and idempotent request ID. The ledger records every reserve, release, pending hold, charge and adjustment.

When enabled, the selected model's fixed credits are reserved atomically with the job. A successfully delivered validated result is charged once. Automatic saving and replaying a completion do not add another charge. Validated output retained because a newer revision or source quota blocks saving is still delivered output and has the same credit treatment as the earlier proposal workflow. A queued cancellation or known zero-usage failure releases the reservation. New failed, expired or interrupted jobs release their full customer reservation even when a provider may bill Studio. Jobs captured under the historical review policy still remain pending for explicit owner reconciliation. Pending holds cannot be spent twice. A released Studio credit hold is not a refund from OpenAI.

A delivered result with unreconciled provider token cost still settles its captured fixed Studio credit charge once. Provider budget retention and customer Studio credits are separate records; unknown provider billing does not invent a refund, an additional credit charge or an exact provider invoice.

The owner can release a pending hold or finalize its charge in Models & credits. Keep this as owner-only testing and settle customer-facing billing, failure/refund, expiration and other terms before selling credits. There is no payment collection, invoice, purchased-credit entitlement or legal-compliance claim in this update.

## Deploy both halves

Allow active builds to finish before upgrading. Upgrade the website first so it accepts the worker's optional unreconciled-accounting receipt, then upgrade the worker. Older workers remain compatible with the updated website; an older website rejects the new receipt field. Do not rotate existing credentials or disable Docker restrictions. The worker needs at least one privately configured provider key: OPENAI_API_KEY, DEEPSEEK_API_KEY, or both. Credentials remain under the dedicated worker account; never enter them in the model catalog or copy them into source.

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
