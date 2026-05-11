import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = resolve(".");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve("output", "native-ui-audit", stamp);
const dataDir = join(outDir, "data");
mkdirSync(dataDir, { recursive: true });

const screenshots = [];
const findings = [];

for (const theme of ["dark", "light"]) {
  seedStore(dataDir, theme);
  const screenshot = join(outDir, `${theme}-workbench.png`);
  const size = await captureNative(theme, screenshot);
  screenshots.push({ theme, path: screenshot, ...size });
}

const report = {
  generatedAt: new Date().toISOString(),
  sourceStyleReferences: [
    "apps/web/src/styles/tokens.css",
    "apps/web/src/styles/thread.css",
    "apps/web/src/styles/task-list.css",
    "apps/web/src/styles/settings.css"
  ],
  screenshots,
  checklist: [
    "Left sidebar uses Web width, brand block, navigation, task list, and bottom utility affordance.",
    "Timeline cards preserve role direction, compact thinking/tool rows, structured tool result rendering, and bottom composer.",
    "Right rail contains Permissions and Trace without putting trace into the ordinary task content flow.",
    "Light mode avoids heavy dark-gray blocks and keeps permission controls readable.",
    "Long paths and large tool results are summarized inline with trace available for raw payloads."
  ],
  findings
};

writeFileSync(join(outDir, "audit-report.json"), JSON.stringify(report, null, 2), "utf8");
writeFileSync(
  join(outDir, "audit-report.md"),
  [
    "# Native UI Screenshot Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Screenshots",
    "",
    ...screenshots.map((item) => `- ${item.theme}: ${item.path}`),
    "",
    "## Manual Checklist",
    "",
    ...report.checklist.map((item) => `- [ ] ${item}`)
  ].join("\n"),
  "utf8"
);

console.log(`Native screenshot audit written to ${outDir}`);

function seedStore(root, theme) {
  const now = new Date().toISOString();
  const taskId = `task_native_audit_${theme}`;
  const events = [
    event(taskId, "task_created", "Task created", {}),
    event(taskId, "user_message", "帮我检查这个项目，必要时修复并验证。", { content: "帮我检查这个项目，必要时修复并验证。" }),
    event(taskId, "thinking_delta", "Reading project state before acting.", { delta: "Reading project state before acting." }),
    event(taskId, "tool_started", "read_file started", { toolCallId: "call_read", toolName: "read_file", riskCategory: "workspace_read" }),
    event(taskId, "tool_progress", "Reading file.", {
      toolCallId: "call_read",
      toolName: "read_file",
      progress: {
        status: "running",
        targetPath: "D:\\MyCode\\myApp_\\Scc_batch_web\\apps\\web\\src\\i18n.ts",
        operation: "read",
        message: "Reading file.",
        processed: 32768,
        total: 65536,
        unit: "bytes"
      }
    }),
    event(taskId, "tool_result", "read_file completed", {
      toolCallId: "call_read",
      toolName: "read_file",
      ok: true,
      output: JSON.stringify({
        path: "D:\\MyCode\\myApp_\\Scc_batch_web\\apps\\web\\src\\i18n.ts",
        mode: "large_preview",
        partial: true,
        totalLines: 1240,
        hash: "hash-preview",
        content: "export const messages = {\\n  en: { permissions: 'Permissions' },\\n  zh: { permissions: '权限审批' }\\n};"
      })
    }),
    event(taskId, "tool_started", "edit_file started", { toolCallId: "call_edit", toolName: "edit_file", riskCategory: "workspace_write" }),
    event(taskId, "tool_progress", "Applying edit.", {
      toolCallId: "call_edit",
      toolName: "edit_file",
      progress: {
        status: "running",
        targetPath: "D:\\MyCode\\myApp_\\Scc_batch_web\\native\\crates\\scc-native-app\\src\\main.rs",
        operation: "edit",
        message: "Applying edit.",
        changes: {
          path: "D:\\MyCode\\myApp_\\Scc_batch_web\\native\\crates\\scc-native-app\\src\\main.rs",
          addedLines: 42,
          removedLines: 12,
          operation: "edit"
        }
      }
    }),
    event(taskId, "tool_result", "edit_file completed", {
      toolCallId: "call_edit",
      toolName: "edit_file",
      ok: true,
      output: JSON.stringify({
        status: "success",
        path: "D:\\MyCode\\myApp_\\Scc_batch_web\\native\\crates\\scc-native-app\\src\\main.rs",
        hash: "hash-after",
        changes: {
          path: "D:\\MyCode\\myApp_\\Scc_batch_web\\native\\crates\\scc-native-app\\src\\main.rs",
          addedLines: 42,
          removedLines: 12,
          operation: "edit"
        }
      })
    }),
    event(taskId, "approval_pending", "shell requires approval.", {
      approvalId: "approval_shell",
      approval: {
        id: "approval_shell",
        taskId,
        toolCall: { id: "call_shell", toolName: "run_command", args: { command: "npm.cmd test" } },
        riskCategory: "shell",
        reason: "shell requires approval.",
        status: "pending",
        createdAt: now
      }
    }),
    event(taskId, "user_input_requested", "User input requested.", {
      toolCallId: "call_ask",
      toolName: "ask_user",
      question: "Should the native audit prioritize visual polish or tool-flow correctness first?"
    }),
    event(taskId, "model_empty_response", "Model returned no displayable content or tool calls.", {
      finishReason: "stop",
      usage: { inputTokens: 450, outputTokens: 0, totalTokens: 450 }
    }),
    event(taskId, "assistant_message", "我已完成第一轮检查：文件读取、编辑进度、审批和空响应都已进入可审计事件。", {
      content: "我已完成第一轮检查：文件读取、编辑进度、审批和空响应都已进入可审计事件。"
    })
  ];
  const store = {
    tasks: [
      {
        id: taskId,
        title: theme === "dark" ? "Native UI audit - dark 权限审批" : "Native UI audit - light 权限审批",
        folderId: "default",
        workRoot: repoRoot,
        status: "running",
        createdAt: now,
        updatedAt: now,
        events,
        approvals: []
      }
    ],
    folders: [
      {
        id: "default",
        name: "Default",
        rootPath: repoRoot,
        isDefault: true,
        createdAt: now,
        updatedAt: now
      }
    ],
    preferences: {
      permissionMode: "auto_approval",
      allowedRisks: [],
      autoApprovalRisks: ["host_observation", "workspace_read", "network"],
      modelProvider: null,
      createdAt: now,
      updatedAt: now
    },
    knowledge: []
  };
  writeFileSync(join(root, "native.json"), JSON.stringify(store, null, 2), "utf8");
}

function event(taskId, eventType, summary, payload) {
  return {
    id: `${eventType}_${Math.random().toString(16).slice(2)}`,
    taskId,
    eventType,
    createdAt: new Date().toISOString(),
    summary,
    payload,
    reverted: false
  };
}

async function captureNative(theme, screenshotPath) {
  const child = spawn("cargo", ["run", "-p", "scc-native-app", "--bin", "scc-native"], {
    cwd: join(repoRoot, "native"),
    env: {
      ...process.env,
      SCC_NATIVE_DATA_DIR: dataDir,
      SCC_NATIVE_THEME: theme
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForWindow();
    await sleep(900);
    const size = await powershellCapture(screenshotPath);
    return parseSize(size);
  } finally {
    await stopNativeWindow();
    child.kill("SIGTERM");
  }
  if (stderr.includes("error:") && !stderr.includes("exit code: 0xffffffff")) {
    findings.push({ theme, severity: "warning", message: stderr.slice(0, 1000) });
  }
}

function parseSize(value) {
  const [width, height] = value.split("x").map((part) => Number.parseInt(part, 10));
  return {
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null
  };
}

function waitForWindow() {
  return runPowerShell(`
$deadline = (Get-Date).AddSeconds(35)
do {
  $p = Get-Process | Where-Object { ($_.MainWindowTitle -like '*SCC Native Agent Workbench*' -or $_.ProcessName -eq 'scc-native') -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { Write-Output $p.Id; exit 0 }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
Write-Error 'SCC Native Agent Workbench window did not appear'
exit 1
`);
}

function powershellCapture(path) {
  const escaped = path.replaceAll("'", "''");
  return runPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
Add-Type -AssemblyName System.Drawing
$p = Get-Process | Where-Object { ($_.MainWindowTitle -like '*SCC Native Agent Workbench*' -or $_.ProcessName -eq 'scc-native') -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw 'native window not found' }
[void][Win32]::SetForegroundWindow($p.MainWindowHandle)
[void][Win32]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0004)
Start-Sleep -Milliseconds 350
$rect = New-Object RECT
[void][Win32]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
$bmp = New-Object System.Drawing.Bitmap($width, $height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
Write-Output ([string]$width + 'x' + [string]$height)
`);
}

function stopNativeWindow() {
  return runPowerShell(`
Get-Process | Where-Object { $_.MainWindowTitle -like '*SCC Native Agent Workbench*' -or $_.ProcessName -eq 'scc-native' } | Stop-Process -Force -ErrorAction SilentlyContinue
`);
}

function runPowerShell(script) {
  return new Promise((resolvePromise, reject) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    ps.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    ps.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    ps.on("exit", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(stderr || stdout || `PowerShell exited ${code}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
