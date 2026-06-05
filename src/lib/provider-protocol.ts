import type { LMStudioModel, ModelApiProtocol } from '@/types/ec9v3';

const OPENCODE_GO_HOST = 'opencode.ai/zen/go';

const OPENCODE_OPENAI_MODEL_PREFIXES = [
  'deepseek-',
  'glm-',
  'kimi-',
  'mimo-',
];

const OPENCODE_ANTHROPIC_MODEL_PREFIXES = [
  'minimax-',
  'qwen',
];

export function normalizeApiProtocol(value: unknown): ModelApiProtocol {
  return value === 'anthropic' ? 'anthropic' : 'openai';
}

export function isOpenCodeGoBaseUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '').toLowerCase().includes(OPENCODE_GO_HOST);
}

export function inferOpenCodeGoModelProtocol(model?: string): ModelApiProtocol | undefined {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return undefined;
  if (OPENCODE_OPENAI_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix))) return 'openai';
  if (OPENCODE_ANTHROPIC_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix))) return 'anthropic';
  return undefined;
}

export function resolveProviderApiProtocol(
  baseUrl: string,
  configuredProtocol: unknown,
  model?: string,
): ModelApiProtocol {
  const configured = normalizeApiProtocol(configuredProtocol);
  if (!isOpenCodeGoBaseUrl(baseUrl)) return configured;
  return inferOpenCodeGoModelProtocol(model) || configured;
}

export function modelMatchesProviderProtocol(
  baseUrl: string,
  model: string,
  apiProtocol: ModelApiProtocol,
): boolean {
  if (!isOpenCodeGoBaseUrl(baseUrl)) return true;
  const inferred = inferOpenCodeGoModelProtocol(model);
  return !inferred || inferred === apiProtocol;
}

export function filterModelsForProviderProtocol(
  baseUrl: string,
  models: LMStudioModel[],
  apiProtocol: ModelApiProtocol,
): LMStudioModel[] {
  return models.filter((model) => modelMatchesProviderProtocol(baseUrl, model.id, apiProtocol));
}
