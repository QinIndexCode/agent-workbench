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
