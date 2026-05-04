SCNet 平台
baseUrl: https://api.scnet.cn/api/llm/v1
apiKey: sk-MTMxLTIyMTI1NTg1MjYyLTE3NzMzODg5MTIwNjA=

| 模型 | 上下文长度 | 输入价格 (元/百万 Tokens) | 输出价格 (元/百万 Tokens) |
|------|-----------|--------------------------|--------------------------|
| Qwen3-235B-A22B-Thinking-2507 | 32K | 0.5 | 5 |
| MiniMax-M2.5 | 128K | 0.5 | 2 |
| MiniMax-M2 | 128K | 0.5 | 2 |
| DeepSeek-V3.2 | 128K | 0.5 | 0.75 |
| Qwen3-30B-A3B-Instruct-2507 | 256K | 0.5 | 0.5 |
| DeepSeek-R1-0528 | 128K | 1 | 4 |
| Qwen3-235B-A22B | 32K | 0.5 | 2 |
| Qwen3-30B-A3B | 128K | 1 | 6 |
| QwQ-32B | 32K | 1 | 4 |
| DeepSeek-R1-Distill-Llama-70B | 32K | 0.1 | 6 |
| DeepSeek-R1-Distill-Qwen-32B | 32K | 1 | 4 |
| DeepSeek-R1-Distill-Qwen-7B | 32K | 0.1 | 0.1 |

---
xiaomi (mimo)
apiKey: sk-cveazkhtzwwltor1ask2gahiewdyrcl5hc69ghapt6yh6g85 （deleted）

baseUrl: https://api.xiaomimimo.com/v1/chat/completions
canonicalLiveModel: mimo-v2.5

tokenPlan:
tokenPlanApiKey:tp-c7mx25u6fcl40op6yuyj7dqsavppv9lqtgfdiyvfionqbio3
baseUrl:https://token-plan-cn.xiaomimimo.com/v1 (openAi)


| 模型 | 类别 | 上下文 | 输出 | 价格 (国内) | 价格 (海外) | 特点 |
|------|------|--------|------|-------------|-------------|------|
| mimo-v2-pro | 通用大模型 | 1M | 128K | ¥7.00/¥21.00 | $1.00/$3.00 | 深度思考、函数调用 |
| mimo-v2-omni | 全模态理解 | 256K | 128K | ¥2.80/¥14.00 | $0.40/$2.00 | 全模态理解 |
| mimo-v2-tts | 语音合成 | 8K | 8K | 免费 | 免费 | 语音合成 |
| mimo-v2-flash | 通用大模型 | 256K | 64K | ¥0.70/¥2.10 | $0.10/$0.30 | 深度思考、轻量快速 |

---
ollama
baseUrl: https://ollama.com
apiKey: 2bac1696b4344ba3b39ede68cfb0507a.alsRbPNjfGsOeojpxJgnNqqu
getModels: curl https://ollama.com/api/tags

<details>
<summary>模型列表 (34 models)</summary>

### Reasoning & Thinking Models
| 模型 | 参数量 | 大小 | 特点 |
|------|--------|------|------|
| kimi-k2-thinking | - | 1.04 TB | 思考模型 |
| kimi-k2:1t | 1T | 1.04 TB | 思考增强 |
| kimi-k2.5 | - | 1.04 TB | 最新思考 |
| cogito-2.1:671b | 671B | 641 GB | 高推理能力 |

### Coding Models
| 模型 | 参数量 | 大小 | 特点 |
|------|--------|------|------|
| qwen3-coder-next | - | 76 GB | 最新代码模型 |
| qwen3-coder:480b | 480B | 476 GB | 超大代码模型 |
| devstral-2:123b | 123B | 119 GB | 代码专用 |
| devstral-small-2:24b | 24B | 48 GB | 轻量代码 |

### General Purpose Models
| 模型 | 参数量 | 大小 | 特点 |
|------|--------|------|------|
| glm-5 | - | 704 GB | 最新 GLM |
| glm-4.7 | - | 648 GB | 大型 GLM |
| glm-4.6 | - | 648 GB | GLM 系列 |
| deepseek-v3.2 | - | 641 GB | 最新 DeepSeek |
| deepseek-v3.1:671b | 671B | 641 GB | V3 系列 |
| qwen3.5:397b | 397B | 370 GB | 超大 Qwen |
| qwen3-vl:235b | 235B | 438 GB | 视觉语言 |
| qwen3-vl:235b-instruct | 235B | 438 GB | VL 指令调优 |
| qwen3-next:80b | 80B | 76 GB | 最新 Qwen |
| mistral-large-3:675b | 675B | 635 GB | Mistral 最大 |
| nemotron-3-super | - | 215 GB | NVIDIA |
| gemma3:27b | 27B | 51 GB | Google |
| gemma3:12b | 12B | 22 GB | Gemma 中型 |
| gemma3:4b | 4B | 8 GB | Gemma 轻量 |
| ministral-3:14b | 14B | 15 GB | Mistral 中型 |
| ministral-3:8b | 8B | 10 GB | Mistral 小型 |
| ministral-3:3b | 3B | 4.3 GB | Mistral 微型 |
| nemotron-3-nano:30b | 30B | 30 GB | NVIDIA 轻量 |
| gpt-oss:120b | 120B | 61 GB | GPT 开源 |
| gpt-oss:20b | 20B | 13 GB | GPT 小型 |

### Other Models
| 模型 | 参数量 | 大小 | 特点 |
|------|--------|------|------|
| minimax-m2.7 | - | 214 GB | 最新 MiniMax |
| minimax-m2.5 | - | 214 GB | MiniMax 更新 |
| minimax-m2.1 | - | 214 GB | MiniMax 迭代 |
| minimax-m2 | - | 214 GB | MiniMax 基础 |
| gemini-3-flash-preview | - | - | Google 预览 |
| rnj-1:8b | 8B | 15 GB | 特殊用途 |

</details>
