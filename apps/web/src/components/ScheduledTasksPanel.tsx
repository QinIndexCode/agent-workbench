import { useState } from "react";
import type { ScheduledTask, ScheduledTaskCreateRequest, ScheduledTaskPatchRequest, TaskFolderRecord } from "@scc/shared";
import { CalendarClock, CheckCircle2, Folder, PauseCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { AccordionSelect } from "./AccordionSelect.js";

export function ScheduledTasksPanel({
  folders,
  language,
  scheduledTasks,
  onCreate,
  onDelete,
  onUpdate
}: {
  folders: TaskFolderRecord[];
  language?: string | null | undefined;
  scheduledTasks: ScheduledTask[];
  onCreate: (input: ScheduledTaskCreateRequest) => Promise<void> | void;
  onDelete: (taskId: string) => Promise<void> | void;
  onUpdate: (taskId: string, input: ScheduledTaskPatchRequest) => Promise<void> | void;
}) {
  const zh = language === "zh-CN";
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <section className="settingsCardList">
      <div className="panelHero">
        <div>
          <h2>{zh ? "定时任务" : "Scheduled tasks"}</h2>
          <p>{zh ? "应用运行时触发，不伪装系统后台服务。" : "Runs while SCC is open; no hidden OS background service."}</p>
        </div>
        <button className="primaryInlineButton" type="button" onClick={() => setCreating(true)}>
          <Plus size={15} /> {zh ? "新建" : "New"}
        </button>
      </div>
      <div className="compactList">
        {scheduledTasks.length === 0 ? <p className="emptyState">{zh ? "还没有定时任务。" : "No scheduled tasks yet."}</p> : null}
        {scheduledTasks.map((task) => (
          <article className="providerRow" key={task.id}>
            <span className="providerIcon"><CalendarClock size={17} /></span>
            <div>
              <strong>{task.title}</strong>
              <small>{task.status} · {new Date(task.nextRunAt).toLocaleString()} · {folderName(folders, task.folderId)}</small>
            </div>
            <button className="iconButton" type="button" onClick={() => setEditing(task)}><Pencil size={15} /></button>
            <button className="iconButton danger" type="button" onClick={() => void onDelete(task.id)}><Trash2 size={15} /></button>
          </article>
        ))}
      </div>
      {(creating || editing) ? (
        <ScheduledTaskDialog
          folders={folders}
          language={language}
          task={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (input) => {
            if (editing) await onUpdate(editing.id, input);
            else await onCreate(input as ScheduledTaskCreateRequest);
            setCreating(false);
            setEditing(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ScheduledTaskDialog({
  folders,
  language,
  task,
  onClose,
  onSave
}: {
  folders: TaskFolderRecord[];
  language?: string | null | undefined;
  task: ScheduledTask | null;
  onClose: () => void;
  onSave: (input: ScheduledTaskCreateRequest | ScheduledTaskPatchRequest) => Promise<void>;
}) {
  const zh = language === "zh-CN";
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [folderId, setFolderId] = useState(task?.folderId ?? "default");
  const [runAt, setRunAt] = useState(task?.schedule.runAt ?? "");
  const [intervalMinutes, setIntervalMinutes] = useState(task?.schedule.intervalMinutes ? String(task.schedule.intervalMinutes) : "");
  const [status, setStatus] = useState(task?.status ?? "active");
  return (
    <div className="modalBackdrop">
      <form className="modalCard settingsModal" onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          title,
          prompt,
          folderId,
          runAt: runAt || undefined,
          intervalMinutes: intervalMinutes ? Number(intervalMinutes) : undefined,
          status
        });
      }}>
        <header>
          <h3>{task ? (zh ? "编辑定时任务" : "Edit scheduled task") : (zh ? "新建定时任务" : "New scheduled task")}</h3>
          <button type="button" onClick={onClose}>×</button>
        </header>
        <label>{zh ? "标题" : "Title"}<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
        <label>{zh ? "任务内容" : "Prompt"}<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} required /></label>
        <label>
          {zh ? "工作文件夹" : "Work folder"}
          <AccordionSelect
            ariaLabel={zh ? "选择工作文件夹" : "Select work folder"}
            options={folders.map((folder) => ({
              value: folder.id,
              label: folder.name,
              description: folder.rootPath,
              icon: <Folder size={15} />
            }))}
            value={folderId}
            onChange={setFolderId}
          />
        </label>
        <label>{zh ? "运行时间" : "Run at"}<input value={runAt} onChange={(event) => setRunAt(event.target.value)} placeholder="2026-05-06T18:00:00+08:00" /></label>
        <label>{zh ? "间隔分钟" : "Interval minutes"}<input type="number" min={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} /></label>
        {task ? (
          <label>
            {zh ? "状态" : "Status"}
            <AccordionSelect
              ariaLabel={zh ? "选择定时任务状态" : "Select scheduled task status"}
              options={[
                { value: "active", label: zh ? "运行中" : "Active", icon: <CalendarClock size={15} /> },
                { value: "paused", label: zh ? "已暂停" : "Paused", icon: <PauseCircle size={15} /> },
                { value: "completed", label: zh ? "已完成" : "Completed", icon: <CheckCircle2 size={15} /> }
              ]}
              value={status}
              onChange={(value) => setStatus(value as ScheduledTask["status"])}
            />
          </label>
        ) : null}
        <footer><button type="button" onClick={onClose}>{zh ? "取消" : "Cancel"}</button><button className="primaryInlineButton" type="submit">{zh ? "保存" : "Save"}</button></footer>
      </form>
    </div>
  );
}

function folderName(folders: TaskFolderRecord[], folderId: string): string {
  return folders.find((folder) => folder.id === folderId)?.name ?? folderId;
}
