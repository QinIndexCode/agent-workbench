# Web Search

The Web Search page configures which providers the built-in `web_search` tool may use. It is not a separate network bypass; outbound search still depends on the `network` permission boundary.

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
