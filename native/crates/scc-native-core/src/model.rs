use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use scc_native_shared::{CanonicalModelMessage, JsonMap, ModelProviderConfig, ModelTurn, ModelUsage, ToolCall};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

pub type ModelDeltaCallback = Arc<dyn Fn(String) + Send + Sync>;

#[async_trait]
pub trait ModelClient: Send + Sync {
    async fn complete(&self, messages: &[CanonicalModelMessage], tools: &[ToolDefinition], on_delta: Option<ModelDeltaCallback>) -> Result<ModelTurn>;
}

#[derive(Clone)]
pub struct OpenAiCompatibleClient {
    config: ModelProviderConfig,
}

impl OpenAiCompatibleClient {
    pub fn new(config: ModelProviderConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl ModelClient for OpenAiCompatibleClient {
    async fn complete(&self, messages: &[CanonicalModelMessage], tools: &[ToolDefinition], on_delta: Option<ModelDeltaCallback>) -> Result<ModelTurn> {
        let url = format!("{}/chat/completions", self.config.base_url.trim_end_matches('/'));
        let body = json!({
            "model": self.config.model,
            "stream": false,
            "messages": serialize_messages(messages)?,
            "tools": serialize_tools(tools),
            "tool_choice": "auto"
        });
        let response = post_json_with_platform_client(&url, &self.config.api_key, &body).await?;
        let mut turn = parse_chat_completion(&response)?;
        if let (Some(callback), false) = (&on_delta, turn.content.is_empty()) {
            callback(turn.content.clone());
        }
        if turn.content.trim().is_empty() && turn.tool_calls.is_empty() {
            turn.empty_response = true;
        }
        Ok(turn)
    }
}

async fn post_json_with_platform_client(url: &str, api_key: &str, body: &Value) -> Result<Value> {
    let request_path = std::env::temp_dir().join(format!("scc-native-request-{}.json", scc_native_shared::create_id("tmp")));
    tokio::fs::write(&request_path, serde_json::to_vec(body)?).await?;
    let output = if cfg!(windows) {
        let script = format!(
            "$body = Get-Content -Raw -LiteralPath '{}'; Invoke-RestMethod -Method Post -Uri '{}' -Headers @{{ Authorization = 'Bearer {}'; 'Content-Type' = 'application/json' }} -Body $body | ConvertTo-Json -Depth 100",
            escape_powershell_path(&request_path),
            url.replace('\'', "''"),
            api_key.replace('\'', "''")
        );
        Command::new("powershell.exe").args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script]).output().await?
    } else {
        Command::new("curl")
            .args(["-sS", "-X", "POST", url, "-H", &format!("Authorization: Bearer {api_key}"), "-H", "Content-Type: application/json", "--data-binary"])
            .arg(format!("@{}", request_path.display()))
            .output()
            .await?
    };
    let _ = tokio::fs::remove_file(&request_path).await;
    if !output.status.success() {
        return Err(anyhow!("model client failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(serde_json::from_slice(&output.stdout).context("decode model response")?)
}

fn escape_powershell_path(path: &PathBuf) -> String {
    path.display().to_string().replace('\'', "''")
}

fn parse_chat_completion(value: &Value) -> Result<ModelTurn> {
    let Some(message) = value.pointer("/choices/0/message") else {
        return Ok(ModelTurn { empty_response: true, finish_reason: value.pointer("/choices/0/finish_reason").and_then(Value::as_str).map(str::to_string), usage: value.get("usage").map(parse_usage), ..Default::default() });
    };
    let content = message.get("content").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut tool_calls = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let id = call.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let function = call.get("function").unwrap_or(&Value::Null);
            let tool_name = function.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = function
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(|parsed| parsed.as_object().cloned())
                .map(|map| map.into_iter().collect::<JsonMap>())
                .unwrap_or_default();
            if !tool_name.is_empty() {
                tool_calls.push(ToolCall { id: if id.is_empty() { scc_native_shared::create_id("call") } else { id }, tool_name, args });
            }
        }
    }
    if let Some(function_call) = message.get("function_call") {
        let tool_name = function_call.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let args = function_call
            .get("arguments")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|parsed| parsed.as_object().cloned())
            .map(|map| map.into_iter().collect::<JsonMap>())
            .unwrap_or_default();
        if !tool_name.is_empty() {
            tool_calls.push(ToolCall { id: scc_native_shared::create_id("call"), tool_name, args });
        }
    }
    Ok(ModelTurn {
        content,
        thinking: None,
        tool_calls,
        usage: value.get("usage").map(parse_usage),
        empty_response: false,
        finish_reason: value.pointer("/choices/0/finish_reason").and_then(Value::as_str).map(str::to_string),
    })
}

fn parse_usage(value: &Value) -> ModelUsage {
    ModelUsage {
        input_tokens: value.get("prompt_tokens").or_else(|| value.get("input_tokens")).and_then(Value::as_u64),
        output_tokens: value.get("completion_tokens").or_else(|| value.get("output_tokens")).and_then(Value::as_u64),
        total_tokens: value.get("total_tokens").and_then(Value::as_u64),
        cached_tokens: value
            .pointer("/prompt_tokens_details/cached_tokens")
            .or_else(|| value.pointer("/input_tokens_details/cached_tokens"))
            .and_then(Value::as_u64),
    }
}

pub fn serialize_messages(messages: &[CanonicalModelMessage]) -> Result<Vec<Value>> {
    messages
        .iter()
        .map(|message| match message {
            CanonicalModelMessage::System { content } => Ok(json!({"role":"system","content":content})),
            CanonicalModelMessage::User { content, .. } => Ok(json!({"role":"user","content":content})),
            CanonicalModelMessage::Assistant { content, tool_calls } => {
                let calls: Vec<Value> = tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.tool_name,
                                "arguments": serde_json::to_string(&call.args).unwrap_or_else(|_| "{}".to_string())
                            }
                        })
                    })
                    .collect();
                Ok(json!({"role":"assistant","content":content,"tool_calls":calls}))
            }
            CanonicalModelMessage::Tool { tool_call_id, content, .. } => Ok(json!({"role":"tool","tool_call_id":tool_call_id,"content":content})),
        })
        .collect()
}

fn serialize_tools(tools: &[ToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type":"function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters
                }
            })
        })
        .collect()
}

pub fn native_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition { name: "list_files".into(), description: "List live workspace files. Use read_file to inspect file contents.".into(), parameters: json!({"type":"object","properties":{"path":{"type":"string"},"max":{"type":"number"}}}) },
        ToolDefinition { name: "read_file".into(), description: "Read live workspace file content. This is the file-content tool; search_files only returns snippets.".into(), parameters: json!({"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"number"},"limit":{"type":"number"}},"required":["path"]}) },
        ToolDefinition { name: "search_files".into(), description: "Search live workspace paths and line snippets. Supports OR with |. Use read_file for complete content.".into(), parameters: json!({"type":"object","properties":{"path":{"type":"string"},"query":{"type":"string"}},"required":["query"]}) },
        ToolDefinition { name: "write_file".into(), description: "Create or overwrite a workspace file. Existing files require expectedHash from read_file; new files use expectedHash='__new__'.".into(), parameters: json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"},"expectedHash":{"type":"string"}},"required":["path","content","expectedHash"]}) },
        ToolDefinition { name: "edit_file".into(), description: "Edit a line range in a workspace file with expectedHash conflict protection and optional expectedText.".into(), parameters: json!({"type":"object","properties":{"path":{"type":"string"},"expectedHash":{"type":"string"},"startLine":{"type":"number"},"endLine":{"type":"number"},"replacement":{"type":"string"},"expectedText":{"type":"string"}},"required":["path","expectedHash","startLine","endLine","replacement"]}) },
        ToolDefinition { name: "run_command".into(), description: "Run a shell command in the workspace with progress and timeout.".into(), parameters: json!({"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"}},"required":["command"]}) },
        ToolDefinition { name: "knowledge_search".into(), description: "Search saved Knowledge library entries. This is not live source-tree search; verify files with search_files/read_file.".into(), parameters: json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}) },
        ToolDefinition { name: "ask_user".into(), description: "Ask the user for a missing decision or clarification. This pauses the task until answered.".into(), parameters: json!({"type":"object","properties":{"question":{"type":"string"},"required":{"type":"boolean"},"options":{"type":"array","items":{"type":"string"}}},"required":["question"]}) },
    ]
}

#[cfg(test)]
#[derive(Default)]
struct PartialTurn {
    content: String,
    tool_calls: std::collections::BTreeMap<usize, PartialToolCall>,
    usage: Option<ModelUsage>,
    finish_reason: Option<String>,
}

#[cfg(test)]
#[derive(Default)]
struct PartialToolCall {
    name: String,
    arguments: String,
}

#[cfg(test)]
fn parse_sse_line(line: &str, turn: &mut PartialTurn) -> Result<Option<String>> {
    let data = line.trim_start_matches("data:").trim();
    if data == "[DONE]" || data.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(data)?;
    if let Some(usage) = value.get("usage") {
        turn.usage = Some(parse_usage(usage));
    }
    let Some(choice) = value.get("choices").and_then(Value::as_array).and_then(|choices| choices.first()) else {
        return Ok(None);
    };
    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
        turn.finish_reason = Some(reason.to_string());
    }
    let Some(delta) = choice.get("delta") else {
        return Ok(None);
    };
    if let Some(content) = delta.get("content").and_then(Value::as_str) {
        turn.content.push_str(content);
        return Ok(Some(content.to_string()));
    }
    if let Some(function_call) = delta.get("function_call") {
        let partial = turn.tool_calls.entry(0).or_default();
        if let Some(name) = function_call.get("name").and_then(Value::as_str) {
            partial.name.push_str(name);
        }
        if let Some(arguments) = function_call.get("arguments").and_then(Value::as_str) {
            partial.arguments.push_str(arguments);
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_native_roles_and_tool_result() -> Result<()> {
        let messages = vec![
            CanonicalModelMessage::System { content: "sys".into() },
            CanonicalModelMessage::User { content: "u".into(), event_id: Some("e1".into()) },
            CanonicalModelMessage::Tool { tool_call_id: "call_1".into(), tool_name: "read_file".into(), content: "{\"ok\":true}".into() },
        ];
        let json = serialize_messages(&messages)?;
        assert_eq!(json[0]["role"], "system");
        assert_eq!(json[2]["role"], "tool");
        assert_eq!(json[2]["tool_call_id"], "call_1");
        Ok(())
    }

    #[test]
    fn parses_legacy_function_call_stream_without_empty_response() -> Result<()> {
        let mut turn = PartialTurn::default();
        parse_sse_line(r#"data: {"choices":[{"delta":{"function_call":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}},"finish_reason":null}]}"#, &mut turn)?;
        parse_sse_line(r#"data: {"choices":[{"delta":{},"finish_reason":"function_call"}]}"#, &mut turn)?;
        let calls: Vec<_> = turn.tool_calls.into_values().collect();
        assert_eq!(calls[0].name, "read_file");
        assert!(!calls[0].arguments.is_empty());
        Ok(())
    }
}
