# Model Providers

The Model Providers page is where SCC gets real runtime model access. Without at least one working provider, task execution, title generation, and thread continuation may all be limited.

## What this page affects

- which provider is active for new work
- the available context window for tasks
- whether SCC may fall back to another provider on failure
- which API keys stay stored locally

## Recommended first setup

1. Add one provider that you already trust to return valid results.
2. Save it and confirm it becomes the current provider.
3. Run one real task or title generation request.
4. Only then decide whether a fallback provider is necessary.

## Important fields

### Preset vendor / protocol

Selects a prefilled provider shape. Presets usually include recommended models and a default base URL.

### Base URL

The actual request entrypoint. Verify this carefully for custom-compatible providers.

### Model

Pick from presets or enter a custom model id.

### Context window

Defines the usable context size. Manual values should match the real capabilities of the target model.
