use anyhow::Result;
use async_trait::async_trait;
use eframe::egui;
use scc_native_core::model::{ModelClient, ModelDeltaCallback, ToolDefinition};
use scc_native_core::{AgentRuntime, NativeStore, OpenAiCompatibleClient, RuntimeEvent};
use scc_native_shared::{CanonicalModelMessage, ModelProviderConfig, ModelTurn, PermissionMode, TaskDetail, TaskEventType, TaskStatus};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::runtime::Runtime;
use tokio::sync::broadcast;

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([1280.0, 820.0]).with_title("SCC Native Agent Workbench"),
        ..Default::default()
    };
    eframe::run_native("SCC Native Agent Workbench", options, Box::new(|cc| Ok(Box::new(NativeWorkbenchApp::new(cc)))))
}

struct NativeWorkbenchApp {
    runtime: Arc<AgentRuntime>,
    tokio: Runtime,
    events: broadcast::Receiver<RuntimeEvent>,
    tasks: Vec<TaskDetail>,
    selected_task_id: Option<String>,
    prompt: String,
    work_root: String,
    status_line: String,
    permission_mode: PermissionMode,
    pending_answer: String,
}

impl NativeWorkbenchApp {
    fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        let tokio = Runtime::new().expect("tokio runtime");
        let data_root = native_data_root();
        let store = NativeStore::open(data_root.join("native.sqlite")).expect("native store");
        let mut prefs = store.get_preferences().unwrap_or_default();
        if prefs.model_provider.is_none() {
            prefs.model_provider = model_provider_from_env();
            let _ = store.save_preferences(&prefs);
        }
        let model: Arc<dyn ModelClient> = if let Some(provider) = prefs.model_provider.clone() {
            Arc::new(OpenAiCompatibleClient::new(provider))
        } else {
            Arc::new(LocalGuidanceModel)
        };
        let runtime = Arc::new(AgentRuntime::new(store.clone(), model, data_root.join("model-traces")));
        let events = runtime.subscribe();
        let tasks = runtime.list_tasks().unwrap_or_default();
        let selected_task_id = tasks.first().map(|task| task.id.clone());
        let permission_mode = prefs.permission_mode;
        Self {
            runtime,
            tokio,
            events,
            tasks,
            selected_task_id,
            prompt: String::new(),
            work_root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).display().to_string(),
            status_line: "Ready".to_string(),
            permission_mode,
            pending_answer: String::new(),
        }
    }

    fn refresh_tasks(&mut self) {
        self.tasks = self.runtime.list_tasks().unwrap_or_default();
        if self.selected_task_id.is_none() {
            self.selected_task_id = self.tasks.first().map(|task| task.id.clone());
        }
    }

    fn selected_task(&self) -> Option<TaskDetail> {
        self.selected_task_id.as_ref().and_then(|id| self.runtime.get_task(id).ok().flatten())
    }

    fn start_task(&mut self) {
        let prompt = self.prompt.trim().to_string();
        if prompt.is_empty() {
            return;
        }
        self.prompt.clear();
        let runtime = self.runtime.clone();
        let work_root = PathBuf::from(self.work_root.clone());
        let shell = runtime.create_task_shell(&prompt, None, work_root).expect("create task shell");
        self.selected_task_id = Some(shell.id.clone());
        self.status_line = format!("Running {}", shell.title);
        self.refresh_tasks();
        self.tokio.spawn(async move {
            let _ = runtime.run_task(&shell.id).await;
        });
    }

    fn set_permission_mode(&mut self, mode: PermissionMode) {
        self.permission_mode = mode;
        let store = self.runtime.store();
        if let Ok(mut prefs) = store.get_preferences() {
            prefs.permission_mode = mode;
            match mode {
                PermissionMode::Ask => prefs.allowed_risks.clear(),
                PermissionMode::ReadOnly => prefs.allowed_risks = vec![scc_native_shared::RiskCategory::HostObservation, scc_native_shared::RiskCategory::WorkspaceRead],
                PermissionMode::FullAccess => prefs.allowed_risks = scc_native_shared::RiskCategory::ALL.to_vec(),
                PermissionMode::Custom => {}
                PermissionMode::AutoApproval => {}
            }
            let _ = store.save_preferences(&prefs);
        }
    }
}

impl eframe::App for NativeWorkbenchApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while self.events.try_recv().is_ok() {
            self.refresh_tasks();
            ctx.request_repaint();
        }

        egui::TopBottomPanel::top("top_bar").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("SCC Native");
                ui.label(&self.status_line);
                ui.separator();
                ui.label("Workspace:");
                ui.text_edit_singleline(&mut self.work_root);
            });
        });

        egui::SidePanel::left("task_list").resizable(true).default_width(280.0).show(ctx, |ui| {
            ui.heading("Tasks");
            if ui.button("Refresh").clicked() {
                self.refresh_tasks();
            }
            ui.separator();
            egui::ScrollArea::vertical().show(ui, |ui| {
                for task in &self.tasks {
                    let selected = self.selected_task_id.as_deref() == Some(task.id.as_str());
                    if ui.selectable_label(selected, format!("{} · {:?}", task.title, task.status)).clicked() {
                        self.selected_task_id = Some(task.id.clone());
                    }
                }
            });
        });

        egui::SidePanel::right("settings").resizable(true).default_width(260.0).show(ctx, |ui| {
            ui.heading("Permissions");
            for (mode, label) in [
                (PermissionMode::Ask, "每次询问 / Ask"),
                (PermissionMode::ReadOnly, "只读 / Read only"),
                (PermissionMode::FullAccess, "完全访问 / Full access"),
                (PermissionMode::Custom, "自定义 / Custom"),
                (PermissionMode::AutoApproval, "自动审批 / Auto approval"),
            ] {
                if ui.radio_value(&mut self.permission_mode, mode, label).changed() {
                    self.set_permission_mode(mode);
                }
            }
            if self.permission_mode == PermissionMode::FullAccess {
                ui.colored_label(egui::Color32::RED, "Full access includes destructive operations. Use only in trusted workspaces.");
            }
            ui.separator();
            ui.heading("Trace");
            ui.label("Native traces are written per task under the native data directory.");
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            if let Some(task) = self.selected_task() {
                ui.horizontal(|ui| {
                    ui.heading(&task.title);
                    ui.label(format!("{:?}", task.status));
                    if matches!(task.status, TaskStatus::Running | TaskStatus::WaitingApproval | TaskStatus::WaitingForUser) && ui.button("Pause").clicked() {
                        let _ = self.runtime.pause(&task.id);
                    }
                    if ui.button("Cancel").clicked() {
                        let _ = self.runtime.cancel(&task.id);
                    }
                });
                ui.separator();
                egui::ScrollArea::vertical().stick_to_bottom(true).show(ui, |ui| {
                    let count = task.events.len();
                    let start = count.saturating_sub(500);
                    for event in &task.events[start..] {
                        draw_event(ui, event);
                    }
                });
                if task.status == TaskStatus::WaitingForUser {
                    ui.separator();
                    ui.horizontal(|ui| {
                        ui.label("Answer:");
                        ui.text_edit_singleline(&mut self.pending_answer);
                        if ui.button("Send answer").clicked() {
                            if let Some(event) = task.events.iter().rev().find(|event| event.event_type == TaskEventType::UserInputRequested) {
                                if let Some(tool_call_id) = event.payload.get("toolCallId").and_then(|v| v.as_str()) {
                                    let runtime = self.runtime.clone();
                                    let task_id = task.id.clone();
                                    let tool_call_id = tool_call_id.to_string();
                                    let answer = std::mem::take(&mut self.pending_answer);
                                    self.tokio.spawn(async move {
                                        let _ = runtime.answer_user_input(&task_id, &tool_call_id, &answer).await;
                                    });
                                }
                            }
                        }
                    });
                }
            } else {
                ui.centered_and_justified(|ui| ui.label("Create a task to start."));
            }
        });

        egui::TopBottomPanel::bottom("composer").show(ctx, |ui| {
            ui.horizontal(|ui| {
                let response = ui.add_sized([ui.available_width() - 100.0, 72.0], egui::TextEdit::multiline(&mut self.prompt).hint_text("Describe a task..."));
                let send = ui.button("Send");
                if send.clicked() || (response.lost_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter) && !input.modifiers.shift)) {
                    self.start_task();
                }
            });
        });
    }
}

fn draw_event(ui: &mut egui::Ui, event: &scc_native_shared::TaskEvent) {
    let color = match event.event_type {
        TaskEventType::UserMessage => egui::Color32::from_rgb(60, 120, 220),
        TaskEventType::AssistantMessage | TaskEventType::AssistantDelta => egui::Color32::from_rgb(90, 180, 120),
        TaskEventType::ToolStarted | TaskEventType::ToolProgress | TaskEventType::ToolResult => egui::Color32::from_rgb(210, 160, 70),
        TaskEventType::ApprovalPending => egui::Color32::from_rgb(230, 120, 60),
        TaskEventType::ModelEmptyResponse => egui::Color32::from_rgb(220, 80, 80),
        _ => egui::Color32::GRAY,
    };
    egui::Frame::group(ui.style()).show(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.colored_label(color, format!("{:?}", event.event_type));
            ui.label(&event.summary);
        });
        match event.event_type {
            TaskEventType::ToolProgress | TaskEventType::ToolResult | TaskEventType::ApprovalPending | TaskEventType::UserInputRequested => {
                ui.collapsing("details", |ui| {
                    ui.monospace(serde_json::to_string_pretty(&event.payload).unwrap_or_default());
                });
            }
            _ => {
                if let Some(content) = event.payload.get("content").and_then(|v| v.as_str()) {
                    ui.label(content);
                }
            }
        }
    });
}

fn native_data_root() -> PathBuf {
    if let Ok(value) = std::env::var("SCC_NATIVE_DATA_DIR") {
        return PathBuf::from(value);
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("data").join("native")
}

fn model_provider_from_env() -> Option<ModelProviderConfig> {
    let api_key = std::env::var("OPENAI_API_KEY").or_else(|_| std::env::var("SCC_OPENAI_API_KEY")).ok()?;
    let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
    let model = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-5.4".to_string());
    Some(ModelProviderConfig { name: "Environment".into(), base_url, api_key, model })
}

struct LocalGuidanceModel;

#[async_trait]
impl ModelClient for LocalGuidanceModel {
    async fn complete(&self, _messages: &[CanonicalModelMessage], _tools: &[ToolDefinition], _on_delta: Option<ModelDeltaCallback>) -> Result<ModelTurn> {
        Ok(ModelTurn {
            content: "No model provider is configured. Set OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL or configure a provider in the native store.".into(),
            ..Default::default()
        })
    }
}
