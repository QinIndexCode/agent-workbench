use crate::store::NativeStore;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use ignore::WalkBuilder;
use regex::Regex;
use scc_native_shared::{create_id, now_iso, JsonMap, KnowledgeItem, RiskCategory, ToolCall, ToolResult};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const LARGE_FILE_BYTES: u64 = 256 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgressUpdate {
    pub status: String,
    pub target_path: Option<String>,
    pub operation: Option<String>,
    pub message: Option<String>,
    pub changes: Option<FileChangeSummary>,
    pub processed: Option<u64>,
    pub total: Option<u64>,
    pub unit: Option<String>,
    pub tail: Option<String>,
    pub display_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSummary {
    pub path: String,
    pub added_lines: usize,
    pub removed_lines: usize,
    pub operation: String,
}

pub type ProgressCallback = Arc<dyn Fn(ToolProgressUpdate) + Send + Sync>;

#[derive(Clone, Default)]
pub struct ToolExecutionOptions {
    pub work_root: PathBuf,
    pub on_progress: Option<ProgressCallback>,
}

#[async_trait]
pub trait ToolExecutor: Send + Sync {
    async fn execute(&self, call: ToolCall, options: ToolExecutionOptions) -> ToolResult;
}

#[derive(Clone)]
pub struct NativeToolExecutor {
    store: NativeStore,
}

impl NativeToolExecutor {
    pub fn new(store: NativeStore) -> Self {
        Self { store }
    }

    pub fn assess(&self, call: &ToolCall) -> RiskCategory {
        match call.tool_name.as_str() {
            "list_files" | "read_file" | "search_files" | "knowledge_search" => RiskCategory::WorkspaceRead,
            "write_file" | "edit_file" => RiskCategory::WorkspaceWrite,
            "run_command" => RiskCategory::Shell,
            "ask_user" => RiskCategory::HostObservation,
            _ => RiskCategory::HostObservation,
        }
    }

    async fn execute_inner(&self, call: &ToolCall, options: &ToolExecutionOptions) -> Result<Value> {
        match call.tool_name.as_str() {
            "list_files" => self.list_files(call, options).await,
            "read_file" => self.read_file(call, options).await,
            "search_files" => self.search_files(call, options).await,
            "write_file" => self.write_file(call, options).await,
            "edit_file" => self.edit_file(call, options).await,
            "run_command" => self.run_command(call, options).await,
            "knowledge_search" => self.knowledge_search(call).await,
            "ask_user" => Ok(json!({"status":"waiting_for_user","question": arg_string(&call.args, "question")?})),
            other => Err(anyhow!("Unknown tool: {other}")),
        }
    }

    async fn list_files(&self, call: &ToolCall, options: &ToolExecutionOptions) -> Result<Value> {
        let root = resolve_workspace_path(&options.work_root, &arg_string_default(&call.args, "path", "."))?;
        emit(options, "running", Some(&root), Some("list"), "Scanning files.", None, None, None);
        let mut files = Vec::new();
        let max = arg_u64_default(&call.args, "max", 200) as usize;
        for entry in WalkBuilder::new(&root).max_depth(Some(4)).hidden(false).build().filter_map(Result::ok) {
            if files.len() >= max {
                break;
            }
            if entry.file_type().is_some_and(|ft| ft.is_file()) {
                files.push(entry.path().display().to_string());
            }
        }
        Ok(json!({"path": root, "files": files, "truncated": files.len() >= max}))
    }

    async fn read_file(&self, call: &ToolCall, options: &ToolExecutionOptions) -> Result<Value> {
        let path = resolve_workspace_path(&options.work_root, &arg_string(&call.args, "path")?)?;
        let meta = tokio::fs::metadata(&path).await?;
        emit(options, "running", Some(&path), Some("read"), "Reading file.", None, Some(0), Some(meta.len()));
        let content = tokio::fs::read_to_string(&path).await?;
        let total_lines = line_count(&content);
        let hash = hash_text(&content);
        let offset = arg_u64(&call.args, "offset").map(|v| v.max(1) as usize);
        let limit = arg_u64(&call.args, "limit").map(|v| v.max(1) as usize);
        let (mode, body, partial) = if let Some(offset) = offset {
            let limit = limit.unwrap_or(200);
            let lines: Vec<_> = content.lines().skip(offset - 1).take(limit).collect();
            ("range", lines.join("\n"), offset > 1 || offset + limit <= total_lines)
        } else if meta.len() <= LARGE_FILE_BYTES {
            ("full", content.clone(), false)
        } else {
            let head = content.lines().take(220).collect::<Vec<_>>().join("\n");
            let tail = content.lines().rev().take(120).collect::<Vec<_>>();
            let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
            ("large_preview", format!("{head}\n\n... large file omitted ...\n\n{tail}"), true)
        };
        emit(options, "completed", Some(&path), Some("read"), "Read complete.", None, Some(meta.len()), Some(meta.len()));
        Ok(json!({"path": path, "mode": mode, "content": body, "sizeBytes": meta.len(), "totalLines": total_lines, "hash": hash, "partial": partial}))
    }

    async fn search_files(&self, call: &ToolCall, options: &ToolExecutionOptions) -> Result<Value> {
        let root = resolve_workspace_path(&options.work_root, &arg_string_default(&call.args, "path", "."))?;
        let terms = parse_search_terms(&arg_string(&call.args, "query")?);
        emit(options, "running", Some(&root), Some("search"), "Searching workspace snippets.", None, Some(0), None);
        let mut matches = Vec::new();
        for entry in WalkBuilder::new(&root).max_depth(Some(8)).hidden(false).build().filter_map(Result::ok) {
            if matches.len() >= 80 {
                break;
            }
            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                continue;
            }
            let path = entry.path();
            let path_text = path.display().to_string();
            if terms.iter().any(|term| path_text.to_lowercase().contains(term)) {
                matches.push(json!({"path": path_text, "line": null, "snippet": "", "matchedField": "path"}));
                continue;
            }
            let Ok(text) = tokio::fs::read_to_string(path).await else {
                continue;
            };
            for (idx, line) in text.lines().enumerate() {
                let lower = line.to_lowercase();
                if let Some(term) = terms.iter().find(|term| lower.contains(*term)) {
                    matches.push(json!({"path": path_text, "line": idx + 1, "snippet": line.trim(), "matchedTerm": term, "matchedField": "content"}));
                    if matches.len() >= 80 {
                        break;
                    }
                }
            }
        }
        emit(options, "completed", Some(&root), Some("search"), "Search complete.", None, Some(matches.len() as u64), None);
        Ok(json!({"kind":"workspace_file_search","terms":terms,"matches":matches,"note":"search_files returns live workspace path/line snippets only. Use read_file for complete file contents."}))
    }

    async fn write_file(&self, call: &ToolCall, options: &ToolExecutionOptions) -> Result<Value> {
        let path = resolve_workspace_path(&options.work_root, &arg_string(&call.args, "path")?)?;
        let content = arg_string(&call.args, "content")?;
        let expected = arg_string_default(&call.args, "expectedHash", "__new__");
        let existed = tokio::fs::try_exists(&path).await?;
        let current = if existed { tokio::fs::read_to_string(&path).await? } else { String::new() };
        if existed && expected != hash_text(&current) {
            return Ok(conflict(&path, &expected, &hash_text(&current)));
        }
        if !existed && expected != "__new__" {
            return Ok(conflict(&path, &expected, "__missing__"));
        }
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let added = line_count(&content);
        let removed = if existed { line_count(&current) } else { 0 };
        let change = FileChangeSummary { path: path.display().to_string(), added_lines: added, removed_lines: removed, operation: if existed { "write".into() } else { "create".into() } };
        emit(options, "running", Some(&path), Some("write"), "Writing file.", Some(change.clone()), Some(0), Some(content.len() as u64));
        let mut written = 0;
        let mut buffer = Vec::with_capacity(content.len());
        for chunk in content.as_bytes().chunks(WRITE_CHUNK_BYTES) {
            buffer.extend_from_slice(chunk);
            written += chunk.len();
            emit(options, "running", Some(&path), Some("write"), "Writing file.", Some(change.clone()), Some(written as u64), Some(content.len() as u64));
        }
        tokio::fs::write(&path, buffer).await?;
        emit(options, "completed", Some(&path), Some("write"), "Write complete.", Some(change.clone()), Some(content.len() as u64), Some(content.len() as u64));
        Ok(json!({"status":"success","path":path,"hash":hash_text(&content),"changes":change}))
    }

    async fn edit_file(&self, call: &ToolCall, options: &ToolExecutionOptions) -> Result<Value> {
        let path = resolve_workspace_path(&options.work_root, &arg_string(&call.args, "path")?)?;
        let expected = arg_string(&call.args, "expectedHash")?;
        let current = tokio::fs::read_to_string(&path).await?;
        let actual = hash_text(&current);
        if expected != actual {
            return Ok(conflict(&path, &expected, &actual));
        }
        let start = arg_u64(&call.args, "startLine").unwrap_or(1).max(1) as usize;
        let end = arg_u64(&call.args, "endLine").unwrap_or(start as u64).max(start as u64) as usize;
        let replacement = arg_string(&call.args, "replacement")?;
        let lines: Vec<&str> = current.lines().collect();
        if start > lines.len() + 1 || end > lines.len() {
            return Err(anyhow!("Line range {start}-{end} is outside current file with {} lines.", lines.len()));
        }
        if let Some(expected_text) = optional_string(&call.args, "expectedText") {
            let old = lines[start - 1..end].join("\n");
            if normalize_newlines(&old) != normalize_newlines(&expected_text) {
                return Ok(json!({"status":"conflict","path":path,"expectedHash":expected,"actualHash":actual,"reason":"expectedText did not match current file. File may have changed; read it again before editing."}));
            }
        }
        let removed = if start <= end { end - start + 1 } else { 0 };
        let added = line_count(&replacement);
        let mut next = String::new();
        for line in &lines[..start - 1] {
            next.push_str(line);
            next.push('\n');
        }
        next.push_str(&replacement);
        if !replacement.ends_with('\n') && end < lines.len() {
            next.push('\n');
        }
        for line in &lines[end..] {
            next.push_str(line);
            next.push('\n');
        }
        let change = FileChangeSummary { path: path.display().to_string(), added_lines: added, removed_lines: removed, operation: "edit".into() };
        emit(options, "running", Some(&path), Some("edit"), "Applying edit.", Some(change.clone()), None, None);
        tokio::fs::write(&path, &next).await?;
        emit(options, "completed", Some(&path), Some("edit"), "Edit complete.", Some(change.clone()), None, None);
        Ok(json!({"status":"success","path":path,"hash":hash_text(&next),"changes":change}))
    }

    async fn run_command(&self, call: &ToolCall, options: &ToolExecutionOptions) -> Result<Value> {
        let command = arg_string(&call.args, "command")?;
        let cwd = resolve_workspace_path(&options.work_root, &arg_string_default(&call.args, "cwd", "."))?;
        emit(options, "running", Some(&cwd), Some("run_command"), "Command started.", None, None, None);
        let mut cmd = if cfg!(windows) {
            let mut cmd = Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &command]);
            cmd
        } else {
            let mut cmd = Command::new("bash");
            cmd.args(["-lc", &command]);
            cmd
        };
        let mut child = cmd.current_dir(&cwd).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn()?;
        let output = timeout(COMMAND_TIMEOUT, async {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            if let Some(mut out) = child.stdout.take() {
                let _ = out.read_to_end(&mut stdout).await;
            }
            if let Some(mut err) = child.stderr.take() {
                let _ = err.read_to_end(&mut stderr).await;
            }
            let status = child.wait().await?;
            Ok::<_, anyhow::Error>((status, stdout, stderr))
        })
        .await
        .context("Command timed out")??;
        let stdout = String::from_utf8_lossy(&output.1).to_string();
        let stderr = String::from_utf8_lossy(&output.2).to_string();
        emit(options, "completed", Some(&cwd), Some("run_command"), "Command finished.", None, Some((stdout.len() + stderr.len()) as u64), None);
        Ok(json!({"exitCode": output.0.code(), "stdout": stdout, "stderr": stderr, "ok": output.0.success()}))
    }

    async fn knowledge_search(&self, call: &ToolCall) -> Result<Value> {
        let query = arg_string(&call.args, "query")?;
        let items = self.store.list_knowledge_items()?;
        let results = fallback_knowledge_search(&items, &query);
        Ok(json!({"kind":"knowledge_library_search","query":query,"results":results,"note":"knowledge_search searches saved Knowledge library entries. Verify current files with search_files/read_file when source freshness matters."}))
    }
}

#[async_trait]
impl ToolExecutor for NativeToolExecutor {
    async fn execute(&self, call: ToolCall, options: ToolExecutionOptions) -> ToolResult {
        match self.execute_inner(&call, &options).await {
            Ok(value) => result(&call, true, value),
            Err(error) => result(&call, false, json!({"status":"failed","output":error.to_string()})),
        }
    }
}

fn result(call: &ToolCall, ok: bool, output: Value) -> ToolResult {
    ToolResult {
        id: create_id("tool_result"),
        tool_call_id: call.id.clone(),
        ok,
        output: serde_json::to_string_pretty(&output).unwrap_or_else(|_| output.to_string()),
        created_at: now_iso(),
    }
}

fn emit(options: &ToolExecutionOptions, status: &str, path: Option<&Path>, op: Option<&str>, message: &str, changes: Option<FileChangeSummary>, processed: Option<u64>, total: Option<u64>) {
    if let Some(callback) = &options.on_progress {
        callback(ToolProgressUpdate {
            status: status.to_string(),
            target_path: path.map(|p| p.display().to_string()),
            operation: op.map(str::to_string),
            message: Some(message.to_string()),
            changes,
            processed,
            total,
            unit: processed.map(|_| "bytes".to_string()),
            tail: None,
            display_mode: None,
        });
    }
}

fn resolve_workspace_path(root: &Path, input: &str) -> Result<PathBuf> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let path = if Path::new(input).is_absolute() { PathBuf::from(input) } else { root.join(input) };
    let check_path = if path.exists() {
        path.canonicalize().unwrap_or_else(|_| path.clone())
    } else {
        path.parent().unwrap_or(&root).canonicalize().unwrap_or_else(|_| root.clone())
    };
    if !check_path.starts_with(&root) {
        return Err(anyhow!("Path escapes workspace root: {}", path.display()));
    }
    Ok(path)
}

fn arg_string(args: &JsonMap, key: &str) -> Result<String> {
    optional_string(args, key).ok_or_else(|| anyhow!("Missing argument: {key}"))
}

fn arg_string_default(args: &JsonMap, key: &str, default: &str) -> String {
    optional_string(args, key).unwrap_or_else(|| default.to_string())
}

fn optional_string(args: &JsonMap, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(ToString::to_string)
}

fn arg_u64(args: &JsonMap, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

fn arg_u64_default(args: &JsonMap, key: &str, default: u64) -> u64 {
    arg_u64(args, key).unwrap_or(default)
}

fn line_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.lines().count()
    }
}

fn hash_text(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n")
}

fn conflict(path: &Path, expected: &str, actual: &str) -> Value {
    json!({
        "status":"conflict",
        "path":path,
        "expectedHash":expected,
        "actualHash":actual,
        "reason":"File may have changed before this edit. Read it again and retry with the current hash."
    })
}

fn parse_search_terms(query: &str) -> Vec<String> {
    let splitter = Regex::new(r"\s*\|\s*|\s+OR\s+").expect("valid regex");
    splitter
        .split(query)
        .map(|part| part.trim().trim_matches('"').to_lowercase())
        .filter(|part| !part.is_empty())
        .collect()
}

fn fallback_knowledge_search(items: &[KnowledgeItem], query: &str) -> Vec<Value> {
    let terms = parse_search_terms(query);
    items
        .iter()
        .filter(|item| {
            let haystack = format!("{} {} {}", item.title, item.tags.join(" "), item.content).to_lowercase();
            terms.iter().any(|term| haystack.contains(term))
        })
        .take(8)
        .map(|item| json!({"id":item.id,"title":item.title,"snippet":item.content.chars().take(320).collect::<String>(),"tags":item.tags,"rankReason":"fallback lexical match"}))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use scc_native_shared::{create_id, JsonMap};

    fn call(tool_name: &str, args: serde_json::Value) -> ToolCall {
        let args = args.as_object().unwrap().clone().into_iter().collect::<JsonMap>();
        ToolCall { id: create_id("call"), tool_name: tool_name.to_string(), args }
    }

    #[tokio::test]
    async fn edit_rejects_hash_conflicts_and_write_reports_changes() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = NativeStore::open(dir.path().join("native.sqlite"))?;
        let tools = NativeToolExecutor::new(store);
        let options = ToolExecutionOptions { work_root: dir.path().to_path_buf(), on_progress: None };

        let write = tools.execute(call("write_file", json!({"path":"a.txt","content":"one\ntwo\n","expectedHash":"__new__"})), options.clone()).await;
        assert!(write.ok);
        assert!(write.output.contains("\"addedLines\": 2") || write.output.contains("\"added_lines\""));

        let conflict = tools.execute(call("edit_file", json!({"path":"a.txt","expectedHash":"bad","startLine":1,"endLine":1,"replacement":"ONE"})), options).await;
        assert!(conflict.ok);
        assert!(conflict.output.contains("\"status\": \"conflict\""));
        Ok(())
    }

    #[tokio::test]
    async fn search_files_supports_or_terms_and_explains_read_file() -> Result<()> {
        let dir = tempfile::tempdir()?;
        tokio::fs::write(dir.path().join("i18n.ts"), "完全访问\n自动审批\n").await?;
        let store = NativeStore::open(dir.path().join("native.sqlite"))?;
        let tools = NativeToolExecutor::new(store);
        let result = tools
            .execute(call("search_files", json!({"path":".","query":"完全访问|自动审批"})), ToolExecutionOptions { work_root: dir.path().to_path_buf(), on_progress: None })
            .await;
        assert!(result.ok, "{}", result.output);
        assert!(result.output.contains("workspace_file_search"));
        assert!(result.output.contains("read_file"));
        Ok(())
    }
}
