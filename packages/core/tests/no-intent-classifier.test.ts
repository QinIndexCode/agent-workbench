import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const coreSrc = join(process.cwd(), "packages", "core", "src");

describe("natural-language intent classifier guard", () => {
  it("keeps user-language intent decisions out of runtime code", () => {
    const removedModule = join(coreSrc, "task-intent.ts");
    const files = [
      "context-assembler.ts",
      "experience.ts",
      "fallback-model.ts",
      "openai-model.ts",
      "task-graph.ts",
      "workbench.ts"
    ].map((file) => readFileSync(join(coreSrc, file), "utf8"));

    const source = files.join("\n");
    const removedIdentifiers = [
      "classifyTaskIntent",
      "explicitlyAvoidsToolUse",
      "currentTurnForbidsToolUse",
      "isTrivialUserMessage",
      "isCodeChangeRequest",
      "selectModelToolsForIntent",
      "shouldLoadDynamicTools"
    ];

    expect(existsSync(removedModule)).toBe(false);
    for (const identifier of removedIdentifiers) {
      expect(source).not.toContain(identifier);
    }
  });
});
