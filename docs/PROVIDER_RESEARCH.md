# Provider verification status

Research date: 2026-10-25. The implemented integration remains the OpenAI Responses API. This record does not enable models, change prices, or establish access to a provider account.

## What was verified

The official OpenAI Python SDK at revision `5d72315876ffd8b72b958623ef4db26da3fb1e61` lists several requested identifiers:

- [Chat model types](https://github.com/openai/openai-python/blob/5d72315876ffd8b72b958623ef4db26da3fb1e61/src/openai/types/shared/chat_model.py): `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`.
- [Responses model types](https://github.com/openai/openai-python/blob/5d72315876ffd8b72b958623ef4db26da3fb1e61/src/openai/types/shared_params/responses_model.py): `gpt-5.5-pro`.

An SDK type is evidence of an identifier, not current availability, pricing, context/output limits, strict JSON-schema support or suitability for this generator. SDKs can retain obsolete identifiers. No model was added or enabled from these lists alone. Other candidate display names have not been converted into guessed API IDs.

Official independent provider sources establish the following distinctions:

- [DeepSeek-V3 README, API section](https://github.com/deepseek-ai/DeepSeek-V3/blob/9b4e9788e4a3a731f7567338ed15d3ec549ce03b/README.md) links its API to `platform.deepseek.com` and describes OpenAI compatibility. This does not establish support for the Responses request used by Studio.
- [Qwen3 README](https://github.com/QwenLM/Qwen3/blob/7a2f61ffc7a20d47efcd2bf97f6f2bf52729042e/README.md) links hosted Qwen models to Alibaba Cloud Model Studio.
- [Qwen-Agent README](https://github.com/QwenLM/Qwen-Agent/blob/31a4d36d123688581a9e9744427272b33ce940e0/README.md) distinguishes its native `qwen_dashscope` adapter and `DASHSCOPE_API_KEY` from other OpenAI-compatible deployments. An example model in that document does not establish its current price or availability on a different platform.

Whether the selected `https://qwen.ai/apiplatform` offers DeepSeek remains unverified. Do not treat Qwen, DashScope, Alibaba Model Studio and independently hosted models as interchangeable accounts or API contracts.

## Blocked checks

The cloud environment's proxy rejected the official DeepSeek and Qwen documentation requests with CONNECT 403. OpenAI pricing/capability documentation was not available through the current allowlist. Required documentation destinations were saved to the environment configuration draft: `api-docs.deepseek.com`, `qwen.ai`, and `developers.openai.com`. Saving a draft does not apply networking changes; review and save the settings before retrying.

The GitHub Actions API also returned Forbidden. `api.github.com` was included in the draft for read-only CI inspection. Native Git access worked but does not establish GitHub API authorization. No current CI outcome was inferred from this failure.

Current provider prices, complete capability contracts, account access and the Qwen hosting question are unresolved. No paid model probes, provider fallback, credential requests or live generation requests were made during this research.

## Conditions for adding an option

Verify the exact ID, text/code capability, structured output contract, current token/cache prices, limits, region-specific endpoint and intended account access against official sources. Keep image, audio, realtime, transcription, translation and restricted specialist pipelines separate from code generation.

Each provider needs a constrained endpoint and its own adapter for request fields, output parsing, refusal/error handling, token usage and caching. Do not change a base URL and assume Responses semantics. Preserve cancellation, bounded repairs, immutable job pricing, conservative reservations and unknown-outcome holds. Never retry or fall back to another paid provider silently.

Studio already allows owner-configured `creditsPerBuild` and premium tiers. Customer credit charges are independent of provider token costs. Keep both configurable and do not invent a currency conversion or new customer balances.
