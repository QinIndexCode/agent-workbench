# 集成

集成页用于把外部聊天平台的消息变成普通 SCC 任务。它不会创建一套绕过权限和工作区边界的独立执行流。

## 这页会影响什么

- 外部消息能否创建 SCC 任务
- 新任务默认落入哪个文件夹
- 新任务默认带什么权限预设
- 平台验签和连接异常如何暴露在界面上

## 当前支持的平台

### Discord

适合把 Slash Command 或 Interaction 请求转成 SCC 任务。

- **Bot Token**
- **Discord Public Key**
- **App ID**
- **Callback URL**

验签方式：

- SCC 会校验 `X-Signature-Ed25519` 和时间戳。
- Public Key 错误或回调地址不匹配会直接失败。

### 飞书 / Lark

适合把飞书 / Lark 文本消息转成 SCC 任务。

- **Verification Token**
- **App Secret**
- **Encrypt Key**
- **Callback URL**

验签方式：

- SCC 优先校验 verification token。
- 如果你启用了加密回调，再补 encrypt key 和 app secret。

### Slack

适合把 Slack Events API 的消息转成 SCC 任务。

- **Signing Secret**
- **Callback URL**

验签方式：

- SCC 会校验 `X-Slack-Signature` 和时间戳。
- 首次接入通常先收到 `url_verification` challenge。

### Telegram

适合把 Telegram bot 消息转成 SCC 任务。

- **Bot Token**
- **Secret Token**
- **Callback URL**

验签方式：

- SCC 会校验 `X-Telegram-Bot-Api-Secret-Token`。
- Bot Token 只应保存在服务端。

### WeCom

适合把企业微信回调转成 SCC 任务。

- **Callback Token**
- **EncodingAESKey**
- **Callback URL**

验签方式：

- SCC 会校验 `msg_signature`。
- 必须先通过 GET echo 握手，后续事件投递才会生效。

## 推荐配置顺序

1. 先决定默认工作文件夹。
2. 再决定默认权限预设，不要为了省事直接给完全访问。
3. 填好平台要求的验签字段和回调地址。
4. 先保持关闭状态保存一次，确认字段回显正常。
5. 用测试频道或测试机器人做连接验证。
6. 连接成功后，再决定是否长期开启接收消息。

## 状态如何理解

- **待配置**：关键字段不足，或配置不足以完成校验
- **连接中**：系统正在尝试建立或刷新状态
- **已连接**：当前允许创建新任务
- **已暂停**：配置保留，但不会再创建新任务
- **异常**：平台连接、字段或回调存在问题

## 推荐的首次验证

1. 新建一个测试集成
2. 连接成功
3. 发一条平台消息
4. 确认 SCC 中真的出现新任务
5. 确认任务落在你指定的文件夹
6. 确认任务仍走正常权限审批
