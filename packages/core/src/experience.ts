import type { ExperienceRecord, SkillRecord, TaskDetail } from "@scc/shared";
import { createId, nowIso } from "./ids.js";

export function createExperience(task: TaskDetail): ExperienceRecord {
  const userGoal = task.events.find((event) => event.type === "user_message")?.summary ?? task.title;
  const assistantResult = [...task.events].reverse().find((event) => event.type === "assistant_message")?.summary ?? "";
  const tools = task.events
    .filter((event) => event.type === "tool_requested")
    .map((event) => String(event.payload["toolName"] ?? "tool"))
    .join(", ");
  const readOnly = task.events
    .filter((event) => event.type === "tool_requested")
    .every((event) => ["host_observation", "workspace_read"].includes(String(event.payload["riskCategory"] ?? "")));

  return {
    id: createId("exp"),
    taskId: task.id,
    title: task.title,
    readOnly,
    createdAt: nowIso(),
    body: [
      `Goal: ${userGoal}`,
      tools ? `Tools: ${tools}` : "Tools: none",
      `Result: ${assistantResult}`.trim()
    ].join("\n")
  };
}

export function promoteExperience(experience: ExperienceRecord): SkillRecord {
  const title = experience.title.replace(/\s+/g, " ").trim().slice(0, 80) || "Recorded workflow";
  return {
    id: createId("skill"),
    sourceExperienceId: experience.id,
    title,
    status: experience.readOnly ? "enabled" : "draft",
    createdAt: nowIso(),
    body: [
      `# ${title}`,
      "",
      "## When to use",
      "Use this when a future task matches the goal and tool pattern below.",
      "",
      "## Experience",
      experience.body,
      "",
      "## Safety",
      experience.readOnly
        ? "This skill was auto-enabled because the source task only used read-only evidence."
        : "This skill stays as a draft because the source task involved side effects."
    ].join("\n")
  };
}
