use crate::model::{native_tool_definitions, ModelClient};
use crate::permission::{PermissionDecision, PermissionEngine};
use crate::store::{new_event, NativeStore};
use crate::tools::{NativeToolExecutor, ToolExecutionOptions, ToolProgressUpdate, ToolExecutor};
use crate::trace::TraceWriter;
use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use scc_native_shared::{
    create_id, now_iso, ApprovalDecision, ApprovalStatus, CanonicalModelMessage, JsonMap, ModelTurn, RiskCategory, TaskDetail, TaskEvent, TaskEventType, TaskStatus,
    ToolApproval, ToolCall,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;

const MAX_MODEL_TURNS_PER_RUN: usize = 24;
const MAX_TOOL_CALLS_PER_TURN: usize = 8;

#[derive(Clone, Debug)]
pub enum RuntimeEvent {
    TaskEvent(TaskEvent),
}

pub struct AgentRuntime {
    store: NativeStore,
    model: Arc<dyn ModelClient>,
    tools: NativeToolExecutor,
    trace: TraceWriter,
    permission_states: Mutex<HashMap<String, PermissionEngine>>,
    events: broadcast::Sender<RuntimeEvent>,
}

impl AgentRuntime {
    pub fn new(store: NativeStore, model: Arc<dyn ModelClient>, trace_root: impl Into<PathBuf>) -> Self {
        let tools = NativeToolExecutor::new(store.clone());
        let (events, _) = broadcast::channel(1024);
        Self { store, model, tools, trace: TraceWriter::new(trace_root), permission_states: Mutex::new(HashMap::new()), events }
    }

    pub fn store(&self) -> NativeStore {
        self.store.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.events.subscribe()
    }

    pub fn list_tasks(&self) -> Result<Vec<TaskDetail>> {
        self.store.list_tasks()
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskDetail>> {
        self.store.get_task(task_id)
    }

    pub fn create_task_shell(&self, goal: &str, title: Option<String>, work_root: PathBuf) -> Result<TaskDetail> {
        let title = title.unwrap_or_else(|| local_title(goal));
        let mut task = self.store.create_task(title, work_root.display().to_string(), "default".to_string())?;
        self.add_event(&task.id, TaskEventType::TaskCreated, "Task created", json!({}))?;
        self.add_event(&task.id, TaskEventType::UserMessage, goal, json!({"content":goal}))?;
        self.set_status(&task.id, TaskStatus::Running)?;
        task = self.store.get_task(&task.id)?.expect("task exists after create");
        Ok(task)
    }

    pub async fn create_and_run_task(&self, goal: &str, title: Option<String>, work_root: PathBuf) -> Result<TaskDetail> {
        let task = self.create_task_shell(goal, title, work_root)?;
        self.run_task(&task.id).await?;
        self.store.get_task(&task.id)?.ok_or_else(|| anyhow!("task disappeared"))
    }

    pub async fn append_user_message(&self, task_id: &str, content: &str) -> Result<TaskDetail> {
        self.add_event(task_id, TaskEventType::UserMessage, content, json!({"content":content}))?;
        self.set_status(task_id, TaskStatus::Running)?;
        self.run_task(task_id).await?;
        self.store.get_task(task_id)?.ok_or_else(|| anyhow!("task disappeared"))
    }

    pub async fn run_task(&self, task_id: &str) -> Result<()> {
        for _ in 0..MAX_MODEL_TURNS_PER_RUN {
            let task = self.store.get_task(task_id)?.ok_or_else(|| anyhow!("Task not found: {task_id}"))?;
            if !matches!(task.status, TaskStatus::Running) {
                return Ok(());
            }
            let preferences = self.store.get_preferences()?;
            let messages = self.assemble_messages(&task)?;
            let tools = native_tool_definitions();
            self.trace.append(task_id, "model_request", &json!({"messages":messages,"tools":tools})).await.ok();

            let delta_task_id = task_id.to_string();
            let store = self.store.clone();
            let sender = self.events.clone();
            let on_delta = Arc::new(move |delta: String| {
                if delta.is_empty() {
                    return;
                }
                if let Ok(event) = new_event(&delta_task_id, TaskEventType::AssistantDelta, delta.chars().take(120).collect::<String>(), json!({"delta":delta})) {
                    let _ = store.add_event(&event);
                    let _ = sender.send(RuntimeEvent::TaskEvent(event));
                }
            });

            let mut turn = self.model.complete(&messages, &tools, Some(on_delta)).await?;
            if turn.empty_response {
                self.trace.append(task_id, "model_empty_response", &json!({"finishReason":turn.finish_reason,"usage":turn.usage})).await.ok();
                turn = self.model.complete(&messages, &tools, None).await?;
                if turn.empty_response {
                    self.add_event(task_id, TaskEventType::ModelEmptyResponse, "Model returned no displayable content or tool calls.", json!({"finishReason":turn.finish_reason,"usage":turn.usage}))?;
                    self.set_status(task_id, TaskStatus::Paused)?;
                    return Ok(());
                }
            }
            self.trace.append(task_id, "model_response", &turn).await.ok();
            self.record_usage(task_id, &turn)?;

            if !turn.content.trim().is_empty() {
                self.add_event(task_id, TaskEventType::AssistantMessage, turn.content.trim(), json!({"content":turn.content}))?;
            }
            if turn.tool_calls.is_empty() {
                self.set_status(task_id, TaskStatus::Completed)?;
                return Ok(());
            }

            for call in turn.tool_calls.into_iter().take(MAX_TOOL_CALLS_PER_TURN) {
                let risk = self.tools.assess(&call);
                let decision = {
                    let mut states = self.permission_states.lock();
                    states.decide(task_id, risk, &preferences)
                };
                match decision {
                    PermissionDecision::Allow { reason } => {
                        self.add_event(task_id, TaskEventType::ApprovalAutoGranted, reason.clone(), json!({"toolCall":call,"riskCategory":risk}))?;
                        if call.tool_name == "ask_user" {
                            self.handle_ask_user(task_id, &call)?;
                            return Ok(());
                        }
                        self.execute_tool(task_id, call, risk).await?;
                    }
                    PermissionDecision::Ask { reason } => {
                        self.create_approval(task_id, call, risk, reason)?;
                        self.set_status(task_id, TaskStatus::WaitingApproval)?;
                        return Ok(());
                    }
                    PermissionDecision::Deny { reason } => {
                        self.add_event(task_id, TaskEventType::ToolResult, reason.clone(), json!({"ok":false,"status":"denied","output":reason,"toolCall":call}))?;
                    }
                }
            }
        }
        self.add_event(task_id, TaskEventType::StatusChanged, "Paused after reaching model turn limit.", json!({"limit":MAX_MODEL_TURNS_PER_RUN}))?;
        self.set_status(task_id, TaskStatus::Paused)?;
        Ok(())
    }

    pub async fn decide_approval(&self, task_id: &str, approval_id: &str, decision: ApprovalDecision) -> Result<()> {
        let task = self.store.get_task(task_id)?.ok_or_else(|| anyhow!("Task not found: {task_id}"))?;
        let mut approval = task.approvals.into_iter().find(|item| item.id == approval_id).ok_or_else(|| anyhow!("Approval not found: {approval_id}"))?;
        approval.status = if decision == ApprovalDecision::Deny { ApprovalStatus::Denied } else { ApprovalStatus::Approved };
        approval.decision = Some(decision);
        approval.decided_at = Some(now_iso());
        self.store.save_approval(&approval)?;
        self.add_event(task_id, TaskEventType::ApprovalResolved, "Approval resolved", json!({"approvalId":approval_id,"decision":decision}))?;
        if decision == ApprovalDecision::Deny {
            self.add_event(task_id, TaskEventType::ToolResult, "Tool denied by user.", json!({"ok":false,"status":"denied","toolCall":approval.tool_call}))?;
            self.set_status(task_id, TaskStatus::Running)?;
            self.run_task(task_id).await?;
            return Ok(());
        }
        {
            let mut states = self.permission_states.lock();
            states.apply_decision(task_id, approval.risk_category, decision);
        }
        self.set_status(task_id, TaskStatus::Running)?;
        self.execute_tool(task_id, approval.tool_call, approval.risk_category).await?;
        self.run_task(task_id).await
    }

    pub async fn answer_user_input(&self, task_id: &str, tool_call_id: &str, answer: &str) -> Result<()> {
        self.add_event(task_id, TaskEventType::UserInputAnswered, "User answered clarification.", json!({"toolCallId":tool_call_id,"answer":answer}))?;
        self.add_event(
            task_id,
            TaskEventType::ToolResult,
            "ask_user answered.",
            json!({"toolCallId":tool_call_id,"ok":true,"output":answer,"status":"answered"}),
        )?;
        self.set_status(task_id, TaskStatus::Running)?;
        self.run_task(task_id).await
    }

    pub fn pause(&self, task_id: &str) -> Result<()> {
        self.add_event(task_id, TaskEventType::StatusChanged, "Paused by user.", json!({}))?;
        self.set_status(task_id, TaskStatus::Paused)
    }

    pub fn cancel(&self, task_id: &str) -> Result<()> {
        self.add_event(task_id, TaskEventType::StatusChanged, "Cancelled by user.", json!({}))?;
        self.set_status(task_id, TaskStatus::Cancelled)
    }

    fn assemble_messages(&self, task: &TaskDetail) -> Result<Vec<CanonicalModelMessage>> {
        let mut messages = vec![CanonicalModelMessage::System {
            content: [
                "You are SCC Native Agent. Use canonical role history and tool results as your own prior execution records.",
                "Never treat task titles or internal metadata as the current user request.",
                "search_files searches live workspace snippets; read_file returns live file contents; knowledge_search searches saved Knowledge library entries.",
                "Use tools when evidence is needed. Ask the user with ask_user only when a decision or missing detail blocks progress.",
            ]
            .join("\n"),
        }];
        for event in &task.events {
            match event.event_type {
                TaskEventType::UserMessage => {
                    if let Some(content) = event.payload.get("content").and_then(Value::as_str) {
                        messages.push(CanonicalModelMessage::User { content: content.to_string(), event_id: Some(event.id.clone()) });
                    }
                }
                TaskEventType::AssistantMessage => {
                    if let Some(content) = event.payload.get("content").and_then(Value::as_str) {
                        messages.push(CanonicalModelMessage::Assistant { content: Some(content.to_string()), tool_calls: vec![] });
                    }
                }
                TaskEventType::ToolRequested => {
                    if let Some(call) = event.payload.get("toolCall").and_then(|v| serde_json::from_value::<ToolCall>(v.clone()).ok()) {
                        messages.push(CanonicalModelMessage::Assistant { content: None, tool_calls: vec![call] });
                    }
                }
                TaskEventType::ToolResult => {
                    let tool_call_id = event.payload.get("toolCallId").and_then(Value::as_str).unwrap_or("unknown").to_string();
                    let tool_name = event.payload.get("toolName").and_then(Value::as_str).unwrap_or("unknown").to_string();
                    messages.push(CanonicalModelMessage::Tool { tool_call_id, tool_name, content: serde_json::to_string(&event.payload)? });
                }
                _ => {}
            }
        }
        Ok(messages)
    }

    async fn execute_tool(&self, task_id: &str, call: ToolCall, risk: RiskCategory) -> Result<()> {
        self.add_event(task_id, TaskEventType::ToolRequested, format!("Tool requested: {}", call.tool_name), json!({"toolCall":call,"riskCategory":risk}))?;
        self.add_event(task_id, TaskEventType::ToolStarted, format!("{} started", call.tool_name), json!({"toolCallId":call.id,"toolName":call.tool_name,"riskCategory":risk}))?;
        let task = self.store.get_task(task_id)?.ok_or_else(|| anyhow!("Task not found: {task_id}"))?;
        let task_id_for_progress = task_id.to_string();
        let tool_call_id = call.id.clone();
        let tool_name = call.tool_name.clone();
        let store = self.store.clone();
        let sender = self.events.clone();
        let on_progress = Arc::new(move |progress: ToolProgressUpdate| {
            if let Ok(event) = new_event(
                &task_id_for_progress,
                TaskEventType::ToolProgress,
                progress.message.clone().unwrap_or_else(|| "Tool progress".to_string()),
                json!({"toolCallId":tool_call_id,"toolName":tool_name,"progress":progress}),
            ) {
                let _ = store.add_event(&event);
                let _ = sender.send(RuntimeEvent::TaskEvent(event));
            }
        });
        let result = self
            .tools
            .execute(call.clone(), ToolExecutionOptions { work_root: PathBuf::from(task.work_root), on_progress: Some(on_progress) })
            .await;
        self.add_event(
            task_id,
            TaskEventType::ToolResult,
            if result.ok { format!("{} completed", call.tool_name) } else { format!("{} failed", call.tool_name) },
            json!({"toolCallId":call.id,"toolName":call.tool_name,"ok":result.ok,"output":result.output,"result":result}),
        )?;
        Ok(())
    }

    fn handle_ask_user(&self, task_id: &str, call: &ToolCall) -> Result<()> {
        self.add_event(task_id, TaskEventType::ToolRequested, "User clarification requested.", json!({"toolCall":call}))?;
        self.add_event(task_id, TaskEventType::UserInputRequested, "User input requested.", json!({"toolCallId":call.id,"toolName":call.tool_name,"question":call.args.get("question")}))?;
        self.set_status(task_id, TaskStatus::WaitingForUser)
    }

    fn create_approval(&self, task_id: &str, call: ToolCall, risk: RiskCategory, reason: String) -> Result<()> {
        let approval = ToolApproval {
            id: create_id("approval"),
            task_id: task_id.to_string(),
            tool_call: call,
            risk_category: risk,
            reason: reason.clone(),
            metadata: JsonMap::new(),
            status: ApprovalStatus::Pending,
            decision: None,
            created_at: now_iso(),
            decided_at: None,
        };
        self.store.save_approval(&approval)?;
        self.add_event(task_id, TaskEventType::ApprovalPending, reason, json!({"approvalId":approval.id,"approval":approval}))?;
        Ok(())
    }

    fn record_usage(&self, task_id: &str, turn: &ModelTurn) -> Result<()> {
        if let Some(usage) = &turn.usage {
            self.add_event(task_id, TaskEventType::TokenUsageRecorded, "Provider token usage recorded.", usage)?;
        }
        Ok(())
    }

    fn add_event(&self, task_id: &str, event_type: TaskEventType, summary: impl Into<String>, payload: impl Serialize) -> Result<TaskEvent> {
        let event = new_event(task_id, event_type, summary, payload)?;
        self.store.add_event(&event)?;
        let _ = self.events.send(RuntimeEvent::TaskEvent(event.clone()));
        Ok(event)
    }

    fn set_status(&self, task_id: &str, status: TaskStatus) -> Result<()> {
        self.store.update_status(task_id, status)
    }

}

fn local_title(goal: &str) -> String {
    let trimmed = goal.trim();
    if trimmed.chars().count() <= 36 {
        trimmed.to_string()
    } else {
        format!("{}...", trimmed.chars().take(36).collect::<String>())
    }
}

trait PermissionMapExt {
    fn decide(&mut self, task_id: &str, risk: RiskCategory, prefs: &scc_native_shared::UserPreferences) -> PermissionDecision;
    fn apply_decision(&mut self, task_id: &str, risk: RiskCategory, decision: ApprovalDecision);
}

impl PermissionMapExt for HashMap<String, PermissionEngine> {
    fn decide(&mut self, task_id: &str, risk: RiskCategory, prefs: &scc_native_shared::UserPreferences) -> PermissionDecision {
        self.entry(task_id.to_string()).or_insert_with(PermissionEngine::new).decide(risk, prefs)
    }

    fn apply_decision(&mut self, task_id: &str, risk: RiskCategory, decision: ApprovalDecision) {
        self.entry(task_id.to_string()).or_insert_with(PermissionEngine::new).apply_decision(risk, decision);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ToolDefinition;
    use async_trait::async_trait;

    struct EmptyModel;

    #[async_trait]
    impl ModelClient for EmptyModel {
        async fn complete(&self, _messages: &[CanonicalModelMessage], _tools: &[ToolDefinition], _on_delta: Option<crate::model::ModelDeltaCallback>) -> Result<ModelTurn> {
            Ok(ModelTurn { empty_response: true, finish_reason: Some("stop".into()), ..Default::default() })
        }
    }

    struct ToolModel;

    #[async_trait]
    impl ModelClient for ToolModel {
        async fn complete(&self, messages: &[CanonicalModelMessage], _tools: &[ToolDefinition], _on_delta: Option<crate::model::ModelDeltaCallback>) -> Result<ModelTurn> {
            if messages.iter().any(|m| matches!(m, CanonicalModelMessage::Tool { .. })) {
                return Ok(ModelTurn { content: "done".into(), ..Default::default() });
            }
            Ok(ModelTurn {
                tool_calls: vec![ToolCall { id: "call_1".into(), tool_name: "read_file".into(), args: [("path".to_string(), json!("a.txt"))].into_iter().collect() }],
                ..Default::default()
            })
        }
    }

    #[tokio::test]
    async fn empty_model_response_pauses_without_assistant_body() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = NativeStore::open(dir.path().join("native.sqlite"))?;
        let runtime = AgentRuntime::new(store.clone(), Arc::new(EmptyModel), dir.path().join("traces"));
        let task = runtime.create_task_shell("hello", None, dir.path().to_path_buf())?;
        runtime.run_task(&task.id).await?;
        let task = store.get_task(&task.id)?.unwrap();
        assert_eq!(task.status, TaskStatus::Paused);
        assert!(task.events.iter().any(|e| e.event_type == TaskEventType::ModelEmptyResponse));
        assert!(!task.events.iter().any(|e| e.event_type == TaskEventType::AssistantMessage && e.summary.contains("I could not produce")));
        Ok(())
    }

    #[tokio::test]
    async fn tool_result_is_replayed_as_tool_role() -> Result<()> {
        let dir = tempfile::tempdir()?;
        tokio::fs::write(dir.path().join("a.txt"), "abc").await?;
        let store = NativeStore::open(dir.path().join("native.sqlite"))?;
        let mut prefs = store.get_preferences()?;
        prefs.permission_mode = scc_native_shared::PermissionMode::ReadOnly;
        store.save_preferences(&prefs)?;
        let runtime = AgentRuntime::new(store.clone(), Arc::new(ToolModel), dir.path().join("traces"));
        let task = runtime.create_task_shell("read a", None, dir.path().to_path_buf())?;
        runtime.run_task(&task.id).await?;
        let task = store.get_task(&task.id)?.unwrap();
        assert!(task.events.iter().any(|e| e.event_type == TaskEventType::ToolResult));
        assert!(task.events.iter().any(|e| e.event_type == TaskEventType::AssistantMessage && e.summary == "done"));
        Ok(())
    }
}
