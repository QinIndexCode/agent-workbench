# Troubleshooting

## Model Not Responding

- Check whether the API key is configured correctly
- Confirm the network connection is normal
- Check the model provider's status page
- Check whether the rate limit has been reached

## Voice Input Unavailable

- Confirm the browser supports the Web Speech API
- Check whether microphone permission has been granted
- Try refreshing the page and re-authorizing

## Tool Execution Failed

- Check whether the current permission level allows the operation
- Confirm tool parameters are correct
- Check error messages in the task timeline

## UI Display Issues

- Try refreshing the page
- Clear browser cache
- Check the browser console for errors

## Data Storage

- Task state, provider/search/integration settings, attachments, checkpoints, memories, and skills are persisted by the local Agent Workbench server in SQLite on this machine.
- Browser storage is used for UI-only state such as local view preferences. Clearing browser data can reset those UI preferences, but it does not delete the server SQLite task history.
- API keys and integration secrets are submitted to the local server, stored as encrypted secret references, and shown back to the Web UI only as redacted metadata such as the last four characters.
- The default server is intended for trusted local access. Do not expose it directly to an untrusted network.
