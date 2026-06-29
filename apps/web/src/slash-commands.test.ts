import { describe, expect, it } from "vitest";
import { buildPlanFirstPrompt, filterSlashCommandMenuItems, parseComposerSlashCommand, slashCommandNames } from "./slash-commands.js";

describe("composer slash commands", () => {
  it("parses normal text and literal slash escapes", () => {
    expect(parseComposerSlashCommand("repair the flow")).toEqual({
      kind: "submit",
      command: "none",
      text: "repair the flow",
      runMode: "normal"
    });
    expect(parseComposerSlashCommand("//literal command")).toEqual({
      kind: "submit",
      command: "literal",
      text: "/literal command",
      runMode: "normal"
    });
  });

  it("requires a concrete /goal request and maps it to goal mode", () => {
    expect(parseComposerSlashCommand("/goal fix login")).toEqual({
      kind: "submit",
      command: "goal",
      text: "fix login",
      runMode: "target"
    });
    const missing = parseComposerSlashCommand("/goal", "en-US");
    expect(missing.kind).toBe("error");
    expect(missing.command).toBe("/goal");
  });

  it("turns /plan into a plan-first ordinary request", () => {
    const parsed = parseComposerSlashCommand("/plan redesign the upload flow", "en-US");
    expect(parsed.kind).toBe("submit");
    if (parsed.kind !== "submit") return;
    expect(parsed.command).toBe("plan");
    expect(parsed.runMode).toBe("normal");
    expect(parsed.text).toContain("Create a visible plan");
    expect(parsed.text).toContain("redesign the upload flow");
    expect(parsed.text).toContain("wait for my confirmation");
  });

  it("navigates to help, library, settings, and docs pages", () => {
    expect(parseComposerSlashCommand("/help")).toEqual({ kind: "navigate", command: "help", target: { area: "docs", section: "task-management" } });
    expect(parseComposerSlashCommand("/?")).toEqual({ kind: "navigate", command: "help", target: { area: "docs", section: "task-management" } });
    expect(parseComposerSlashCommand("/knowledge")).toEqual({ kind: "navigate", command: "knowledge", target: { area: "library", section: "knowledge" } });
    expect(parseComposerSlashCommand("/memory")).toEqual({ kind: "navigate", command: "memory", target: { area: "library", section: "memory" } });
    expect(parseComposerSlashCommand("/skill")).toEqual({ kind: "navigate", command: "skill", target: { area: "library", section: "skills" } });
    expect(parseComposerSlashCommand("/model")).toEqual({ kind: "navigate", command: "model", target: { area: "settings", section: "providers" } });
    expect(parseComposerSlashCommand("/permissions")).toEqual({ kind: "navigate", command: "permissions", target: { area: "settings", section: "permissions" } });
    expect(parseComposerSlashCommand("/search")).toEqual({ kind: "navigate", command: "search", target: { area: "settings", section: "search" } });
    expect(parseComposerSlashCommand("/docs")).toEqual({ kind: "navigate", command: "docs", target: { area: "docs", section: "overview" } });
  });

  it("rejects removed or unknown commands", () => {
    expect(parseComposerSlashCommand("/target old mode").kind).toBe("error");
    const unknown = parseComposerSlashCommand("/unknown now", "zh-CN");
    expect(unknown.kind).toBe("error");
    if (unknown.kind !== "error") throw new Error("Expected an error for unknown slash command.");
    expect(unknown.message).toContain("/goal");
    expect(unknown.message).toContain("/knowledge");
    expect(unknown.message).toContain("//");
  });

  it("turns task-intent commands into explicit prompts", () => {
    const cases = [
      ["/review knowledge search UX", "strict code/product review", "knowledge search UX"],
      ["/verify CLI command coverage", "Verify", "CLI command coverage"],
      ["/debug stuck task status", "debugging loop", "stuck task status"],
      ["/research current agent protocols", "Gather current reliable evidence", "current agent protocols"],
      ["/doc sync command docs", "Create or update documentation", "sync command docs"],
      ["/knowledge provider cache notes", "Knowledge library", "provider cache notes"],
      ["/memory durable project facts", "durable memory", "durable project facts"],
      ["/skill office document handling", "Skills", "office document handling"],
      ["/cache", "cache hit rate", "recent tasks"]
    ] as const;
    for (const [input, expectedInstruction, expectedRequest] of cases) {
      const parsed = parseComposerSlashCommand(input, "en-US");
      expect(parsed.kind).toBe("submit");
      if (parsed.kind !== "submit") continue;
      expect(parsed.runMode).toBe("normal");
      expect(parsed.text).toContain(expectedInstruction);
      expect(parsed.text).toContain(expectedRequest);
    }
  });

  it("exposes menu items for every supported command", () => {
    const names = slashCommandNames();
    expect(filterSlashCommandMenuItems("/", "en-US").map((item) => item.name)).toEqual(names);
    expect(filterSlashCommandMenuItems("/pl", "en-US").map((item) => item.name)).toEqual(["plan"]);
    expect(filterSlashCommandMenuItems("/kn", "en-US").map((item) => item.name)).toEqual(["knowledge"]);
    expect(filterSlashCommandMenuItems("cache", "en-US").map((item) => item.name)).toEqual(["cache"]);
    expect(buildPlanFirstPrompt("检查 CLI", "zh-CN")).toContain("等待我确认");
  });
});
