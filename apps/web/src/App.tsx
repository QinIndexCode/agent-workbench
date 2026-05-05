import { useState } from "react";
import type { ApprovalDecision, RiskCategory, SkillRecord, UserPreferences } from "@scc/shared";
import { api } from "./api.js";
import { ApprovalCard } from "./components/ApprovalCard.js";
import { Composer } from "./components/Composer.js";
import { InspectorPanel } from "./components/InspectorPanel.js";
import { LearningPanel } from "./components/LearningPanel.js";
import { PermissionsPanel } from "./components/PermissionsPanel.js";
import { ProjectMemoryPanel } from "./components/ProjectMemoryPanel.js";
import { TaskList } from "./components/TaskList.js";
import { Timeline } from "./components/Timeline.js";
import { useWorkbenchData } from "./useWorkbenchData.js";

export function App() {
  const data = useWorkbenchData();
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const pendingApproval = data.selected?.approvals.find((approval) => approval.status === "pending") ?? null;
  const running = data.selected?.status === "running" || data.selected?.status === "waiting_approval";

  return (
    <main className="shell">
      <TaskList
        open={taskDrawerOpen}
        tasks={data.tasks}
        selectedId={data.selectedId}
        onClose={() => setTaskDrawerOpen(false)}
        onSelect={(taskId) => {
          setTaskDrawerOpen(false);
          void data.selectTask(taskId);
        }}
      />

      <section className="thread">
        <header className="threadHeader">
          <button className="mobileTaskToggle" type="button" onClick={() => setTaskDrawerOpen(true)}>
            Tasks
          </button>
          <div>
            <h1>{data.selected?.title ?? "New task"}</h1>
          </div>
        </header>

        {data.error ? <div className="errorLine">{data.error}</div> : null}
        {pendingApproval ? <ApprovalCard approval={pendingApproval} onDecision={(decision) => approve(decision)} /> : null}
        <Timeline task={data.selected} />
        <Composer
          busy={data.busy}
          running={running}
          onSubmit={(text) =>
            void data.runTaskAction(() => (data.selected ? api.sendMessage(data.selected.id, text) : api.createTask(text)))
          }
          onStop={() => data.selected && void data.runTaskAction(() => api.control(data.selected!.id, "pause"))}
        />
      </section>

      <InspectorPanel selected={data.selected}>
        {{
          learning: (
            <LearningPanel
              memories={data.memories}
              patterns={data.patterns}
              skills={data.skills}
              reflections={data.reflections}
              onRunReflection={() => void data.runSideAction(() => api.runReflection())}
              onSkillStatus={(skillId, status) => void updateSkillStatus(skillId, status)}
            />
          ),
          permissions: (
            <PermissionsPanel
              permissions={data.permissions}
              preferences={data.preferences}
              onGrant={(risk) => void grantGlobal(risk)}
              onRevoke={(risk) => void data.runSideAction(() => api.revokeGlobalPermission(risk))}
              onPreference={(patch) => void updatePreference(patch)}
            />
          ),
          memory: (
            <ProjectMemoryPanel
              memories={data.projectMemories}
              onCreate={(title, content) =>
                void data.runSideAction(() =>
                  api.createProjectMemory({ title, content, category: "convention", tags: [], projectId: "default" })
                )
              }
              onDelete={(id) => void data.runSideAction(() => api.deleteProjectMemory(id))}
            />
          )
        }}
      </InspectorPanel>
    </main>
  );

  function approve(decision: ApprovalDecision) {
    if (!data.selected || !pendingApproval) return;
    void data.runTaskAction(() => api.decideApproval(data.selected!.id, pendingApproval.id, decision));
  }

  function grantGlobal(risk: RiskCategory) {
    void data.runSideAction(() =>
      api.grantGlobalPermission(
        risk,
        risk === "destructive"
          ? "User explicitly granted destructive global permission from the workbench UI."
          : "User granted global permission from the workbench UI."
      )
    );
  }

  function updatePreference(patch: Partial<UserPreferences>) {
    void data.runSideAction(() => api.updatePreferences(patch));
  }

  function updateSkillStatus(skillId: string, status: SkillRecord["status"]) {
    void data.runSideAction(() => api.patchSkill(skillId, { status }));
  }
}
