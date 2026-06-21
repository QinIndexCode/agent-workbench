# Model Providers

The Model Providers page is where Agent Workbench gets real runtime model access. Without at least one working provider, task execution, title generation, and thread continuation may all be limited.

## What this page affects

- which provider is active for new work
- the available context window for tasks
- whether Agent Workbench may fall back to another provider on failure
- which API keys stay stored locally

## Recommended first setup

1. Add one provider that you already trust to return valid results.
2. Save it and confirm it becomes the current provider.
3. Click the provider row's connection test and confirm the server can use the current Base URL, model, and locally stored key for a minimal preflight.
4. Run one real task or title generation request to confirm the full path.
5. Only then decide whether a fallback provider is necessary.

## Important fields

### Preset vendor / protocol

Selects a prefilled provider shape. Presets usually include recommended models and a default base URL.

### Base URL

The actual request entrypoint. Verify this carefully for custom-compatible providers.

### Model

Pick from presets or enter a custom model id.

For Xiaomi MiMo pay-as-you-go API, use the OpenAI-compatible endpoint `https://api.xiaomimimo.com/v1` with an `sk-*` API key. MiMo Token Plan is a separate subscription path: keys use the `tp-*` format and the Base URL must come from the Token Plan page, such as `https://token-plan-cn.xiaomimimo.com/v1`, `https://token-plan-sgp.xiaomimimo.com/v1`, or `https://token-plan-ams.xiaomimimo.com/v1`. These two key types are independent and cannot be mixed.

Token Plan docs also publish Anthropic-compatible `/anthropic` endpoints, but the built-in Token Plan presets represent the OpenAI-compatible request shape. Use the matching protocol or a custom endpoint when an external tool expects Anthropic Messages.

Kimi Code Plan requires a stable `prompt_cache_key` to improve cache hit rate. Agent Workbench sends one automatically for official Kimi endpoints in automatic prompt-cache mode. Other custom OpenAI-compatible services do not receive this field by default unless `AGENT_WORKBENCH_PROMPT_CACHE_MODE=always` is set.

Qwen and DeepSeek thinking controls use provider extensions, such as Qwen `enable_thinking` or DeepSeek reasoning controls. The built-in presets keep requests OpenAI-compatible and do not inject non-standard fields that are not exposed in the UI; use provider consoles or future custom extensions when you need per-request thinking control.

### Context window

Defines the usable context size. Manual values should match the real capabilities of the target model.

### Connection test

The connection test sends one minimal model request through the server. The web UI does not read or display the API key. Results separate common failure classes:

- Configuration or API key needs attention: usually 401/403, a missing key, a wrong Base URL, or a mismatched model id.
- Rate limited: usually 429; wait for quota to recover or switch providers.
- Provider temporarily unavailable: usually 5xx or a transient network failure; retry later.

## Prompt caching

Agent Workbench keeps stable instructions and project context at the front of
model requests so providers can reuse prompt prefixes across turns.

Anthropic Messages enables automatic prompt caching by default. Official OpenAI,
official Kimi, and MiMo Token Plan OpenAI-compatible endpoints receive a stable
`prompt_cache_key`. Custom OpenAI-compatible services differ: set
`AGENT_WORKBENCH_PROMPT_CACHE_MODE=always` only when the service documents
support for `prompt_cache_key`. Use `off` to disable explicit cache hints.
Provider usage records expose cached-token counts when the provider returns them.

Cache-hit quality is tracked with a rolling window. The first request is usually
a warmup; later requests with the same provider, model, endpoint, and sorted
tool-name family reuse a stable `prompt_cache_key`. Full tool schemas are still
sent in each request, so cache routing does not remove capabilities or weaken
task quality. Agent Workbench also keeps a short in-memory response cache for
initial direct-answer final replies. It is not used for tool calls, file
evidence, image inputs, or tasks with existing history. For production cost
control, the rolling `cachedTokens / inputTokens` target is at least 90%. If the
ratio stays below target, first check for frequent model, Base URL, tool-set, or
provider-cache-mode changes.
