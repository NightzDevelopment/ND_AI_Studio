# Provider verification record

Initial research date: 2026-10-25. Cache-accounting review: 2026-10-26. This record covers public documentation and source inspection. It does not establish account access, authorize paid requests, enable a model, or prove live generation. No paid probes or provider fallback requests were made.

The model prices, limits and provider-guide details below retain their earlier research provenance. They were not independently reverified during the cache-accounting review: the OpenAI prompt-caching guide and model-page requests returned proxy HTTP 403. Official SDK sources were accessible and provide the pinned evidence below. Desired network settings do not establish effective runtime access.

## Small coding selection

These candidates have useful documented differences in cost or capability. Prices are USD per one million tokens, excluding tax, regional premiums, optional tools and other service tiers. Studio's provider-cost estimate and its owner-configured internal credit charge remain separate.

| Provider | Exact API model ID | Intended choice | Uncached input | Cached input | Output | Documented context / maximum output |
| --- | --- | --- | ---: | ---: | ---: | --- |
| OpenAI | `gpt-6-luna` | Efficient, focused coding tasks | 0.10 | 0.01 | 0.50 | 1,050,000 / 128,000 tokens |
| OpenAI | `gpt-6.1-sol` | Complex coding with lower cost than Astra | 2.00 | 0.10 | 10.00 | 1,050,000 / 128,000 tokens |
| OpenAI | `gpt-6-astra` | Premium, demanding coding and reasoning | 10.00 | 1.00 | 50.00 | 1,050,000 / 128,000 tokens |
| DeepSeek | `deepseek-flash` | Low-cost alternative provider | 0.30 | 0.006 | 1.20 | Advertised 1M / 384K tokens |
| DeepSeek | `deepseek-v4-pro` | Higher-end DeepSeek alternative | 1.32 | 0.044 | 3.96 | Advertised 1M / 384K tokens |

The OpenAI rows use Standard processing and the short-input price band. Their model pages explicitly support Responses and structured outputs. They accept text and image input and return text; Studio uses their text/code path only. Studio can retain its smaller source and output limits.

The DeepSeek rows deliberately use **peak prices as conservative estimates**. Off-peak prices are half these amounts. The provider defines peak hours as Monday through Friday, 01:00-04:00 and 06:00-10:00 UTC, excluding Chinese public holidays. Frozen peak-price snapshots avoid pretending to implement the provider's holiday calendar or predicting which price window a request will finish in. Actual provider charges may be lower. This is an estimate, not a provider invoice.

DeepSeek documents `deepseek-flash` as served by DeepSeek-V4.1-Flash-1017 and `deepseek-v4-pro` by DeepSeek-V4-Pro-0813. Legacy Flash aliases are accepted but point to retired model names; use the current documented ID instead.

Sources:

- [OpenAI pricing](https://developers.openai.com/api/docs/pricing).
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).
- [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/). The trailing-slash URL returned the pricing page during this research; the path without a trailing slash unexpectedly returned the introductory page.

Prices and aliases can change. Recheck official documentation before updating presets, and preserve the exact model, prices, provider, limits and credit quote captured by an existing job. Owner-configured premium credit charges do not imply an automatic conversion from provider spending to customer money.

## OpenAI request and accounting contract

Use the fixed HTTPS endpoint `https://api.openai.com/v1/responses`, a private worker credential and the documented Responses JSON-schema output format. Do not enable built-in tools or a different processing tier implicitly.

For the three OpenAI candidates above, prompts exceeding 272K input tokens use twice the ordinary input and cache rates and 1.5 times the output rate for the full request. These multipliers are verified for these model profiles, not arbitrary older or custom models.

Caching needs explicit treatment. The earlier prompt-caching research recorded write rates of 1.25 times ordinary input for 30 minutes and 2.5 times ordinary input for 12 hours. These remain historical reference values requiring a current pricing check before configuration. The SDK sources inspected in the later review do not establish either price and currently type only a `30m` request TTL. Do not assume that every model supports both lifetimes.

The official [Python Responses usage type](https://github.com/openai/openai-python/blob/5d72315876ffd8b72b958623ef4db26da3fb1e61/src/openai/types/responses/response_usage.py#L8-L18) and [Node Responses usage type](https://github.com/openai/openai-node/blob/7562cd29af87561ccce4e1ec4b873c2c04c97f87/src/resources/responses/responses.ts#L9385-L9400) define `input_tokens_details.cache_write_tokens` and `cached_tokens` without a required lifetime breakdown. Positive aggregate writes without `cache_write_tokens_details` are therefore compatible with these schemas. SDK types do not prove that an enriched breakdown can never appear; they do rule out treating that breakdown as a universal requirement.

When a response supplies an enriched breakdown, its supported accounting shape is:

```json
{
  "usage": {
    "input_tokens": 12000,
    "input_tokens_details": {
      "cached_tokens": 4000,
      "cache_write_tokens": 7000,
      "cache_write_tokens_details": {
        "ttl_30m_tokens": 3000,
        "ttl_12h_tokens": 4000
      }
    }
  }
}
```

Here ordinary input is `12000 - 4000 - 7000 = 1000`. Validate nonnegative safe integer counts, nonoverlap with cached reads and write components summing to the aggregate. If the captured rates are known, charge ordinary tokens at the ordinary input rate, reads at the cached rate, and each write component at its corresponding write rate. Writes replace the ordinary input rate for those tokens. Output tokens already include reasoning tokens; do not add that subset again. Inconsistent counts cannot support an exact cost calculation.

The pinned [Python request schema](https://github.com/openai/openai-python/blob/5d72315876ffd8b72b958623ef4db26da3fb1e61/src/openai/types/responses/response_create_params.py#L169-L180) documents `prompt_cache_options` for GPT-5.6 and later, implicit caching by default and a default `30m` TTL. Its [options type](https://github.com/openai/openai-python/blob/5d72315876ffd8b72b958623ef4db26da3fb1e61/src/openai/types/responses/response_create_params.py#L407-L441) and [Node equivalent](https://github.com/openai/openai-node/blob/7562cd29af87561ccce4e1ec4b873c2c04c97f87/src/resources/responses/responses.ts#L12078-L12117) document that top-level `prompt_cache_options: { "mode": "explicit" }` without explicit breakpoints uses no prompt caching. This policy must be confined to supported model profiles and captured with the job. Do not send new caching fields to arbitrary legacy models or infer a custom model's policy or price from its identifier. The separate [retention field](https://github.com/openai/openai-python/blob/5d72315876ffd8b72b958623ef4db26da3fb1e61/src/openai/types/responses/response_create_params.py#L183-L200) describes maximum retention, whereas TTL is a minimum lifetime; a `24h` retention setting does not establish a 12-hour write-price band. `store: false` does not select a cache policy.

If aggregate writes lack a lifetime allocation, or a needed captured write price is absent, provider cost remains unreconciled. Custom models may have `provider-default` caching and null write prices; the worker must not invent either a TTL or a price. Keep the full existing job budget reserved and record explicit `result.accounting` metadata for owner reconciliation. This retained amount is a reservation estimate, not a provider invoice or a proven upper bound on the actual charge. Independently known ordinary, cached-read, output and priced-write costs still apply: if their minimum already exceeds the remaining budget, fail the build and retain that known minimum with unreconciled metadata. Missing billing detail alone does not invalidate returned source: other bounded source still undergoes the ordinary offline validation and delivery path, without another paid repair request to obtain billing metadata. A successfully delivered result settles its captured fixed Studio credit charge exactly once, independently of unresolved provider cost.

[Official prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching), inaccessible during the later review; use the pinned SDK evidence above for the corrected response-shape requirement.

## DeepSeek request and accounting contract

Use a separate provider selection, credential and constrained HTTPS endpoint: `https://api.deepseek.com/responses`. Responses support was verified directly, rather than inferred from the label "OpenAI-compatible."

The official API reference documents:

- `input`, `instructions`, `max_output_tokens` and non-streaming Responses requests.
- `text.format: { "type": "json_schema", "name": "...", "schema": { ... } }`. It also supports JSON-object mode. The format reference enumerates type, name and schema; do not depend on an undocumented `strict` flag for enforcement. Validate the returned source schema, paths and limits locally.
- `reasoning: { "effort": "none" }` explicitly disables thinking. Without an override, thinking is enabled with high effort. Output limits include reasoning and visible output together.
- A stateless response with `status`, `output`, and Responses-shaped `usage.input_tokens`, `usage.input_tokens_details.cached_tokens`, and `usage.output_tokens`. Reasoning tokens are a subset of output.
- `store` is unsupported and the response always reports `store: false`. Previous-response IDs, conversations and background mode are unsupported. Many unsupported parameters are silently ignored.
- Prompt caching is managed automatically. The documented prices distinguish cache hits and misses, without a separate cache-write price. OpenAI cache-control and cache-write assumptions must not be copied into this adapter.
- Non-streaming requests may emit blank keep-alive lines before the JSON response. A client timeout and bounded response size still apply. The server closes a connection if inference has not started after ten minutes. A timeout is an uncertain billed outcome, not permission to retry the paid request.
- A non-personal custom `user` identifier can isolate cache and scheduling on the Responses interface. Do not send Discord identity or other personal information for this purpose.

Sources:

- [Responses compatibility guide](https://api-docs.deepseek.com/guides/responses_api).
- [Create response API reference](https://api-docs.deepseek.com/api/create-response).
- [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode).
- [Context caching](https://api-docs.deepseek.com/guides/kv_cache).
- [Rate limits, identity isolation and keep-alives](https://api-docs.deepseek.com/quick_start/rate_limit).
- [JSON-output guide](https://api-docs.deepseek.com/guides/json_mode). Its Chat Completions examples do not by themselves establish the Responses schema contract; the separate Responses reference does.

Keep source validation, rootless container checks, cancellation, bounded repair, budget reservations, immutable prices and unknown-outcome holds common across providers. Never retry or silently fall back to another paid provider.

## Qwen platform remains unresolved

The selected [qwen.ai API-platform URL](https://qwen.ai/apiplatform) returned HTTP 200, but its response was a JavaScript application shell rather than an inspectable API catalog. Its script assets reference `g.alicdn.com`; those requests returned HTTP 403 during the research. The required documentation/script destinations were saved to the environment configuration draft. Saving a draft does not prove runtime propagation.

The shell contains DeepSeek terms in metadata keywords. **Search keywords are not evidence that the platform sells or serves DeepSeek.** Whether this selected Qwen platform offers DeepSeek remains unverified. No Qwen model ID, price, adapter contract or credential interchangeability was inferred from that page.

Independent official sources establish narrower facts:

- [Qwen3 README](https://github.com/QwenLM/Qwen3/blob/7a2f61ffc7a20d47efcd2bf97f6f2bf52729042e/README.md) links hosted Qwen models to Alibaba Cloud Model Studio.
- [Qwen-Agent README](https://github.com/QwenLM/Qwen-Agent/blob/31a4d36d123688581a9e9744427272b33ce940e0/README.md) distinguishes a native `qwen_dashscope` adapter and `DASHSCOPE_API_KEY` from other OpenAI-compatible deployments.

These facts do not prove that Qwen, DashScope, Alibaba Model Studio and independent hosting share accounts, model catalogs or API contracts. Qwen integration needs selected-platform evidence before implementation or enablement.

## Remaining candidates and acceptance

The [official OpenAI SDK model types](https://github.com/openai/openai-python/blob/5d72315876ffd8b72b958623ef4db26da3fb1e61/src/openai/types/shared/chat_model.py) and [Responses types](https://github.com/openai/openai-python/blob/5d72315876ffd8b72b958623ef4db26da3fb1e61/src/openai/types/shared_params/responses_model.py) identify additional requested names, including `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4` and `gpt-5.4-mini`. SDK presence is not sufficient verification of their current price, lifecycle, limits, account access or suitability. SDKs retain deprecated values. Do not convert unverified display names into guessed IDs or bulk-enable candidates.

Image, audio, realtime, transcription, translation and restricted specialist models need their own implemented pipelines and billing units. They do not belong in the coding selector merely because an identifier exists.

Fixture tests can verify endpoint constraints, payloads, usage parsing, cancellation and accounting. They do not verify live account access, output quality, provider billing or container enforcement. Keep credentials private on workers, leave newly offered choices disabled until the owner deliberately configures them, and disclose any separately authorized live acceptance test and its budget.
