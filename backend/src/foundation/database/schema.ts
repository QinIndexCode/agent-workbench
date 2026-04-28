import { DatabaseMigrationPlanEntry } from './types';

function qualified(schema: string, table: string): string {
  return `"${schema}"."${table}"`;
}

function buildCoreRuntimeStatements(schema: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'tasks')} (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      current_unit_id TEXT NULL,
      updated_at BIGINT NOT NULL,
      payload JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'task_runtimes')} (
      task_id TEXT PRIMARY KEY,
      definition JSONB NOT NULL,
      runtime JSONB NOT NULL,
      active_provider_id TEXT NULL,
      latest_checkpoint_id TEXT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'checkpoints')} (
      task_id TEXT PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      state JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'task_metadata')} (
      task_id TEXT PRIMARY KEY,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      latest_session_id TEXT NULL,
      selected_provider_id TEXT NULL,
      labels JSONB NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'execution_sessions')} (
      session_id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      unit_id TEXT NULL,
      provider_id TEXT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      ended_at BIGINT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'task_projections')} (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      current_unit_id TEXT NULL,
      latest_session_id TEXT NULL,
      latest_correlation_id TEXT NULL,
      latest_turn_id TEXT NULL,
      latest_checkpoint_id TEXT NULL,
      updated_at BIGINT NOT NULL,
      summary JSONB NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'runtime_events')} (
      row_id BIGSERIAL UNIQUE,
      event_id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      unit_id TEXT NULL,
      checkpoint_id TEXT NULL,
      type TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      payload JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_events_task_time ON ${qualified(schema, 'runtime_events')} (task_id, timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_events_task_row ON ${qualified(schema, 'runtime_events')} (task_id, row_id ASC)`
  ];
}

function buildArtifactStatements(schema: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'validated_outputs')} (
      task_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      contract_keys JSONB NOT NULL,
      wrapper TEXT NOT NULL,
      raw TEXT NOT NULL,
      parsed JSONB NOT NULL,
      validated_at BIGINT NOT NULL,
      metadata JSONB NOT NULL,
      PRIMARY KEY (task_id, unit_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'tool_invocations')} (
      row_id BIGSERIAL PRIMARY KEY,
      invocation_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      checkpoint_id TEXT NULL,
      tool_id TEXT NOT NULL,
      arguments JSONB NOT NULL,
      status TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      ended_at BIGINT NULL,
      result JSONB NULL,
      error TEXT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tool_invocations_task_invocation ON ${qualified(schema, 'tool_invocations')} (task_id, invocation_id, row_id DESC)`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'tool_approvals')} (
      row_id BIGSERIAL PRIMARY KEY,
      approval_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      checkpoint_id TEXT NULL,
      tool_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      resolved_at BIGINT NULL,
      granted_by TEXT NULL,
      reason TEXT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tool_approvals_task_invocation ON ${qualified(schema, 'tool_approvals')} (task_id, invocation_id, row_id DESC)`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'conversations')} (
      message_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      session_id TEXT NULL,
      correlation_id TEXT NULL,
      role TEXT NOT NULL,
      visibility TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_task_created ON ${qualified(schema, 'conversations')} (task_id, created_at ASC)`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'provider_secrets')} (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      cipher_text TEXT NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'config_snapshots')} (
      version TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      config JSONB NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT FALSE
    )`
  ];
}

function buildQueueStatements(schema: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'queue_items')} (
      task_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      run_after BIGINT NOT NULL,
      priority INTEGER NOT NULL,
      lease_owner TEXT NULL,
      claim_token TEXT NULL,
      lease_expires_at BIGINT NULL,
      attempt_count INTEGER NOT NULL,
      max_retries INTEGER NOT NULL,
      last_error TEXT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_queue_items_claim ON ${qualified(schema, 'queue_items')} (state, run_after ASC, priority DESC, updated_at ASC)`
  ];
}

function buildOperatorCommandStatements(schema: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'operator_commands')} (
      row_id BIGSERIAL PRIMARY KEY,
      command_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      applied_at BIGINT NULL,
      actor TEXT NULL,
      reason TEXT NULL,
      payload JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_operator_commands_task_created ON ${qualified(schema, 'operator_commands')} (task_id, created_at ASC, row_id ASC)`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'operator_messages')} (
      row_id BIGSERIAL PRIMARY KEY,
      message_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      command_id TEXT NULL,
      created_at BIGINT NOT NULL,
      actor TEXT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      consumed_at BIGINT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_operator_messages_task_created ON ${qualified(schema, 'operator_messages')} (task_id, created_at ASC, row_id ASC)`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'interrupt_requests')} (
      row_id BIGSERIAL PRIMARY KEY,
      request_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      command_id TEXT NULL,
      created_at BIGINT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_interrupt_requests_task_created ON ${qualified(schema, 'interrupt_requests')} (task_id, created_at ASC, row_id ASC)`
  ];
}

function buildPlatformResourceStatements(schema: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'platform_channels')} (
      channel_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      endpoint TEXT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'platform_schedules')} (
      schedule_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      cadence TEXT NOT NULL,
      task_template JSONB NOT NULL,
      last_run_at BIGINT NULL,
      next_run_at BIGINT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'platform_memories')} (
      memory_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      scope TEXT NOT NULL,
      tags JSONB NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_platform_memories_updated ON ${qualified(schema, 'platform_memories')} (updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'platform_commands')} (
      row_id BIGSERIAL PRIMARY KEY,
      command_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      actor TEXT NULL,
      reason TEXT NULL,
      input JSONB NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_platform_commands_resource_created ON ${qualified(schema, 'platform_commands')} (resource_type, resource_id, created_at ASC, row_id ASC)`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'platform_audits')} (
      row_id BIGSERIAL PRIMARY KEY,
      audit_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      error TEXT NULL,
      result JSONB NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_platform_audits_resource_created ON ${qualified(schema, 'platform_audits')} (resource_type, resource_id, created_at ASC, row_id ASC)`
  ];
}

function buildAuthorityAlignmentStatements(schema: string): string[] {
  return [
    `ALTER TABLE ${qualified(schema, 'operator_commands')} ADD COLUMN IF NOT EXISTS updated_at BIGINT NULL`,
    `ALTER TABLE ${qualified(schema, 'operator_commands')} ADD COLUMN IF NOT EXISTS message TEXT NULL`,
    `ALTER TABLE ${qualified(schema, 'operator_commands')} ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE ${qualified(schema, 'operator_messages')} ADD COLUMN IF NOT EXISTS session_id TEXT NULL`,
    `ALTER TABLE ${qualified(schema, 'operator_messages')} ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL`,
    `ALTER TABLE ${qualified(schema, 'interrupt_requests')} ADD COLUMN IF NOT EXISTS requested_by TEXT NULL`,
    `ALTER TABLE ${qualified(schema, 'interrupt_requests')} ADD COLUMN IF NOT EXISTS updated_at BIGINT NULL`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'platform_commands')} (
      row_id BIGSERIAL PRIMARY KEY,
      command_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      actor TEXT NULL,
      reason TEXT NULL,
      input JSONB NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_platform_commands_resource_created ON ${qualified(schema, 'platform_commands')} (resource_type, resource_id, created_at ASC, row_id ASC)`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'platform_audits')} (
      row_id BIGSERIAL PRIMARY KEY,
      audit_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      error TEXT NULL,
      result JSONB NOT NULL,
      metadata JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_platform_audits_resource_created ON ${qualified(schema, 'platform_audits')} (resource_type, resource_id, created_at ASC, row_id ASC)`
  ];
}

function buildRuntimeRobustnessStatements(schema: string): string[] {
  return [
    `ALTER TABLE ${qualified(schema, 'runtime_events')} ADD COLUMN IF NOT EXISTS row_id BIGSERIAL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_events_row_id_unique ON ${qualified(schema, 'runtime_events')} (row_id)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_events_task_row ON ${qualified(schema, 'runtime_events')} (task_id, row_id ASC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_config_snapshots_single_active ON ${qualified(schema, 'config_snapshots')} (is_active) WHERE is_active = TRUE`
  ];
}

export function buildBackendNewMigrationBootstrapSql(schema: string): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'schema_version')} (
      schema_name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'schema_migrations')} (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      executed_at BIGINT NOT NULL
    )`
  ];
}

export function buildBackendNewMigrationPlan(schema: string): DatabaseMigrationPlanEntry[] {
  return [
    {
      version: '20260325_001_core_runtime',
      description: 'Create core runtime, session, projection, and event tables.',
      statements: buildCoreRuntimeStatements(schema)
    },
    {
      version: '20260325_002_artifacts_and_state',
      description: 'Create validated output, tool, approval, conversation, secret, and config tables.',
      statements: buildArtifactStatements(schema)
    },
    {
      version: '20260325_003_queue_runtime',
      description: 'Create durable queue storage and indexes.',
      statements: buildQueueStatements(schema)
    },
    {
      version: '20260325_004_operator_commands',
      description: 'Create operator command, message, and interrupt event tables.',
      statements: buildOperatorCommandStatements(schema)
    },
    {
      version: '20260325_005_platform_resources',
      description: 'Create platform resource tables for channels, schedules, and memories.',
      statements: buildPlatformResourceStatements(schema)
    },
    {
      version: '20260325_006_authority_alignment',
      description: 'Align operator table columns and add platform command/audit log tables.',
      statements: buildAuthorityAlignmentStatements(schema)
    },
    {
      version: '20260331_007_runtime_robustness',
      description: 'Harden runtime event ordering and enforce a single active config snapshot.',
      statements: buildRuntimeRobustnessStatements(schema)
    }
  ];
}

export function buildBackendNewSchemaSql(schema: string): string[] {
  return [
    ...buildBackendNewMigrationBootstrapSql(schema),
    ...buildBackendNewMigrationPlan(schema).flatMap(entry => entry.statements)
  ];
}
