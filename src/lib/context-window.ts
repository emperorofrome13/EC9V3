import { getProviderHeaders, listModels } from '@/lib/lmstudio';
import type { ModelApiProtocol } from '@/types/ec9v3';

export type ContextLimitSource = 'runtime_metadata' | 'model_metadata' | 'manual_fallback';

export interface ContextLimitResolution {
  contextLimit: number;
  source: ContextLimitSource;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function findNumericContextValue(value: unknown, parentKey = ''): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1024) {
    return /ctx|context|window|token|length/i.test(parentKey) ? value : null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/ctx|context|window|token|length/i.test(key) && typeof nested === 'number' && Number.isFinite(nested) && nested >= 1024) {
      return nested;
    }
    const found = findNumericContextValue(nested, key);
    if (found) return found;
  }
  return null;
}

function normalizeProviderBaseUrl(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '');
  return url.endsWith('/v1') ? url.slice(0, -3) : url;
}

export async function getRuntimeContextLimit(
  baseUrl: string,
  selectedModel?: string,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
): Promise<number | null> {
  // Previously this POSTed a `max_tokens: 1` completion to read `model_info`,
  // which actually generates a token on every poll (the context meter polls
  // every 15s). Read model metadata from the REST `/api/v0/models[/:id]`
  // endpoint instead — no inference is performed.
  try {
    const url = normalizeProviderBaseUrl(baseUrl);
    const headers = getProviderHeaders(apiKey, apiProtocol, true);
    const signal = AbortSignal.timeout(5000);

    if (selectedModel && selectedModel !== 'local-model') {
      const single = await fetch(`${url}/api/v0/models/${encodeURIComponent(selectedModel)}`, {
        headers,
        signal,
      }).catch(() => null);
      if (single?.ok) {
        const data = await single.json();
        const limit = findNumericContextValue(data);
        if (limit) return Math.floor(limit);
      }
    }

    const listRes = await fetch(`${url}/api/v0/models`, { headers, signal }).catch(() => null);
    if (listRes?.ok) {
      const data = await listRes.json();
      const list: unknown[] = Array.isArray(data?.data) ? data.data : [];
      const target = selectedModel && selectedModel !== 'local-model'
        ? list.find((m: any) => m?.id === selectedModel)
        : list.find((m: any) => String(m?.state || '').toLowerCase() === 'loaded') || list[0];
      const limit = findNumericContextValue(target);
      if (limit) return Math.floor(limit);
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveLoadedModelContextLimit(
  baseUrl: string,
  selectedModel?: string,
  fallback?: number,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
): Promise<ContextLimitResolution> {
  const runtimeLimit = await getRuntimeContextLimit(baseUrl, selectedModel, apiKey, apiProtocol);
  if (runtimeLimit) return { contextLimit: runtimeLimit, source: 'runtime_metadata' };

  try {
    const models = await listModels(baseUrl, apiKey, apiProtocol);
    const loadedModel = models.find((m) => String(m.state || '').toLowerCase() === 'loaded');
    const model = selectedModel && selectedModel !== 'local-model'
      ? models.find((m) => m.id === selectedModel) || models[0]
      : loadedModel || models[0];
    const discovered = findNumericContextValue(model);
    if (discovered) return { contextLimit: Math.floor(discovered), source: 'model_metadata' };
  } catch {
    // Some LM Studio/OpenAI-compatible endpoints do not expose context metadata.
  }
  return {
    contextLimit: Math.max(1024, Number(fallback) || 30000),
    source: 'manual_fallback',
  };
}

export async function getLoadedModelContextLimit(
  baseUrl: string,
  selectedModel?: string,
  fallback?: number,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
): Promise<number> {
  return (await resolveLoadedModelContextLimit(baseUrl, selectedModel, fallback, apiKey, apiProtocol)).contextLimit;
}
