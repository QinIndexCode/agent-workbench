import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const XIAOMI_MIMO_FLASH_PROVIDER_ID = 'xiaomi-mimo-v2-flash';
export const XIAOMI_MIMO_FLASH_SECRET_ID = 'xiaomi-mimo-live-provider';
export const XIAOMI_MIMO_FAST_MODEL = 'mimo-v2-flash';
export const XIAOMI_MIMO_STRONG_MODEL = 'mimo-v2.5';
export const XIAOMI_MIMO_FLASH_MODEL = XIAOMI_MIMO_FAST_MODEL;
export const XIAOMI_MIMO_FLASH_DOC_FILENAME = 'dont_touch_(APIKEY).md';

const XIAOMI_MIMO_FAST_TIMEOUT_MS = '45000';
const XIAOMI_MIMO_STRONG_TIMEOUT_MS = '90000';
const XIAOMI_MIMO_DEFAULT_MAX_RETRIES = '2';
const XIAOMI_MIMO_DEFAULT_RETRY_BACKOFF_MS = '1000';
const TOKEN_PLAN_HOSTNAME = 'token-plan-cn.xiaomimimo.com';
const TOKEN_PLAN_SUPPORTED_MODELS = new Set([
  'mimo-v2-omni',
  'mimo-v2-pro',
  'mimo-v2-tts',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'mimo-v2.5-tts',
  'mimo-v2.5-tts-voiceclone',
  'mimo-v2.5-tts-voicedesign',
]);

function normalizeBaseUrl(rawUrl) {
  return rawUrl
    .trim()
    .replace(/\s+\([^)]*\)\s*$/i, '')
    .replace(/\/chat\/completions\/?$/i, '')
    .replace(/\/+$/g, '');
}

function extractRequiredMatch(section, pattern, fieldName) {
  const matched = section.match(pattern);
  if (!matched?.[1]?.trim()) {
    throw new Error(`Could not parse Xiaomi Mimo live provider ${fieldName} from ${XIAOMI_MIMO_FLASH_DOC_FILENAME}.`);
  }
  return matched[1].trim();
}

function extractOptionalMatch(section, pattern) {
  const matched = section.match(pattern);
  return matched?.[1]?.trim() || null;
}

function formatProviderLabel(model) {
  if (model === XIAOMI_MIMO_FAST_MODEL) {
    return 'Xiaomi Mimo V2 Flash';
  }
  if (model === XIAOMI_MIMO_STRONG_MODEL) {
    return 'Xiaomi Mimo V2.5';
  }
  return `Xiaomi Mimo ${model}`;
}

export function resolveXiaomiMimoLiveModel(overrideModel = null, env = process.env) {
  return overrideModel?.trim()
    || env.XIAOMI_MIMO_LIVE_MODEL?.trim()
    || XIAOMI_MIMO_STRONG_MODEL;
}

export function resolveXiaomiMimoLiveProviderPolicy(options = {}) {
  const env = options.env ?? process.env;
  const model = resolveXiaomiMimoLiveModel(options.model, env);
  const defaultTimeoutMs = model === XIAOMI_MIMO_STRONG_MODEL
    ? XIAOMI_MIMO_STRONG_TIMEOUT_MS
    : XIAOMI_MIMO_FAST_TIMEOUT_MS;
  return {
    model,
    requestTimeoutMs: env.BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS?.trim() || defaultTimeoutMs,
    maxRetries: env.BACKEND_NEW_PROVIDER_MAX_RETRIES?.trim() || XIAOMI_MIMO_DEFAULT_MAX_RETRIES,
    retryBackoffMs: env.BACKEND_NEW_PROVIDER_RETRY_BACKOFF_MS?.trim() || XIAOMI_MIMO_DEFAULT_RETRY_BACKOFF_MS,
  };
}

export function resolveXiaomiMimoFlashDocPath(repoRoot = process.cwd()) {
  return path.resolve(repoRoot, XIAOMI_MIMO_FLASH_DOC_FILENAME);
}

function slugifyModel(model) {
  return model.replace(/[^a-z0-9._-]+/gi, '-');
}

function getTokenPlanCompatibility(baseUrl, model) {
  let hostname = null;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return {
      tokenPlan: false,
      supported: true,
    };
  }
  if (hostname !== TOKEN_PLAN_HOSTNAME) {
    return {
      tokenPlan: false,
      supported: true,
    };
  }
  return {
    tokenPlan: true,
    supported: TOKEN_PLAN_SUPPORTED_MODELS.has(model),
  };
}

function resolveCompatibleLiveModel(baseUrl, model, options = {}) {
  const compatibility = getTokenPlanCompatibility(baseUrl, model);
  if (!compatibility.tokenPlan || compatibility.supported) {
    return model;
  }
  if (options.allowCompatibleModelFallback && model === XIAOMI_MIMO_FAST_MODEL) {
    return XIAOMI_MIMO_STRONG_MODEL;
  }
  throw new Error(
    `The tokenPlan Xiaomi endpoint (${TOKEN_PLAN_HOSTNAME}) does not currently support model ${model}. `
    + `Supported models: ${Array.from(TOKEN_PLAN_SUPPORTED_MODELS).join(', ')}.`
  );
}

async function writeRuntimeProviderManifest(repoRoot, source) {
  const manifestDir = path.resolve(repoRoot, '.codex-run', 'tmp', 'providers');
  const manifestPath = path.join(
    manifestDir,
    `${source.providerId}.${slugifyModel(source.model)}.manifest.json`,
  );
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({
    providers: [
      {
        id: source.providerId,
        label: source.label,
        vendor: 'custom',
        transport: 'openai-compatible',
        baseUrl: source.baseUrl,
        model: source.model,
        apiKeySecretId: source.secretId,
        auth: {
          scheme: 'bearer',
        },
        metadata: {
          scope: 'live-provider',
          recommended: true,
        },
        endpoints: {
          chatCompletionsPath: '/chat/completions',
          messagesPath: '/messages',
        },
        apiVersion: null,
        organization: null,
        project: null,
        headers: {},
      },
    ],
  }, null, 2), 'utf8');
  return manifestPath;
}

export async function readXiaomiMimoFlashProviderSource(repoRoot = process.cwd(), options = {}) {
  const docPath = resolveXiaomiMimoFlashDocPath(repoRoot);
  const content = await fs.readFile(docPath, 'utf8');
  const sectionMatch = content.match(/xiaomi\s*\(mimo\)([\s\S]*?)(?:\r?\n---|\s*$)/i);
  if (!sectionMatch?.[1]) {
    throw new Error(`Could not find the Xiaomi Mimo section in ${XIAOMI_MIMO_FLASH_DOC_FILENAME}.`);
  }

  const section = sectionMatch[1];
  const defaultApiKey = extractRequiredMatch(section, /apiKey:\s*([^\r\n]+)/i, 'api key');
  const defaultRawBaseUrl = extractRequiredMatch(section, /baseUrl:\s*([^\r\n]+)/i, 'base URL');
  const tokenPlanSection = extractOptionalMatch(section, /tokenPlan:\s*([\s\S]*)/i);
  const tokenPlanApiKey = tokenPlanSection
    ? extractOptionalMatch(tokenPlanSection, /tokenPlanApiKey:\s*([^\r\n]+)/i)
    : null;
  const tokenPlanRawBaseUrl = tokenPlanSection
    ? extractOptionalMatch(tokenPlanSection, /baseUrl:\s*([^\r\n]+)/i)
    : null;
  const apiKey = tokenPlanApiKey || defaultApiKey;
  const rawBaseUrl = tokenPlanRawBaseUrl || defaultRawBaseUrl;
  const baseUrl = normalizeBaseUrl(rawBaseUrl);

  const requestedModel = resolveXiaomiMimoLiveModel(options.model, options.env);
  const model = resolveCompatibleLiveModel(baseUrl, requestedModel, options);
  return {
    providerId: XIAOMI_MIMO_FLASH_PROVIDER_ID,
    label: formatProviderLabel(model),
    model,
    requestedModel,
    secretId: XIAOMI_MIMO_FLASH_SECRET_ID,
    docPath,
    apiKey,
    chatCompletionsUrl: rawBaseUrl,
    baseUrl,
  };
}

export async function buildXiaomiMimoFlashLiveEnv(repoRoot = process.cwd(), options = {}) {
  const source = await readXiaomiMimoFlashProviderSource(repoRoot, options);
  const policy = resolveXiaomiMimoLiveProviderPolicy({ ...options, model: source.model });
  const manifestPath = await writeRuntimeProviderManifest(repoRoot, source);
  const currentNodeOptions = process.env.NODE_OPTIONS?.trim() ?? '';
  const nextNodeOptions = process.platform === 'win32'
    ? [currentNodeOptions, '--use-system-ca'].filter(Boolean).join(' ')
    : currentNodeOptions;
  return {
    BACKEND_NEW_LIVE_PROVIDER_ENABLED: '1',
    BACKEND_NEW_LIVE_PROVIDER_ID: source.providerId,
    BACKEND_NEW_LIVE_PROVIDER_MODEL: source.model,
    BACKEND_NEW_LIVE_PROVIDER_API_KEY: source.apiKey,
    BACKEND_NEW_LIVE_PROVIDER_MANIFEST: manifestPath,
    BACKEND_NEW_PROVIDER_MANIFEST: manifestPath,
    BACKEND_NEW_PROVIDER_DEFAULT_ID: source.providerId,
    BACKEND_NEW_PROVIDER_REQUEST_TIMEOUT_MS: policy.requestTimeoutMs,
    BACKEND_NEW_PROVIDER_MAX_RETRIES: policy.maxRetries,
    BACKEND_NEW_PROVIDER_RETRY_BACKOFF_MS: policy.retryBackoffMs,
    ...(nextNodeOptions ? { NODE_OPTIONS: nextNodeOptions } : {}),
  };
}
