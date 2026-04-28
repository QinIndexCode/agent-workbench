export type ExtensionSourceKind = 'builtin' | 'manifest' | 'mcp' | 'skill';

export type SkillRegistrationSource =
  | 'CONFIG_ROOT'
  | 'IMPORT_MANIFEST';

export type SkillKind =
  | 'runtime-skill'
  | 'instruction-skill';

export interface InstructionSkillAssetSummary {
  totalFiles: number;
  markdownFiles: number;
  scriptFiles: number;
  templateFiles: number;
  assetFiles: number;
  samplePaths: string[];
}

export interface InstructionSkillSource {
  format: 'claude-style-skill';
  skillFile: string;
  marketplaceFile?: string | null;
  pluginName?: string | null;
}

export interface SkillDefinition {
  id: string;
  name: string;
  rootDir: string;
  entryFile?: string;
  description?: string;
  kind?: SkillKind;
  assetSummary?: InstructionSkillAssetSummary;
  instructionSource?: InstructionSkillSource;
  metadata?: Record<string, unknown>;
  registrationSource?: SkillRegistrationSource;
}

export interface McpServerDefinition {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'ws';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  declaredTools?: string[];
  declaredResources?: string[];
  declaredPrompts?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentToolSchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  description?: string;
}

export type AgentToolEffect =
  | 'READ'
  | 'WRITE'
  | 'PROCESS'
  | 'NETWORK';

export type AgentToolRiskLevel =
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH';

export interface AgentToolDefinition {
  id: string;
  name: string;
  description: string;
  source: ExtensionSourceKind;
  version?: string;
  effect: AgentToolEffect;
  riskLevel: AgentToolRiskLevel;
  inputSchema: AgentToolSchemaField[];
  tags?: string[];
}

export interface ExtensionCatalogSnapshot {
  skills: SkillDefinition[];
  mcpServers: McpServerDefinition[];
  tools: AgentToolDefinition[];
}
