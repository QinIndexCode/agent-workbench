# Web Search

The Web Search page configures which providers the built-in `web_search` tool may use. It is not a separate network bypass; outbound search still depends on the `network` permission boundary.

## First setup

1. Open **Settings → Web search**.
2. Click **Add** and choose a search provider.
3. Use DuckDuckGo for a quick trial; use Brave or SerpAPI with an API key for stronger evidence workflows.
4. For Custom providers, the endpoint must include `{query}` and `{limit}`, for example `https://search.example.test?q={query}&limit={limit}`.
5. Save the provider and confirm that it is marked available.

After this setup, the agent has a source it can choose. Actual outbound access is still controlled by the task's `network` approval.

## What this page affects

- whether the agent has any online search source available
- the quality and cost of search evidence
- what happens when network permission is denied

## Provider options

- **DuckDuckGo**: lightest first option, no API key required
- **Brave**: needs an API key and is better suited for formal evidence gathering
- **SerpAPI**: needs an API key and is commonly used for broader search aggregation
- **Custom**: for your own search proxy, requires `{query}` and `{limit}` in the endpoint template

## Permission boundary

Configured providers do **not** automatically allow network access. If `network` permission is denied, the agent must stay on local evidence or explicitly report that it cannot search the web.

## Troubleshooting order

- If search did not happen, first check whether the task timeline requested `network` approval.
- If approval was allowed but there are no results, check whether the provider is available.
- If Brave, SerpAPI, or Custom fails, save the API key or endpoint again.
- If a Custom provider returns empty results, confirm that the server returns a search-result shape Agent Workbench can parse.
