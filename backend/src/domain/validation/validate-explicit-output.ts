import { extractContractKeys, parseContractObject } from '../parser/contract-shape';
import { ExplicitOutputEnvelope } from '../contracts/types';
import { ExplicitOutputValidationResult, ValidationIssue } from './types';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const STRING_COMPATIBLE_ARRAY_KEYS = new Set([
  'artifactpaths',
  'artifacts',
  'files',
  'files_created',
  'filescreated',
  'producedfiles'
]);

function isStringCompatibleArrayKey(keyPath: string): boolean {
  const leaf = keyPath.split('.').at(-1)?.replace(/\[\]$/g, '').toLowerCase() ?? '';
  return STRING_COMPATIBLE_ARRAY_KEYS.has(leaf);
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

function validateContractValueShape(params: {
  unitId: string;
  keyPath: string;
  expected: unknown;
  actual: unknown;
  issues: ValidationIssue[];
}): void {
  const expected = params.expected;
  const actual = params.actual;

  if (typeof expected === 'string') {
    const expectedType = expected.trim().toLowerCase();
    if (['string', 'number', 'boolean', 'object', 'array'].includes(expectedType)) {
      const actualType = describeValueType(actual);
      if (actualType !== expectedType) {
        params.issues.push({
          code: 'contract_type_mismatch',
          message: `Explicit output key "${params.keyPath}" for unit "${params.unitId}" must be ${expectedType}, but received ${actualType}.`
        });
      }
    }
    return;
  }

  if (Array.isArray(expected)) {
    if (typeof actual === 'string' && isStringCompatibleArrayKey(params.keyPath)) {
      return;
    }
    if (!Array.isArray(actual)) {
      params.issues.push({
        code: 'contract_type_mismatch',
        message: `Explicit output key "${params.keyPath}" for unit "${params.unitId}" must be array, but received ${describeValueType(actual)}.`
      });
      return;
    }
    if (expected.length > 0 && actual.length > 0) {
      validateContractValueShape({
        unitId: params.unitId,
        keyPath: `${params.keyPath}[]`,
        expected: expected[0],
        actual: actual[0],
        issues: params.issues
      });
    }
    return;
  }

  if (isObjectRecord(expected)) {
    if (!isObjectRecord(actual)) {
      params.issues.push({
        code: 'contract_type_mismatch',
        message: `Explicit output key "${params.keyPath}" for unit "${params.unitId}" must be object, but received ${describeValueType(actual)}.`
      });
      return;
    }
    for (const [nestedKey, nestedExpected] of Object.entries(expected)) {
      const nestedPath = `${params.keyPath}.${nestedKey}`;
      if (!(nestedKey in actual)) {
        params.issues.push({
          code: 'missing_contract_key',
          message: `Explicit output is missing contract key "${nestedPath}".`
        });
        continue;
      }
      validateContractValueShape({
        unitId: params.unitId,
        keyPath: nestedPath,
        expected: nestedExpected,
        actual: actual[nestedKey],
        issues: params.issues
      });
    }
    return;
  }

  if (typeof expected === 'number' && typeof actual !== 'number') {
    params.issues.push({
      code: 'contract_type_mismatch',
      message: `Explicit output key "${params.keyPath}" for unit "${params.unitId}" must be number, but received ${describeValueType(actual)}.`
    });
  } else if (typeof expected === 'boolean' && typeof actual !== 'boolean') {
    params.issues.push({
      code: 'contract_type_mismatch',
      message: `Explicit output key "${params.keyPath}" for unit "${params.unitId}" must be boolean, but received ${describeValueType(actual)}.`
    });
  }
}

export function validateExplicitOutput(params: {
  currentUnitId: string;
  explicitOutputs: ExplicitOutputEnvelope[];
  outputContract?: string;
}): ExplicitOutputValidationResult {
  const issues: ValidationIssue[] = [];
  const contractKeys = params.outputContract ? extractContractKeys(params.outputContract) : [];
  const currentOutputs = params.explicitOutputs.filter(output => output.unitId === params.currentUnitId);

  if (currentOutputs.length === 0) {
    issues.push({
      code: 'missing_explicit_output',
      message: `Missing explicit output for unit "${params.currentUnitId}".`
    });
    return {
      ok: false,
      contractKeys,
      issues,
      acceptedOutput: null
    };
  }

  if (currentOutputs.length > 1) {
    issues.push({
      code: 'duplicate_explicit_output',
      message: `Multiple explicit outputs detected for unit "${params.currentUnitId}".`
    });
  }

  const acceptedOutput = currentOutputs[0] ?? null;
  if (!acceptedOutput) {
    return {
      ok: false,
      contractKeys,
      issues,
      acceptedOutput: null
    };
  }

  if (acceptedOutput.parsedJson === null) {
    issues.push({
      code: 'invalid_output_json',
      message: `Explicit output for unit "${params.currentUnitId}" is not valid JSON.`
    });
    return {
      ok: false,
      contractKeys,
      issues,
      acceptedOutput: null
    };
  }

  if (contractKeys.length > 0) {
    const contractShape = params.outputContract ? parseContractObject(params.outputContract) : null;
    if (!isObjectRecord(acceptedOutput.parsedJson)) {
      issues.push({
        code: 'output_not_object',
        message: 'Explicit output must be a JSON object to satisfy the output contract.'
      });
    } else {
      for (const key of contractKeys) {
        if (!(key in acceptedOutput.parsedJson)) {
          issues.push({
            code: 'missing_contract_key',
            message: `Explicit output is missing contract key "${key}".`
          });
          continue;
        }
        if (contractShape && key in contractShape) {
          validateContractValueShape({
            unitId: params.currentUnitId,
            keyPath: key,
            expected: contractShape[key],
            actual: acceptedOutput.parsedJson[key],
            issues
          });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    contractKeys,
    issues,
    acceptedOutput: issues.length === 0 ? acceptedOutput : null
  };
}
