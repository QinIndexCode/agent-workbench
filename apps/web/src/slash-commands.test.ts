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

  it("opens help and rejects removed or unknown commands", () => {
    expect(parseComposerSlashCommand("/help")).toEqual({ kind: "open_help", command: "help" });
    expect(parseComposerSlashCommand("/?")).toEqual({ kind: "open_help", command: "help" });
    expect(parseComposerSlashCommand("/target old mode").kind).toBe("error");
    const unknown = parseComposerSlashCommand("/verify now", "zh-CN");
    expect(unknown.kind).toBe("error");
    if (unknown.kind !== "error") throw new Error("Expected an error for unknown slash command.");
    expect(unknown.message).toContain("/goal");
    expect(unknown.message).toContain("//");
  });

  it("exposes menu items for every supported command", () => {
    const names = slashCommandNames();
    expect(filterSlashCommandMenuItems("/", "en-US").map((item) => item.name)).toEqual(names);
    expect(filterSlashCommandMenuItems("/pl", "en-US").map((item) => item.name)).toEqual(["plan"]);
    expect(buildPlanFirstPrompt("检查 CLI", "zh-CN")).toContain("等待我确认");
  });
});
