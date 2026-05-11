mod design;

use anyhow::Result;
use async_trait::async_trait;
use design::{apply_context_style, rgba, ThemeTokens};
use eframe::egui;
use egui::{Align, Color32, FontId, Layout, RichText, Sense, Stroke, Vec2};
use scc_native_core::model::{ModelClient, ModelDeltaCallback, ToolDefinition};
use scc_native_core::{AgentRuntime, NativeStore, OpenAiCompatibleClient, RuntimeEvent};
use scc_native_shared::{
    ApprovalDecision, CanonicalModelMessage, ModelProviderConfig, ModelTurn, PermissionMode, RiskCategory, TaskDetail, TaskEvent, TaskEventType, TaskStatus,
};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::runtime::Runtime;
use tokio::sync::broadcast;

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1440.0, 860.0])
            .with_min_inner_size([920.0, 640.0])
            .with_title("SCC Native Agent Workbench"),
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
    allowed_risks: Vec<RiskCategory>,
    auto_approval_risks: Vec<RiskCategory>,
    pending_answer: String,
    selected_nav: NavSection,
    tokens: ThemeTokens,
    show_trace_panel: bool,
    full_access_confirmation: bool,
    last_error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NavSection {
    Tasks,
    Library,
    Settings,
    Docs,
}

impl NativeWorkbenchApp {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
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
        let tokens = match std::env::var("SCC_NATIVE_THEME").unwrap_or_else(|_| "dark".to_string()).as_str() {
            "light" => ThemeTokens::light(),
            _ => ThemeTokens::dark(),
        };
        apply_context_style(&cc.egui_ctx, tokens);
        Self {
            runtime,
            tokio,
            events,
            tasks,
            selected_task_id,
            prompt: String::new(),
            work_root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).display().to_string(),
            status_line: "Ready".to_string(),
            permission_mode: prefs.permission_mode,
            allowed_risks: prefs.allowed_risks,
            auto_approval_risks: prefs.auto_approval_risks,
            pending_answer: String::new(),
            selected_nav: NavSection::Tasks,
            tokens,
            show_trace_panel: true,
            full_access_confirmation: false,
            last_error: None,
        }
    }

    fn refresh_tasks(&mut self) {
        match self.runtime.list_tasks() {
            Ok(tasks) => {
                self.tasks = tasks;
                if self.selected_task_id.is_none() {
                    self.selected_task_id = self.tasks.first().map(|task| task.id.clone());
                }
            }
            Err(error) => self.last_error = Some(error.to_string()),
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
        match runtime.create_task_shell(&prompt, None, work_root) {
            Ok(shell) => {
                self.selected_task_id = Some(shell.id.clone());
                self.status_line = format!("Running {}", shell.title);
                self.refresh_tasks();
                self.tokio.spawn(async move {
                    let _ = runtime.run_task(&shell.id).await;
                });
            }
            Err(error) => self.last_error = Some(error.to_string()),
        }
    }

    fn set_permission_mode(&mut self, mode: PermissionMode) {
        if mode == PermissionMode::FullAccess && self.permission_mode != PermissionMode::FullAccess {
            self.full_access_confirmation = true;
            return;
        }
        self.apply_permission_mode(mode);
    }

    fn apply_permission_mode(&mut self, mode: PermissionMode) {
        self.permission_mode = mode;
        if let Ok(mut prefs) = self.runtime.store().get_preferences() {
            prefs.permission_mode = mode;
            match mode {
                PermissionMode::Ask => prefs.allowed_risks.clear(),
                PermissionMode::ReadOnly => prefs.allowed_risks = vec![RiskCategory::HostObservation, RiskCategory::WorkspaceRead],
                PermissionMode::FullAccess => prefs.allowed_risks = RiskCategory::ALL.to_vec(),
                PermissionMode::Custom => prefs.allowed_risks = self.allowed_risks.clone(),
                PermissionMode::AutoApproval => {
                    prefs.auto_approval_risks = self.auto_approval_risks.iter().copied().filter(|risk| *risk != RiskCategory::Destructive).collect();
                    prefs.allowed_risks.clear();
                }
            }
            self.allowed_risks = prefs.allowed_risks.clone();
            self.auto_approval_risks = prefs.auto_approval_risks.clone();
            if let Err(error) = self.runtime.store().save_preferences(&prefs) {
                self.last_error = Some(error.to_string());
            }
        }
    }

    fn save_risk_lists(&mut self) {
        if let Ok(mut prefs) = self.runtime.store().get_preferences() {
            prefs.allowed_risks = self.allowed_risks.clone();
            prefs.auto_approval_risks = self.auto_approval_risks.iter().copied().filter(|risk| *risk != RiskCategory::Destructive).collect();
            if let Err(error) = self.runtime.store().save_preferences(&prefs) {
                self.last_error = Some(error.to_string());
            }
        }
    }
}

impl eframe::App for NativeWorkbenchApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while let Ok(RuntimeEvent::TaskEvent(_)) = self.events.try_recv() {
            self.refresh_tasks();
            ctx.request_repaint();
        }

        egui::SidePanel::left("native_sidebar")
            .exact_width(self.tokens.sidebar_width)
            .resizable(false)
            .frame(egui::Frame::none().fill(self.tokens.sidebar_bg))
            .show(ctx, |ui| {
                draw_sidebar(ui, self);
            });

        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(self.tokens.app_bg))
            .show(ctx, |ui| {
                draw_main_workspace(ui, self, ctx);
            });

        draw_right_rail_overlay(ctx, self);

        if self.full_access_confirmation {
            draw_full_access_modal(ctx, self);
        }
    }
}

fn draw_sidebar(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp) {
    let tokens = app.tokens;
    egui::Frame::none()
        .fill(tokens.sidebar_bg)
        .stroke(Stroke::new(1.0, tokens.border))
        .inner_margin(egui::Margin::same(20.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.set_min_height(ui.available_height());
            ui.vertical(|ui| {
                ui.horizontal(|ui| {
                    let (rect, _) = ui.allocate_exact_size(Vec2::splat(38.0), Sense::hover());
                    ui.painter().rect_filled(rect, tokens.radius_sm, tokens.surface_2);
                    ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, "S", FontId::proportional(22.0), tokens.accent);
                    ui.vertical(|ui| {
                        ui.label(RichText::new("SCC Native").size(23.0).strong().color(tokens.text));
                        ui.label(RichText::new("AGENT WORKBENCH").size(10.5).strong().color(tokens.muted));
                    });
                });
                ui.add_space(26.0);
                nav_button(ui, app, NavSection::Tasks, "Tasks", "Task timeline and tools");
                nav_button(ui, app, NavSection::Library, "Library", "Knowledge, skills, memory");
                nav_button(ui, app, NavSection::Settings, "Settings", "Providers and runtime");
                nav_button(ui, app, NavSection::Docs, "Docs", "Local operation notes");
                ui.add_space(18.0);
                ui.separator();
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new("TASKS").size(11.0).strong().color(tokens.muted));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if small_icon_button(ui, tokens, "↻").clicked() {
                            app.refresh_tasks();
                        }
                    });
                });
                ui.add_space(6.0);
                egui::ScrollArea::vertical().id_salt("sidebar_tasks").auto_shrink([false, false]).show(ui, |ui| {
                    if app.tasks.is_empty() {
                        tokens.subtle_frame().show(ui, |ui| {
                            ui.label(RichText::new("No tasks yet").strong().color(tokens.text));
                            ui.label(RichText::new("Start from the composer.").size(12.0).color(tokens.muted));
                        });
                    }
                    let tasks = app.tasks.clone();
                    for task in tasks {
                        let selected = app.selected_task_id.as_deref() == Some(task.id.as_str());
                        if task_row(ui, tokens, &task, selected).clicked() {
                            app.selected_task_id = Some(task.id.clone());
                            app.selected_nav = NavSection::Tasks;
                        }
                    }
                });
                ui.with_layout(Layout::bottom_up(Align::LEFT), |ui| {
                    ui.add_space(10.0);
                    let label = if tokens.dark { "Light mode" } else { "Dark mode" };
                    if ui.button(label).clicked() {
                        app.tokens = if tokens.dark { ThemeTokens::light() } else { ThemeTokens::dark() };
                        apply_context_style(ui.ctx(), app.tokens);
                    }
                });
            });
        });
}

fn nav_button(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp, section: NavSection, label: &str, description: &str) {
    let tokens = app.tokens;
    let selected = app.selected_nav == section;
    let response = tokens.card_frame(selected).show(ui, |ui| {
        ui.set_min_height(30.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new(nav_icon(section)).size(15.0).color(if selected { tokens.text } else { tokens.muted_strong }));
            ui.vertical(|ui| {
                ui.label(RichText::new(label).size(14.0).strong().color(tokens.text));
                ui.label(RichText::new(description).size(10.5).color(tokens.muted));
            });
        });
    });
    if response.response.interact(Sense::click()).clicked() {
        app.selected_nav = section;
    }
}

fn task_row(ui: &mut egui::Ui, tokens: ThemeTokens, task: &TaskDetail, selected: bool) -> egui::Response {
    let response = tokens.card_frame(selected).show(ui, |ui| {
        ui.set_min_height(38.0);
        ui.horizontal(|ui| {
            status_dot(ui, tokens, task.status);
            ui.vertical(|ui| {
                ui.label(RichText::new(&task.title).size(12.5).strong().color(tokens.text));
                ui.label(RichText::new(format!("{:?} · {} events", task.status, task.events.len())).size(10.5).color(tokens.muted));
            });
        });
    });
    response.response.interact(Sense::click())
}

fn draw_main_workspace(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp, ctx: &egui::Context) {
    let tokens = app.tokens;
    ui.vertical(|ui| {
        ui.set_width(ui.available_width());
        draw_workspace_header(ui, app);
        match app.selected_nav {
            NavSection::Tasks => draw_task_thread(ui, app, ctx),
            NavSection::Library => draw_placeholder_surface(ui, tokens, "Library", "Native v1 keeps the agent workbench first. Knowledge, skills, memory, and reflections are preserved in the Web reference until the next native vertical slice."),
            NavSection::Settings => draw_settings_surface(ui, app),
            NavSection::Docs => draw_placeholder_surface(ui, tokens, "Docs", "Native traces are written per task under the native data directory. Tool history is canonical role history, not user text."),
        }
    });
}

fn draw_workspace_header(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp) {
    let tokens = app.tokens;
    ui.add_space(16.0);
    ui.horizontal(|ui| {
        ui.vertical(|ui| {
            ui.label(RichText::new(section_title(app.selected_nav)).size(23.0).strong().color(tokens.text));
            ui.label(RichText::new(&app.status_line).size(12.0).color(tokens.muted));
        });
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            let text = if app.show_trace_panel { "Hide right rail" } else { "Show right rail" };
            if ui.button(text).clicked() {
                app.show_trace_panel = !app.show_trace_panel;
            }
        });
    });
    if let Some(error) = &app.last_error {
        ui.add_space(8.0);
        egui::Frame::none()
            .fill(tokens.danger_bg)
            .stroke(Stroke::new(1.0, tokens.danger_border))
            .rounding(tokens.radius)
            .inner_margin(egui::Margin::symmetric(12.0, 9.0))
            .show(ui, |ui| {
                ui.label(RichText::new(error).color(tokens.danger));
            });
    }
    ui.add_space(10.0);
}

fn draw_task_thread(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp, ctx: &egui::Context) {
    draw_task_thread_content(ui, app, ctx);
}

fn draw_task_thread_content(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp, ctx: &egui::Context) {
    let tokens = app.tokens;
    tokens.panel_frame().show(ui, |ui| {
        ui.set_min_height((ui.available_height() - 136.0).max(340.0));
        if let Some(task) = app.selected_task() {
            ui.horizontal(|ui| {
                status_dot(ui, tokens, task.status);
                ui.label(RichText::new(&task.title).size(18.0).strong().color(tokens.text));
                ui.label(RichText::new(format!("{:?}", task.status)).size(12.0).color(tokens.muted));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if matches!(task.status, TaskStatus::Running | TaskStatus::WaitingApproval | TaskStatus::WaitingForUser) && ui.button("Pause").clicked() {
                        let _ = app.runtime.pause(&task.id);
                    }
                    if ui.button("Cancel").clicked() {
                        let _ = app.runtime.cancel(&task.id);
                    }
                });
            });
            ui.add_space(8.0);
            ui.separator();
            ui.add_space(8.0);
            egui::ScrollArea::vertical().id_salt(("timeline", task.id.clone())).stick_to_bottom(true).auto_shrink([false, false]).show(ui, |ui| {
                let count = task.events.len();
                let start = count.saturating_sub(700);
                for event in &task.events[start..] {
                    draw_event_card(ui, app, tokens, event);
                    ui.add_space(6.0);
                }
                if task.status == TaskStatus::Running {
                    draw_running_indicator(ui, tokens, ctx);
                }
            });
            if task.status == TaskStatus::WaitingForUser {
                ui.add_space(10.0);
                draw_ask_user_answer(ui, app, &task);
            }
        } else {
            draw_empty_state(ui, tokens);
        }
    });
    ui.add_space(10.0);
    draw_composer(ui, app);
}

fn draw_event_card(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp, tokens: ThemeTokens, event: &TaskEvent) {
    let from_user = matches!(event.event_type, TaskEventType::UserMessage | TaskEventType::UserInputAnswered);
    ui.with_layout(if from_user { Layout::right_to_left(Align::TOP) } else { Layout::left_to_right(Align::TOP) }, |ui| {
        let max_width = if from_user { ui.available_width() * 0.78 } else { ui.available_width() * 0.84 };
        ui.allocate_ui_with_layout(Vec2::new(max_width.max(360.0), 0.0), Layout::top_down(Align::LEFT), |ui| {
            ui.push_id(&event.id, |ui| {
                match event.event_type {
                    TaskEventType::ToolStarted | TaskEventType::ToolProgress | TaskEventType::ToolResult => draw_tool_event(ui, tokens, event),
                    TaskEventType::ApprovalPending => draw_approval_event(ui, app, tokens, event),
                    TaskEventType::UserInputRequested => draw_ask_user_event(ui, tokens, event),
                    TaskEventType::ModelEmptyResponse => draw_empty_response_event(ui, tokens, event),
                    TaskEventType::ThinkingDelta => draw_thinking_event(ui, tokens, event),
                    _ => draw_message_event(ui, tokens, event, from_user),
                }
            });
        });
    });
}

fn draw_message_event(ui: &mut egui::Ui, tokens: ThemeTokens, event: &TaskEvent, from_user: bool) {
    tokens.bubble_frame(from_user).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new(event_label(event.event_type)).size(11.0).strong().color(tokens.muted));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new(short_time(&event.created_at)).size(10.0).color(tokens.muted));
            });
        });
        ui.add_space(4.0);
        if let Some(content) = event.payload.get("content").and_then(Value::as_str) {
            ui.label(RichText::new(content).size(13.5).color(tokens.text));
        } else if let Some(delta) = event.payload.get("delta").and_then(Value::as_str) {
            ui.label(RichText::new(delta).size(13.0).color(tokens.muted_strong));
        } else {
            ui.label(RichText::new(&event.summary).size(13.0).color(tokens.text));
        }
    });
}

fn draw_tool_event(ui: &mut egui::Ui, tokens: ThemeTokens, event: &TaskEvent) {
    let tool_name = event.payload.get("toolName").and_then(Value::as_str).unwrap_or("tool");
    let progress = event.payload.get("progress");
    let target_path = progress
        .and_then(|value| value.get("targetPath"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| event.payload.get("targetPath").and_then(Value::as_str).map(str::to_string))
        .or_else(|| parse_tool_output(event).and_then(|value| value.get("path").and_then(Value::as_str).map(str::to_string)));
    let changes = extract_changes(event);
    tokens.subtle_frame().show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new("✎").size(14.0).color(tokens.warning));
            ui.vertical(|ui| {
                ui.label(RichText::new(tool_name).size(13.0).strong().color(tokens.text));
                if let Some(path) = target_path.as_deref() {
                    ui.label(RichText::new(short_path(path)).size(11.0).color(tokens.muted)).on_hover_text(path);
                } else {
                    ui.label(RichText::new(&event.summary).size(11.0).color(tokens.muted));
                }
            });
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if let Some((added, removed)) = changes {
                    change_badge(ui, tokens, added, removed);
                }
                status_badge(ui, tokens, tool_status(event));
            });
        });
        if matches!(event.event_type, TaskEventType::ToolProgress) {
            if let Some((processed, total)) = progress
                .and_then(|value| Some((value.get("processed")?.as_u64()?, value.get("total")?.as_u64()?)))
            {
                let fraction = if total == 0 { 0.0 } else { (processed as f32 / total as f32).clamp(0.0, 1.0) };
                ui.add(egui::ProgressBar::new(fraction).show_percentage());
            }
        }
        ui.add_space(4.0);
        ui.collapsing("Details", |ui| {
            if let Some(path) = target_path.as_deref() {
                ui.label(RichText::new(path).size(12.0).color(tokens.muted_strong)).on_hover_text(path);
            }
            if let Some(output) = parse_tool_output(event) {
                draw_tool_output_summary(ui, tokens, &output);
            } else if let Some(progress) = progress {
                ui.label(RichText::new(progress.get("message").and_then(Value::as_str).unwrap_or("Running")).color(tokens.muted_strong));
            }
            ui.collapsing("Raw debug payload", |ui| {
                ui.monospace(serde_json::to_string_pretty(&event.payload).unwrap_or_default());
            });
        });
    });
}

fn draw_tool_output_summary(ui: &mut egui::Ui, tokens: ThemeTokens, output: &Value) {
    if output.get("content").and_then(Value::as_str).is_some() {
        let path = output.get("path").and_then(Value::as_str).unwrap_or("file");
        let mode = output.get("mode").and_then(Value::as_str).unwrap_or("read");
        let partial = output.get("partial").and_then(Value::as_bool).unwrap_or(false);
        ui.label(RichText::new(format!("Read {mode}: {}", short_path(path))).color(tokens.text));
        ui.label(RichText::new(format!("Partial: {partial}; use range reads for omitted sections.")).size(11.0).color(tokens.muted));
        if let Some(content) = output.get("content").and_then(Value::as_str) {
            let preview: String = content.chars().take(900).collect();
            egui::Frame::none()
                .fill(tokens.surface)
                .stroke(Stroke::new(1.0, tokens.border))
                .rounding(tokens.radius_sm)
                .inner_margin(egui::Margin::same(9.0))
                .show(ui, |ui| ui.monospace(preview));
        }
        return;
    }
    if let Some(status) = output.get("status").and_then(Value::as_str) {
        ui.label(RichText::new(format!("Status: {status}")).color(if status == "conflict" { tokens.danger } else { tokens.text }));
        if status == "conflict" {
            if let Some(reason) = output.get("reason").and_then(Value::as_str) {
                ui.label(RichText::new(reason).color(tokens.danger));
            }
        }
    }
    if let Some(matches) = output.get("matches").and_then(Value::as_array) {
        ui.label(RichText::new(format!("{} workspace snippet matches. Use read_file for full contents.", matches.len())).color(tokens.muted_strong));
        for item in matches.iter().take(4) {
            let path = item.get("path").and_then(Value::as_str).unwrap_or("");
            let line = item.get("line").and_then(Value::as_u64).map(|v| format!(":{v}")).unwrap_or_default();
            let snippet = item.get("snippet").and_then(Value::as_str).unwrap_or("");
            ui.label(RichText::new(format!("{}{}  {}", short_path(path), line, snippet)).size(11.5).color(tokens.muted));
        }
        return;
    }
    if output.to_string().len() > 1200 {
        ui.label(RichText::new("Large result omitted inline. Use trace for the full payload.").color(tokens.muted));
    } else {
        ui.monospace(serde_json::to_string_pretty(output).unwrap_or_else(|_| output.to_string()));
    }
}

fn draw_approval_event(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp, tokens: ThemeTokens, event: &TaskEvent) {
    egui::Frame::none()
        .fill(tokens.warning_bg)
        .stroke(Stroke::new(1.0, tokens.warning))
        .rounding(tokens.radius)
        .inner_margin(egui::Margin::same(12.0))
        .show(ui, |ui| {
            ui.label(RichText::new("Approval required").strong().color(tokens.text));
            ui.label(RichText::new(&event.summary).color(tokens.muted_strong));
            ui.add_space(8.0);
            ui.horizontal_wrapped(|ui| {
                if primary_button(ui, tokens, "Allow once", true).clicked() {
                    resolve_approval(app, event, ApprovalDecision::AllowOnce);
                }
                if ui.button("Allow for task").clicked() {
                    resolve_approval(app, event, ApprovalDecision::AllowForTask);
                }
                if ui.button("Deny").clicked() {
                    resolve_approval(app, event, ApprovalDecision::Deny);
                }
            });
            ui.collapsing("Approval payload", |ui| ui.monospace(serde_json::to_string_pretty(&event.payload).unwrap_or_default()));
        });
}

fn resolve_approval(app: &mut NativeWorkbenchApp, event: &TaskEvent, decision: ApprovalDecision) {
    let Some(approval_id) = event.payload.get("approvalId").and_then(Value::as_str).map(str::to_string) else {
        app.last_error = Some("approvalId missing from approval event".to_string());
        return;
    };
    let runtime = app.runtime.clone();
    let task_id = event.task_id.clone();
    app.tokio.spawn(async move {
        let _ = runtime.decide_approval(&task_id, &approval_id, decision).await;
    });
}

fn draw_ask_user_event(ui: &mut egui::Ui, tokens: ThemeTokens, event: &TaskEvent) {
    tokens.bubble_frame(false).show(ui, |ui| {
        ui.label(RichText::new("Question for user").strong().color(tokens.text));
        let question = event.payload.get("question").and_then(|value| value.as_str().or_else(|| value.get("question").and_then(Value::as_str))).unwrap_or(&event.summary);
        ui.label(RichText::new(question).color(tokens.muted_strong));
    });
}

fn draw_empty_response_event(ui: &mut egui::Ui, tokens: ThemeTokens, event: &TaskEvent) {
    egui::Frame::none()
        .fill(tokens.danger_bg)
        .stroke(Stroke::new(1.0, tokens.danger_border))
        .rounding(tokens.radius)
        .inner_margin(egui::Margin::same(12.0))
        .show(ui, |ui| {
            ui.label(RichText::new("Empty model response").strong().color(tokens.danger));
            ui.label(RichText::new(&event.summary).color(tokens.muted_strong));
        });
}

fn draw_thinking_event(ui: &mut egui::Ui, tokens: ThemeTokens, event: &TaskEvent) {
    egui::Frame::none()
        .fill(rgba(tokens.surface_low.r(), tokens.surface_low.g(), tokens.surface_low.b(), 180))
        .rounding(tokens.radius_sm)
        .inner_margin(egui::Margin::symmetric(10.0, 7.0))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("Thinking").size(12.0).strong().color(tokens.muted_strong));
                ui.label(RichText::new(event.payload.get("delta").and_then(Value::as_str).unwrap_or(&event.summary)).size(12.0).color(tokens.muted));
            });
        });
}

fn draw_running_indicator(ui: &mut egui::Ui, tokens: ThemeTokens, ctx: &egui::Context) {
    let tick = (ctx.input(|input| input.time) * 3.0) as usize % 4;
    let dots = ".".repeat(tick);
    egui::Frame::none()
        .fill(tokens.surface_low)
        .rounding(tokens.radius)
        .inner_margin(egui::Margin::symmetric(12.0, 9.0))
        .show(ui, |ui| ui.label(RichText::new(format!("think{dots}")).size(13.0).color(tokens.muted_strong)));
    ctx.request_repaint_after(std::time::Duration::from_millis(260));
}

fn draw_ask_user_answer(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp, task: &TaskDetail) {
    let tokens = app.tokens;
    tokens.panel_frame().show(ui, |ui| {
        ui.label(RichText::new("Answer required").strong().color(tokens.text));
        ui.horizontal(|ui| {
            ui.add_sized([ui.available_width() - 120.0, 36.0], egui::TextEdit::singleline(&mut app.pending_answer).hint_text("Type your answer..."));
            if ui.button("Send answer").clicked() {
                if let Some(event) = task.events.iter().rev().find(|event| event.event_type == TaskEventType::UserInputRequested) {
                    if let Some(tool_call_id) = event.payload.get("toolCallId").and_then(Value::as_str) {
                        let runtime = app.runtime.clone();
                        let task_id = task.id.clone();
                        let tool_call_id = tool_call_id.to_string();
                        let answer = std::mem::take(&mut app.pending_answer);
                        app.tokio.spawn(async move {
                            let _ = runtime.answer_user_input(&task_id, &tool_call_id, &answer).await;
                        });
                    }
                }
            }
        });
    });
}

fn draw_composer(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp) {
    let tokens = app.tokens;
    tokens.panel_frame().show(ui, |ui| {
        ui.add_sized([ui.available_width(), 86.0], egui::TextEdit::multiline(&mut app.prompt).hint_text("Describe a task, ask a follow-up, or paste evidence..."));
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new("Workspace").size(12.0).color(tokens.muted));
            ui.add_sized([ui.available_width() - 170.0, 28.0], egui::TextEdit::singleline(&mut app.work_root));
            let is_running = app.selected_task().is_some_and(|task| matches!(task.status, TaskStatus::Running | TaskStatus::WaitingApproval | TaskStatus::WaitingForUser));
            let has_input = !app.prompt.trim().is_empty();
            let button_text = if has_input { "Send" } else if is_running { "Pause" } else { "Send" };
            if primary_button(ui, tokens, button_text, has_input || is_running).clicked() {
                if has_input {
                    app.start_task();
                } else if is_running {
                    if let Some(task_id) = app.selected_task_id.clone() {
                        let _ = app.runtime.pause(&task_id);
                    }
                }
            }
        });
    });
}

fn draw_right_rail(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp) {
    let tokens = app.tokens;
    egui::Frame::none()
        .fill(tokens.app_bg)
        .inner_margin(egui::Margin::symmetric(14.0, 16.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            egui::ScrollArea::vertical().id_salt("right_rail").show(ui, |ui| {
                ui.set_width(ui.available_width());
                draw_permission_panel(ui, app);
                ui.add_space(12.0);
                draw_trace_panel(ui, app);
            });
        });
}

fn draw_right_rail_overlay(ctx: &egui::Context, app: &mut NativeWorkbenchApp) {
    let screen = ctx.input(|input| input.screen_rect());
    let pixels_per_point = ctx.pixels_per_point().max(1.0);
    let rail_width = 306.0;
    let screen_right = screen.right() / pixels_per_point;
    let screen_top = screen.top() / pixels_per_point;
    let screen_height = screen.height() / pixels_per_point;
    let top = screen_top + 45.0;
    let height = (screen_height - 45.0).max(480.0);
    egui::Window::new("native_right_rail_overlay")
        .title_bar(false)
        .resizable(false)
        .collapsible(false)
        .fixed_pos(egui::pos2(screen_right - rail_width, top))
        .fixed_size(Vec2::new(rail_width, height))
        .frame(
            egui::Frame::none()
                .fill(app.tokens.app_bg)
                .stroke(Stroke::new(1.0, app.tokens.border))
                .inner_margin(egui::Margin::symmetric(0.0, 0.0)),
        )
        .show(ctx, |ui| {
            ui.set_width(rail_width);
            ui.set_min_height(height);
            draw_right_rail(ui, app);
        });
}

fn draw_permission_panel(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp) {
    let tokens = app.tokens;
    tokens.panel_frame().show(ui, |ui| {
        ui.label(RichText::new("Permissions").size(15.0).strong().color(tokens.text));
        ui.label(RichText::new("Approval mode and risk coverage").size(11.5).color(tokens.muted));
        ui.add_space(10.0);
        let modes = [
            (PermissionMode::Ask, "Ask"),
            (PermissionMode::ReadOnly, "Read only"),
            (PermissionMode::FullAccess, "Full access"),
            (PermissionMode::Custom, "Custom"),
            (PermissionMode::AutoApproval, "Auto approval"),
        ];
        ui.horizontal_wrapped(|ui| {
            for (mode, label) in modes {
                let selected = app.permission_mode == mode;
                if mode_chip(ui, tokens, label, selected, mode == PermissionMode::FullAccess).clicked() {
                    app.set_permission_mode(mode);
                }
            }
        });
        ui.add_space(10.0);
        ui.separator();
        ui.add_space(8.0);
        for risk in RiskCategory::ALL {
            draw_risk_row(ui, app, risk);
        }
    });
}

fn draw_risk_row(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp, risk: RiskCategory) {
    let tokens = app.tokens;
    let selected = match app.permission_mode {
        PermissionMode::Ask => false,
        PermissionMode::ReadOnly => matches!(risk, RiskCategory::HostObservation | RiskCategory::WorkspaceRead),
        PermissionMode::FullAccess => true,
        PermissionMode::Custom => app.allowed_risks.contains(&risk),
        PermissionMode::AutoApproval => risk != RiskCategory::Destructive && app.auto_approval_risks.contains(&risk),
    };
    let locked = matches!(app.permission_mode, PermissionMode::Ask | PermissionMode::ReadOnly | PermissionMode::FullAccess)
        || (app.permission_mode == PermissionMode::AutoApproval && risk == RiskCategory::Destructive);
    tokens.subtle_frame().show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new(risk_icon(risk)).color(if risk == RiskCategory::Destructive { tokens.danger } else { tokens.muted_strong }));
            ui.vertical(|ui| {
                ui.label(RichText::new(risk.label()).size(12.5).strong().color(tokens.text));
                ui.label(RichText::new(risk_status_text(app.permission_mode, selected, risk)).size(10.5).color(tokens.muted));
            });
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if locked {
                    status_badge(ui, tokens, if selected { "allowed" } else { "ask" });
                } else {
                    let mut value = selected;
                    if ui.checkbox(&mut value, "").changed() {
                        match app.permission_mode {
                            PermissionMode::Custom => toggle_risk(&mut app.allowed_risks, risk, value),
                            PermissionMode::AutoApproval => toggle_risk(&mut app.auto_approval_risks, risk, value),
                            _ => {}
                        }
                        app.save_risk_lists();
                    }
                }
            });
        });
    });
}

fn draw_trace_panel(ui: &mut egui::Ui, app: &NativeWorkbenchApp) {
    let tokens = app.tokens;
    egui::Frame::none()
        .fill(tokens.surface_high)
        .stroke(Stroke::new(1.0, tokens.border))
        .rounding(tokens.radius)
        .inner_margin(egui::Margin::same(14.0))
        .show(ui, |ui| {
        ui.label(RichText::new("Trace").size(15.0).strong().color(tokens.text));
        ui.label(RichText::new("Per-task JSONL for debugging only").size(11.5).color(tokens.muted));
        ui.add_space(8.0);
        if let Some(task) = app.selected_task() {
            let root = native_data_root().join("model-traces").join(&task.id).join("trace.jsonl");
            ui.label(RichText::new(short_path(&root.display().to_string())).size(12.0).color(tokens.muted_strong)).on_hover_text(root.display().to_string());
            ui.add_space(8.0);
            let usage = task.events.iter().filter(|event| event.event_type == TaskEventType::TokenUsageRecorded).count();
            let tools = task.events.iter().filter(|event| matches!(event.event_type, TaskEventType::ToolStarted | TaskEventType::ToolResult)).count();
            metrics_row(ui, tokens, "Events", task.events.len());
            metrics_row(ui, tokens, "Tool records", tools);
            metrics_row(ui, tokens, "Usage records", usage);
        } else {
            ui.label(RichText::new("Select a task to inspect trace path.").color(tokens.muted));
        }
        });
}

fn draw_settings_surface(ui: &mut egui::Ui, app: &mut NativeWorkbenchApp) {
    let tokens = app.tokens;
    tokens.panel_frame().show(ui, |ui| {
        ui.label(RichText::new("Runtime settings").size(17.0).strong().color(tokens.text));
        ui.label(RichText::new("Provider configuration is loaded from environment variables for native v1.").color(tokens.muted));
        ui.add_space(12.0);
        if model_provider_from_env().is_some() {
            ui.label(RichText::new("Provider: configured").color(tokens.success));
        } else {
            ui.label(RichText::new("Provider: not configured").color(tokens.warning));
        }
        ui.label(RichText::new("Set OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL before real-model tasks.").size(12.0).color(tokens.muted));
    });
}

fn draw_placeholder_surface(ui: &mut egui::Ui, tokens: ThemeTokens, title: &str, body: &str) {
    tokens.panel_frame().show(ui, |ui| {
        ui.vertical_centered(|ui| {
            ui.add_space(80.0);
            ui.label(RichText::new(title).size(24.0).strong().color(tokens.text));
            ui.label(RichText::new(body).size(13.0).color(tokens.muted));
            ui.add_space(120.0);
        });
    });
}

fn draw_empty_state(ui: &mut egui::Ui, tokens: ThemeTokens) {
    ui.vertical_centered(|ui| {
        ui.add_space(100.0);
        ui.label(RichText::new("What should we build or verify?").size(28.0).strong().color(tokens.text));
        ui.add_space(10.0);
        ui.label(RichText::new("Native v1 keeps the current user request, tool calls, results, trace, and permissions separated.").size(13.0).color(tokens.muted));
        ui.add_space(100.0);
    });
}

fn draw_full_access_modal(ctx: &egui::Context, app: &mut NativeWorkbenchApp) {
    let tokens = app.tokens;
    egui::Window::new("Full access confirmation")
        .collapsible(false)
        .resizable(false)
        .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
        .frame(egui::Frame::none().fill(tokens.surface).stroke(Stroke::new(1.0, tokens.danger_border)).rounding(tokens.radius_lg).inner_margin(egui::Margin::same(18.0)))
        .show(ctx, |ui| {
            ui.set_width(420.0);
            ui.label(RichText::new("Full access includes destructive operations.").size(16.0).strong().color(tokens.danger));
            ui.label(RichText::new("Use this only when the workspace and task boundary are trusted.").color(tokens.muted_strong));
            ui.add_space(14.0);
            ui.horizontal(|ui| {
                if ui.button("Cancel").clicked() {
                    app.full_access_confirmation = false;
                }
                if primary_button(ui, tokens, "Enable full access", true).clicked() {
                    app.full_access_confirmation = false;
                    app.apply_permission_mode(PermissionMode::FullAccess);
                }
            });
        });
}

fn primary_button(ui: &mut egui::Ui, tokens: ThemeTokens, label: &str, enabled: bool) -> egui::Response {
    ui.add_enabled(
        enabled,
        egui::Button::new(RichText::new(label).strong().color(tokens.accent_text))
            .fill(tokens.accent)
            .stroke(Stroke::NONE)
            .rounding(999.0),
    )
}

fn mode_chip(ui: &mut egui::Ui, tokens: ThemeTokens, label: &str, selected: bool, danger: bool) -> egui::Response {
    let fill = if selected {
        if danger { tokens.danger_bg } else { tokens.accent_soft }
    } else {
        tokens.surface_2
    };
    let stroke = if selected {
        if danger { tokens.danger_border } else { tokens.border_strong }
    } else {
        tokens.border
    };
    ui.add(
        egui::Button::new(RichText::new(label).size(12.0).strong().color(if danger && selected { tokens.danger } else { tokens.text }))
            .fill(fill)
            .stroke(Stroke::new(1.0, stroke))
            .rounding(999.0),
    )
}

fn small_icon_button(ui: &mut egui::Ui, tokens: ThemeTokens, label: &str) -> egui::Response {
    ui.add(
        egui::Button::new(RichText::new(label).color(tokens.muted_strong))
            .fill(Color32::TRANSPARENT)
            .stroke(Stroke::new(1.0, tokens.border))
            .rounding(tokens.radius_sm),
    )
}

fn status_badge(ui: &mut egui::Ui, tokens: ThemeTokens, label: &str) {
    let color = match label {
        "failed" | "denied" | "conflict" | "ask" => tokens.danger,
        "running" | "started" => tokens.warning,
        "allowed" | "completed" | "success" => tokens.success,
        _ => tokens.muted_strong,
    };
    egui::Frame::none()
        .fill(tokens.surface_3)
        .stroke(Stroke::new(1.0, tokens.border))
        .rounding(999.0)
        .inner_margin(egui::Margin::symmetric(7.0, 3.0))
        .show(ui, |ui| {
            ui.label(RichText::new(label).size(10.0).strong().color(color));
        });
}

fn change_badge(ui: &mut egui::Ui, tokens: ThemeTokens, added: i64, removed: i64) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(format!("+{added}")).size(11.0).strong().color(tokens.success));
        ui.label(RichText::new(format!("-{removed}")).size(11.0).strong().color(tokens.danger));
    });
}

fn status_dot(ui: &mut egui::Ui, tokens: ThemeTokens, status: TaskStatus) {
    let color = match status {
        TaskStatus::Running => tokens.warning,
        TaskStatus::Completed => tokens.success,
        TaskStatus::Failed | TaskStatus::Cancelled => tokens.danger,
        TaskStatus::WaitingApproval | TaskStatus::WaitingForUser => tokens.warning,
        _ => tokens.muted,
    };
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(8.0), Sense::hover());
    ui.painter().circle_filled(rect.center(), 4.0, color);
}

fn metrics_row(ui: &mut egui::Ui, tokens: ThemeTokens, label: &str, value: usize) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(label).color(tokens.muted));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(RichText::new(value.to_string()).strong().color(tokens.text));
        });
    });
}

fn toggle_risk(list: &mut Vec<RiskCategory>, risk: RiskCategory, selected: bool) {
    if selected && !list.contains(&risk) {
        list.push(risk);
    } else if !selected {
        list.retain(|item| *item != risk);
    }
}

fn parse_tool_output(event: &TaskEvent) -> Option<Value> {
    event.payload
        .get("output")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .or_else(|| event.payload.get("result").and_then(|result| result.get("output")).and_then(Value::as_str).and_then(|raw| serde_json::from_str(raw).ok()))
}

fn extract_changes(event: &TaskEvent) -> Option<(i64, i64)> {
    let from_progress = event
        .payload
        .get("progress")
        .and_then(|progress| progress.get("changes"))
        .and_then(|changes| Some((changes.get("addedLines")?.as_i64()?, changes.get("removedLines")?.as_i64()?)));
    if from_progress.is_some() {
        return from_progress;
    }
    parse_tool_output(event).and_then(|output| {
        let changes = output.get("changes")?;
        Some((changes.get("addedLines")?.as_i64()?, changes.get("removedLines")?.as_i64()?))
    })
}

fn tool_status(event: &TaskEvent) -> &'static str {
    match event.event_type {
        TaskEventType::ToolStarted => "started",
        TaskEventType::ToolProgress => "running",
        TaskEventType::ToolResult => {
            if event.payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                "completed"
            } else {
                "failed"
            }
        }
        _ => "tool",
    }
}

fn event_label(event_type: TaskEventType) -> &'static str {
    match event_type {
        TaskEventType::UserMessage => "User",
        TaskEventType::AssistantMessage => "Assistant",
        TaskEventType::AssistantDelta => "Assistant stream",
        TaskEventType::TaskCreated => "Task",
        TaskEventType::StatusChanged => "Status",
        TaskEventType::TokenUsageRecorded => "Token usage",
        TaskEventType::UserInputAnswered => "User answer",
        _ => "Event",
    }
}

fn nav_icon(section: NavSection) -> &'static str {
    match section {
        NavSection::Tasks => "□",
        NavSection::Library => "◇",
        NavSection::Settings => "◌",
        NavSection::Docs => "≡",
    }
}

fn risk_icon(risk: RiskCategory) -> &'static str {
    match risk {
        RiskCategory::HostObservation => "◌",
        RiskCategory::WorkspaceRead => "R",
        RiskCategory::WorkspaceWrite => "W",
        RiskCategory::Shell => "$",
        RiskCategory::Network => "N",
        RiskCategory::Destructive => "!",
    }
}

fn risk_status_text(mode: PermissionMode, selected: bool, risk: RiskCategory) -> String {
    match mode {
        PermissionMode::Ask => "will ask every time".to_string(),
        PermissionMode::ReadOnly => {
            if selected { "read-only mode allows this class" } else { "will ask before execution" }.to_string()
        }
        PermissionMode::FullAccess => "globally allowed by full access".to_string(),
        PermissionMode::Custom => {
            if selected { "globally allowed in custom mode" } else { "will ask in custom mode" }.to_string()
        }
        PermissionMode::AutoApproval => {
            if risk == RiskCategory::Destructive {
                "destructive is never rule-auto-approved".to_string()
            } else if selected {
                "rule auto-approval covers this class".to_string()
            } else {
                "will ask or require explicit approval".to_string()
            }
        }
    }
}

fn section_title(section: NavSection) -> &'static str {
    match section {
        NavSection::Tasks => "Task Workbench",
        NavSection::Library => "Library",
        NavSection::Settings => "Settings",
        NavSection::Docs => "Docs",
    }
}

fn short_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() <= 3 {
        return normalized;
    }
    format!(".../{}/{}/{}", parts[parts.len() - 3], parts[parts.len() - 2], parts[parts.len() - 1])
}

fn short_time(value: &str) -> String {
    value.split('T').nth(1).and_then(|time| time.get(0..8)).unwrap_or(value).to_string()
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
