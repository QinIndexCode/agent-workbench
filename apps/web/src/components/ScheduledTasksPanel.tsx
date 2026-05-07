import { useState } from "react";
import type { ScheduledTask, ScheduledTaskCreateRequest, ScheduledTaskPatchRequest, TaskFolderRecord } from "@scc/shared";
import { CalendarClock, Clock3, Folder, PauseCircle, Pencil, PlayCircle, Plus, Sparkles, Trash2 } from "lucide-react";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

const pageSize = 8;

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
  const [page, setPage] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const pageCount = Math.max(1, Math.ceil(scheduledTasks.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleTasks = scheduledTasks.slice(safePage * pageSize, safePage * pageSize + pageSize);

  return (
    <>
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
        {visibleTasks.map((task) => (
          <article className="providerRow scheduledTaskRow" key={task.id}>
            <span className={task.type === "reflection" ? "providerIcon reflectionIcon" : "providerIcon"}>
              {task.type === "reflection" ? <Sparkles size={17} /> : <CalendarClock size={17} />}
            </span>
            <div className="scheduledTaskMain">
              <strong>{task.title}</strong>
              <span className="scheduledPrompt">{task.prompt}</span>
              <small>{scheduleSummary(task, language)} · {new Date(task.nextRunAt).toLocaleString()} · {folderName(folders, task.folderId, language)}</small>
              {task.lastRunSummary ? <small>{task.lastRunSummary}</small> : null}
              {task.lastError ? <small className="dangerText">{task.lastError}</small> : null}
            </div>
            <span className={task.status === "active" ? "statusPill" : "statusPill muted"}>
              {task.status === "active" ? (zh ? "运行中" : "Active") : task.status === "completed" ? (zh ? "已完成" : "Completed") : (zh ? "已暂停" : "Paused")}
            </span>
            <div className="rowIconActions">
              <button
                aria-label={task.status === "active" ? (zh ? "暂停定时任务" : "Pause scheduled task") : (zh ? "恢复定时任务" : "Resume scheduled task")}
                className="iconButton"
                title={task.status === "active" ? (zh ? "暂停" : "Pause") : (zh ? "恢复" : "Resume")}
                type="button"
                onClick={() => void onUpdate(task.id, { status: task.status === "active" ? "paused" : "active" })}
              >
                {task.status === "active" ? <PauseCircle size={15} /> : <PlayCircle size={15} />}
              </button>
              <button className="iconButton" type="button" onClick={() => setEditing(task)}><Pencil size={15} /></button>
              <button className="iconButton danger" type="button" onClick={() => setConfirmDeleteId(task.id)}><Trash2 size={15} /></button>
            </div>
          </article>
        ))}
      </div>
      {scheduledTasks.length > pageSize ? (
        <div className="scheduledPagination">
          <button type="button" disabled={safePage === 0} onClick={() => setPage(Math.max(0, safePage - 1))}>{zh ? "上一页" : "Previous"}</button>
          <span>{safePage + 1} / {pageCount}</span>
          <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}>{zh ? "下一页" : "Next"}</button>
        </div>
      ) : null}
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
    <ConfirmDialog
      open={confirmDeleteId !== null}
      title={zh ? "删除定时任务" : "Delete scheduled task"}
      confirmLabel={zh ? "删除" : "Delete"}
      cancelLabel={zh ? "取消" : "Cancel"}
      onCancel={() => setConfirmDeleteId(null)}
      onConfirm={() => {
        if (confirmDeleteId) void onDelete(confirmDeleteId);
        setConfirmDeleteId(null);
      }}
    >
      <p>{zh ? "删除后该定时任务的运行历史和计划将一并清除。" : "Deleting removes the scheduled task's run history and schedule."}</p>
    </ConfirmDialog>
    </>
  );
}

function buildSchedulePreview(scheduleKind: string, frequency?: string, timeOfDay?: string, intervalHours?: string, intervalMinutes?: string, zh = false): string {
  if (scheduleKind === "interval") {
    const h = Number(intervalHours) || 0;
    const m = Number(intervalMinutes) || 0;
    if (h === 0 && m === 0) return zh ? "无效间隔" : "Invalid interval";
    if (h > 0 && m > 0) return zh ? `每 ${h} 小时 ${m} 分钟` : `Every ${h}h ${m}m`;
    if (h > 0) return zh ? `每 ${h} 小时` : `Every ${h}h`;
    return zh ? `每 ${m} 分钟` : `Every ${m}m`;
  }
  const freqLabel = zh
    ? frequency === "weekly" ? "每周" : frequency === "monthly" ? "每月" : "每天"
    : frequency === "weekly" ? "Weekly" : frequency === "monthly" ? "Monthly" : "Daily";
  return `${freqLabel} ${timeOfDay || "09:00"}`;
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
  const [folderId, setFolderId] = useState(task?.folderId ?? "");
  const [scheduleKind, setScheduleKind] = useState<"calendar" | "interval">(task?.schedule.kind === "interval" ? "interval" : "calendar");
  const [frequency, setFrequency] = useState<"daily" | "weekly" | "monthly">(task?.schedule.frequency ?? "daily");
  const [timeOfDay, setTimeOfDay] = useState(task?.schedule.timeOfDay ?? "09:00");
  const [intervalHours, setIntervalHours] = useState(String(Math.floor((task?.schedule.intervalMinutes ?? 60) / 60)));
  const [intervalMinutes, setIntervalMinutes] = useState(String((task?.schedule.intervalMinutes ?? 60) % 60));

  const preview = buildSchedulePreview(scheduleKind, frequency, timeOfDay, intervalHours, intervalMinutes, zh);

  return (
    <div className="modalBackdrop stdBackdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="stdModal" onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          title,
          prompt,
          folderId: folderId || undefined,
          scheduleKind,
          ...(scheduleKind === "calendar"
            ? { frequency, timeOfDay }
            : {
                intervalHours: Math.max(0, Math.min(12, Number(intervalHours) || 0)),
                intervalMinutes: Math.max(0, Math.min(59, Number(intervalMinutes) || 0))
              })
        });
      }}>
        <div className="stdHeader">
          <h3>{task ? (zh ? "编辑定时任务" : "Edit scheduled task") : (zh ? "新建定时任务" : "New scheduled task")}</h3>
          <button type="button" className="stdClose" onClick={onClose}>×</button>
        </div>

        <div className="stdBody">
          <div className="stdField">
            <span className="stdFieldLabel">{zh ? "任务名称" : "Task name"}</span>
            <input className="stdInput" placeholder={zh ? "输入任务名称" : "Enter task name"} value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>

          <div className="stdField">
            <span className="stdFieldLabel">{zh ? "触发时间" : "Schedule"}</span>
            <div className="stdScheduleStack">
              <AccordionSelect
                ariaLabel={zh ? "选择运行方式" : "Select schedule mode"}
                options={[
                  { value: "calendar", label: zh ? "按固定时间" : "Fixed time", description: zh ? "每天、每周或每月在指定时间运行。" : "Run daily, weekly, or monthly at a fixed time.", icon: <CalendarClock size={15} /> },
                  { value: "interval", label: zh ? "按间隔时间" : "Interval", description: zh ? "每隔 0-12 小时的指定时长运行。" : "Run every chosen interval up to 12 hours.", icon: <Clock3 size={15} /> }
                ]}
                value={scheduleKind}
                onChange={(value) => setScheduleKind(value as "calendar" | "interval")}
              />
              <div className="stdRow">
              {scheduleKind === "calendar" ? (
                <>
                  <label className="stdSelectWrap stdGrow">
                    <AccordionSelect
                      ariaLabel={zh ? "选择重复周期" : "Select repeat frequency"}
                      options={[
                        { value: "daily", label: zh ? "每天" : "Daily" },
                        { value: "weekly", label: zh ? "每周" : "Weekly" },
                        { value: "monthly", label: zh ? "每月" : "Monthly" }
                      ]}
                      value={frequency}
                      onChange={(value) => setFrequency(value as "daily" | "weekly" | "monthly")}
                    />
                  </label>
                  <input className="stdInput stdTimeInput" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} placeholder="09:00" pattern="^([01]\\d|2[0-3]):[0-5]\\d$" required />
                </>
              ) : (
                <>
                  <div className="stdIntervalInputs">
                    <input
                      className="stdIntervalNum"
                      type="number"
                      min={0}
                      max={12}
                      value={intervalHours}
                      onChange={(e) => setIntervalHours(String(Math.max(0, Math.min(12, Number(e.target.value) || 0))))}
                    />
                    <span className="stdIntervalSep">{zh ? "时" : "h"}</span>
                    <input
                      className="stdIntervalNum"
                      type="number"
                      min={0}
                      max={59}
                      value={intervalMinutes}
                      onChange={(e) => setIntervalMinutes(String(Math.max(0, Math.min(59, Number(e.target.value) || 0))))}
                    />
                    <span className="stdIntervalSep">{zh ? "分" : "m"}</span>
                  </div>
                </>
              )}
              </div>
            </div>
          </div>

          <div className="stdField">
            <div className="stdFieldHeader">
              <span className="stdFieldLabel">{zh ? "任务内容" : "Task prompt"}</span>
            </div>
            <div className="stdTextareaWrap">
              <textarea
                className="stdTextarea"
                placeholder={zh ? "描述你希望自动执行的任务..." : "Describe what you want automated..."}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                required
              />
            </div>
          </div>
        </div>

        <div className="stdBottomBar">
          <AccordionSelect
            ariaLabel={zh ? "选择工作文件夹" : "Select work folder"}
            placement="up"
            options={[
              { value: "", label: zh ? "无文件夹" : "No folder", icon: <Folder size={15} /> },
              ...folders.map((folder) => ({
                value: folder.id,
                label: folder.name,
                description: folder.rootPath,
                icon: <Folder size={15} />
              }))
            ]}
            value={folderId}
            onChange={setFolderId}
          />
          <span className="stdPreviewTag">
            <Clock3 size={12} />
            {preview}
          </span>
        </div>

        <div className="stdFooter">
          <button type="button" className="stdCancelBtn" onClick={onClose}>{zh ? "取消" : "Cancel"}</button>
          <button className="primaryInlineButton" type="submit">{task ? (zh ? "保存" : "Save") : (zh ? "创建" : "Create")}</button>
        </div>
      </form>
    </div>
  );
}

function folderName(folders: TaskFolderRecord[], folderId: string | undefined, language?: string | null | undefined): string {
  if (!folderId) return language === "zh-CN" ? "无工作文件夹" : "No work folder";
  return folders.find((folder) => folder.id === folderId)?.name ?? folderId;
}

function scheduleSummary(task: ScheduledTask, language?: string | null | undefined): string {
  const zh = language === "zh-CN";
  if (task.schedule.kind === "interval") {
    const total = task.schedule.intervalMinutes ?? 60;
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return zh ? `每隔 ${hours} 小时 ${minutes} 分钟` : `Every ${hours}h ${minutes}m`;
  }
  const frequency = task.schedule.frequency ?? "daily";
  const frequencyLabel = zh
    ? frequency === "weekly"
      ? "每周"
      : frequency === "monthly"
        ? "每月"
        : "每天"
    : frequency === "weekly"
      ? "Weekly"
      : frequency === "monthly"
        ? "Monthly"
        : "Daily";
  return `${frequencyLabel} ${task.schedule.timeOfDay ?? "09:00"}`;
}
