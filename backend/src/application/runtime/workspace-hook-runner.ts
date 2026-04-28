import { spawn } from 'node:child_process';
import { createRuntimeEventEnvelope } from '../../foundation/projection/event-envelope';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { WorkspaceHookDefinition, WorkspaceWorkflowLoader } from '../platform/workspace-workflow-loader';

export interface WorkspaceHookExecutionRecord {
  event: string;
  command: string;
  description: string | null;
  status: 'SUCCEEDED' | 'FAILED';
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function truncateHookText(value: string, limit = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

async function executeHookCommand(params: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<WorkspaceHookExecutionRecord> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(params.command, {
        cwd: params.cwd,
        shell: true,
        windowsHide: true,
        env: params.env ?? process.env
      });
    } catch (error) {
      resolve({
        event: '',
        command: params.command,
        description: null,
        status: 'FAILED',
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: truncateHookText(error instanceof Error ? error.message : String(error))
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (status: 'SUCCEEDED' | 'FAILED', exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        event: '',
        command: params.command,
        description: null,
        status,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: truncateHookText(stdout),
        stderr: truncateHookText(stderr)
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      stderr += `${stderr ? '\n' : ''}${error.message}`;
      finish('FAILED', null);
    });
    child.on('close', (code) => {
      finish(code === 0 && !timedOut ? 'SUCCEEDED' : 'FAILED', typeof code === 'number' ? code : null);
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      stderr += `${stderr ? '\n' : ''}Hook timed out after ${params.timeoutMs}ms.`;
      try {
        child.kill();
      } catch {
        finish('FAILED', null);
      }
    }, params.timeoutMs);
  });
}

export async function runWorkspaceHooks(params: {
  foundation: BackendNewFoundation;
  event: string;
  taskId?: string | null;
  unitId?: string | null;
  correlationId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  checkpointId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<WorkspaceHookExecutionRecord[]> {
  const loader = new WorkspaceWorkflowLoader(params.foundation.cwd);
  const snapshot = await loader.discover();
  if (!snapshot.workspaceRoot) {
    return [];
  }
  const matchingHooks = snapshot.hooks.filter((hook) => hook.event === params.event);
  if (matchingHooks.length === 0) {
    return [];
  }

  const records: WorkspaceHookExecutionRecord[] = [];
  const taskWorkspaceDir = params.taskId ? params.foundation.layout.forTask(params.taskId).workspaceDir : null;
  for (const hook of matchingHooks) {
    const executed = await executeHookCommand({
      command: hook.command,
      cwd: snapshot.workspaceRoot,
      timeoutMs: hook.timeoutMs ?? 5_000,
      env: {
        ...process.env,
        SCC_WORKSPACE_ROOT: snapshot.workspaceRoot,
        ...(taskWorkspaceDir ? { SCC_TASK_WORKSPACE: taskWorkspaceDir } : {}),
        ...(params.taskId ? { SCC_TASK_ID: params.taskId } : {}),
        ...(params.unitId ? { SCC_UNIT_ID: params.unitId } : {})
      }
    });
    const record: WorkspaceHookExecutionRecord = {
      ...executed,
      event: hook.event,
      description: hook.description
    };
    records.push(record);

    await params.foundation.logs.recordTrace({
      timestamp: Date.now(),
      taskId: params.taskId?.trim() || 'workspace_hook',
      unitId: params.unitId ?? null,
      correlationId: params.correlationId ?? `corr_workspace_hook_${params.event}`,
      turnId: params.turnId ?? `turn_workspace_hook_${params.event}`,
      action: record.status === 'SUCCEEDED' ? 'workspace_hook_executed' : 'workspace_hook_failed',
      details: {
        hookEvent: record.event,
        hookCommand: record.command,
        hookDescription: record.description,
        hookStatus: record.status,
        hookExitCode: record.exitCode,
        hookTimedOut: record.timedOut,
        hookDurationMs: record.durationMs,
        hookStdout: record.stdout,
        hookStderr: record.stderr,
        ...(params.metadata ?? {})
      }
    });
    await params.foundation.logs.recordAudit({
      timestamp: Date.now(),
      severity: record.status === 'SUCCEEDED' ? 'INFO' : 'WARN',
      event: record.status === 'SUCCEEDED' ? 'workspace_hook_executed' : 'workspace_hook_failed',
      taskId: params.taskId ?? null,
      unitId: params.unitId ?? null,
      correlationId: params.correlationId ?? null,
      turnId: params.turnId ?? null,
      checkpointId: params.checkpointId ?? null,
      details: {
        hookEvent: record.event,
        hookCommand: record.command,
        hookDescription: record.description,
        hookStatus: record.status,
        hookExitCode: record.exitCode,
        hookTimedOut: record.timedOut,
        hookDurationMs: record.durationMs,
        ...(params.metadata ?? {})
      }
    });

    if (params.taskId) {
      await params.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: params.correlationId ?? `corr_workspace_hook_${params.event}`,
          sessionId: params.sessionId ?? `sess_workspace_hook_${params.event}`,
          turnId: params.turnId ?? `turn_workspace_hook_${params.event}`,
          taskId: params.taskId,
          unitId: params.unitId ?? null,
          checkpointId: params.checkpointId ?? null,
          type: record.status === 'SUCCEEDED' ? 'WORKSPACE_HOOK_EXECUTED' : 'WORKSPACE_HOOK_FAILED',
          payload: {
            event: record.event,
            command: record.command,
            description: record.description,
            status: record.status,
            exitCode: record.exitCode,
            timedOut: record.timedOut,
            durationMs: record.durationMs,
            stdout: record.stdout,
            stderr: record.stderr,
            ...(params.metadata ?? {})
          }
        })
      );
    }
  }

  return records;
}
