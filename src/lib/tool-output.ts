export const LOCAL_TOOL_RESULT_REPLAY_CHARS = 80_000;
export const CLOUD_TOOL_RESULT_REPLAY_CHARS = 12_000;
export const LOCAL_SEARCH_RESULT_LIMIT = 100;
export const CLOUD_SEARCH_RESULT_LIMIT = 60;
export const LOCAL_DIRECTORY_RESULT_LIMIT = 160;
export const CLOUD_DIRECTORY_RESULT_LIMIT = 80;

type ReplayableToolResult = {
  success: boolean;
  result?: string;
  error?: string;
};

function headAtNaturalBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const newline = value.lastIndexOf('\n', maxChars);
  if (newline >= Math.floor(maxChars * 0.55)) return value.slice(0, newline);
  const whitespace = value.lastIndexOf(' ', maxChars);
  return value.slice(0, whitespace >= Math.floor(maxChars * 0.7) ? whitespace : maxChars);
}

export function tailAtNaturalBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const start = value.length - maxChars;
  const newline = value.indexOf('\n', start);
  if (newline !== -1 && newline <= start + Math.floor(maxChars * 0.45)) return value.slice(newline + 1);
  const whitespace = value.indexOf(' ', start);
  return value.slice(whitespace !== -1 && whitespace <= start + Math.floor(maxChars * 0.3) ? whitespace + 1 : start);
}

export function trimTextForReplay(value: string, maxChars: number, label = 'content'): string {
  if (value.length <= maxChars) return value;
  const markerBudget = Math.min(240, Math.max(120, Math.floor(maxChars * 0.08)));
  const contentBudget = Math.max(0, maxChars - markerBudget);
  const head = headAtNaturalBoundary(value, Math.floor(contentBudget * 0.65));
  const tail = tailAtNaturalBoundary(value, Math.max(0, contentBudget - head.length));
  const omitted = Math.max(0, value.length - head.length - tail.length);
  const marker = `\n\n[${label} trimmed for model replay: ${omitted} characters omitted. The preserved sections end and begin at natural boundaries where possible. Narrow the next search or read request.]\n\n`;
  if (head.length + marker.length + tail.length <= maxChars) return `${head}${marker}${tail}`;
  const adjustedTail = tailAtNaturalBoundary(tail, Math.max(0, maxChars - head.length - marker.length));
  return `${head}${marker}${adjustedTail}`.slice(0, maxChars);
}

export function clampResultLimit(
  value: unknown,
  defaultLimit: number,
  maximumLimit: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultLimit;
  return Math.min(Math.floor(parsed), maximumLimit);
}

export function formatLineResultWindow(
  lines: string[],
  options: {
    label: string;
    maxItems: number;
    offset?: number;
    continuation: string;
    knownTotal?: number;
  },
): string {
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const selected = lines.slice(offset, offset + options.maxItems);
  if (selected.length === 0) return lines.length === 0 ? `(no ${options.label} found)` : `(no ${options.label} at offset ${offset})`;
  const knownTotal = options.knownTotal ?? lines.length;
  const hasMore = knownTotal > offset + selected.length;
  if (!hasMore) return selected.join('\n');
  return [
    selected.join('\n'),
    '',
    `[Showing ${options.label} ${offset + 1}-${offset + selected.length}${options.knownTotal !== undefined ? ` of ${knownTotal}` : ''}. ${options.continuation}]`,
  ].join('\n');
}

export function trimToolResultForReplay<T extends ReplayableToolResult>(
  result: T,
  maxChars = LOCAL_TOOL_RESULT_REPLAY_CHARS,
): T {
  if (result.success) {
    return {
      ...result,
      result: trimTextForReplay(String(result.result || ''), maxChars, 'tool result'),
    };
  }
  return {
    ...result,
    error: trimTextForReplay(String(result.error || ''), maxChars, 'tool error'),
  };
}
