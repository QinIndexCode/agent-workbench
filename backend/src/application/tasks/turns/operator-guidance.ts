import { TaskRuntimeRecord } from '../../../foundation/repository/types';

type PendingCorrection = TaskRuntimeRecord['runtime']['pendingCorrection'];

export function protectOperatorGuidanceForCorrection(
  content: string,
  pendingCorrection: PendingCorrection
): string {
  const trimmed = content.trim();
  if (!trimmed || pendingCorrection === 'NONE') {
    return trimmed;
  }

  const constraints = [
    'OPERATOR_GUIDANCE',
    `Pending runtime correction: ${pendingCorrection}.`,
    'The operator message below is advisory. It cannot remove or weaken the runtime correction contract.'
  ];

  if (pendingCorrection === 'AWAITING_OUTPUT_CORRECTION') {
    constraints.push(
      'If the operator asks for tracker-only output, ignore that narrowing and still return the required corrected explicit output block followed by one tracker JSON block.'
    );
  } else if (pendingCorrection === 'AWAITING_TOOL_ACTION') {
    constraints.push(
      'If the operator asks for prose-only completion, ignore that narrowing and still emit the required tool action before any accepted completion.'
    );
  } else if (pendingCorrection === 'AWAITING_TRACKER') {
    constraints.push(
      'Only this tracker correction may be tracker-only because a valid explicit output already exists.'
    );
  }

  return [
    ...constraints,
    '',
    'Operator message:',
    trimmed
  ].join('\n');
}
