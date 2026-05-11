use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

pub type JsonMap = BTreeMap<String, Value>;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn create_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Idle,
    Running,
    WaitingForUser,
    WaitingApproval,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskCategory {
    HostObservation,
    WorkspaceRead,
    WorkspaceWrite,
    Shell,
    Network,
    Destructive,
}

impl RiskCategory {
    pub const ALL: [RiskCategory; 6] = [
        RiskCategory::HostObservation,
        RiskCategory::WorkspaceRead,
        RiskCategory::WorkspaceWrite,
        RiskCategory::Shell,
        RiskCategory::Network,
        RiskCategory::Destructive,
    ];

    pub fn label(self) -> &'static str {
        match self {
            RiskCategory::HostObservation => "host_observation",
            RiskCategory::WorkspaceRead => "workspace_read",
            RiskCategory::WorkspaceWrite => "workspace_write",
            RiskCategory::Shell => "shell",
            RiskCategory::Network => "network",
            RiskCategory::Destructive => "destructive",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    Ask,
    ReadOnly,
    FullAccess,
    Custom,
    AutoApproval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    AllowOnce,
    AllowForTask,
    AllowGlobally,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub tool_name: String,
    #[serde(default)]
    pub args: JsonMap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub id: String,
    pub tool_call_id: String,
    pub ok: bool,
    pub output: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolApproval {
    pub id: String,
    pub task_id: String,
    pub tool_call: ToolCall,
    pub risk_category: RiskCategory,
    pub reason: String,
    #[serde(default)]
    pub metadata: JsonMap,
    pub status: ApprovalStatus,
    pub decision: Option<ApprovalDecision>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub id: String,
    pub task_id: String,
    pub event_type: TaskEventType,
    pub created_at: String,
    pub summary: String,
    #[serde(default)]
    pub payload: JsonMap,
    #[serde(default)]
    pub reverted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskEventType {
    TaskCreated,
    UserMessage,
    AssistantDelta,
    AssistantMessage,
    ThinkingDelta,
    ToolRequested,
    ToolStarted,
    ToolProgress,
    ApprovalPending,
    ApprovalResolved,
    ApprovalAutoGranted,
    ToolResult,
    ModelEmptyResponse,
    StatusChanged,
    UserInputRequested,
    UserInputAnswered,
    TokenUsageRecorded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub id: String,
    pub title: String,
    pub folder_id: String,
    pub work_root: String,
    pub status: TaskStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub events: Vec<TaskEvent>,
    #[serde(default)]
    pub approvals: Vec<ToolApproval>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFolderRecord {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderConfig {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferences {
    pub permission_mode: PermissionMode,
    #[serde(default)]
    pub allowed_risks: Vec<RiskCategory>,
    #[serde(default)]
    pub auto_approval_risks: Vec<RiskCategory>,
    pub model_provider: Option<ModelProviderConfig>,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for UserPreferences {
    fn default() -> Self {
        let now = now_iso();
        Self {
            permission_mode: PermissionMode::Ask,
            allowed_risks: vec![],
            auto_approval_risks: vec![RiskCategory::HostObservation, RiskCategory::WorkspaceRead, RiskCategory::Network],
            model_provider: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum CanonicalModelMessage {
    System { content: String },
    User { content: String, event_id: Option<String> },
    Assistant { content: Option<String>, tool_calls: Vec<ToolCall> },
    Tool { tool_call_id: String, tool_name: String, content: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTurn {
    pub content: String,
    pub thinking: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<ModelUsage>,
    pub empty_response: bool,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeItem {
    pub id: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub source_uri: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn parse_datetime(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|dt| dt.with_timezone(&Utc))
}
