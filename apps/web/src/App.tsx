import { useEffect, useMemo, useState } from "react";
import type { ApprovalDecision, ExperienceRecord, SkillRecord, TaskDetail, ToolApproval } from "@scc/shared";
import { ArrowUp, LoaderCircle, Square, Terminal } from "lucide-react";
import { api } from "./api.js";

export function App() {
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const [experiences, setExperiences] = useState<ExperienceRecord[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(nextId = selectedId) {
    const list = await api.listTasks();
    setTasks(list);
    const id = nextId ?? list[0]?.id ?? null;
    setSelectedId(id);
    setSelected(id ? await api.getTask(id) : null);
    setExperiences(await api.listExperiences());
    setSkills(await api.listSkills());
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, []);

  async function runAction(action: () => Promise<TaskDetail>) {
    setBusy(true);
    setError(null);
    try {
      const task = await action();
      setSelectedId(task.id);
      setSelected(task);
      await refresh(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const pendingApproval = selected?.approvals.find((approval) => approval.status === "pending") ?? null;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Terminal size={18} />
          <span>SCC</span>
        </div>
        <TaskList tasks={tasks} selectedId={selectedId} onSelect={setSelectedIdAndLoad} />
      </aside>

      <section className="thread">
        <header className="threadHeader">
          <div>
            <p className="eyebrow">Agent Workbench</p>
            <h1>{selected?.title ?? "New task"}</h1>
          </div>
        </header>

        {error ? <div className="errorLine">{error}</div> : null}
        {pendingApproval ? (
          <ApprovalCard approval={pendingApproval} onDecision={(decision) => approve(pendingApproval, decision)} />
        ) : null}

        <Timeline task={selected} />

        <Composer
          busy={busy}
          running={selected?.status === "running" || selected?.status === "waiting_approval"}
          onSubmit={(text) =>
            runAction(() => (selected ? api.sendMessage(selected.id, text) : api.createTask(text)))
          }
          onStop={() => selected && runAction(() => api.control(selected.id, "pause"))}
        />
      </section>

      <aside className="inspector">
        <h2>Learning</h2>
        <CompactList
          title="Experience"
          rows={experiences.map((item) => ({ id: item.id, label: item.title, meta: item.readOnly ? "read-only" : "draft" }))}
        />
        <CompactList
          title="Skills"
          rows={skills.map((item) => ({ id: item.id, label: item.title, meta: item.status }))}
        />
      </aside>
    </main>
  );

  async function setSelectedIdAndLoad(taskId: string) {
    setSelectedId(taskId);
    setSelected(await api.getTask(taskId));
  }

  async function approve(approval: ToolApproval, decision: ApprovalDecision) {
    if (!selected) return;
    await runAction(() => api.decideApproval(selected.id, approval.id, decision));
  }
}

export function TaskList({
  tasks,
  selectedId,
  onSelect
}: {
  tasks: TaskDetail[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}) {
  return (
    <nav className="taskList">
      {tasks.map((task) => (
        <button
          className={task.id === selectedId ? "taskItem selected" : "taskItem"}
          key={task.id}
          onClick={() => onSelect(task.id)}
        >
          <span>{task.title}</span>
          <small>{task.status.replace("_", " ")}</small>
        </button>
      ))}
    </nav>
  );
}

export function Timeline({ task }: { task: TaskDetail | null }) {
  const events = useMemo(
    () =>
      task?.events.filter((event) =>
        ["user_message", "assistant_message", "guidance_pending", "guidance_consumed", "approval_pending", "approval_resolved", "tool_result"].includes(
          event.type
        )
      ) ?? [],
    [task]
  );

  if (!task) {
    return <div className="empty">Start with a goal.</div>;
  }

  return (
    <div className="timeline">
      {events.map((event) => (
        <article className={`event ${event.type}`} key={event.id}>
          <small>{event.type.replaceAll("_", " ")}</small>
          <p>{event.summary}</p>
          {event.type === "tool_result" ? <pre>{String(event.payload["output"] ?? "").slice(0, 1600)}</pre> : null}
        </article>
      ))}
    </div>
  );
}

export function ApprovalCard({
  approval,
  onDecision
}: {
  approval: ToolApproval;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  return (
    <section className="approvalCard">
      <div>
        <small>{approval.riskCategory.replace("_", " ")}</small>
        <h2>{approval.toolCall.toolName}</h2>
      </div>
      <p>{approval.reason}</p>
      <pre>{String(approval.toolCall.args["command"] ?? JSON.stringify(approval.toolCall.args, null, 2))}</pre>
      <div className="approvalActions">
        <button onClick={() => onDecision("allow_once")}>Allow once</button>
        <button onClick={() => onDecision("allow_for_task")}>Allow for this task</button>
        <button onClick={() => onDecision("deny")}>Deny</button>
      </div>
    </section>
  );
}

export function Composer({
  busy,
  running,
  onSubmit,
  onStop
}: {
  busy: boolean;
  running: boolean;
  onSubmit: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const canSubmit = text.trim().length > 0;
  const icon = busy ? <LoaderCircle className="spin" size={18} /> : canSubmit ? <ArrowUp size={18} /> : <Square size={15} />;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (canSubmit) {
          onSubmit(text.trim());
          setText("");
        } else if (running) {
          onStop();
        }
      }}
    >
      <textarea
        aria-label="Task input"
        placeholder="Ask the agent to do something..."
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={1}
      />
      <button aria-label={canSubmit ? "Send" : "Stop"} disabled={busy || (!canSubmit && !running)} type="submit">
        {icon}
      </button>
    </form>
  );
}

export function CompactList({
  title,
  rows
}: {
  title: string;
  rows: Array<{ id: string; label: string; meta: string }>;
}) {
  return (
    <section className="compactList">
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="muted">None yet</p> : null}
      {rows.map((row) => (
        <div className="compactRow" key={row.id}>
          <span>{row.label}</span>
          <small>{row.meta}</small>
        </div>
      ))}
    </section>
  );
}
