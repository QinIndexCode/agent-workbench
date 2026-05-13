# Settings Center

The Settings center is the operational control surface for SCC. It decides:

- which model runs tasks
- how tool approvals behave
- whether external tools or chat entrypoints are active
- whether repeat tasks can run
- whether search may go online
- how the UI and local storage behave for you

## Recommended first-time order

1. Add one real model in **Model Providers**
2. Choose a safe approval mode in **Permissions**
3. Connect external tools in **MCP** only if you need them
4. Add **Integrations** only if inbound chat messages should create tasks
5. Add **Scheduled tasks** only if repeat automation is needed
6. Configure **Web search** only if tasks need online evidence
7. Finish with **Preferences** for personal workflow tuning

## What each settings page is for

### Model Providers

Add model endpoints, save local keys, choose the active provider, and manage fallback routing.

### Permissions

Define the tool-risk boundary for the workspace.

### MCP

Connect external tool servers into SCC without bypassing approval or timeline evidence.

### Integrations

Route Discord, Feishu, Slack, Telegram, or WeCom messages into normal SCC tasks with a default folder and permission preset.

### Scheduled Tasks

Create repeat automation that runs while SCC stays open.

### Web Search

Configure the providers behind the built-in `web_search` tool.

### Preferences

Tune language, theme, response style, startup behavior, and local storage hygiene without changing tool approval policy.
