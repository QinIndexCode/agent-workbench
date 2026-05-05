# Model Providers

SCC 通过统一的抽象层支持多种模型服务商。配置信息存储在本地，API Key 写入本地数据目录。

## 支持协议

### OpenAI-compatible
兼容 OpenAI API 格式的服务商：
- OpenAI
- Azure OpenAI
- 其他兼容服务

### Anthropic Messages
Anthropic 的 Messages API：
- Claude 3.5 Sonnet
- Claude 3 Opus
- Claude 3 Haiku

### Gemini
Google 的 Gemini API：
- Gemini 1.5 Pro
- Gemini 1.5 Flash

## 配置步骤

1. 进入设置页面的 **Providers** 标签
2. 选择协议类型
3. 填写 API Key 和基础 URL（如使用自定义端点）
4. 指定默认模型和上下文窗口大小
5. 保存配置
