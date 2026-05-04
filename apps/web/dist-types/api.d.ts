import type { ApprovalDecision, ExperienceRecord, SkillRecord, TaskDetail } from "@scc/shared";
export declare const api: {
    createTask(goal: string): Promise<TaskDetail>;
    listTasks(): Promise<TaskDetail[]>;
    getTask(taskId: string): Promise<TaskDetail>;
    sendMessage(taskId: string, content: string): Promise<TaskDetail>;
    control(taskId: string, action: "pause" | "resume" | "cancel"): Promise<TaskDetail>;
    decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<TaskDetail>;
    listExperiences(): Promise<ExperienceRecord[]>;
    listSkills(): Promise<SkillRecord[]>;
};
//# sourceMappingURL=api.d.ts.map