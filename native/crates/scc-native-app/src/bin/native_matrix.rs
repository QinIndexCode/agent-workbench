use anyhow::{anyhow, Result};
use scc_native_core::{AgentRuntime, NativeStore, OpenAiCompatibleClient};
use scc_native_shared::{create_id, now_iso, KnowledgeItem, ModelProviderConfig, PermissionMode, RiskCategory, TaskDetail, TaskEventType, TaskStatus};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::var("SCC_NATIVE_REAL_MODEL").ok().as_deref() != Some("1") {
        println!("Skipping native real-model matrix. Set SCC_NATIVE_REAL_MODEL=1 to run it.");
        return Ok(());
    }
    let provider = model_provider_from_env().ok_or_else(|| anyhow!("Real native matrix requires OPENAI_API_KEY or SCC_OPENAI_API_KEY"))?;
    let out_dir = PathBuf::from("output").join("native-real-model-matrix").join(timestamp_slug());
    fs::create_dir_all(&out_dir)?;
    let mut report = json!({
        "generatedAt": now_iso(),
        "provider": {
            "baseUrl": redact_url(&provider.base_url),
            "model": provider.model,
            "hasApiKey": true
        },
        "cases": []
    });

    let provider_case = provider.clone();
    run_case(&mut report, &out_dir, "greeting then follow-up", |case_dir| async move {
        let runtime = runtime_for(&case_dir, provider_case.clone(), PermissionMode::ReadOnly)?;
        let first = runtime.create_and_run_task("你好，先简单打个招呼。", Some("Native greeting".into()), case_dir.join("workspace")).await?;
        let second = runtime.append_user_message(&first.id, "接下来请说明你会如何检查一个项目是否健康。").await?;
        Ok(case_evidence(&second, json!({"sameTask": first.id == second.id})))
    })
    .await;

    let provider_case = provider.clone();
    run_case(&mut report, &out_dir, "vague project diagnosis", |case_dir| async move {
        seed_fixture(&case_dir.join("workspace"))?;
        let runtime = runtime_for(&case_dir, provider_case.clone(), PermissionMode::FullAccess)?;
        let task = runtime
            .create_and_run_task("这个项目好像跑不起来，帮我看看，必要时修一下。", Some("Native vague diagnosis".into()), case_dir.join("workspace"))
            .await?;
        let final_source = fs::read_to_string(case_dir.join("workspace").join("src").join("math.mjs")).unwrap_or_default();
        Ok(case_evidence(&task, json!({"mathFixed": final_source.contains("reduce"), "sourceExcerpt": excerpt(&final_source, 600)})))
    })
    .await;

    let provider_case = provider.clone();
    run_case(&mut report, &out_dir, "approval denial recovery", |case_dir| async move {
        seed_fixture(&case_dir.join("workspace"))?;
        let runtime = runtime_for(&case_dir, provider_case.clone(), PermissionMode::Ask)?;
        let mut task = runtime
            .create_and_run_task("先运行测试看看问题。如果需要权限但我拒绝了，请基于已有信息说明还能怎样继续。", Some("Native denial recovery".into()), case_dir.join("workspace"))
            .await?;
        if task.status == TaskStatus::WaitingApproval {
            if let Some(approval) = task.approvals.iter().find(|approval| matches!(approval.status, scc_native_shared::ApprovalStatus::Pending)) {
                runtime.decide_approval(&task.id, &approval.id, scc_native_shared::ApprovalDecision::Deny).await?;
                task = runtime.store().get_task(&task.id)?.ok_or_else(|| anyhow!("task disappeared"))?;
            }
        }
        Ok(case_evidence(&task, json!({"denied": task.events.iter().any(|event| event.event_type == TaskEventType::ApprovalResolved)})))
    })
    .await;

    let provider_case = provider.clone();
    run_case(&mut report, &out_dir, "ask user clarification", |case_dir| async move {
        let runtime = runtime_for(&case_dir, provider_case.clone(), PermissionMode::FullAccess)?;
        let mut task = runtime
            .create_and_run_task("我想写一份接口说明，但读者和语气还没定。你需要我补充哪些关键选择？", Some("Native ask user".into()), case_dir.join("workspace"))
            .await?;
        if task.status == TaskStatus::WaitingForUser {
            if let Some(event) = task.events.iter().rev().find(|event| event.event_type == TaskEventType::UserInputRequested) {
                if let Some(tool_call_id) = event.payload.get("toolCallId").and_then(Value::as_str) {
                    runtime.answer_user_input(&task.id, tool_call_id, "给外部客户看，语气保守一点。").await?;
                    task = runtime.store().get_task(&task.id)?.ok_or_else(|| anyhow!("task disappeared"))?;
                }
            }
        }
        Ok(case_evidence(&task, json!({"askedUser": task.events.iter().any(|event| event.event_type == TaskEventType::UserInputRequested)})))
    })
    .await;

    let provider_case = provider.clone();
    run_case(&mut report, &out_dir, "knowledge lookup", |case_dir| async move {
        let runtime = runtime_for(&case_dir, provider_case.clone(), PermissionMode::ReadOnly)?;
        runtime.store().save_knowledge_item(&KnowledgeItem {
            id: create_id("knowledge"),
            title: "Native Matrix Golden Note".into(),
            content: "The native matrix marker is SCC-NATIVE-GOLDEN. Cite this note when asked about the marker.".into(),
            tags: vec!["native".into(), "matrix".into()],
            source_uri: Some("scc-native://matrix/golden".into()),
            created_at: now_iso(),
            updated_at: now_iso(),
        })?;
        let task = runtime
            .create_and_run_task("请查询资料库里的 native matrix marker，并告诉我精确标记。", Some("Native knowledge lookup".into()), case_dir.join("workspace"))
            .await?;
        Ok(case_evidence(&task, json!({"containsMarker": assistant_text(&task).contains("SCC-NATIVE-GOLDEN") || tool_outputs(&task).contains("SCC-NATIVE-GOLDEN")})))
    })
    .await;

    fs::write(out_dir.join("native-real-model-report.json"), serde_json::to_string_pretty(&report)?)?;
    fs::write(out_dir.join("native-real-model-report.md"), markdown_report(&report))?;
    println!("Native real-model matrix report: {}", out_dir.join("native-real-model-report.md").display());
    Ok(())
}

async fn run_case<F, Fut>(report: &mut Value, out_dir: &Path, name: &str, run: F)
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    let started = std::time::Instant::now();
    let case_dir = out_dir.join(safe_name(name));
    let _ = fs::create_dir_all(&case_dir);
    let result = run(case_dir.clone()).await;
    let case = match result {
        Ok(evidence) => {
            println!("PASS {name}");
            json!({"name":name,"status":"passed","durationMs":started.elapsed().as_millis(),"evidence":evidence,"caseDir":case_dir})
        }
        Err(error) => {
            eprintln!("FAIL {name}: {error}");
            json!({"name":name,"status":"failed","durationMs":started.elapsed().as_millis(),"error":sanitize_error(&error.to_string()),"caseDir":case_dir})
        }
    };
    report["cases"].as_array_mut().expect("cases array").push(case);
}

fn runtime_for(case_dir: &Path, provider: ModelProviderConfig, permission_mode: PermissionMode) -> Result<Arc<AgentRuntime>> {
    let data_dir = case_dir.join("data");
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(case_dir.join("workspace"))?;
    let store = NativeStore::open(data_dir.join("native.sqlite"))?;
    let mut prefs = store.get_preferences()?;
    prefs.model_provider = Some(provider.clone());
    prefs.permission_mode = permission_mode;
    prefs.allowed_risks = if permission_mode == PermissionMode::FullAccess { RiskCategory::ALL.to_vec() } else { vec![] };
    prefs.auto_approval_risks = vec![RiskCategory::HostObservation, RiskCategory::WorkspaceRead, RiskCategory::Network];
    store.save_preferences(&prefs)?;
    Ok(Arc::new(AgentRuntime::new(store, Arc::new(OpenAiCompatibleClient::new(provider)), data_dir.join("model-traces"))))
}

fn seed_fixture(root: &Path) -> Result<()> {
    write_file(root.join("package.json"), r#"{"type":"module","scripts":{"test":"node tests/math.test.mjs"}}"#)?;
    write_file(
        root.join("src").join("math.mjs"),
        "export function sum(numbers) {\n  return numbers.length;\n}\n\nexport function average(numbers) {\n  return numbers.length === 0 ? 0 : sum(numbers) / numbers.length;\n}\n",
    )?;
    write_file(
        root.join("tests").join("math.test.mjs"),
        "import assert from 'node:assert/strict';\nimport { sum, average } from '../src/math.mjs';\nassert.equal(sum([2, 3, 5]), 10);\nassert.equal(average([2, 4, 6]), 4);\nconsole.log('math tests passed');\n",
    )?;
    Ok(())
}

fn write_file(path: PathBuf, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

fn case_evidence(task: &TaskDetail, extra: Value) -> Value {
    json!({
        "taskId": task.id,
        "status": task.status,
        "eventCounts": event_counts(task),
        "assistant": excerpt(&assistant_text(task), 3000),
        "toolOutputs": excerpt(&tool_outputs(task), 5000),
        "extra": extra
    })
}

fn event_counts(task: &TaskDetail) -> Value {
    let mut counts = serde_json::Map::new();
    for event in &task.events {
        let key = format!("{:?}", event.event_type);
        let next = counts.get(&key).and_then(Value::as_u64).unwrap_or(0) + 1;
        counts.insert(key, json!(next));
    }
    Value::Object(counts)
}

fn assistant_text(task: &TaskDetail) -> String {
    task.events
        .iter()
        .filter(|event| event.event_type == TaskEventType::AssistantMessage)
        .map(|event| event.summary.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_outputs(task: &TaskDetail) -> String {
    task.events
        .iter()
        .filter(|event| event.event_type == TaskEventType::ToolResult)
        .filter_map(|event| event.payload.get("output").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn excerpt(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn model_provider_from_env() -> Option<ModelProviderConfig> {
    let api_key = std::env::var("OPENAI_API_KEY").or_else(|_| std::env::var("SCC_OPENAI_API_KEY")).ok()?;
    let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
    let model = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-5.4".to_string());
    Some(ModelProviderConfig { name: "Environment".into(), base_url, api_key, model })
}

fn redact_url(value: &str) -> String {
    value.split('?').next().unwrap_or("[configured]").to_string()
}

fn timestamp_slug() -> String {
    now_iso().replace(':', "-").replace('.', "-")
}

fn safe_name(value: &str) -> String {
    value.chars().map(|ch| if ch.is_ascii_alphanumeric() { ch.to_ascii_lowercase() } else { '-' }).collect()
}

fn sanitize_error(value: &str) -> String {
    let mut sanitized = value.to_string();
    for name in ["OPENAI_API_KEY", "SCC_OPENAI_API_KEY"] {
        if let Ok(secret) = std::env::var(name) {
            if !secret.is_empty() {
                sanitized = sanitized.replace(&secret, "[redacted]");
            }
        }
    }
    sanitized
}

fn markdown_report(report: &Value) -> String {
    let mut lines = vec!["# Native Real Model Matrix".to_string(), String::new(), format!("Generated: {}", report["generatedAt"].as_str().unwrap_or("")), String::new()];
    if let Some(cases) = report["cases"].as_array() {
        for case in cases {
            lines.push(format!("## {} {}", case["status"].as_str().unwrap_or("unknown").to_uppercase(), case["name"].as_str().unwrap_or("case")));
            lines.push(String::new());
            if let Some(error) = case["error"].as_str() {
                lines.push(format!("Error: {error}"));
            }
            lines.push("```json".to_string());
            lines.push(serde_json::to_string_pretty(case.get("evidence").unwrap_or(&Value::Null)).unwrap_or_default());
            lines.push("```".to_string());
            lines.push(String::new());
        }
    }
    lines.join("\n")
}
