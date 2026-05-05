# Model Providers

SCC supports multiple model providers through a unified abstraction layer. Configuration is stored locally; API keys are written to the local data directory.

## Supported Protocols

### OpenAI-compatible
Providers compatible with the OpenAI API format:
- OpenAI
- Azure OpenAI
- Other compatible services

### Anthropic Messages
Anthropic's Messages API:
- Claude 3.5 Sonnet
- Claude 3 Opus
- Claude 3 Haiku

### Gemini
Google's Gemini API:
- Gemini 1.5 Pro
- Gemini 1.5 Flash

## Configuration Steps

1. Go to the **Providers** tab in Settings
2. Select the protocol type
3. Enter the API key and base URL (if using a custom endpoint)
4. Specify the default model and context window size
5. Save the configuration
