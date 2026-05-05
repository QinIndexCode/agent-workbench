import { useState, type ReactNode } from "react";
import type { TaskDetail } from "@scc/shared";

type InspectorTab = "details" | "learning" | "permissions" | "memory";

const tabs: Array<{ id: InspectorTab; label: string }> = [
  { id: "details", label: "Details" },
  { id: "learning", label: "Learning" },
  { id: "permissions", label: "Permissions" },
  { id: "memory", label: "Memory" }
];

export function InspectorPanel({
  selected,
  children
}: {
  selected: TaskDetail | null;
  children: { learning: ReactNode; permissions: ReactNode; memory: ReactNode };
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("details");

  return (
    <aside className="inspector">
      <nav className="inspectorTabs" aria-label="Inspector sections">
        {tabs.map((tab) => (
          <button
            className={activeTab === tab.id ? "inspectorTab selected" : "inspectorTab"}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="inspectorBody">
        {activeTab === "details" ? <TaskDetails task={selected} /> : null}
        {activeTab === "learning" ? children.learning : null}
        {activeTab === "permissions" ? children.permissions : null}
        {activeTab === "memory" ? children.memory : null}
      </div>
    </aside>
  );
}

function TaskDetails({ task }: { task: TaskDetail | null }) {
  if (!task) {
    return (
      <section>
        <h2>Details</h2>
        <p className="muted">No task selected.</p>
      </section>
    );
  }

  const pendingApprovals = task.approvals.filter((approval) => approval.status === "pending").length;
  const toolResults = task.events.filter((event) => event.type === "tool_result").length;

  return (
    <section>
      <h2>Details</h2>
      <dl className="detailList">
        <div>
          <dt>Status</dt>
          <dd>{task.status.replace("_", " ")}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{task.events.length}</dd>
        </div>
        <div>
          <dt>Tool results</dt>
          <dd>{toolResults}</dd>
        </div>
        <div>
          <dt>Approvals</dt>
          <dd>{pendingApprovals}</dd>
        </div>
      </dl>
    </section>
  );
}
