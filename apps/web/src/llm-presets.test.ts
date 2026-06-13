import { describe, expect, it } from "vitest";
import { MODEL_PROVIDER_PRESETS, formatTokenAmount, parseTokenAmount } from "./llm-presets.js";

describe("llm presets", () => {
  it("parses token amounts with convenient K and M suffixes", () => {
    expect(parseTokenAmount("128K")).toBe(128000);
    expect(parseTokenAmount("1M")).toBe(1000000);
    expect(parseTokenAmount("1.05M")).toBe(1050000);
    expect(parseTokenAmount("1048576")).toBe(1048576);
    expect(() => parseTokenAmount("large")).toThrow("Invalid token amount");
  });

  it("formats token amounts for model configuration", () => {
    expect(formatTokenAmount(1048576)).toBe("1.05M tokens");
    expect(formatTokenAmount(128000)).toBe("128K tokens");
  });

  it("orders providers by broad provider familiarity instead of local default", () => {
    expect(MODEL_PROVIDER_PRESETS.map((preset) => preset.vendor).slice(0, 5)).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "xai",
      "deepseek"
    ]);
    expect(MODEL_PROVIDER_PRESETS.at(-2)?.vendor).toBe("openrouter");
    expect(MODEL_PROVIDER_PRESETS.at(-1)?.vendor).toBe("custom");
  });

  it("keeps the Xiaomi MiMo preset aligned with the OpenAI-compatible public endpoint", () => {
    const mimo = MODEL_PROVIDER_PRESETS.find((preset) => preset.vendor === "mimo");
    expect(mimo).toMatchObject({
      protocol: "openai_compatible",
      baseUrl: "https://api.xiaomimimo.com/v1"
    });
    expect(mimo?.models.map((model) => model.id)).toEqual(["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-flash"]);
    expect(mimo?.models.find((model) => model.id === "mimo-v2.5-pro")).toMatchObject({
      contextWindow: 1_048_576,
      supportsTools: true,
      supportsThinking: true
    });
  });
});
