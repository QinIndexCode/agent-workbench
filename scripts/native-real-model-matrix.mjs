import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";

const outDir = resolve("output", "dual-real-model-matrix", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });

if (process.env.SCC_NATIVE_REAL_MODEL !== "1") {
  console.log("Skipping dual real-model matrix. Set SCC_NATIVE_REAL_MODEL=1 to run real provider tasks.");
  process.exit(0);
}

const report = {
  generatedAt: new Date().toISOString(),
  native: null,
  typescript: null,
  notes: [
    "This script runs real provider-backed tasks; it does not use fake model fixtures.",
    "TS runtime is included unless SCC_NATIVE_MATRIX_TS=0.",
    "Artifacts are written under output/ and must not be committed."
  ]
};

report.native = await runCommand("cargo", ["run", "-p", "scc-native-app", "--bin", "native_matrix"], {
  cwd: resolve("native"),
  env: { ...process.env, SCC_NATIVE_REAL_MODEL: "1" }
});

if (process.env.SCC_NATIVE_MATRIX_TS !== "0") {
  report.typescript = await runCommand("npm.cmd", ["run", "smoke:live-model"], {
    cwd: resolve("."),
    env: { ...process.env, SCC_LIVE_MODEL_SMOKE: "1" }
  });
}

writeFileSync(join(outDir, "dual-real-model-matrix.json"), JSON.stringify(report, null, 2), "utf8");
writeFileSync(
  join(outDir, "dual-real-model-matrix.md"),
  [
    "# Dual Real Model Matrix",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Native: ${report.native?.ok ? "PASS" : "FAIL"}`,
    report.native?.stdout ? "\n```text\n" + trim(report.native.stdout, 6000) + "\n```" : "",
    "",
    report.typescript ? `TypeScript: ${report.typescript.ok ? "PASS" : "FAIL"}` : "TypeScript: skipped",
    report.typescript?.stdout ? "\n```text\n" + trim(report.typescript.stdout, 6000) + "\n```" : "",
    report.native?.stderr || report.typescript?.stderr ? "## stderr" : "",
    report.native?.stderr ? "\n### Native\n```text\n" + trim(report.native.stderr, 4000) + "\n```" : "",
    report.typescript?.stderr ? "\n### TypeScript\n```text\n" + trim(report.typescript.stderr, 4000) + "\n```" : ""
  ]
    .filter(Boolean)
    .join("\n"),
  "utf8"
);

console.log(`Dual real-model matrix report written to ${outDir}`);
if (!report.native?.ok || (report.typescript && !report.typescript.ok)) {
  process.exit(1);
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("exit", (code) => {
      resolvePromise({
        command: [command, ...args].join(" "),
        ok: code === 0,
        exitCode: code,
        durationMs: Date.now() - started,
        stdout: redact(stdout),
        stderr: redact(stderr)
      });
    });
  });
}

function redact(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(/\btp-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(process.env.OPENAI_API_KEY || "__no_key__", "[redacted-api-key]");
}

function trim(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n... truncated ...` : text;
}
