import type { ApprovalDecision, TaskDetail, ToolApproval } from "@scc/shared";
export declare function App(): import("react/jsx-runtime").JSX.Element;
export declare function TaskList({ tasks, selectedId, onSelect }: {
    tasks: TaskDetail[];
    selectedId: string | null;
    onSelect: (taskId: string) => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function Timeline({ task }: {
    task: TaskDetail | null;
}): import("react/jsx-runtime").JSX.Element;
export declare function ApprovalCard({ approval, onDecision }: {
    approval: ToolApproval;
    onDecision: (decision: ApprovalDecision) => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function Composer({ busy, running, onSubmit, onStop }: {
    busy: boolean;
    running: boolean;
    onSubmit: (text: string) => void;
    onStop: () => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function CompactList({ title, rows }: {
    title: string;
    rows: Array<{
        id: string;
        label: string;
        meta: string;
    }>;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=App.d.ts.map