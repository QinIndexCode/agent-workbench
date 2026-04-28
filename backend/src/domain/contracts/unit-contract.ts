import { extractContractKeys, parseContractObject } from '../parser/contract-shape';
import { AgentUnit, PermissionLevel } from './types';

export interface InputContractScope {
  unitIds: string[];
  outputKeysByUnitId: Record<string, string[]>;
  memoryUnitIds: string[];
  memoryKinds: Array<'MILESTONE' | 'DECISION'>;
  includeGlobalMemory: boolean;
  structured: boolean;
  usedCompatibilityFallback: boolean;
  source: 'STRUCTURED' | 'NORMALIZED' | 'COMPAT_FALLBACK';
}

export interface UnitContract {
  unitId: string;
  taskScope?: string;
  inputContract?: string;
  outputContract?: string;
  exitCondition?: string;
  permissionLevel: PermissionLevel;
  contractSource: 'STRUCTURED' | 'NORMALIZED' | 'COMPAT_FALLBACK';
  referencedInputUnitIds: string[];
  inputScope: InputContractScope;
  outputContractKeys: string[];
  exitContractKeys: string[];
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function collectReferencedUnitIds(input: string | undefined, knownUnitIds: string[]): string[] {
  if (!input) {
    return [];
  }
  return knownUnitIds.filter((unitId) => input.includes(unitId));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeKeySelectorMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, keys]) => Array.isArray(keys))
      .map(([unitId, keys]) => [unitId, normalizeStringArray(keys)])
      .filter(([, keys]) => keys.length > 0)
  );
}

function parseStructuredInputScope(input: string | undefined, knownUnitIds: string[]): InputContractScope | null {
  if (!input) {
    return null;
  }
  const parsed = parseContractObject(input);
  if (!parsed) {
    return null;
  }
  const directUnits = [
    ...normalizeStringArray(parsed.units),
    ...normalizeStringArray(parsed.allowUnits),
    ...normalizeStringArray(parsed.unitIds),
    ...normalizeStringArray(parsed.sourceUnits)
  ];
  const outputKeysByUnitId = {
    ...normalizeKeySelectorMap(parsed.outputKeys),
    ...normalizeKeySelectorMap(parsed.allowKeys),
    ...normalizeKeySelectorMap(parsed.keysByUnit)
  };
  const keyedUnits = Object.keys(outputKeysByUnitId);
  const uniqueUnits = Array.from(new Set([...directUnits, ...keyedUnits])).filter((unitId) => knownUnitIds.includes(unitId));
  const explicitMemoryUnits = [
    ...normalizeStringArray(parsed.memoryUnits),
    ...normalizeStringArray(parsed.includeMemoryUnits)
  ].filter((unitId) => knownUnitIds.includes(unitId));
  const memoryKinds = normalizeStringArray(parsed.memoryKinds)
    .filter((kind): kind is 'MILESTONE' | 'DECISION' => kind === 'MILESTONE' || kind === 'DECISION');
  const includeGlobalMemory = typeof parsed.includeGlobalMemory === 'boolean'
    ? parsed.includeGlobalMemory
    : true;

  return {
    unitIds: uniqueUnits,
    outputKeysByUnitId: Object.fromEntries(
      Object.entries(outputKeysByUnitId).filter(([unitId]) => knownUnitIds.includes(unitId))
    ),
    memoryUnitIds: explicitMemoryUnits.length > 0 ? explicitMemoryUnits : uniqueUnits,
    memoryKinds,
    includeGlobalMemory,
    structured: true,
    usedCompatibilityFallback: false,
    source: 'STRUCTURED'
  };
}

function createInputContractScope(input: string | undefined, knownUnitIds: string[]): InputContractScope {
  const structured = parseStructuredInputScope(input, knownUnitIds);
  if (structured) {
    return structured;
  }
  const referencedUnitIds = collectReferencedUnitIds(input, knownUnitIds);
  const usedCompatibilityFallback = referencedUnitIds.length > 0;
  return {
    unitIds: referencedUnitIds,
    outputKeysByUnitId: {},
    memoryUnitIds: referencedUnitIds,
    memoryKinds: [],
    includeGlobalMemory: true,
    structured: false,
    usedCompatibilityFallback,
    source: usedCompatibilityFallback ? 'COMPAT_FALLBACK' : 'NORMALIZED'
  };
}

function normalizePermissionLevel(value: PermissionLevel | undefined): PermissionLevel {
  return value ?? 'DEPENDENCY';
}

export function createUnitContract(unit: AgentUnit, knownUnitIds: string[]): UnitContract {
  const taskScope = normalizeOptionalText(unit.taskScope);
  const inputContract = normalizeOptionalText(unit.inputContract);
  const outputContract = normalizeOptionalText(unit.outputContract);
  const exitCondition = normalizeOptionalText(unit.exitCondition);
  const inputScope = createInputContractScope(inputContract, knownUnitIds);

  return {
    unitId: unit.id,
    taskScope,
    inputContract,
    outputContract,
    exitCondition,
    permissionLevel: normalizePermissionLevel(unit.permissionLevel),
    contractSource: inputScope.source,
    referencedInputUnitIds: inputScope.unitIds,
    inputScope,
    outputContractKeys: outputContract ? extractContractKeys(outputContract) : [],
    exitContractKeys: exitCondition ? extractContractKeys(exitCondition) : []
  };
}

export interface UnitContractValidationIssue {
  code: string;
  message: string;
  unitId: string;
}

export interface UnitContractValidationResult {
  ok: boolean;
  issues: UnitContractValidationIssue[];
}

function isValidPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'GLOBAL' || value === 'DEPENDENCY' || value === 'PRIVATE';
}

function hasInvalidStructuredContract(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  if (value.trim().startsWith('{')) {
    return parseContractObject(value) === null;
  }
  return false;
}

export function validateUnitContract(unit: AgentUnit, knownUnitIds: string[]): UnitContractValidationResult {
  const issues: UnitContractValidationIssue[] = [];
  const inputContract = normalizeOptionalText(unit.inputContract);

  if (unit.permissionLevel && !isValidPermissionLevel(unit.permissionLevel)) {
    issues.push({
      code: 'invalid_permission_level',
      message: `Unit "${unit.id}" has invalid permissionLevel "${unit.permissionLevel}".`,
      unitId: unit.id
    });
  }

  if (hasInvalidStructuredContract(unit.outputContract)) {
    issues.push({
      code: 'invalid_output_contract',
      message: `Unit "${unit.id}" has an invalid structured output contract.`,
      unitId: unit.id
    });
  }

  if (hasInvalidStructuredContract(unit.exitCondition)) {
    issues.push({
      code: 'invalid_exit_condition',
      message: `Unit "${unit.id}" has an invalid structured exit condition.`,
      unitId: unit.id
    });
  }

  const referencedInputUnitIds = createInputContractScope(inputContract, knownUnitIds).unitIds;
  for (const referencedUnitId of referencedInputUnitIds) {
    if (referencedUnitId === unit.id) {
      issues.push({
        code: 'input_contract_self_reference',
        message: `Unit "${unit.id}" inputContract must not reference itself as an upstream output source.`,
        unitId: unit.id
      });
    }
  }

  if (inputContract?.trim().startsWith('{')) {
    const parsed = parseContractObject(inputContract);
    if (parsed) {
      const unitCandidates = [
        ...normalizeStringArray(parsed.units),
        ...normalizeStringArray(parsed.allowUnits),
        ...normalizeStringArray(parsed.unitIds),
        ...normalizeStringArray(parsed.sourceUnits),
        ...Object.keys(normalizeKeySelectorMap(parsed.outputKeys)),
        ...Object.keys(normalizeKeySelectorMap(parsed.allowKeys)),
        ...Object.keys(normalizeKeySelectorMap(parsed.keysByUnit)),
        ...normalizeStringArray(parsed.memoryUnits),
        ...normalizeStringArray(parsed.includeMemoryUnits)
      ];
      for (const unitId of Array.from(new Set(unitCandidates))) {
        if (!knownUnitIds.includes(unitId)) {
          issues.push({
            code: 'input_contract_unknown_unit',
            message: `Unit "${unit.id}" inputContract references unknown unit "${unitId}".`,
            unitId: unit.id
          });
        }
      }
      for (const memoryKind of normalizeStringArray(parsed.memoryKinds)) {
        if (memoryKind !== 'MILESTONE' && memoryKind !== 'DECISION') {
          issues.push({
            code: 'input_contract_invalid_memory_kind',
            message: `Unit "${unit.id}" inputContract uses invalid memoryKind "${memoryKind}".`,
            unitId: unit.id
          });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}
