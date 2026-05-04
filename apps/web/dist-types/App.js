import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { ArrowUp, LoaderCircle, Square, Terminal } from "lucide-react";
import { api } from "./api.js";
export function App() {
    const [tasks, setTasks] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [selected, setSelected] = useState(null);
    const [experiences, setExperiences] = useState([]);
    const [skills, setSkills] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
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
    async function runAction(action) {
        setBusy(true);
        setError(null);
        try {
            const task = await action();
            setSelectedId(task.id);
            setSelected(task);
            await refresh(task.id);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setBusy(false);
        }
    }
    const pendingApproval = selected?.approvals.find((approval) => approval.status === "pending") ?? null;
    return (_jsxs("main", { className: "shell", children: [_jsxs("aside", { className: "sidebar", children: [_jsxs("div", { className: "brand", children: [_jsx(Terminal, { size: 18 }), _jsx("span", { children: "SCC" })] }), _jsx(TaskList, { tasks: tasks, selectedId: selectedId, onSelect: setSelectedIdAndLoad })] }), _jsxs("section", { className: "thread", children: [_jsx("header", { className: "threadHeader", children: _jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Agent Workbench" }), _jsx("h1", { children: selected?.title ?? "New task" })] }) }), error ? _jsx("div", { className: "errorLine", children: error }) : null, pendingApproval ? (_jsx(ApprovalCard, { approval: pendingApproval, onDecision: (decision) => approve(pendingApproval, decision) })) : null, _jsx(Timeline, { task: selected }), _jsx(Composer, { busy: busy, running: selected?.status === "running" || selected?.status === "waiting_approval", onSubmit: (text) => runAction(() => (selected ? api.sendMessage(selected.id, text) : api.createTask(text))), onStop: () => selected && runAction(() => api.control(selected.id, "pause")) })] }), _jsxs("aside", { className: "inspector", children: [_jsx("h2", { children: "Learning" }), _jsx(CompactList, { title: "Experience", rows: experiences.map((item) => ({ id: item.id, label: item.title, meta: item.readOnly ? "read-only" : "draft" })) }), _jsx(CompactList, { title: "Skills", rows: skills.map((item) => ({ id: item.id, label: item.title, meta: item.status })) })] })] }));
    async function setSelectedIdAndLoad(taskId) {
        setSelectedId(taskId);
        setSelected(await api.getTask(taskId));
    }
    async function approve(approval, decision) {
        if (!selected)
            return;
        await runAction(() => api.decideApproval(selected.id, approval.id, decision));
    }
}
export function TaskList({ tasks, selectedId, onSelect }) {
    return (_jsx("nav", { className: "taskList", children: tasks.map((task) => (_jsxs("button", { className: task.id === selectedId ? "taskItem selected" : "taskItem", onClick: () => onSelect(task.id), children: [_jsx("span", { children: task.title }), _jsx("small", { children: task.status.replace("_", " ") })] }, task.id))) }));
}
export function Timeline({ task }) {
    const events = useMemo(() => task?.events.filter((event) => ["user_message", "assistant_message", "guidance_pending", "guidance_consumed", "approval_pending", "approval_resolved", "tool_result"].includes(event.type)) ?? [], [task]);
    if (!task) {
        return _jsx("div", { className: "empty", children: "Start with a goal." });
    }
    return (_jsx("div", { className: "timeline", children: events.map((event) => (_jsxs("article", { className: `event ${event.type}`, children: [_jsx("small", { children: event.type.replaceAll("_", " ") }), _jsx("p", { children: event.summary }), event.type === "tool_result" ? _jsx("pre", { children: String(event.payload["output"] ?? "").slice(0, 1600) }) : null] }, event.id))) }));
}
export function ApprovalCard({ approval, onDecision }) {
    return (_jsxs("section", { className: "approvalCard", children: [_jsxs("div", { children: [_jsx("small", { children: approval.riskCategory.replace("_", " ") }), _jsx("h2", { children: approval.toolCall.toolName })] }), _jsx("p", { children: approval.reason }), _jsx("pre", { children: String(approval.toolCall.args["command"] ?? JSON.stringify(approval.toolCall.args, null, 2)) }), _jsxs("div", { className: "approvalActions", children: [_jsx("button", { onClick: () => onDecision("allow_once"), children: "Allow once" }), _jsx("button", { onClick: () => onDecision("allow_for_task"), children: "Allow for this task" }), _jsx("button", { onClick: () => onDecision("deny"), children: "Deny" })] })] }));
}
export function Composer({ busy, running, onSubmit, onStop }) {
    const [text, setText] = useState("");
    const canSubmit = text.trim().length > 0;
    const icon = busy ? _jsx(LoaderCircle, { className: "spin", size: 18 }) : canSubmit ? _jsx(ArrowUp, { size: 18 }) : _jsx(Square, { size: 15 });
    return (_jsxs("form", { className: "composer", onSubmit: (event) => {
            event.preventDefault();
            if (busy)
                return;
            if (canSubmit) {
                onSubmit(text.trim());
                setText("");
            }
            else if (running) {
                onStop();
            }
        }, children: [_jsx("textarea", { "aria-label": "Task input", placeholder: "Ask the agent to do something...", value: text, onChange: (event) => setText(event.target.value), rows: 1 }), _jsx("button", { "aria-label": canSubmit ? "Send" : "Stop", disabled: busy || (!canSubmit && !running), type: "submit", children: icon })] }));
}
export function CompactList({ title, rows }) {
    return (_jsxs("section", { className: "compactList", children: [_jsx("h3", { children: title }), rows.length === 0 ? _jsx("p", { className: "muted", children: "None yet" }) : null, rows.map((row) => (_jsxs("div", { className: "compactRow", children: [_jsx("span", { children: row.label }), _jsx("small", { children: row.meta })] }, row.id)))] }));
}
