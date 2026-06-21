# MCP

The MCP page connects external tool servers into Agent Workbench and keeps those tools inside the same approval, evidence, and timeline system as built-in tools.

## Supported transport types

### stdio

Best for local scripts or local services. You normally provide:

- command
- arguments
- optional working directory

### streamable HTTP

Best for remote MCP endpoints. You normally provide just the URL.

## What risk overrides actually do

Risk overrides do **not** downgrade an entire server. They only remap the risk class for one named tool.

## Best first validation

1. Add one small MCP server
2. Connect it successfully
3. Confirm its tools appear in the discovered-tool list
4. Disconnect it and confirm discovery disappears

## Browser and computer-control tools

Agent Workbench keeps the built-in tool surface small: shell, workspace files, web search, knowledge, memory, skills, and task controls. Browser automation and richer desktop/computer-control tools should be connected as MCP servers instead of being assumed to exist by default.

For browser work, prefer a Playwright-compatible or browser-control MCP server that exposes explicit tools such as navigate, click, type, screenshot, console logs, and DOM inspection. Keep risky tools mapped accurately:

- screenshots, DOM reads, and console reads are usually `workspace_read` or `host_observation`
- navigation to external sites is usually `network`
- clicks, form entry, downloads, uploads, or desktop actions may require `shell` or `destructive` depending on impact

Configure browser tools to prefer selectors, roles, or accessibility-tree targets. Coordinate clicks should be a fallback for targets that have no semantic locator. After every click, type, hotkey, drag, upload, or download, capture fresh evidence: screenshot, DOM, console/network output, or the actual resulting file.

Desktop/computer-control tools affect host state, and on Windows they usually operate the active foreground desktop. Do not downgrade an entire MCP server for convenience. Set risk overrides per tool, and treat clipboard access, global hotkeys, file pickers, system settings, account/payment flows, and deletions as high-risk actions.

After connecting a browser or computer-control MCP server, verify it against a harmless local URL or test window: open the target, capture one screenshot or DOM/window snapshot, and confirm the resulting tool evidence appears in the task timeline. If no real tool evidence exists, do not claim that keyboard, mouse, or browser interaction was tested.
