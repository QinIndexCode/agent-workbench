# Integrations

The Integrations page turns external chat messages into normal SCC tasks. It does **not** create a hidden execution path that bypasses folders, models, or approvals.

## What this page affects

- whether external messages can create SCC tasks
- which folder those tasks land in
- which default permission preset they start with
- how verification or connection failures surface in the UI

## Supported platforms

### Discord

Use this when inbound work should start from slash commands or Discord interactions.

- **Bot token**
- **Discord public key**
- **App ID**
- **Callback URL**

Verification:

- SCC verifies `X-Signature-Ed25519` and the timestamp.
- A wrong public key or mismatched endpoint will fail immediately.

### Feishu / Lark

Use this when Feishu or Lark text messages should become SCC tasks.

- **Verification token**
- **App secret**
- **Encrypt key**
- **Callback URL**

Verification:

- SCC validates the verification token first.
- If your app uses encrypted callbacks, add the encrypt key and app secret too.

### Slack

Use this when Slack Events API messages should create SCC tasks.

- **Signing secret**
- **Callback URL**

Verification:

- SCC validates `X-Slack-Signature` and the timestamp.
- The first request is usually a `url_verification` challenge.

### Telegram

Use this when Telegram bot messages should create SCC tasks.

- **Bot token**
- **Secret token**
- **Callback URL**

Verification:

- SCC checks `X-Telegram-Bot-Api-Secret-Token`.
- Keep the bot token server-side only.

### WeCom

Use this when WeCom callbacks should create SCC tasks.

- **Callback token**
- **EncodingAESKey**
- **Callback URL**

Verification:

- SCC validates `msg_signature`.
- The callback must pass the GET echo handshake before event delivery works.

## Recommended setup order

1. Choose the default work folder first.
2. Choose the default permission preset next.
3. Fill the provider-specific verification fields and callback URL.
4. Save once while still disabled and confirm the values come back correctly.
5. Validate with a test bot or test channel.
6. Only then decide whether the integration should stay enabled long term.

## Status meanings

- **Setup needed**: required fields are still missing.
- **Connected**: the current configuration is sufficient for verified inbound traffic.
- **Paused**: the configuration is stored, but SCC will not create new tasks from this provider.
- **Error**: the latest verification or inbound processing failed.
