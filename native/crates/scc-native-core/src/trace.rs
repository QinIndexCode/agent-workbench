use anyhow::Result;
use serde::Serialize;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

#[derive(Clone)]
pub struct TraceWriter {
    root: PathBuf,
}

impl TraceWriter {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub async fn append<T: Serialize>(&self, task_id: &str, event_type: &str, payload: &T) -> Result<()> {
        let dir = self.root.join(task_id);
        tokio::fs::create_dir_all(&dir).await?;
        let path = dir.join("trace.jsonl");
        let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(path).await?;
        let value = serde_json::json!({
            "type": event_type,
            "createdAt": scc_native_shared::now_iso(),
            "payload": payload
        });
        file.write_all(serde_json::to_string(&value)?.as_bytes()).await?;
        file.write_all(b"\n").await?;
        Ok(())
    }
}
