import { extractContractKeys } from '../parser/contract-shape';
import { ExplicitOutputEnvelope } from '../contracts/types';
import { ExplicitOutputValidationResult, ValidationIssue } from './types';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
