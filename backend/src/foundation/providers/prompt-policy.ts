import { ResolvedProviderProfile } from './types';

export interface ProviderPromptPolicy {
  vendorLabel: string;
  preferredOutputWrappers: Array<'square' | 'angle' | 'xml'>;
  trackerFormat: 'json';
  toolCallFormat: 'json-or-xml' | 'json';
  guidanceLines: string[];
}

function createSharedPolicy(params: {
  vendorLabel: string;
  preferredOutputWrappers: Array<'square' | 'angle' | 'xml'>;
  toolCallFormat?: ProviderPromptPolicy['toolCallFormat'];
  guidanceLines?: string[];
}): ProviderPromptPolicy {
  return {
    vendorLabel: params.vendorLabel,
    preferredOutputWrappers: params.preferredOutputWrappers,
    trackerFormat: 'json',
    toolCallFormat: params.toolCallFormat ?? 'json-or-xml',
    guidanceLines: params.guidanceLines ?? []
  };
}

function createOpenAiCompatiblePolicy(vendorLabel = 'OpenAI-compatible'): ProviderPromptPolicy {
  return createSharedPolicy({
    vendorLabel,
    preferredOutputWrappers: ['square', 'angle', 'xml'],
    toolCallFormat: 'json',
    guidanceLines: [
      'Return explicit output first. If tool actions are needed, emit JSON tool call objects next, then end with one tracker JSON block.',
      'Use only canonical JSON tool names such as read_file, inspect_file, write_file, create_folder, list_files, search_files, run_command, and delegate_subtask. Do not use XML tool wrappers.'
    ]
  });
}

export function resolveProviderPromptPolicy(
  profile: Pick<ResolvedProviderProfile, 'vendor' | 'transport'>
): ProviderPromptPolicy {
  if (profile.transport === 'openai-compatible') {
    if (profile.vendor === 'deepseek') {
      return createOpenAiCompatiblePolicy('DeepSeek-compatible');
    }
    if (profile.vendor === 'openai' || profile.vendor === 'chatgpt' || profile.vendor === 'custom') {
      return createOpenAiCompatiblePolicy('OpenAI-compatible');
    }
    return createOpenAiCompatiblePolicy(`${profile.vendor}/openai-compatible`);
  }
  switch (profile.vendor) {
    case 'deepseek':
      return createSharedPolicy({
        vendorLabel: 'DeepSeek-compatible',
        preferredOutputWrappers: ['square', 'angle', 'xml'],
        guidanceLines: [
          'Prefer compact structured blocks and avoid trailing explanatory prose after the tracker.',
          'Keep explicit output, tool calls, and tracker as separate machine-readable blocks in this order: explicit output, any needed tool blocks, then one final tracker JSON.'
        ]
      });
    case 'anthropic':
      return createSharedPolicy({
        vendorLabel: 'Anthropic-compatible',
        preferredOutputWrappers: ['xml', 'square', 'angle'],
        guidanceLines: [
          'Use exact wrapper boundaries and keep tracker JSON standalone on its own line.'
        ]
      });
    default:
      return createSharedPolicy({
        vendorLabel: `${profile.vendor}/${profile.transport}`,
        preferredOutputWrappers: ['square', 'xml', 'angle'],
        guidanceLines: [
          'Preserve strict machine-readable wrappers and keep the response ordered as explicit output, any needed tool blocks, then one tracker JSON without trailing prose.'
        ]
      });
  }
}
