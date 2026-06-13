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

For Xiaomi MiMo, use the OpenAI-compatible endpoint `https://api.xiaomimimo.com/v1` and the lowercase model ids from the preset, such as `mimo-v2.5-pro`. Keeping the model id and context window aligned prevents the workbench from unnecessarily capping request size.

### Context window

Defines the usable context size. Manual values should match the real capabilities of the target model.

### Connection test

The connection test sends one minimal model request through the server. The web UI does not read or display the API key. Results separate common failure classes:

- Configuration or API key needs attention: usually 401/403, a missing key, a wrong Base URL, or a mismatched model id.
- Rate limited: usually 429; wait for quota to recover or switch providers.
- Provider temporarily unavailable: usually 5xx or a transient network failure; retry later.

## Prompt caching

Agent Workbench keeps stable instructions, project context, and deterministic
tool schemas at the front of model requests so providers can reuse prompt
prefixes across turns.

Anthropic Messages enables automatic prompt caching by default. Official OpenAI
endpoints also receive a stable `prompt_cache_key`. Custom OpenAI-compatible
services differ: set `AGENT_WORKBENCH_PROMPT_CACHE_MODE=always` only when the
service documents support for `prompt_cache_key`. Use `off` to disable explicit
cache hints. Provider usage records expose cached-token counts when the provider
returns them.
