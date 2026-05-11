use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use scc_native_shared::{
    create_id, now_iso, KnowledgeItem, TaskDetail, TaskEvent, TaskEventType, TaskFolderRecord, TaskStatus, ToolApproval, UserPreferences,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoreSnapshot {
    tasks: Vec<TaskDetail>,
    folders: Vec<TaskFolderRecord>,
    preferences: UserPreferences,
    knowledge: Vec<KnowledgeItem>,
}

#[derive(Clone)]
pub struct NativeStore {
    path: PathBuf,
    state: Arc<Mutex<StoreSnapshot>>,
}

impl NativeStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = normalize_store_path(path.as_ref());
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let state = if path.exists() {
            serde_json::from_str::<StoreSnapshot>(&fs::read_to_string(&path)?).context("decode native store")?
        } else {
            StoreSnapshot { preferences: UserPreferences::default(), folders: vec![default_folder()?], ..Default::default() }
        };
        let store = Self { path, state: Arc::new(Mutex::new(state)) };
        store.persist()?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn persist(&self) -> Result<()> {
        let state = self.state.lock().clone();
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&self.path, serde_json::to_string_pretty(&state)?)?;
        Ok(())
    }

    pub fn save_preferences(&self, prefs: &UserPreferences) -> Result<()> {
        self.state.lock().preferences = prefs.clone();
        self.persist()
    }

    pub fn get_preferences(&self) -> Result<UserPreferences> {
        Ok(self.state.lock().preferences.clone())
    }

    pub fn save_folder(&self, folder: &TaskFolderRecord) -> Result<()> {
        let mut state = self.state.lock();
        upsert_by(&mut state.folders, folder.clone(), |item| item.id.clone());
        drop(state);
        self.persist()
    }

    pub fn list_folders(&self) -> Result<Vec<TaskFolderRecord>> {
        let mut folders = self.state.lock().folders.clone();
        if !folders.iter().any(|folder| folder.id == "default") {
            folders.insert(0, default_folder()?);
        }
        folders.sort_by_key(|f| (!f.is_default, f.name.clone()));
        Ok(folders)
    }

    pub fn create_task(&self, title: String, work_root: String, folder_id: String) -> Result<TaskDetail> {
        let now = now_iso();
        let task = TaskDetail {
            id: create_id("task"),
            title,
            folder_id,
            work_root,
            status: TaskStatus::Idle,
            created_at: now.clone(),
            updated_at: now,
            events: vec![],
            approvals: vec![],
        };
        self.save_task(&task)?;
        Ok(task)
    }

    pub fn save_task(&self, task: &TaskDetail) -> Result<()> {
        let mut state = self.state.lock();
        upsert_by(&mut state.tasks, task.clone(), |item| item.id.clone());
        drop(state);
        self.persist()
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskDetail>> {
        Ok(self.state.lock().tasks.iter().find(|task| task.id == task_id).cloned())
    }

    pub fn list_tasks(&self) -> Result<Vec<TaskDetail>> {
        let mut tasks = self.state.lock().tasks.clone();
        tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(tasks)
    }

    pub fn update_status(&self, task_id: &str, status: TaskStatus) -> Result<()> {
        let mut state = self.state.lock();
        let task = state.tasks.iter_mut().find(|task| task.id == task_id).ok_or_else(|| anyhow!("Task not found: {task_id}"))?;
        task.status = status;
        task.updated_at = now_iso();
        drop(state);
        self.persist()
    }

    pub fn add_event(&self, event: &TaskEvent) -> Result<()> {
        let mut state = self.state.lock();
        let task = state.tasks.iter_mut().find(|task| task.id == event.task_id).ok_or_else(|| anyhow!("Task not found: {}", event.task_id))?;
        upsert_by(&mut task.events, event.clone(), |item| item.id.clone());
        task.updated_at = now_iso();
        drop(state);
        self.persist()
    }

    pub fn save_approval(&self, approval: &ToolApproval) -> Result<()> {
        let mut state = self.state.lock();
        let task = state.tasks.iter_mut().find(|task| task.id == approval.task_id).ok_or_else(|| anyhow!("Task not found: {}", approval.task_id))?;
        upsert_by(&mut task.approvals, approval.clone(), |item| item.id.clone());
        task.updated_at = now_iso();
        drop(state);
        self.persist()
    }

    pub fn save_knowledge_item(&self, item: &KnowledgeItem) -> Result<()> {
        let mut state = self.state.lock();
        upsert_by(&mut state.knowledge, item.clone(), |item| item.id.clone());
        drop(state);
        self.persist()
    }

    pub fn list_knowledge_items(&self) -> Result<Vec<KnowledgeItem>> {
        Ok(self.state.lock().knowledge.clone())
    }

    pub fn import_legacy_records_readonly(&self, _legacy_path: impl AsRef<Path>) -> Result<usize> {
        Err(anyhow!(
            "Legacy SQLite import is reserved for the sqlite feature build. This default native build stays pure Rust for toolchain portability."
        ))
    }
}

pub fn new_event(task_id: &str, event_type: TaskEventType, summary: impl Into<String>, payload: impl Serialize) -> Result<TaskEvent> {
    let payload = serde_json::to_value(payload)?;
    Ok(TaskEvent {
        id: create_id("event"),
        task_id: task_id.to_string(),
        event_type,
        created_at: now_iso(),
        summary: summary.into(),
        payload: match payload {
            serde_json::Value::Object(map) => map.into_iter().collect(),
            _ => Default::default(),
        },
        reverted: false,
    })
}

pub fn default_folder() -> Result<TaskFolderRecord> {
    let cwd = std::env::current_dir()?.to_string_lossy().to_string();
    let now = now_iso();
    Ok(TaskFolderRecord {
        id: "default".to_string(),
        name: "Default".to_string(),
        root_path: cwd,
        is_default: true,
        created_at: now.clone(),
        updated_at: now,
    })
}

fn normalize_store_path(path: &Path) -> PathBuf {
    if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("sqlite")) {
        path.with_extension("json")
    } else {
        path.to_path_buf()
    }
}

fn upsert_by<T, F>(items: &mut Vec<T>, next: T, key: F)
where
    F: Fn(&T) -> String,
{
    let next_key = key(&next);
    if let Some(existing) = items.iter_mut().find(|item| key(item) == next_key) {
        *existing = next;
    } else {
        items.push(next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_roundtrips_tasks_events_and_preferences() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = NativeStore::open(dir.path().join("native.json"))?;
        let mut task = store.create_task("Hello".into(), ".".into(), "default".into())?;
        task.status = TaskStatus::Running;
        task.events.push(new_event(&task.id, TaskEventType::UserMessage, "hello", serde_json::json!({"content":"hello"}))?);
        store.save_task(&task)?;

        let loaded = store.get_task(&task.id)?.expect("task exists");
        assert_eq!(loaded.status, TaskStatus::Running);
        assert_eq!(loaded.events.len(), 1);
        assert_eq!(store.get_preferences()?.permission_mode, scc_native_shared::PermissionMode::Ask);
        Ok(())
    }
}
