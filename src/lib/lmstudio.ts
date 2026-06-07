import type {
  APIMessageContent,
  ToolDefinition,
  LMStudioModel,
  LMStudioChatOptions,
  LMStudioStreamEvent,
  ModelApiProtocol,
} from '@/types/ec9v3';

export interface LMStudioChatResponse {
  content: string;
  reasoningContent?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  choices?: unknown[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model?: string;
}

const PROVIDER_RESPONSE_TIMEOUT_MS = Number(process.env.EC9V3_PROVIDER_RESPONSE_TIMEOUT_MS || 60_000);
const PROVIDER_STREAM_IDLE_TIMEOUT_MS = Number(process.env.EC9V3_PROVIDER_STREAM_IDLE_TIMEOUT_MS || 120_000);

function providerTimeoutMessage(label: string, timeoutMs: number): string {
  return `${label} timed out after ${Math.round(timeoutMs / 1000)}s without a provider response. The provider may still have charged tokens; retry with a smaller request or different model.`;
}

async function fetchWithProviderTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = PROVIDER_RESPONSE_TIMEOUT_MS,
): Promise<Response> {
  const timeoutController = new AbortController();
  const upstreamSignal = init.signal;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  const onAbort = () => timeoutController.abort();
  upstreamSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await fetch(input, { ...init, signal: timeoutController.signal });
  } catch (error) {
    if (timedOut) throw new Error(providerTimeoutMessage('Provider connection', timeoutMs));
    throw error;
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', onAbort);
  }
}

async function readStreamChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  timeoutMs = PROVIDER_STREAM_IDLE_TIMEOUT_MS,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) throw new Error('Request aborted');

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(providerTimeoutMessage('Provider stream', timeoutMs)));
    }, timeoutMs);
    abortHandler = () => reject(new Error('Request aborted'));
    signal?.addEventListener('abort', abortHandler, { once: true });
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
  }
}

function shouldSendModel(model: string | undefined): model is string {
  return Boolean(model && model.trim() && model !== 'local-model');
}

function parseSseDataLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  return trimmed.slice(5).trimStart();
}

function applyLmOptiFields(body: Record<string, unknown>, options: LMStudioChatOptions): void {
  if (!options.lmOpti) return;

  // Qwen exposes thinking as a provider-specific extra body field. LM Studio
  // model cards expose the custom field as "Enable Thinking"; Qwen's
  // OpenAI-compatible docs use enable_thinking. Send both spellings only for
  // the explicit LM Opti mode so the normal compatibility path stays unchanged.
  body.enable_thinking = true;
  body.enableThinking = true;
}

function normalizeProviderBaseUrl(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '');
  return url.endsWith('/v1') ? url.slice(0, -3) : url;
}

export function getProviderHeaders(
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
  includeContentType = false,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) headers['Content-Type'] = 'application/json';
  if (apiProtocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }
  if (!apiKey) return headers;

  headers.Authorization = `Bearer ${apiKey}`;
  if (apiProtocol === 'anthropic') {
    // Native Anthropic expects x-api-key while Anthropic-compatible gateways
    // commonly use bearer auth. Sending both keeps the adapter useful for both.
    headers['x-api-key'] = apiKey;
  }
  return headers;
}

function formatApiError(status: number, rawText: string): string {
  const text = rawText.trim();
  if (!text) return `API error (${status}): Empty error response`;

  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === 'string'
      ? parsed.error
      : typeof parsed.error?.message === 'string'
      ? parsed.error.message
      : typeof parsed.message === 'string'
      ? parsed.message
      : '';
    if (message) return `API error (${status}): ${message}`;
  } catch {
    // Fall through to HTML/plain text formatting.
  }

  if (/^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) {
    const title = /<title>(.*?)<\/title>/is.exec(text)?.[1]?.trim();
    const pre = /<pre>(.*?)<\/pre>/is.exec(text)?.[1]?.trim();
    const message = (pre || title || 'HTML error page returned by LM Studio')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return `API error (${status}): ${message}`;
  }

  return `API error (${status}): ${text.slice(0, 1000)}`;
}

export async function listModels(
  baseUrl: string,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
): Promise<LMStudioModel[]> {
  const url = normalizeProviderBaseUrl(baseUrl);
  const headers = getProviderHeaders(apiKey, apiProtocol);
  if (apiProtocol === 'openai') {
    const restRes = await fetch(`${url}/api/v0/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (restRes?.ok) {
      const data = await restRes.json();
      if (Array.isArray(data.data)) return data.data;
    }
  }

  const res = await fetch(`${url}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
  const data = await res.json();
  return data.data || [];
}

export async function testConnection(
  baseUrl: string,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
): Promise<boolean> {
  try {
    const url = normalizeProviderBaseUrl(baseUrl);
    const res = await fetch(`${url}/v1/models`, {
      headers: getProviderHeaders(apiKey, apiProtocol),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};
type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicContentBlock[] };

function contentToPlainText(content: APIMessageContent | null): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => part.type === 'text' ? part.text : `[Image: ${part.image_url.url}]`)
    .join('\n');
}

function contentToAnthropicBlocks(content: APIMessageContent | null): AnthropicContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(part.image_url.url);
    if (dataUrl) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] },
      });
    } else {
      blocks.push({ type: 'text', text: `[Image URL: ${part.image_url.url}]` });
    }
  }
  return blocks;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function appendAnthropicMessage(messages: AnthropicMessage[], message: AnthropicMessage): void {
  if (message.content.length === 0) return;
  const previous = messages[messages.length - 1];
  if (previous?.role === message.role) {
    previous.content.push(...message.content);
  } else {
    messages.push(message);
  }
}

function toAnthropicMessages(options: LMStudioChatOptions): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = contentToPlainText(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id) continue;
      appendAnthropicMessage(messages, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: contentToPlainText(message.content),
        }],
      });
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = contentToAnthropicBlocks(message.content);
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const candidate = toolCall as {
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        if (typeof candidate.id !== 'string' || typeof candidate.function?.name !== 'string') continue;
        blocks.push({
          type: 'tool_use',
          id: candidate.id,
          name: candidate.function.name,
          input: parseToolArguments(candidate.function.arguments),
        });
      }
    }
    appendAnthropicMessage(messages, { role, content: blocks });
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages,
  };
}

function toAnthropicTools(tools: ToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function buildAnthropicBody(options: LMStudioChatOptions, stream: boolean): Record<string, unknown> {
  if (!shouldSendModel(options.model)) {
    throw new Error('Anthropic-compatible providers require an explicit model selection.');
  }

  const translated = toAnthropicMessages(options);
  const body: Record<string, unknown> = {
    model: options.model,
    messages: translated.messages,
    max_tokens: options.maxTokens ?? 30000,
    temperature: options.temperature ?? 0.7,
    top_p: options.topP ?? 0.9,
    stream,
  };
  if (translated.system) body.system = translated.system;

  const tools = options.tool_choice === 'none' ? undefined : toAnthropicTools(options.tools);
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = options.tool_choice === 'required' ? { type: 'any' } : { type: 'auto' };
  }
  return body;
}

async function anthropicChatCompletion(
  baseUrl: string,
  options: LMStudioChatOptions,
): Promise<LMStudioChatResponse> {
  const url = normalizeProviderBaseUrl(baseUrl);
  const res = await fetchWithProviderTimeout(`${url}/v1/messages`, {
    method: 'POST',
    headers: getProviderHeaders(options.apiKey, 'anthropic', true),
    body: JSON.stringify(buildAnthropicBody(options, false)),
    signal: options.signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(formatApiError(res.status, errText));
  }

  const data = await res.json();
  const blocks: Array<Record<string, unknown>> = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('');
  const reasoningContent = blocks
    .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => String(block.thinking))
    .join('');
  const toolCalls = blocks
    .filter((block) => block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string')
    .map((block) => ({
      id: String(block.id),
      name: String(block.name),
      arguments: JSON.stringify(block.input ?? {}),
    }));

  return {
    content: text,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    usage: data.usage ? {
      prompt_tokens: Number(data.usage.input_tokens || 0),
      completion_tokens: Number(data.usage.output_tokens || 0),
      total_tokens: Number(data.usage.input_tokens || 0) + Number(data.usage.output_tokens || 0),
    } : undefined,
    model: typeof data.model === 'string' ? data.model : options.model,
  };
}

export async function chatCompletion(
  baseUrl: string,
  options: LMStudioChatOptions
): Promise<LMStudioChatResponse> {
  if (options.apiProtocol === 'anthropic') {
    return anthropicChatCompletion(baseUrl, options);
  }

  const url = normalizeProviderBaseUrl(baseUrl);
  const body: Record<string, unknown> = {
    messages: options.messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 30000,
    top_p: options.topP ?? 0.9,
    stream: false,
  };
  if (options.topK !== undefined) body.top_k = options.topK;
  if (options.repeatPenalty !== undefined) body.repeat_penalty = options.repeatPenalty;
  applyLmOptiFields(body, options);
  
  // Use 'local-model' to refer to currently loaded model, or omit if empty
  if (shouldSendModel(options.model)) {
    body.model = options.model;
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || 'auto';
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`;

  const res = await fetchWithProviderTimeout(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(formatApiError(res.status, errText));
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No response from API');

  const result: LMStudioChatResponse = {
    content: choice.message?.content || '',
    reasoningContent: typeof choice.message?.reasoning_content === 'string' ? choice.message.reasoning_content : undefined,
    choices: data.choices,
    usage: data.usage,
    model: data.model,
  };

  if (choice.message?.tool_calls?.length > 0) {
    result.toolCalls = choice.message.tool_calls.map(
      (tc: { id: string; function: { name: string; arguments: unknown } }) => {
        const args = tc.function.arguments;
        const argString = typeof args === 'string'
          ? (args.trim() === '' ? '{}' : args)
          : JSON.stringify(args ?? {});
        return {
          id: tc.id,
          name: tc.function.name,
          arguments: argString,
        };
      }
    );
  }

  return result;
}

export async function* streamChatCompletion(
  baseUrl: string,
  options: LMStudioChatOptions
): AsyncGenerator<LMStudioStreamEvent> {
  if (options.apiProtocol === 'anthropic') {
    yield* streamAnthropicChatCompletion(baseUrl, options);
    return;
  }

  const url = normalizeProviderBaseUrl(baseUrl);
  const body: Record<string, unknown> = {
    messages: options.messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 30000,
    top_p: options.topP ?? 0.9,
    stream: true,
  };
  if (options.topK !== undefined) body.top_k = options.topK;
  if (options.repeatPenalty !== undefined) body.repeat_penalty = options.repeatPenalty;
  applyLmOptiFields(body, options);
  
  // Use provided model or omit to use currently loaded model
  if (shouldSendModel(options.model)) {
    body.model = options.model;
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice || 'auto';
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`;

  let res: Response;
  try {
    res = await fetchWithProviderTimeout(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
    return;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    yield { type: 'error', error: formatApiError(res.status, errText) };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: 'error', error: 'No response body' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  // Accumulate tool-call deltas keyed by index. OpenAI streams send `index` on every
  // chunk and `id`/`name` only on the first chunk per call; previously we keyed by id
  // which caused later tool calls' args to bleed into earlier ones.
  type AccumulatedToolCall = { id: string | null; name: string | null; args: string };
  const toolCallAcc = new Map<number, AccumulatedToolCall>();
  let streamDone = false;

  try {
    outer: while (true) {
      const { done, value } = await readStreamChunkWithIdleTimeout(reader, options.signal);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const sseData = parseSseDataLine(trimmed);
        if (sseData === '[DONE]') {
          streamDone = true;
          break outer;
        }
        if (sseData === undefined) continue;

        try {
          const json = JSON.parse(sseData);
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: 'content', content: delta.content };
          }

          if (delta.reasoning_content) {
            yield { type: 'reasoning_content', reasoningContent: delta.reasoning_content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              let acc = toolCallAcc.get(idx);
              if (!acc) {
                acc = { id: null, name: null, args: '' };
                toolCallAcc.set(idx, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function && 'arguments' in tc.function) {
                const argDelta = tc.function.arguments;
                if (typeof argDelta === 'string') {
                  acc.args += argDelta;
                } else if (argDelta !== undefined && argDelta !== null) {
                  // Some servers (and non-streaming responses surfaced as a single
                  // delta) send `arguments` as a complete object rather than a
                  // string chunk. Treat it as the full payload and replace any
                  // accumulated string so we don't produce `"{}{\"foo\":1}"`.
                  acc.args = JSON.stringify(argDelta);
                }
              }
            }
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }

    // Emit completed tool calls in index order.
    const indices = Array.from(toolCallAcc.keys()).sort((a, b) => a - b);
    for (const idx of indices) {
      const acc = toolCallAcc.get(idx)!;
      if (acc.id && acc.name) {
        yield {
          type: 'tool_call',
          toolCallId: acc.id,
          toolName: acc.name,
          toolArguments: acc.args,
        };
      }
    }
    if (streamDone) yield { type: 'done' };
  } catch (err) {
    yield { type: 'error', error: `Stream error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

async function* streamAnthropicChatCompletion(
  baseUrl: string,
  options: LMStudioChatOptions,
): AsyncGenerator<LMStudioStreamEvent> {
  const url = normalizeProviderBaseUrl(baseUrl);
  let body: Record<string, unknown>;
  try {
    body = buildAnthropicBody(options, true);
  } catch (error) {
    yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
    return;
  }

  let res: Response;
  try {
    res = await fetchWithProviderTimeout(`${url}/v1/messages`, {
      method: 'POST',
      headers: getProviderHeaders(options.apiKey, 'anthropic', true),
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
    return;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    yield { type: 'error', error: formatApiError(res.status, errText) };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: 'error', error: 'No response body' };
    return;
  }

  type AnthropicToolAccumulator = {
    id: string;
    name: string;
    initialInput: Record<string, unknown>;
    json: string;
  };
  const tools = new Map<number, AnthropicToolAccumulator>();
  const decoder = new TextDecoder();
  let buffer = '';
  let emittedDone = false;

  try {
    outer: while (true) {
      const { done, value } = await readStreamChunkWithIdleTimeout(reader, options.signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('event:')) continue;
        const sseData = parseSseDataLine(trimmed);
        if (sseData === '[DONE]') break outer;
        if (sseData === undefined) continue;

        try {
          const json = JSON.parse(sseData) as {
            type?: string;
            index?: number;
            content_block?: Record<string, unknown>;
            delta?: Record<string, unknown>;
            error?: { message?: string };
          };
          if (json.type === 'error') {
            yield { type: 'error', error: json.error?.message || 'Anthropic-compatible stream error' };
            return;
          }
          if (json.type === 'content_block_start' && typeof json.index === 'number') {
            const block = json.content_block;
            if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
              tools.set(json.index, {
                id: block.id,
                name: block.name,
                initialInput: parseToolArguments(block.input),
                json: '',
              });
            }
          }
          if (json.type === 'content_block_delta') {
            const delta = json.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              yield { type: 'content', content: delta.text };
            }
            if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              yield { type: 'reasoning_content', reasoningContent: delta.thinking };
            }
            if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && typeof json.index === 'number') {
              const tool = tools.get(json.index);
              if (tool) tool.json += delta.partial_json;
            }
          }
          if (json.type === 'message_stop') {
            emittedDone = true;
            break outer;
          }
        } catch {
          // Skip malformed provider chunks and continue consuming the stream.
        }
      }
    }

    for (const index of Array.from(tools.keys()).sort((a, b) => a - b)) {
      const tool = tools.get(index)!;
      yield {
        type: 'tool_call',
        toolCallId: tool.id,
        toolName: tool.name,
        toolArguments: tool.json || JSON.stringify(tool.initialInput),
      };
    }
    if (emittedDone) yield { type: 'done' };
  } catch (error) {
    yield { type: 'error', error: `Stream error: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}
