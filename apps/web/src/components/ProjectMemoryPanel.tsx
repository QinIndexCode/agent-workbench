import { useState } from "react";
import type { ProjectMemory } from "@scc/shared";

export function ProjectMemoryPanel({
  memories,
  onCreate,
  onDelete
}: {
  memories: ProjectMemory[];
  onCreate: (title: string, content: string) => void;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const safeMemories = Array.isArray(memories) ? memories : [];

  return (
    <section className="compactList">
      <h3>Project Memory</h3>
      <form
        className="memoryForm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || !content.trim()) return;
          onCreate(title.trim(), content.trim());
          setTitle("");
          setContent("");
        }}
      >
        <input aria-label="Project memory title" placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <textarea
          aria-label="Project memory content"
          placeholder="Architecture, convention, or project fact..."
          rows={3}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
        <button className="subtleButton" type="submit">
          Add memory
        </button>
      </form>
      {safeMemories.length === 0 ? <p className="muted">None yet</p> : null}
      {safeMemories.slice(0, 4).map((memory) => (
        <div className="compactRow" key={memory.id}>
          <span>{memory.title || memory.id}</span>
          <small>{memory.category || "memory"}</small>
          <button className="textButton" onClick={() => onDelete(memory.id)}>
            Delete
          </button>
        </div>
      ))}
    </section>
  );
}
