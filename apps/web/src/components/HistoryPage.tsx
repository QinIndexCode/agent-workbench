import { useMemo, useState } from "react";
import type { TaskDeleteRequest, TaskDetail } from "@agent-workbench/shared";
import { Menu, Search, Trash2 } from "lucide-react";
import { getUiCopy } from "../i18n.js";
import "../styles/settings.css";
import { AccordionSelect } from "./AccordionSelect.js";

export function HistoryPage({
  language,
  tasks,
  onDelete,
  onOpenTask,
  onOpenTasks
}: {
  language?: string | null;
  tasks: TaskDetail[];
  onDelete: (taskId: string, options: TaskDeleteRequest) => Promise<void>;
  onOpenTask: (taskId: string) => void;
  onOpenTasks: () => void;
}) {
  const text = getHistoryCopy(language);
  const shell = getUiCopy(language).shell;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<TaskDetail["status"] | "all">("all");
  const [deleteLearningData, setDeleteLearningData] = useState(true);
  const [deleteDerivedSkills, setDeleteDerivedSkills] = useState(false);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (status !== "all" && task.status !== status) return false;
      return !needle || `${task.title} ${task.status}`.toLowerCase().includes(needle);
    });
  }, [query, status, tasks]);

  return (
    <section className="settingsView historyView" aria-label={text.title}>
      <header className="settingsHeader">
        <button className="mobileTaskToggle" type="button" onClick={onOpenTasks}>
          <Menu size={16} />
          {shell.tasks}
        </button>
        <div>
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
        </div>
      </header>
      <div className="singlePageBody">
        <div className="historyToolbar">
          <label className="skillSearch">
            <Search size={15} />
            <input aria-label={text.search} placeholder={text.search} value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <AccordionSelect
            ariaLabel={text.statusFilter}
            size="compact"
            value={status}
            options={[
              { value: "all", label: text.all },
              ...["running", "waiting_for_user", "waiting_approval", "paused", "completed", "failed", "cancelled"].map((value) => ({
                value,
                label: value.replace("_", " ")
              }))
            ]}
            onChange={(value) => setStatus(value as TaskDetail["status"] | "all")}
          />
          <label>
            <input checked={deleteLearningData} type="checkbox" onChange={(event) => setDeleteLearningData(event.target.checked)} />
            {text.deleteLearning}
          </label>
          <label>
            <input checked={deleteDerivedSkills} disabled={!deleteLearningData} type="checkbox" onChange={(event) => setDeleteDerivedSkills(event.target.checked)} />
            {text.deleteSkills}
          </label>
        </div>
        <div className="historyRows">
          {visible.length === 0 ? <p className="muted">{text.empty}</p> : null}
          {visible.map((task) => (
            <article className="historyRow" key={task.id}>
              <button className="historyTaskButton" type="button" onClick={() => onOpenTask(task.id)}>
                <strong>{task.title}</strong>
                <span>{task.status.replace("_", " ")} · {new Date(task.updatedAt).toLocaleString()}</span>
              </button>
              <small>{task.events.length} events · {task.approvals.length} approvals</small>
              <button
                className="iconButton dangerIcon"
                type="button"
                aria-label={`${text.delete} ${task.title}`}
                onClick={() => void onDelete(task.id, { deleteLearningData, deleteDerivedSkills })}
              >
                <Trash2 size={15} />
              </button>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function getHistoryCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "历史记录" : "History",
    subtitle: zh ? "管理任务线程、删除历史，并决定是否同步清理学习数据。" : "Manage task threads, delete history, and choose whether learning data is cleaned up too.",
    search: zh ? "搜索任务历史" : "Search history",
    statusFilter: zh ? "筛选任务状态" : "Filter task status",
    all: zh ? "全部状态" : "All statuses",
    deleteLearning: zh ? "删除关联经验/记忆" : "Delete linked learning data",
    deleteSkills: zh ? "删除仅由该任务派生的 Skill" : "Delete derived-only skills",
    empty: zh ? "没有匹配的任务。" : "No matching tasks.",
    delete: zh ? "删除" : "Delete"
  };
}
