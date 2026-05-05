# MCP

Model Context Protocol (MCP) is an open protocol for connecting external tool services.

## Features

- Unified tool discovery and calling interface
- Tools run in independent processes
- Dynamic tool list synchronization

## Configuring Local Services

1. Go to the **MCP** tab in Settings
2. Click **Add Service**
3. Enter the service name, launch command, and arguments
4. After saving, the system will attempt to connect and fetch the tool list

## Configuring Remote Services

- SSE (Server-Sent Events) transport is supported
- Tool lists are synced automatically after entering the endpoint

## Usage

- The model generates MCP tool calls when needed
- Execution is handled per the current permission policy
- Results are appended to the task timeline
