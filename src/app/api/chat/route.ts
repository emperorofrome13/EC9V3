import { NextRequest, NextResponse } from 'next/server';
import { streamChatCompletion, chatCompletion } from '@/lib/lmstudio';
import { TOOL_DEFINITIONS, TOOL_MAX_ITERATIONS } from '@/lib/tools';
import { buildSkillPrompt } from '@/skills/registry';
import {
  dispatchSubAgents,
  appendWorklog,
} from '@/lib/agents/registry';
import { loadPrompt } from '@/lib/prompts';
import { QUALITY_GATES, TODO_DISCIPLINE_PROTOCOL, type ExecutionPlan, type PlanTask } from '@/lib/planning';
import { TaskStore, type TaskRow, type TaskStatus } from '@/lib/task-store';
import { ConversationStore } from '@/lib/conversation-store';
import { estimateTextTokens, getLoadedModelContextLimit } from '@/lib/context-window';
import { chunkFileForContext, type FileChunkOptions } from '@/lib/file-chunking';
import {
  CLOUD_HISTORY_MESSAGE_LIMIT,
  CLOUD_STATE_RELATIVE_PATH,
  CLOUD_TRANSCRIPT_CHARS,
  formatCloudStateForPrompt,
  readCloudState,
  writeCloudState,
} from '@/lib/cloud-mode';
import {
  CLOUD_DIRECTORY_RESULT_LIMIT,
  CLOUD_SEARCH_RESULT_LIMIT,
  CLOUD_TOOL_RESULT_REPLAY_CHARS,
  LOCAL_DIRECTORY_RESULT_LIMIT,
  LOCAL_SEARCH_RESULT_LIMIT,
  LOCAL_TOOL_RESULT_REPLAY_CHARS,
  clampResultLimit,
  formatLineResultWindow,
  tailAtNaturalBoundary,
  trimToolResultForReplay,
} from '@/lib/tool-output';
import {
  extractAutoPromptVerdictFromLines as extractAutoPromptVerdictStrict,
} from '@/lib/autoprompt-verdict';
import { resolveProviderApiProtocol } from '@/lib/provider-protocol';
import {
  applyEditFileArgs,
  applyMultiEditArgs,
  editLoopRewriteBlockedError,
  formatReadFileContent,
  hasReadFile,
  isEditLoopLocked,
  lockEditLoopForPath,
  isSourceLikeFilePath,
  markFileRead,
  readBeforeEditError,
  recordEditLoopOutcome,
  resetEditLoopForPath,
  shellCommandWouldDeleteTrackedSourceFile,
  shellCommandLooksLikeWholeFileRewrite,
  shellCommandWouldRewriteLockedFile,
  sourceSyntaxExtension,
  type EditLoopState,
} from '@/lib/file-editing';
import type {
  Agent,
  APIMessageContent,
  AutoPromptAction,
  AutoPromptIssue,
  AutoPromptStage,
  AutoPromptStageResult,
  AutoPromptStructuredResult,
  AutoPromptStructuredVerdict,
  AutoPromptVerification,
  ChatMessage,
  ModelApiProtocol,
  ToolCall,
} from '@/types/ec9v3';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

const shellExecOptions = process.platform === 'win32' ? { shell: 'powershell.exe' } : {};

function normalizeWindowsShellCommand(command: string): string {
  if (process.platform !== 'win32') return command;
  return command
    .replace(/(^|[;&|]\s*)(npm|npx|pnpm|yarn)(?=\s)/gi, (_match, prefix: string, bin: string) => `${prefix}${bin}.cmd`)
    .replace(/(^|[;&|]\s*)(npm|npx|pnpm|yarn)$/gi, (_match, prefix: string, bin: string) => `${prefix}${bin}.cmd`);
}

async function execShellCommand(command: string, options: { cwd: string; timeout: number; maxBuffer: number }) {
  const normalizedCommand = normalizeWindowsShellCommand(command);
  const nodePath = [path.join(process.cwd(), 'node_modules'), process.env.NODE_PATH]
    .filter(Boolean)
    .join(path.delimiter);
  const execOptions = {
    ...options,
    env: { ...process.env, NODE_PATH: nodePath },
  };
  if (process.platform !== 'win32') {
    return execAsync(normalizedCommand, execOptions);
  }
  try {
    return await execAsync(normalizedCommand, { ...execOptions, shell: 'powershell.exe' });
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    if (/InvalidEndOfLine|not a valid statement separator|The token '&&'/i.test(output)) {
      return execAsync(normalizedCommand, { ...execOptions, shell: 'cmd.exe' });
    }
    throw error;
  }
}

function isNodeSyntaxCheckable(filePath: string): boolean {
  return Boolean(sourceSyntaxExtension(filePath));
}

const BINARY_FILE_EXTENSIONS = new Set([
  '.db', '.sqlite', '.sqlite3', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.exe', '.dll', '.bin', '.wasm',
]);

async function shouldBlockTextRead(filePath: string): Promise<boolean> {
  if (BINARY_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function validateSourceBeforeWrite(filePath: string, content: string): Promise<string | undefined> {
  if (!isNodeSyntaxCheckable(filePath)) return undefined;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ec9v3-jscheck-'));
  const tempPath = path.join(tempDir, `candidate${sourceSyntaxExtension(filePath) || '.js'}`);
  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await execFileAsync(process.execPath, ['--check', tempPath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return undefined;
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
    return `JavaScript syntax check failed for ${path.basename(filePath)}. The edit was not written. Fix the proposed content and retry.\n${output}`;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function globToRegex(pattern: string): RegExp {
  // First escape all regex special characters except * and ?
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Then convert glob wildcards to regex
  const regexPattern = escaped
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`);
}

function expandGlobBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match || match.index === undefined) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => expandGlobBraces(`${before}${part}${after}`));
}

function globPatternVariants(pattern: string): string[] {
  const variants = expandGlobBraces(pattern).flatMap((expanded) => (
    expanded.startsWith('**/') ? [expanded, expanded.slice(3)] : [expanded]
  ));
  return Array.from(new Set(variants));
}

function getWorkingDir(requestedWd?: string): string {
  if (!requestedWd) return process.env.WORKING_DIRECTORY || process.cwd();
  return path.isAbsolute(requestedWd) ? requestedWd : path.resolve(process.cwd(), requestedWd);
}

function safePath(base: string, relative: string): string {
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.includes('..')) throw new Error('Path traversal denied: ".." is not allowed');
  const resolved = path.resolve(base, normalized);
  const baseResolved = path.resolve(base);
  const relativeToBase = path.relative(baseResolved, resolved);
  if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
    throw new Error('Path traversal denied');
  }
  return resolved;
}

function formatRecoverableToolError(name: string, args: Record<string, unknown>, error: unknown): string {
  const err = error as { code?: string; path?: string; syscall?: string; message?: string };
  const requestedPath = args.path ?? args.file_path ?? args.working_directory;
  const requested = requestedPath ? ` Requested path: ${String(requestedPath)}.` : '';
  const resolved = err.path ? ` Resolved path: ${err.path}.` : '';

  if (err.code === 'ENOENT') {
    return `${name} failed: path not found.${requested}${resolved} List the parent directory or correct the path, then retry.`;
  }
  if (err.code === 'ENOTDIR') {
    return `${name} failed: part of the path is not a directory.${requested}${resolved}`;
  }
  if (err.code === 'EISDIR') {
    return `${name} failed: expected a file but found a directory.${requested}${resolved}`;
  }

  return `${name} failed: ${err.message || String(error)}`;
}

const DANGEROUS_PATTERNS = [
  /rm\s+(-[rfRF]+\s+)*\//, // rm -rf /anything
  /rm\s+(-[rfRF]+\s+)*~/, // rm -rf ~
  /rm\s+(-[rfRF]+\s+)+/, // rm -rf (with flags and space)
  /sudo\s/i,
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\//,
  /chmod\s+\d+/, // chmod 777
  /chmod\s+[-rwx]*[rwx]{3}/, // chmod +rwx
  /curl.*\|\s*(ba)?sh/i,
  /wget.*\|\s*(ba)?sh/i,
  /\|\s*(ba)?sh\s*$/, // pipe to shell at end
  /\$\(/, // command substitution $(...)
  /`[^`]+`/, // backtick command substitution
];

const MAX_TODO_STORE_SIZE = 100;
const MAX_TRANSCRIPT_CHARS = 240_000;
const MAX_COMPACTION_SOURCE_CHARS = 240_000;
const BAD_TOOL_CALL_FLUSH_THRESHOLD = 4;
const TOOL_USAGE_GUIDANCE = [
  '## Tool Usage Guidance',
  'The shell_command tool runs in PowerShell on Windows. Use PowerShell commands such as Get-ChildItem, Get-Content, Select-Object, Select-String, Test-Path, and Start-Process.',
  'Avoid Unix-only commands and redirection patterns such as cat > file, head, tail, timeout, heredocs, and bare grep unless you have verified they exist in this environment.',
  'For existing files, read_file first. If exact edit_file matching fails, call read_file with numbered:true and use edit_file replace_range/start_line/end_line/new_text.',
  'Do not recover from edit failures by deleting, recreating, or shell-overwriting existing source files.',
].join('\n');
type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'removed';
type TodoMode = 'FREEFORM' | 'PROTOCOL';
type TodoPhase = 'DECLARE' | 'EXECUTE' | 'RESOLVE';
type TodoItem = { id: string; content: string; status: TodoStatus; priority: string };
type ToolEvidence = { name: string; success: boolean; summary: string };
type ToolCallPlan = { name: string; args: Record<string, unknown> };
type ToolValidation = { allowed: true; reminder?: string } | { allowed: false; error: string };
type ToolResult = { success: boolean; result?: string; error?: string };
const todoProtocols = new Map<string, TodoProtocol>();

type ApiMessage = { role: string; content: APIMessageContent | null; tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string };

function validAgent(value: unknown): Agent {
  return value === 'cpp_expert' ||
    value === 'python_ml' ||
    value === 'full-stack-developer' ||
    value === 'frontend-styling-expert'
    ? value
    : 'general';
}

const AGENT_PROMPT_PATHS: Record<string, string> = {
  general: 'agents/general.md',
  cpp_expert: 'agents/cpp_expert.md',
  python_ml: 'agents/python_ml.md',
  'full-stack-developer': 'agents/full-stack-developer.md',
  'frontend-styling-expert': 'agents/frontend-styling-expert.md',
};

async function loadAgentSystemPrompt(agent?: string, fallbackPrompt = ''): Promise<string> {
  const promptPath = AGENT_PROMPT_PATHS[agent || 'general'] || AGENT_PROMPT_PATHS.general;
  const prompt = await loadPrompt(promptPath);
  if (prompt) return prompt;
  if (promptPath !== AGENT_PROMPT_PATHS.general) {
    const generalPrompt = await loadPrompt(AGENT_PROMPT_PATHS.general);
    if (generalPrompt) return generalPrompt;
  }
  return fallbackPrompt;
}

interface AutoCompactionOptions {
  enabled?: boolean;
  limitType?: 'percent' | 'tokens';
  percent?: number;
  tokens?: number;
  fallbackContextTokens?: number;
}

interface ContextOverloadProtectionOptions {
  enabled?: boolean;
}

function createStreamingErrorResponse(message: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', finalContent: '' })}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function cleanupTodoStore() {
  if (todoProtocols.size > MAX_TODO_STORE_SIZE) {
    const keys = Array.from(todoProtocols.keys());
    for (let i = 0; i < keys.length - MAX_TODO_STORE_SIZE; i++) {
      todoProtocols.get(keys[i])?.close();
      todoProtocols.delete(keys[i]);
    }
  }
}

function normalizeTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((t, index) => {
    const todo = t as { id?: string; content?: string; status?: string; priority?: string };
    const status = todo.status === 'completed' || todo.status === 'in_progress' || todo.status === 'pending' || todo.status === 'removed'
      ? todo.status
      : 'pending';
    return {
      id: String(todo.id || `todo-${index + 1}`),
      content: String(todo.content || ''),
      status,
      priority: String(todo.priority || 'medium'),
    };
  });
}

function todoProtocolKey(conversationId?: string, projectId?: string): string {
  return `${projectId || 'default'}:${conversationId || 'default'}`;
}

function getTodos(conversationId?: string, projectId?: string): TodoItem[] {
  if (!conversationId) return [];
  return todoProtocols.get(todoProtocolKey(conversationId, projectId))?.todos || [];
}

function getTodoProtocol(conversationId?: string, projectId?: string, workingDirectory?: string): TodoProtocol {
  const key = todoProtocolKey(conversationId, projectId);
  let protocol = todoProtocols.get(key);
  if (!protocol) {
    protocol = new TodoProtocol(conversationId || 'default', projectId || 'default', workingDirectory || process.cwd());
    todoProtocols.set(key, protocol);
    cleanupTodoStore();
  }
  return protocol;
}

function resetConversationTodos(conversationId?: string, projectId?: string) {
  if (!conversationId) return;
  const key = todoProtocolKey(conversationId, projectId);
  todoProtocols.get(key)?.close();
  todoProtocols.delete(key);
}

function areTodosComplete(todos: TodoItem[]): boolean {
  return todos.length > 0 && todos.every((todo) => todo.status === 'completed' || todo.status === 'removed');
}

function messageContentToText(content: APIMessageContent | null | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image_url') return '[attached image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function apiContentForChatMessage(msg: ChatMessage): APIMessageContent | null {
  const text = msg.content ?? '';
  if (msg.role !== 'user' || !msg.attachments?.length) return text;

  const imageParts = msg.attachments
    .filter((attachment) => attachment.dataUrl && attachment.mimeType?.startsWith('image/'))
    .map((attachment) => ({
      type: 'image_url' as const,
      image_url: { url: attachment.dataUrl, detail: 'auto' as const },
    }));

  if (imageParts.length === 0) return text;
  return [
    { type: 'text' as const, text: withVisualInstruction(text || 'Please analyze the attached image.') },
    ...imageParts,
  ];
}

function withVisualInstruction(text: string): string {
  const instruction = 'Image attachment(s) are included in this message as vision input. Analyze the image pixels directly; do not say you cannot view images.';
  return text.includes('Image attachment(s) are included in this message as vision input.')
    ? text
    : `${instruction}\n\n${text}`;
}

function contentWithVisualInstruction(content: APIMessageContent | null): APIMessageContent | null {
  if (!Array.isArray(content) || !contentHasImage(content)) return content;
  let added = false;
  const next = content.map((part) => {
    if (part.type !== 'text' || added) return part;
    added = true;
    return { ...part, text: withVisualInstruction(part.text || 'Please analyze the attached image.') };
  });
  if (!added) {
    return [
      { type: 'text' as const, text: withVisualInstruction('Please analyze the attached image.') },
      ...next,
    ];
  }
  return next;
}

function toolAllowsEmptyArgs(name: string): boolean {
  return name === 'list_directory';
}

function toolCallArgumentsForReplay(toolCall: ToolCall): string | null {
  if (typeof toolCall.arguments === 'string') {
    const trimmed = toolCall.arguments.trim();
    if (!trimmed || trimmed.startsWith('[Large payload omitted')) return null;
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return null;
    }
  }

  if (!toolCall.arguments || typeof toolCall.arguments !== 'object' || Array.isArray(toolCall.arguments)) {
    return null;
  }

  const emptyArgs = Object.keys(toolCall.arguments).length === 0;
  if (emptyArgs && !toolAllowsEmptyArgs(toolCall.name)) return null;
  return JSON.stringify(toolCall.arguments);
}

function summarizeHistoricalToolCalls(toolCalls?: ToolCall[]): string {
  if (!toolCalls?.length) return '';
  const relevant = toolCalls.filter((toolCall) =>
    toolCall.status === 'completed' ||
    toolCall.status === 'error' ||
    toolCall.result !== undefined
  );
  if (relevant.length === 0) return '';

  const recent = relevant.slice(-12);
  const lines = recent.map((toolCall) => {
    const status = toolCall.isError || toolCall.status === 'error' ? 'error' : 'ok';
    const args = typeof toolCall.arguments === 'string'
      ? toolCall.arguments.startsWith('[Large payload omitted')
        ? '[large arguments omitted]'
        : truncateMiddle(toolCall.arguments, 300, 'tool arguments')
      : JSON.stringify(toolCall.arguments ?? {});
    const result = toolCall.result
      ? truncateMiddle(String(toolCall.result), 500, 'tool result')
      : '';
    return `- ${toolCall.name} (${status}) args=${args}${result ? ` result=${result}` : ''}`;
  });

  const omitted = relevant.length > recent.length
    ? `\n- ${relevant.length - recent.length} older tool call(s) omitted from replay.`
    : '';
  return `\n\nHistorical tool activity summary (not active tool calls):\n${lines.join('\n')}${omitted}`;
}

function contentHasImage(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => {
    const candidate = part as { type?: unknown; image_url?: unknown };
    return candidate.type === 'image_url' && Boolean(candidate.image_url);
  });
}

function chatMessageHasImage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as { attachments?: unknown; content?: unknown };
  if (contentHasImage(candidate.content)) return true;
  return Array.isArray(candidate.attachments) && candidate.attachments.some((attachment) => {
    const item = attachment as { dataUrl?: unknown; mimeType?: unknown };
    return typeof item.dataUrl === 'string' &&
      (typeof item.mimeType !== 'string' || item.mimeType.startsWith('image/'));
  });
}

function chatMessagesToApiMessages(chatMessages: ChatMessage[]): ApiMessage[] {
  const apiMessages: ApiMessage[] = [];
  for (const msg of chatMessages) {
    if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') continue;
    const historicalToolSummary = msg.role === 'assistant'
      ? summarizeHistoricalToolCalls(msg.toolCalls)
      : '';
    const content = apiContentForChatMessage(msg);
    apiMessages.push({
      role: msg.role,
      content: typeof content === 'string'
        ? `${content}${historicalToolSummary}`
        : content,
    });
  }
  return apiMessages;
}

function summarizeEvidence(evidence: ToolEvidence[]): string {
  if (evidence.length === 0) return 'No tool evidence since the last TODO update.';
  return evidence
    .slice(-6)
    .map((item) => `${item.success ? 'success' : 'failed'}:${item.name} - ${item.summary.slice(0, 180)}`)
    .join('\n');
}

function truncateMiddle(value: string, maxChars: number, label = 'content'): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head);
  return [
    value.slice(0, head),
    `\n\n[${label} truncated: ${value.length - maxChars} characters omitted]\n\n`,
    value.slice(value.length - tail),
  ].join('');
}

function appendBounded(base: string, addition: string, maxChars: number): string {
  const combined = `${base}${base ? '\n\n' : ''}${addition}`;
  return tailAtNaturalBoundary(combined, maxChars);
}

function findLastUserMessageIndex(messages: ApiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return messages.length - 1;
}

function flushMessagesAfterAnchor(messages: ApiMessage[], anchorIndex: number): void {
  messages.splice(Math.max(0, anchorIndex + 1));
}

function buildToolRecoveryFlushPrompt(workingDir: string, todos?: TodoItem[]): string {
  const todoSummary = todos?.length
    ? `\nCurrent TODO state:\n${JSON.stringify(todos, null, 2)}`
    : '';
  return [
    'TOOL CALL STATE FLUSHED:',
    'Tool-call state was flushed after repeated invalid tool calls.',
    'Continue from the known working directory using complete JSON arguments, or answer without tools if no tool is required.',
    `Known working directory: ${workingDir}`,
    todoSummary,
  ].filter(Boolean).join('\n');
}

async function searchFilesFallback(
  workingDir: string,
  searchPath: string,
  pattern: string,
  globPattern?: string,
  caseInsensitive = false,
  maxResults = 100,
): Promise<string> {
  const flags = caseInsensitive ? 'i' : '';
  const regex = new RegExp(pattern, flags);
  const patternVariants = globPattern ? globPatternVariants(globPattern) : undefined;
  const globRegexes = patternVariants?.map((variant) => globToRegex(variant));
  const excludeDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.ec9v3', '.ec9v3-context-chunks']);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(workingDir, fullPath).replace(/\\/g, '/');
      if (globRegexes && !globRegexes.some((regex) => regex.test(relativePath) || regex.test(entry.name))) continue;
      let content = '';
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          results.push(`${relativePath}:${i + 1}:${lines[i]}`);
          if (results.length >= maxResults) break;
        }
      }
    }
  }

  const stat = await fs.stat(searchPath);
  if (stat.isFile()) {
    let content = '';
    try {
      content = await fs.readFile(searchPath, 'utf-8');
    } catch {
      return '(no matches found)';
    }
    const relativePath = path.relative(workingDir, searchPath).replace(/\\/g, '/');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) results.push(`${relativePath}:${i + 1}:${lines[i]}`);
    }
  } else {
    await walk(searchPath);
  }
  return results.join('\n') || '(no matches found)';
}

function compactToolResultForMemory(
  result: ToolResult,
  maxChars = LOCAL_TOOL_RESULT_REPLAY_CHARS,
): ToolResult {
  return trimToolResultForReplay(result, maxChars);
}

class TodoProtocol {
  readonly conversationId: string;
  readonly projectId: string;
  readonly workingDirectory: string;
  mode: TodoMode = 'FREEFORM';
  phase: TodoPhase = 'DECLARE';
  todos: TodoItem[] = [];
  private readonly store: TaskStore;
  private evidence: ToolEvidence[] = [];
  private responseHasTodo = false;
  private responseHasNonTodo = false;
  private responseRecordedNonTodoEvidence = false;

  constructor(conversationId: string, projectId: string, workingDirectory: string) {
    this.conversationId = conversationId;
    this.projectId = projectId;
    this.workingDirectory = workingDirectory;
    this.store = new TaskStore(workingDirectory);
    this.store.upsertProject({
      id: projectId,
      name: path.basename(workingDirectory) || projectId,
      workingDirectory,
    });
  }

  beginResponse(calls: ToolCallPlan[]) {
    this.responseHasTodo = calls.some((call) => call.name === 'todo');
    this.responseHasNonTodo = calls.some((call) => call.name !== 'todo');
    this.responseRecordedNonTodoEvidence = false;
  }

  validate_tool_call(toolName: string, args: Record<string, unknown>): ToolValidation {
    const isTodo = toolName === 'todo';
    const isTodoWrite = isTodo && args.action === 'write';

    if (this.mode === 'FREEFORM') {
      if (this.responseHasTodo && this.responseHasNonTodo) {
        return {
          allowed: false,
          error: 'NEVER mix todo.write and other tools in the same response. The server will reject it.',
        };
      }
      const hasActivePlan = this.todos.some((todo) => todo.status === 'in_progress');
      if (!isTodoWrite && !hasActivePlan) {
        return {
          allowed: false,
          error: 'Structured Planning is enabled. Call todo.write first to create a plan and set a step to in_progress.',
        };
      }
      return { allowed: true };
    }

    if (this.responseHasTodo && this.responseHasNonTodo) {
      return {
        allowed: true,
        reminder: 'Structured Planning reminder: keep todo.write and other tools in separate responses when possible so plan state stays fresh.',
      };
    }

    if (this.phase === 'DECLARE' && !isTodoWrite) {
      return { allowed: true, reminder: 'Structured Planning reminder: the current phase is DECLARE. Update todo.write to set the active step before tool work when possible.' };
    }

    if (this.phase === 'EXECUTE' && isTodo) {
      return { allowed: true, reminder: 'Structured Planning reminder: the current phase is EXECUTE. Prefer finishing tool calls first, then update TODO state in the next response.' };
    }

    if (this.phase === 'RESOLVE' && !isTodoWrite) {
      return { allowed: true, reminder: 'Structured Planning reminder: the current phase is RESOLVE. Update TODO state soon so the visible plan matches the work.' };
    }

    if (isTodoWrite) {
      const nextTodos = normalizeTodos(args.todos);
      const validation = this.validateTodoWrite(nextTodos);
      if (!validation.allowed) return validation;
    }

    return { allowed: true };
  }

  applyTodoWrite(args: Record<string, unknown>): ToolResult {
    const nextTodos = normalizeTodos(args.todos);
    const validation = this.validateTodoWrite(nextTodos);
    if (!validation.allowed) return { success: false, error: validation.error };

    const previousMode = this.mode;
    const previousById = new Map(this.todos.map((todo) => [todo.id, todo]));
    const newlyCompleted = nextTodos.filter(
      (todo) => todo.status === 'completed' && previousById.get(todo.id)?.status !== 'completed',
    );
    this.todos = nextTodos;
    this.persistTodos(nextTodos, previousById);
    const openCount = this.openStepCount(nextTodos);

    if (this.mode === 'FREEFORM' && openCount >= 1) {
      this.mode = 'PROTOCOL';
      this.phase = 'DECLARE';
    }

    if (this.mode === 'PROTOCOL') {
      if (areTodosComplete(nextTodos)) {
        this.mode = 'FREEFORM';
        this.phase = 'DECLARE';
        this.evidence = [];
      } else if (this.phase === 'RESOLVE' && newlyCompleted.length > 0) {
        this.phase = nextTodos.some((todo) => todo.status === 'in_progress') ? 'EXECUTE' : 'DECLARE';
        this.evidence = [];
      } else if (nextTodos.some((todo) => todo.status === 'in_progress')) {
        this.phase = 'EXECUTE';
      }
    }

    const modeChange = previousMode !== this.mode ? ` Mode: ${previousMode} -> ${this.mode}.` : ` Mode: ${this.mode}.`;
    return {
      success: true,
      result: `Updated ${nextTodos.length} conversation-scoped task(s).${modeChange} Phase: ${this.phase}.\n${summarizeEvidence(this.evidence)}`,
    };
  }

  record_tool_result(toolName: string, result: ToolResult) {
    if (toolName === 'todo') return;
    if (this.mode !== 'PROTOCOL') return;
    this.evidence.push({
      name: toolName,
      success: result.success,
      summary: result.success ? String(result.result || '') : String(result.error || ''),
    });
    this.responseRecordedNonTodoEvidence = true;
  }

  finishResponse() {
    if (this.mode === 'PROTOCOL' && this.phase === 'EXECUTE' && this.responseRecordedNonTodoEvidence) {
      this.phase = 'RESOLVE';
    }
  }

  forceResolveAfterMaxIterations() {
    if (this.mode === 'PROTOCOL' && this.phase === 'EXECUTE') {
      this.phase = 'RESOLVE';
    }
  }

  close() {
    this.store.close();
  }

  private openStepCount(todos: TodoItem[]): number {
    return todos.filter((todo) => todo.status !== 'completed' && todo.status !== 'removed').length;
  }

  private validateTodoWrite(nextTodos: TodoItem[]): ToolValidation {
    if (nextTodos.length === 0) return { allowed: true };
    const empty = nextTodos.find((todo) => !todo.id || !todo.content.trim());
    if (empty) return { allowed: false, error: 'Every TODO item must have a stable id and non-empty content.' };

    const openCount = this.openStepCount(nextTodos);
    if (this.mode === 'FREEFORM' && openCount < 1) {
      return nextTodos.length === 0
        ? { allowed: true }
        : { allowed: false, error: 'Structured Planning requires at least one non-completed step set to in_progress before work starts.' };
    }

    const activeCount = nextTodos.filter((todo) => todo.status === 'in_progress').length;
    const previousById = new Map(this.todos.map((todo) => [todo.id, todo]));
    const newlyCompleted = nextTodos.filter(
      (todo) => todo.status === 'completed' && previousById.get(todo.id)?.status !== 'completed',
    );
    const resolvingCompletedStep = this.mode === 'PROTOCOL' && this.phase === 'RESOLVE' && newlyCompleted.length > 0;
    if (!areTodosComplete(nextTodos)) {
      if (activeCount !== 1) {
        return { allowed: false, error: 'TODO state must have exactly one in_progress item unless every item is completed or removed.' };
      }
    }

    if (this.mode === 'PROTOCOL' && this.phase === 'RESOLVE') {
      if (newlyCompleted.length > 0 && this.evidence.length === 0) {
        return { allowed: false, error: 'Cannot mark step completed — no tool evidence collected' };
      }
    }

    return { allowed: true };
  }

  private persistTodos(nextTodos: TodoItem[], previousById: Map<string, TodoItem>): void {
    const timestamp = new Date().toISOString();
    for (const todo of nextTodos) {
      const storageId = this.storageTaskId(todo.id);
      const existing = this.store.getTask(storageId);
      const taskStatus = this.mapTodoStatus(todo.status);
      const task: TaskRow = {
        id: storageId,
        projectId: this.projectId,
        title: todo.content,
        description: null,
        status: taskStatus,
        dependsOn: existing?.dependsOn ?? [],
        filesInvolved: existing?.filesInvolved ?? [],
        successCriteria: existing?.successCriteria ?? null,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        completedAt: taskStatus === 'done' ? (existing?.completedAt ?? timestamp) : existing?.completedAt ?? null,
        error: existing?.error ?? null,
        retryCount: existing?.retryCount ?? 0,
      };
      this.store.upsertTask(task);

      const previous = previousById.get(todo.id);
      if (todo.status === 'completed' && previous?.status !== 'completed') {
        this.store.setTaskStatus(storageId, 'done', { completedAt: timestamp });
        this.store.appendAuditLog({
          type: 'task_complete',
          project_id: this.projectId,
          task_id: storageId,
          visible_task_id: todo.id,
          summary: todo.content,
        });
      } else if (todo.status === 'removed' && previous?.status !== 'removed') {
        this.store.setTaskStatus(storageId, 'skipped');
      }
    }
  }

  private storageTaskId(todoId: string): string {
    const scope = crypto
      .createHash('sha1')
      .update(`${this.projectId}:${this.conversationId || 'default'}`)
      .digest('hex')
      .slice(0, 8);
    return `${this.projectId}:todo:${scope}:${todoId}`;
  }

  private mapTodoStatus(status: TodoStatus): TaskStatus {
    switch (status) {
      case 'completed':
        return 'done';
      case 'removed':
        return 'skipped';
      case 'in_progress':
        return 'in_progress';
      case 'pending':
      default:
        return 'pending';
    }
  }
}

function estimateMessageTokens(messages: ApiMessage[]): number {
  return messages.reduce((sum, msg) => {
    const serializedTools = msg.tool_calls ? `\n${JSON.stringify(msg.tool_calls)}` : '';
    const toolId = msg.tool_call_id ? `\n${msg.tool_call_id}` : '';
    return sum + estimateTextTokens(`${msg.role}\n${messageContentToText(msg.content)}${serializedTools}${toolId}`) + 4;
  }, 0);
}

function getCompactionThreshold(contextLimit: number, options?: AutoCompactionOptions): number {
  if (options?.limitType === 'tokens') {
    return Math.max(1000, Math.floor(Number(options.tokens) || Math.floor(contextLimit * 0.9)));
  }
  const percent = Math.min(98, Math.max(50, Number(options?.percent) || 90));
  return Math.floor(contextLimit * (percent / 100));
}

function serializeMessagesForCompaction(messages: ApiMessage[], contextLimit: number): string {
  const maxChars = Math.min(MAX_COMPACTION_SOURCE_CHARS, Math.max(8000, contextLimit * 3));
  const sections: string[] = [];
  let total = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const toolCalls = msg.tool_calls ? `\nTool calls: ${truncateMiddle(JSON.stringify(msg.tool_calls), 8000, 'tool calls')}` : '';
    const toolResult = msg.tool_call_id ? `\nTool result for: ${msg.tool_call_id}` : '';
    const section = `[${msg.role.toUpperCase()}]\n${truncateMiddle(messageContentToText(msg.content), 40_000, 'message')}${toolCalls}${toolResult}`;
    const separatorLength = sections.length > 0 ? 10 : 0;
    if (total + section.length + separatorLength > maxChars) {
      const remaining = Math.max(0, maxChars - total - separatorLength);
      if (remaining > 1000) sections.unshift(section.slice(section.length - remaining));
      break;
    }
    sections.unshift(section);
    total += section.length + separatorLength;
  }

  return sections.join('\n\n---\n\n');
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateToolArgsBeforeExecution(name: string, args: Record<string, unknown>, rawArguments?: string): ToolValidation {
  const emptyArgs = Object.keys(args || {}).length === 0;
  const rawHint = rawArguments ? ` Raw arguments: ${rawArguments.slice(0, 300)}` : '';
  const emptyArgsHint = emptyArgs
    ? `The ${name} tool call arrived with empty arguments ({}). Retry the same tool with complete JSON arguments.${rawHint}`
    : '';

  switch (name) {
    case 'create_file':
      if (!isNonEmptyString(args.path)) {
        return { allowed: false, error: emptyArgsHint || "create_file requires a non-empty 'path' argument." };
      }
      if (args.content === undefined || args.content === null) {
        return { allowed: false, error: emptyArgsHint || "create_file requires a 'content' argument." };
      }
      return { allowed: true };
    case 'edit_file':
      if (!isNonEmptyString(args.path)) {
        return { allowed: false, error: emptyArgsHint || "edit_file requires a non-empty 'path' argument." };
      }
      if (
        typeof args.append !== 'string' &&
        !(args.replace_entire_file === true && args.new_text !== undefined && args.new_text !== null) &&
        !(args.replace_range === true && args.start_line !== undefined && args.end_line !== undefined && args.new_text !== undefined && args.new_text !== null) &&
        !(args.mode === 'replace_range' && args.start_line !== undefined && args.end_line !== undefined && args.new_text !== undefined && args.new_text !== null) &&
        !(args.insert_at_line !== undefined && args.new_text !== undefined && args.new_text !== null) &&
        !(args.mode === 'insert_at_line' && args.insert_at_line !== undefined && args.new_text !== undefined && args.new_text !== null) &&
        !(isNonEmptyString(args.old_text) && args.new_text !== undefined && args.new_text !== null) &&
        !(isNonEmptyString(args.insert_before) && args.new_text !== undefined && args.new_text !== null) &&
        !(isNonEmptyString(args.insert_after) && args.new_text !== undefined && args.new_text !== null)
      ) {
        return { allowed: false, error: "edit_file requires old_text/new_text, replace_entire_file/new_text, replace_range/start_line/end_line/new_text, insert_at_line/new_text, insert_before/new_text, insert_after/new_text, or append." };
      }
      return { allowed: true };
    case 'multi_edit':
      if (!isNonEmptyString(args.file_path) || !Array.isArray(args.edits) || args.edits.length === 0) {
        return { allowed: false, error: emptyArgsHint || "multi_edit requires 'file_path' and a non-empty 'edits' array." };
      }
      return { allowed: true };
    case 'read_file':
    case 'delete_file':
      if (!isNonEmptyString(args.path)) {
        return { allowed: false, error: emptyArgsHint || `${name} requires a non-empty 'path' argument.` };
      }
      return { allowed: true };
    case 'grep':
      if (!isNonEmptyString(args.pattern)) {
        return { allowed: false, error: emptyArgsHint || "grep requires a non-empty 'pattern' argument." };
      }
      return { allowed: true };
    case 'glob':
      if (!isNonEmptyString(args.pattern)) {
        return { allowed: false, error: emptyArgsHint || "glob requires a non-empty 'pattern' argument." };
      }
      return { allowed: true };
    case 'shell_command':
      if (!isNonEmptyString(args.command)) {
        return { allowed: false, error: emptyArgsHint || "shell_command requires a non-empty 'command' argument." };
      }
      return { allowed: true };
    case 'web_search':
      if (!isNonEmptyString(args.query)) {
        return { allowed: false, error: emptyArgsHint || "web_search requires a non-empty 'query' argument." };
      }
      return { allowed: true };
    case 'read_webpage':
      if (!isNonEmptyString(args.url)) {
        return { allowed: false, error: emptyArgsHint || "read_webpage requires a non-empty 'url' argument." };
      }
      return { allowed: true };
    case 'todo':
      if (args.action !== 'read' && args.action !== 'write') {
        return { allowed: false, error: emptyArgsHint || "todo requires action 'read' or 'write'." };
      }
      if (args.action === 'write' && !Array.isArray(args.todos)) {
        return { allowed: false, error: "todo.write requires a 'todos' array." };
      }
      return { allowed: true };
    default:
      return { allowed: true };
  }
}

async function compactHistoryIfNeeded(
  baseUrl: string,
  model: string | undefined,
  enhancedSystemPrompt: string,
  historyMessages: ApiMessage[],
  options?: AutoCompactionOptions,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
): Promise<{
  messages: ApiMessage[];
  event?: {
    summary: string;
    originalTokenEstimate: number;
    compactedTokenEstimate: number;
    contextLimit: number;
    threshold: number;
  };
}> {
  if (!options?.enabled || historyMessages.length < 4) {
    return { messages: historyMessages };
  }

  const contextLimit = await getLoadedModelContextLimit(baseUrl, model, options.fallbackContextTokens, apiKey, apiProtocol);
  const threshold = getCompactionThreshold(contextLimit, options);
  const fullMessages = enhancedSystemPrompt
    ? [{ role: 'system', content: enhancedSystemPrompt }, ...historyMessages]
    : historyMessages;
  const originalTokenEstimate = estimateMessageTokens(fullMessages);
  if (originalTokenEstimate < threshold) {
    return { messages: historyMessages };
  }

  const lastUserIndex = historyMessages.map((m) => m.role).lastIndexOf('user');
  if (lastUserIndex <= 0) {
    return { messages: historyMessages };
  }

  const compactableMessages = historyMessages.slice(0, lastUserIndex);
  const activeMessages = historyMessages.slice(lastUserIndex);
  const compactableText = serializeMessagesForCompaction(compactableMessages, contextLimit);
  let response;
  try {
    response = await chatCompletion(baseUrl, {
      model,
      temperature: 0.2,
      maxTokens: Math.min(4096, Math.max(1024, Math.floor(contextLimit * 0.08))),
      topP: 0.9,
      repeatPenalty: 1.05,
      apiKey,
      apiProtocol,
      messages: [
        {
          role: 'system',
          content: 'Compact a coding-assistant conversation. Preserve current goals, user preferences, key decisions, files touched, commands/results, unresolved bugs, and constraints. Be concise but specific. Do not invent facts.',
        },
        {
          role: 'user',
          content: `Summarize this older conversation history for future turns:\n\n${compactableText}`,
        },
      ],
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.warn('Auto-compaction failed; continuing with original history:', err.message || String(error));
    return { messages: historyMessages };
  }
  const summary = response.content?.trim();
  if (!summary) {
    return { messages: historyMessages };
  }

  const compactedMessages: ApiMessage[] = [
    { role: 'system', content: `Conversation compacted:\n\n${summary}` },
    ...activeMessages,
  ];
  return {
    messages: compactedMessages,
    event: {
      summary,
      originalTokenEstimate,
      compactedTokenEstimate: estimateMessageTokens([
        ...(enhancedSystemPrompt ? [{ role: 'system', content: enhancedSystemPrompt }] : []),
        ...compactedMessages,
      ]),
      contextLimit,
      threshold,
    },
  };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workingDir: string,
  fileChunkOptions?: FileChunkOptions,
  modifiedFiles?: Set<string>,
  readFiles?: Set<string>,
  editState?: EditLoopState,
  cloudModeEnabled = false,
): Promise<{ success: boolean; result?: string; error?: string }> {
  function recordModified(filePath: string) {
    modifiedFiles?.add(filePath.replace(/\\/g, '/'));
  }

  try {
    switch (name) {
    case 'create_file': {
      if (!args || !args.path) return { success: false, error: `create_file requires 'path'. Received args: ${JSON.stringify(args)}` };
      if (args.content === undefined || args.content === null) return { success: false, error: `create_file requires 'content' argument. The content may have been lost due to JSON parsing truncation.` };
      const fullPath = safePath(workingDir, String(args.path));
      if (fsSync.existsSync(fullPath)) {
        return { success: false, error: 'File exists. Use edit_file or multi_edit after read_file.' };
      }
      if (isEditLoopLocked(editState, workingDir, fullPath)) {
        return { success: false, error: editLoopRewriteBlockedError(workingDir, fullPath) };
      }
      const content = String(args.content);
      const syntaxError = await validateSourceBeforeWrite(fullPath, content);
      if (syntaxError) return { success: false, error: syntaxError };
      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
      recordModified(String(args.path));
      return { success: true, result: `File created: ${args.path} (${Buffer.byteLength(content, 'utf-8')} bytes)` };
    }
    case 'read_file': {
      if (!args.path) return { success: false, error: "read_file requires a 'path' argument." };
      const fullPath = safePath(workingDir, String(args.path));
      if (await shouldBlockTextRead(fullPath)) {
        return { success: false, error: `read_file only reads text files. ${args.path} appears to be binary; use an appropriate structured tool or inspect metadata instead.` };
      }
      const hasRequestedLineRange = args.start_line !== undefined || args.end_line !== undefined;
      const chunked = hasRequestedLineRange
        ? null
        : await chunkFileForContext(workingDir, fullPath, String(args.path), fileChunkOptions);
      if (chunked) {
        markFileRead(readFiles, workingDir, fullPath);
        resetEditLoopForPath(editState, workingDir, fullPath);
        return { success: true, result: chunked };
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      markFileRead(readFiles, workingDir, fullPath);
      resetEditLoopForPath(editState, workingDir, fullPath);
      return { success: true, result: formatReadFileContent(content, args) };
    }
    case 'list_directory': {
      const targetPath = args.path ? safePath(workingDir, String(args.path)) : workingDir;
      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const items = entries
        .filter((entry) => !cloudModeEnabled || (entry.name !== '.ec9v3' && entry.name !== '.ec9v3-context-chunks'))
        .sort((a, b) => { if (a.isDirectory() && !b.isDirectory()) return -1; if (!a.isDirectory() && b.isDirectory()) return 1; return a.name.localeCompare(b.name); })
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
      const maxResults = clampResultLimit(
        args.max_results,
        cloudModeEnabled ? CLOUD_DIRECTORY_RESULT_LIMIT : LOCAL_DIRECTORY_RESULT_LIMIT,
        cloudModeEnabled ? CLOUD_DIRECTORY_RESULT_LIMIT : 500,
      );
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      return {
        success: true,
        result: formatLineResultWindow(
          items.map((item) => `${item.type === 'directory' ? '[dir]' : '[file]'} ${item.name}`),
          {
            label: 'directory entries',
            maxItems: maxResults,
            offset,
            knownTotal: items.length,
            continuation: `Call list_directory again with {"path":${JSON.stringify(String(args.path || '.'))},"offset":${offset + maxResults},"max_results":${maxResults}} to continue.`,
          },
        ),
      };
    }
    case 'edit_file': {
      if (!args.path) return { success: false, error: "edit_file requires 'path'." };
      const fullPath = safePath(workingDir, String(args.path));
      if (!hasReadFile(readFiles, workingDir, fullPath)) {
        return { success: false, error: readBeforeEditError(String(args.path)) };
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      const editResult = applyEditFileArgs(content, args);
      if (!editResult.success) {
        const recovery = recordEditLoopOutcome(editState, workingDir, fullPath, false);
        return recovery ? { success: false, error: `${editResult.error} ${recovery}` } : editResult;
      }
      const syntaxError = await validateSourceBeforeWrite(fullPath, editResult.content);
      if (syntaxError) {
        const recovery = lockEditLoopForPath(editState, workingDir, fullPath);
        return { success: false, error: recovery ? `${syntaxError} ${recovery}` : syntaxError };
      }
      await fs.writeFile(fullPath, editResult.content, 'utf-8');
      recordModified(String(args.path));
      markFileRead(readFiles, workingDir, fullPath);
      recordEditLoopOutcome(editState, workingDir, fullPath, true);
      return { success: true, result: `Edited ${args.path}: ${editResult.summary}` };
    }
    case 'multi_edit': {
      if (!args.file_path || !args.edits || !Array.isArray(args.edits)) return { success: false, error: "multi_edit requires 'file_path' and 'edits' (array of {old_string, new_string})." };
      const fullPath = safePath(workingDir, String(args.file_path));
      if (!hasReadFile(readFiles, workingDir, fullPath)) {
        return { success: false, error: readBeforeEditError(String(args.file_path)) };
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      const editResult = applyMultiEditArgs(content, args.edits as Array<Record<string, unknown>>);
      if (!editResult.success) {
        const recovery = recordEditLoopOutcome(editState, workingDir, fullPath, false);
        return recovery ? { success: false, error: `${editResult.error} ${recovery}` } : editResult;
      }
      const syntaxError = await validateSourceBeforeWrite(fullPath, editResult.content);
      if (syntaxError) {
        const recovery = lockEditLoopForPath(editState, workingDir, fullPath);
        return { success: false, error: recovery ? `${syntaxError} ${recovery}` : syntaxError };
      }
      await fs.writeFile(fullPath, editResult.content, 'utf-8');
      recordModified(String(args.file_path));
      markFileRead(readFiles, workingDir, fullPath);
      recordEditLoopOutcome(editState, workingDir, fullPath, true);
      return { success: true, result: `Edited ${args.file_path}: ${editResult.summary}` };
    }
    case 'delete_file': {
      if (!args.path) return { success: false, error: "delete_file requires a 'path'." };
      const fullPath = safePath(workingDir, String(args.path));
      if (isEditLoopLocked(editState, workingDir, fullPath)) {
        return { success: false, error: editLoopRewriteBlockedError(workingDir, fullPath) };
      }
      if (isSourceLikeFilePath(String(args.path))) {
        if (modifiedFiles?.has(String(args.path).replace(/\\/g, '/')) || hasReadFile(readFiles, workingDir, fullPath)) {
          return { success: false, error: 'delete_file blocked for a source-like file already read, created, or edited in this run. Use edit_file or multi_edit for targeted corrections instead of delete/recreate.' };
        }
      }
      await fs.unlink(fullPath);
      recordModified(String(args.path));
      return { success: true, result: `Deleted: ${args.path}` };
    }
    case 'grep': {
      if (!args.pattern) return { success: false, error: "grep requires 'pattern'." };
      try {
        const maxResults = clampResultLimit(
          args.max_results,
          cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : LOCAL_SEARCH_RESULT_LIMIT,
          cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 300,
        );
        const rgArgs = [
          'rg', '--no-heading', '--max-count', String(maxResults),
          args.case_insensitive ? '-i' : '',
          args.glob ? `--glob=${escapeShellArg(String(args.glob))}` : '',
          '-e', escapeShellArg(String(args.pattern)),
          args.path ? escapeShellArg(safePath(workingDir, String(args.path))) : escapeShellArg(workingDir),
        ].filter(Boolean).join(' ');
        const { stdout, stderr } = await execShellCommand(rgArgs, { timeout: 15000, maxBuffer: 5 * 1024 * 1024, cwd: workingDir });
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        return {
          success: true,
          result: output
            ? formatLineResultWindow(output.split(/\r?\n/).filter(Boolean), {
                label: 'grep matches',
                maxItems: maxResults,
                continuation: 'Narrow the grep pattern, path, or glob to inspect the relevant matches.',
              })
            : '(no matches found)',
        };
      } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        if (err.stdout) {
          const maxResults = clampResultLimit(
            args.max_results,
            cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : LOCAL_SEARCH_RESULT_LIMIT,
            cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 300,
          );
          return {
            success: true,
            result: formatLineResultWindow(err.stdout.trim().split(/\r?\n/).filter(Boolean), {
              label: 'grep matches',
              maxItems: maxResults,
              continuation: 'Narrow the grep pattern, path, or glob to inspect the relevant matches.',
            }),
          };
        }
        try {
          const fallback = await searchFilesFallback(
            workingDir,
            args.path ? safePath(workingDir, String(args.path)) : workingDir,
            String(args.pattern),
            args.glob ? String(args.glob) : undefined,
            Boolean(args.case_insensitive),
            clampResultLimit(
              args.max_results,
              cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : LOCAL_SEARCH_RESULT_LIMIT,
              cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 300,
            ),
          );
          return { success: true, result: fallback };
        } catch (fallbackError: unknown) {
          const fallbackErr = fallbackError as { message?: string };
          return { success: false, error: `grep failed: ${err.message || String(error)}; fallback failed: ${fallbackErr.message || String(fallbackError)}` };
        }
      }
    }
    case 'glob': {
      if (!args.pattern) return { success: false, error: "glob requires 'pattern'." };
      try {
        const searchPath = args.path ? safePath(workingDir, String(args.path)) : workingDir;
        const pattern = String(args.pattern);
        const patternVariants = globPatternVariants(pattern);
        const regexes = patternVariants.map((variant) => globToRegex(variant));
        const excludeDirs = ['node_modules', '.git', '.next', 'dist', 'build', '.ec9v3', '.ec9v3-context-chunks'];
        const maxResults = clampResultLimit(
          args.max_results,
          cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 200,
          cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 500,
        );
        const results: string[] = [];
        
        async function walk(dir: string): Promise<void> {
          if (results.length > maxResults) return;
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length > maxResults) return;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!excludeDirs.includes(entry.name)) {
                await walk(fullPath);
              }
            } else if (entry.isFile()) {
              const relativePath = path.relative(workingDir, fullPath).replace(/\\/g, '/');
              if (regexes.some((regex) => regex.test(relativePath) || regex.test(entry.name))) {
                results.push(relativePath);
                if (results.length > maxResults) return;
              }
            }
          }
        }
        
        await walk(searchPath);
        const sorted = results.sort();
        return {
          success: true,
          result: sorted.length > 0
            ? formatLineResultWindow(sorted, {
                label: 'glob matches',
                maxItems: maxResults,
                continuation: 'Narrow the glob pattern or path to inspect additional files.',
              })
            : '(no files found)',
        };
      } catch (error: unknown) {
        const err = error as { message?: string };
        return { success: false, error: `glob failed: ${err.message || String(error)}` };
      }
    }
    case 'shell_command': {
      if (!args.command) return { success: false, error: "shell_command requires 'command'." };
      const cmd = String(args.command);
      if (process.platform === 'win32' && /&&|\|\|/.test(cmd)) {
        return {
          success: false,
          error: 'PowerShell command rejected: do not use CMD/Unix && or || chaining. Use PowerShell syntax such as `;`, `if (Test-Path app.js) { ... } else { ... }`, or run one command at a time.',
        };
      }
      const lockedRewriteError = shellCommandWouldRewriteLockedFile(cmd, workingDir, editState);
      if (lockedRewriteError) return { success: false, error: lockedRewriteError };
      const trackedSourceDeleteError = shellCommandWouldDeleteTrackedSourceFile(
        cmd,
        workingDir,
        new Set([...(readFiles || []), ...(modifiedFiles || [])]),
      );
      if (trackedSourceDeleteError) return { success: false, error: trackedSourceDeleteError };
      if (shellCommandLooksLikeWholeFileRewrite(cmd)) {
        return { success: false, error: 'Shell whole-file rewrite blocked. Use create_file for new files, or read_file plus edit_file for existing files. If the whole existing file is malformed, use edit_file with replace_entire_file:true and new_text after reading it.' };
      }
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(cmd)) return { success: false, error: 'Command blocked for safety.' };
      }
      const cmdWd = args.working_directory ? safePath(workingDir, String(args.working_directory)) : workingDir;
      try {
        const { stdout, stderr } = await execShellCommand(cmd, { cwd: cmdWd, timeout: 30000, maxBuffer: 1024 * 1024 });
        return { success: true, result: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || '(no output)' };
      } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string; message?: string; code?: number };
        const output = [err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n');
        return { success: false, error: `Command exited with code ${err.code}\n${output || err.message}` };
      }
    }
    case 'web_search': {
      if (!args.query) return { success: false, error: "web_search requires 'query'." };
      try {
        const maxResults = Math.min(Number(args.max_results) || 5, 10);
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(args.query))}`;
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) return { success: false, error: `Web search failed: HTTP ${response.status}` };
        const html = await response.text();
        const results: Array<{ title: string; url: string; snippet: string }> = [];
        const resultRegex = /<a[^>]+class="result__a"[^>]*>(.*?)<\/a>.*?<a[^>]+class="result__url"[^>]*>(.*?)<\/a>.*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;
        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
          const title = match[1].replace(/<[^>]+>/g, '').trim();
          const urlText = match[2].replace(/<[^>]+>/g, '').trim();
          const snippet = match[3].replace(/<[^>]+>/g, '').trim();
          if (title && urlText) results.push({ title, url: urlText, snippet });
        }
        if (results.length === 0) return { success: false, error: 'No web search results found.' };
        return { success: true, result: `Found ${results.length} results:\n\n${results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`).join('\n\n')}` };
      } catch (error: unknown) {
        const err = error as { message?: string };
        return { success: false, error: `Web search failed: ${err.message}` };
      }
    }
    case 'read_webpage': {
      if (!args.url) return { success: false, error: "read_webpage requires 'url'." };
      try {
        const response = await fetch(String(args.url), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) return { success: false, error: `Failed to read webpage: HTTP ${response.status}` };
        const html = await response.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return { success: true, result: text };
      } catch (error: unknown) {
        const err = error as { message?: string };
        return { success: false, error: `Failed to read webpage: ${err.message}` };
      }
    }
    case 'todo': {
      const action = String(args.action);
      const convId = args._conversationId ? String(args._conversationId) : 'default';
      const protocol = getTodoProtocol(
        convId,
        args._projectId ? String(args._projectId) : undefined,
        args._workingDirectory ? String(args._workingDirectory) : undefined,
      );
      if (action === 'read') {
        const todos = protocol.todos;
        if (todos.length === 0) return { success: true, result: '(no tasks)' };
        return { success: true, result: `Mode: ${protocol.mode}. Phase: ${protocol.phase}.\n${todos.map(t => `[${t.status}] ${t.priority.toUpperCase()}: ${t.content} (id: ${t.id})`).join('\n')}` };
      }
      if (action === 'write' && Array.isArray(args.todos)) {
        return protocol.applyTodoWrite(args);
      }
      return { success: false, error: "todo requires 'action' ('read' or 'write')." };
    }
    default:
      return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (error: unknown) {
    return { success: false, error: formatRecoverableToolError(name, args || {}, error) };
  }
}

const AUTOPROMPT_STAGE_NAMES: Record<string, string> = {
  review: 'Code Review',
  placeholder_cleanup: 'Placeholder Cleanup',
  run_fix: 'Run & Fix',
  senior_review: 'Senior Review',
  completeness: 'Completeness',
  task_verify: 'Completeness',
};

const AUTOPROMPT_STAGE_ORDER: AutoPromptStage[] = [
  'review',
  'placeholder_cleanup',
  'run_fix',
  'senior_review',
  'completeness',
];

function isMeaningfulVerificationCommand(command: string): boolean {
  return /\b(node\s+--check|npm\s+(test|run|exec)|pnpm\s+(test|run|exec)|yarn\s+(test|run)|npx\b.*\b(tsc|playwright|vitest|jest|eslint)|pytest|cargo\s+test|go\s+test|dotnet\s+test|python\b.*\bpytest|curl\b|Invoke-WebRequest\b|Test-Path\b)/i.test(command);
}

function isBrowserRuntimeVerificationCommand(command: string): boolean {
  return /\b(playwright|puppeteer|chromium|firefox|webkit)\b/i.test(command) ||
    /\brequire\(['"]playwright['"]\)/i.test(command) ||
    /\bfrom\s+['"]playwright/i.test(command) ||
    /\bpage\.goto\b|\bpage\.locator\b|\bpage\.keyboard\b|\bpage\.click\b/i.test(command);
}

function isBrowserAppTask(userMessage: string, context: string): boolean {
  const text = `${userMessage}\n${context}`.toLowerCase();
  const browserSignals = [
    'browser calculator',
    'browser app',
    'static app',
    'open index.html',
    'index.html',
    'app.js',
    'dom',
    'onclick',
    'keyboard support',
    'playwright',
  ];
  return browserSignals.some((signal) => text.includes(signal));
}

function hasMeaningfulVerificationEvidence(content: string): boolean {
  return /\bnode\s+--check\b[\s\S]{0,500}\b(?:success|passed|pass|no output|no syntax errors?)\b/i.test(content) ||
    /\b(?:npm|pnpm|yarn)\s+(?:test|run|exec)\b[\s\S]{0,500}\b(?:success|passed|pass)\b/i.test(content) ||
    /\b(?:playwright|vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test|tsc)\b[\s\S]{0,500}\b(?:success|passed|pass|no errors?)\b/i.test(content);
}

function hasContradictoryFailureEvidence(content: string): boolean {
  return [
    /\bcritical failures?\b/i,
    /\b(?:unresolved|remaining|has|had|found|critical|blocking)\s+syntax errors?\b/i,
    /\bsyntax errors?\s+(?:remain|found|detected)\b/i,
    /\bissues? remain\b/i,
    /\bappears truncated\b/i,
    /\btruncated\/incomplete\b/i,
    /\bmissing (?:critical )?(?:methods?|files?|functionality|requirements?)\b/i,
    /\bnot implemented\b/i,
    /\bcannot pass\b/i,
    /\bblocking\)\b/i,
  ].some((pattern) => pattern.test(content));
}

function hasExplicitSatisfiedEvidence(content: string): boolean {
  return /\b(?:final result:\s*)?all requirements satisfied\b/i.test(content) ||
    /\bverification complete\b[\s\S]{0,200}\bpass\b/i.test(content);
}

function canonicalAutoPromptStage(stageId: string): AutoPromptStage {
  return stageId === 'task_verify' ? 'completeness' : stageId as AutoPromptStage;
}

function normalizeAutoPromptStages(stages: Record<string, unknown> | undefined): AutoPromptStage[] {
  if (!stages) return [];
  const enabled = new Set<AutoPromptStage>();
  for (const stage of AUTOPROMPT_STAGE_ORDER) {
    if (stages[stage] === true) enabled.add(stage);
  }
  if (stages.task_verify === true) enabled.add('completeness');
  return AUTOPROMPT_STAGE_ORDER.filter((stage) => enabled.has(stage));
}

function summarizeAutoPromptPriorStages(results?: AutoPromptStageResult[]): string {
  if (!results?.length) return 'No previous AutoPrompt stages have run.';
  return results
    .map((result) => {
      const structured = result.structured;
      const remaining = structured?.remaining_issues?.length
        ? `\nRemaining issues:\n${structured.remaining_issues.map((issue) => `- ${issue}`).join('\n')}`
        : '';
      const files = structured?.files_changed?.length
        ? `\nFiles changed: ${structured.files_changed.join(', ')}`
        : '';
      return `## ${result.stage} (${result.verdict || (result.passed ? 'pass' : 'fail')})\n${result.summary}${files}${remaining}`;
    })
    .join('\n\n---\n\n');
}

function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAutoPromptIssues(value: unknown): AutoPromptIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [{ description: item.trim() }];
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const description = typeof record.description === 'string'
      ? record.description
      : typeof record.issue === 'string'
        ? record.issue
        : '';
    if (!description.trim()) return [];
    return [{
      severity: typeof record.severity === 'string' ? record.severity : undefined,
      description: description.trim(),
      file: typeof record.file === 'string' ? record.file : undefined,
    }];
  });
}

function normalizeAutoPromptActions(value: unknown): AutoPromptAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [{ type: 'other' as const, detail: item.trim() }];
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const rawType = typeof record.type === 'string' ? record.type : 'other';
    const type = rawType === 'inspected' || rawType === 'edited' || rawType === 'verified' ? rawType : 'other';
    const detail = typeof record.detail === 'string'
      ? record.detail
      : typeof record.description === 'string'
        ? record.description
        : '';
    return detail.trim() ? [{ type, detail: detail.trim() }] : [];
  });
}

function normalizeAutoPromptVerification(value: unknown): AutoPromptVerification[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const evidence = typeof record.evidence === 'string'
      ? record.evidence
      : typeof record.result === 'string'
        ? record.result
        : '';
    return [{
      command: typeof record.command === 'string' ? record.command : undefined,
      passed: record.passed === true,
      evidence: evidence || (record.passed === true ? 'Verification passed.' : 'Verification failed or was not run.'),
    }];
  });
}

function parseJsonArrayField(text: string, fieldName: string): unknown[] {
  const marker = `"${fieldName}"`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return [];
  const colonIndex = text.indexOf(':', markerIndex + marker.length);
  if (colonIndex === -1) return [];
  const start = text.indexOf('[', colonIndex);
  if (start === -1) return [];

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '[') depth++;
    if (char === ']') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

function parseAutoPromptStructuredResultLoose(text: string): AutoPromptStructuredResult | null {
  const verdictMatch = /"verdict"\s*:\s*"(pass|fixed|fail)"/i.exec(text);
  const summaryMatch = /"summary"\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(text);
  if (!verdictMatch || !summaryMatch) return null;
  const summary = summaryMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
  if (!summary) return null;
  return {
    verdict: verdictMatch[1].toLowerCase() as AutoPromptStructuredVerdict,
    summary,
    issues_found: normalizeAutoPromptIssues(parseJsonArrayField(text, 'issues_found')),
    actions: normalizeAutoPromptActions(parseJsonArrayField(text, 'actions')),
    files_changed: stringArray(parseJsonArrayField(text, 'files_changed')),
    verification: normalizeAutoPromptVerification(parseJsonArrayField(text, 'verification')),
    remaining_issues: stringArray(parseJsonArrayField(text, 'remaining_issues')),
  };
}

function parseAutoPromptStructuredResult(content: string): AutoPromptStructuredResult | null {
  const json = extractJsonObject(content);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const rawVerdict = typeof parsed.verdict === 'string' ? parsed.verdict.toLowerCase() : '';
    const verdict: AutoPromptStructuredVerdict | '' =
      rawVerdict === 'pass' || rawVerdict === 'fixed' || rawVerdict === 'fail' ? rawVerdict : '';
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    if (!verdict || !summary) return null;
    return {
      verdict,
      summary,
      issues_found: normalizeAutoPromptIssues(parsed.issues_found),
      actions: normalizeAutoPromptActions(parsed.actions),
      files_changed: stringArray(parsed.files_changed),
      verification: normalizeAutoPromptVerification(parsed.verification),
      remaining_issues: stringArray(parsed.remaining_issues),
    };
  } catch {
    return parseAutoPromptStructuredResultLoose(json);
  }
}

function legacyStructuredAutoPromptResult(content: string, stageName: string): AutoPromptStructuredResult | null {
  const verdict = extractAutoPromptVerdictStrict(content);
  if (!verdict) return null;
  return {
    verdict: verdict === 'FIXED' ? 'fixed' : verdict === 'PASS' ? 'pass' : 'fail',
    summary: `${stageName}: legacy text verdict ${verdict}`,
    issues_found: [],
    actions: [],
    files_changed: [],
    verification: [],
    remaining_issues: verdict === 'FAIL' ? ['Legacy text result reported FAIL.'] : [],
  };
}

function formatAutoPromptStructuredDetails(
  structured: AutoPromptStructuredResult,
  rawContent: string,
  toolEvidence: string,
  validationNotes: string[],
): string {
  const sections = [
    `## Structured Result\n\n${JSON.stringify(structured, null, 2)}`,
    validationNotes.length ? `## Server Consistency Notes\n\n${validationNotes.map((note) => `- ${note}`).join('\n')}` : '',
    rawContent.trim() ? `## Stage Output\n\n${rawContent.trim()}` : '',
    toolEvidence.trim() ? `## Tool Evidence\n\n${toolEvidence.trim()}` : '',
  ];
  return sections.filter(Boolean).join('\n\n');
}

interface GoalVerification {
  passed: boolean;
  summary: string;
  nextAction: string;
}

async function verifyGoalReached(
  baseUrl: string,
  model: string | undefined,
  userGoal: string,
  transcript: string,
  todos: TodoItem[],
  lmOpti = false,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
  signal?: AbortSignal,
): Promise<GoalVerification> {
  const response = await chatCompletion(baseUrl, {
    model,
    temperature: 0.1,
    maxTokens: 1200,
    topP: 0.8,
    repeatPenalty: 1.05,
    lmOpti,
    apiKey,
    apiProtocol,
    signal,
    messages: [
      {
        role: 'system',
        content: `You are Goal Mode verifier for a coding assistant. Decide whether the user's goal has actually been reached.

Use the assistant transcript, tool results, and TODO state as evidence. Be strict:
- PASS only when the requested outcome is implemented and verified.
- FAIL when work is incomplete, tests/builds failed, TODOs remain open, or verification is missing.
- If FAIL, provide the next concrete action the assistant should take.

Output only JSON:
{"passed": boolean, "summary": "short evidence-based summary", "nextAction": "concrete next action or empty string if passed"}`,
      },
      {
        role: 'user',
        content: `User goal:\n${userGoal}\n\nTODO state:\n${JSON.stringify(todos, null, 2)}\n\nAssistant/tool transcript:\n${transcript.slice(-60000)}`,
      },
    ],
  });

  try {
    const parsed = JSON.parse(response.content || '{}');
    return {
      passed: parsed.passed === true,
      summary: String(parsed.summary || ''),
      nextAction: String(parsed.nextAction || parsed.next_action || ''),
    };
  } catch {
    const content = response.content || '';
    const passed = /\bPASS\b/i.test(content) && !/\bFAIL\b/i.test(content);
    return {
      passed,
      summary: content.slice(0, 1000) || 'Verifier returned no usable summary.',
      nextAction: passed ? '' : 'Continue working on the unmet goal and verify the result.',
    };
  }
}

function getDefaultPlan(): ExecutionPlan {
  return {
    task_summary: '',
    complexity: 'low',
    tasks: [],
    subagent_strategy: 'none',
    file_scoping: {},
  };
}

const PLANNING_SYSTEM_PROMPT = `You are a planning module for an AI coding assistant. Given the user's request,
the detected agent, and the working directory, produce a structured execution plan.

Analyze the request and determine:
1. The concrete tasks required to complete the user's request
2. Dependencies between tasks using task IDs from this plan
3. What files each task needs to read, create, or modify
4. Whether subagents would help and how they should be coordinated
5. What success criteria would verify each task is complete

For subagent strategy:
- "none" — task is simple, main agent handles everything
- "single" — one specialized agent would help
- "sequential" — multiple agents where later agents depend on earlier results
- "parallel" — multiple agents that can work independently on non-overlapping files

Output ONLY valid JSON matching this schema. No markdown, no explanation, no commentary.

{
  "task_summary": "string — one sentence",
  "complexity": "low | medium | high",
  "tasks": [
    {
      "id": "string - stable task id unique within this plan",
      "title": "string - short task title",
      "description": "string - optional details",
      "depends_on": ["string - task ids in this plan that must be done first"],
      "files_to_read": ["string - file paths or glob patterns"],
      "files_to_create": ["string - expected new files"],
      "files_to_modify": ["string - existing files to change"],
      "success_criteria": "string - testable condition that means this task is done"
    }
  ],
  "subagent_strategy": "none | single | sequential | parallel",
  "file_scoping": {
    "task-id": {
      "allowed_read": ["string - files this task may read"],
      "allowed_write": ["string - files this task may create or modify"]
    }
  }
}`;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizePlanTask(value: unknown, index: number): PlanTask {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `task-${index + 1}`;
  return {
    id,
    title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : id,
    description: typeof record.description === 'string' ? record.description : undefined,
    depends_on: isStringArray(record.depends_on) ? record.depends_on : [],
    files_to_read: isStringArray(record.files_to_read) ? record.files_to_read : [],
    files_to_create: isStringArray(record.files_to_create) ? record.files_to_create : [],
    files_to_modify: isStringArray(record.files_to_modify) ? record.files_to_modify : [],
    success_criteria: typeof record.success_criteria === 'string' ? record.success_criteria : '',
  };
}

function normalizeExecutionPlan(value: unknown): ExecutionPlan | null {
  const record = (value && typeof value === 'object' ? value : null) as Record<string, unknown> | null;
  if (!record) return null;
  const strategy = record.subagent_strategy;
  const subagentStrategy = strategy === 'single' || strategy === 'sequential' || strategy === 'parallel'
    ? strategy
    : 'none';
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
  const fileScoping = record.file_scoping && typeof record.file_scoping === 'object' && !Array.isArray(record.file_scoping)
    ? record.file_scoping as ExecutionPlan['file_scoping']
    : {};

  return {
    task_summary: typeof record.task_summary === 'string' ? record.task_summary : '',
    complexity: record.complexity === 'medium' || record.complexity === 'high' ? record.complexity : 'low',
    tasks: rawTasks.map(normalizePlanTask),
    subagent_strategy: subagentStrategy,
    file_scoping: fileScoping,
  };
}

function isRunnablePlanTask(task: PlanTask): boolean {
  return Boolean(task.id.trim() && task.title.trim() && task.success_criteria.trim());
}

function planStorageTaskId(projectId: string, planId: string, taskId: string): string {
  return `${projectId}:plan:${planId}:${taskId}`;
}

function upsertPlanTasks(workingDir: string, projectId: string, planId: string, plan: ExecutionPlan): string[] {
  const store = new TaskStore(workingDir);
  const storedIds: string[] = [];
  try {
    store.upsertProject({
      id: projectId,
      name: path.basename(workingDir) || projectId,
      workingDirectory: workingDir,
    });
    plan.tasks.forEach((task, index) => {
      const storageId = planStorageTaskId(projectId, planId, task.id);
      const existing = store.getTask(storageId);
      const timestamp = new Date(Date.now() + index).toISOString();
      const filesInvolved = Array.from(new Set([
        ...task.files_to_read,
        ...task.files_to_create,
        ...task.files_to_modify,
      ]));
      store.upsertTask({
        id: storageId,
        projectId,
        title: task.title,
        description: task.description ?? null,
        status: existing?.status ?? 'pending',
        dependsOn: task.depends_on.map((id) => planStorageTaskId(projectId, planId, id)),
        filesInvolved,
        successCriteria: task.success_criteria,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        completedAt: existing?.completedAt ?? null,
        error: existing?.error ?? null,
        retryCount: existing?.retryCount ?? 0,
      });
      storedIds.push(storageId);
    });
    return storedIds;
  } finally {
    store.close();
  }
}

async function runPlanningPass(
  userMessage: string,
  agent: string,
  workingDir: string,
  projectId: string,
  loadedSkills: string[],
  baseUrl: string,
  model?: string,
  planningPassTimeout?: number,
  lmOpti = false,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
): Promise<ExecutionPlan> {
  const timeout = planningPassTimeout || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await chatCompletion(baseUrl, {
      messages: [
        { role: 'system', content: PLANNING_SYSTEM_PROMPT },
        { role: 'user', content: `User request: ${userMessage}\nDetected agent: ${agent}\nWorking directory: ${workingDir}\nLoaded skills: ${loadedSkills.join(', ') || 'none'}` },
      ],
      temperature: 0.3,
      maxTokens: 2000,
      topP: 0.9,
      repeatPenalty: 1.1,
      lmOpti,
      apiKey,
      apiProtocol,
      signal: controller.signal,
    });

    clearTimeout(timer);

    let plan: ExecutionPlan | null;
    try {
      plan = normalizeExecutionPlan(JSON.parse(response.content || '{}'));
    } catch {
      console.warn('Planning pass returned invalid JSON, using defaults');
      return getDefaultPlan();
    }

    if (!plan || !plan.task_summary || !Array.isArray(plan.tasks) || plan.tasks.length === 0 || !plan.tasks.every(isRunnablePlanTask)) {
      console.warn('Planning pass returned incomplete plan, using defaults');
      return getDefaultPlan();
    }

    const planId = crypto
      .createHash('sha1')
      .update(`${projectId}:${userMessage}:${Date.now()}`)
      .digest('hex')
      .slice(0, 10);
    const storedTaskIds = upsertPlanTasks(workingDir, projectId, planId, plan);
    await appendWorklog(workingDir, {
      ts: new Date().toISOString(),
      type: 'plan',
      project_id: projectId,
      summary: plan.task_summary,
      data: {
        plan_id: planId,
        complexity: plan.complexity,
        subagent_strategy: plan.subagent_strategy,
        task_ids: storedTaskIds,
        visible_task_ids: plan.tasks.map((task) => task.id),
        success_criteria: plan.tasks.map((task) => task.success_criteria).filter(Boolean),
      },
    });

    return plan;
  } catch (error: unknown) {
    clearTimeout(timer);
    const err = error as { message?: string };
    console.warn('Planning pass failed, using defaults:', err?.message);
    return getDefaultPlan();
  }
}

async function runAutoPromptStage(
  stageId: string,
  context: string,
  userMessage: string,
  previousSummary: string,
  baseUrl: string,
  model: string | undefined,
  workingDir: string,
  maxTokens?: number,
  fullMessageHistory?: ApiMessage[],
  priorStageResults?: AutoPromptStageResult[],
  fileChunkOptions?: FileChunkOptions,
  modifiedFiles?: Set<string>,
  readFiles?: Set<string>,
  lmOpti = false,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
  cloudModeEnabled = false,
): Promise<AutoPromptStageResult> {
  const canonicalStage = canonicalAutoPromptStage(stageId);
  const stageName = AUTOPROMPT_STAGE_NAMES[canonicalStage] || canonicalStage;
  
  // Load prompt from .md file
  let promptTemplate: string;
  try {
    promptTemplate = await loadPrompt(`autoprompt/${canonicalStage}.md`);
    if (!promptTemplate) {
      throw new Error(`Prompt file not found for stage: ${stageId}`);
    }
  } catch (error) {
    console.error(`Failed to load autoprompt stage ${stageId}:`, error);
    return { 
      stage: canonicalStage, 
      passed: false, 
      summary: `${stageName}: Error - Failed to load prompt configuration`,
      details: String(error),
    };
  }

  const startTime = Date.now();
  const prompt = promptTemplate
    .replace(/{context}/g, context)
    .replace(/{requirements}/g, userMessage)
    .replace(/{errors}/g, previousSummary ? `Previous issues:\n${previousSummary}` : 'No previous issues.');
  const stageRuntimeInstruction = canonicalStage === 'run_fix'
    ? [
        '## Run & Fix Runtime Requirement',
        'This stage must run the created software or the closest practical runtime check before deciding pass/fixed.',
        'For browser/static apps, run node --check on JavaScript files, then run a browser-like smoke test when possible (for example a short Playwright script using require("playwright") to open the local HTML file and click/test key flows).',
        'Do not use stale temp-file paths from prior tool errors. Do not use node -c. On Windows, run PowerShell commands one at a time or use PowerShell if/else syntax, not && or ||.',
        'If browser runtime errors mention undefined inline handlers, missing DOM ids, or hidden functions, fix the app code and rerun the same browser smoke.',
        'For package apps, run the relevant build/test/start command. Capture concrete failures, fix them with tools, and rerun the same check.',
        'Do not mark pass/fixed from inspection alone. If the software cannot be run, use verdict "fail" and explain the blocker.',
      ].join('\n')
    : '';
  const structuredOutputInstruction = [
    '## Required Structured Result',
    'When your tool work is complete, return exactly one JSON object and no markdown.',
    'Use this schema:',
    '{"verdict":"pass|fixed|fail","summary":"short result","issues_found":[{"severity":"low|medium|high|critical","description":"...","file":"optional path"}],"actions":[{"type":"inspected|edited|verified|other","detail":"..."}],"files_changed":["path"],"verification":[{"command":"optional command","passed":true,"evidence":"short evidence"}],"remaining_issues":["issue still not fixed"]}',
    'The AutoPrompt agent decides the verdict. Use "fixed" only if you changed files. Use "fail" only when blockers or remaining issues exist.',
  ].join('\n');

  // Track actions taken by the autoprompt
  const actionsTaken: string[] = [];
  let fullContent = '';
  let toolEvidenceTranscript = '';
  let iterationCount = 0;
  let meaningfulVerificationCommands = 0;
  let toolEventIndex = 0;
  let lastEditToolEventIndex = 0;
  let lastSuccessfulVerificationEventIndex = 0;
  let lastFailedToolEventIndex = 0;
  let lastSuccessfulBrowserVerificationEventIndex = 0;
  const maxIterations = 15;

  try {
    const messages: ApiMessage[] = [];
    const editState: EditLoopState = new Map();
    let badToolCallTurns = 0;
    let forceNoToolsNextTurn = false;
    let emptyAfterToolContinueCount = 0;
    let lastToolActivitySummary = '';

    // The autoprompt stage prompt is the model's primary instruction set for
    // this stage; it must come BEFORE the conversation history so the model
    // sees it as the controlling system message, otherwise PASS/FAIL output
    // discipline is buried mid-conversation and the verdict regex falls back
    // to "fail".
    messages.push({ role: 'system', content: [prompt, stageRuntimeInstruction, structuredOutputInstruction].filter(Boolean).join('\n\n') });

    if (fullMessageHistory && fullMessageHistory.length > 0) {
      for (const msg of fullMessageHistory) {
        // Skip nested system messages from the chat history so the autoprompt
        // system prompt remains the canonical instruction set.
        if (msg.role === 'system') continue;
        messages.push({
          role: msg.role,
          content: msg.content,
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
          ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
          ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
        });
      }
    }

    let userPrompt = [
      'Continue as if the user asked you to double-check the work now.',
      `Working directory: ${workingDir}`,
      `Original user request:\n${userMessage || '(none)'}`,
      `Latest assistant output / context:\n${truncateMiddle(context || '(no assistant context)', 30000, 'AutoPrompt context')}`,
      `Files modified this run:\n${modifiedFiles?.size ? Array.from(modifiedFiles).join('\n') : '(none recorded)'}`,
      `Prior AutoPrompt stages:\n${summarizeAutoPromptPriorStages(priorStageResults)}`,
      previousSummary ? `Prior unresolved issues:\n${previousSummary}` : 'Prior unresolved issues: none recorded.',
      'Use tools as needed. Inspect real files, fix issues that belong to this stage, verify when appropriate, then return the required JSON object.',
    ].join('\n\n');
    if (priorStageResults && priorStageResults.length > 0) {
      userPrompt += '\n\nDo not repeat prior stage work unless you need to verify or fix something that remains relevant.';
    }
    messages.push({ role: 'user', content: userPrompt });
    const toolFlushAnchorIndex = messages.length - 1;

    // Give autoprompt full tool access with tool loop
    while (iterationCount < maxIterations) {
      iterationCount++;
      
      const chatOpts: Record<string, unknown> = {
        messages: messages as any,
        temperature: 0.3,
        maxTokens: maxTokens ?? 30000,
        topP: 0.9,
        repeatPenalty: 1.1,
        lmOpti,
        apiKey,
        apiProtocol,
      };
      if (forceNoToolsNextTurn) {
        chatOpts.tool_choice = 'none';
      } else {
        chatOpts.tools = TOOL_DEFINITIONS;
      }
      if (model) chatOpts.model = model;
      forceNoToolsNextTurn = false;
      
      const response = await chatCompletion(baseUrl, chatOpts as any);

      if (response.content) {
        fullContent += response.content;
        actionsTaken.push(`Generated analysis (${response.content.length} chars)`);
      }

      // Check if response contains tool calls
      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (!response.content?.trim() && lastToolActivitySummary && emptyAfterToolContinueCount < 3) {
          messages.push({
            role: 'user',
            content: [
              'AUTOPROMPT TOOL LOOP CONTINUE:',
              'Your previous response returned no text and no tool call after receiving tool results.',
              'Continue this AutoPrompt stage now. Follow the stage mission: inspect enough real project state, fix issues you find with tools, verify again, then return the required JSON object.',
              'Do not stop after only listing a directory or reading one file unless that genuinely proves the stage is complete.',
              `Recent tool activity:\n${lastToolActivitySummary}`,
              `Known working directory: ${workingDir}`,
            ].join('\n'),
          });
          emptyAfterToolContinueCount++;
          continue;
        }
        break;
      }

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content || '',
        ...(response.reasoningContent ? { reasoning_content: response.reasoningContent } : {}),
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // Execute tools
      let parseErrorCallsThisIteration = 0;
      let invalidValidationCallsThisIteration = 0;
      let executedValidCallsThisIteration = 0;
      for (const tc of response.toolCalls) {
        toolEventIndex++;
        let args: Record<string, unknown> = {};
        let parseError: string | undefined;
        let didExecuteTool = false;
        try {
          args = JSON.parse(tc.arguments || '{}');
        } catch (error) {
          args = {};
          parseError = `Failed to parse tool arguments as JSON. ${error instanceof Error ? error.message : String(error)}. Raw arguments: "${tc.arguments || ''}"`;
        }

        let toolResult: ToolResult;
        if (parseError) {
          parseErrorCallsThisIteration++;
          toolResult = { success: false, error: parseError };
        } else {
          const argValidation = validateToolArgsBeforeExecution(tc.name, args, tc.arguments);
          if (!argValidation.allowed) invalidValidationCallsThisIteration++;
          toolResult = argValidation.allowed
            ? await executeTool(tc.name, args, workingDir, fileChunkOptions, modifiedFiles, readFiles, editState, cloudModeEnabled)
            : { success: false, error: argValidation.error };
          if (argValidation.allowed) {
            didExecuteTool = true;
            executedValidCallsThisIteration++;
            if (toolResult.success && (tc.name === 'edit_file' || tc.name === 'create_file' || tc.name === 'multi_edit')) {
              lastEditToolEventIndex = toolEventIndex;
            }
            if (toolResult.success && tc.name === 'shell_command' && isMeaningfulVerificationCommand(String(args.command || ''))) {
              meaningfulVerificationCommands++;
              lastSuccessfulVerificationEventIndex = toolEventIndex;
              if (isBrowserRuntimeVerificationCommand(String(args.command || ''))) {
                lastSuccessfulBrowserVerificationEventIndex = toolEventIndex;
              }
            }
          }
        }
        
        if (!toolResult.success) {
          lastFailedToolEventIndex = toolEventIndex;
        }
        actionsTaken.push(`${didExecuteTool ? 'Executed' : 'Rejected'} tool: ${tc.name} (${toolResult.success ? 'success' : 'failed'})`);
        const replayToolResult = compactToolResultForMemory(
          toolResult,
          cloudModeEnabled ? CLOUD_TOOL_RESULT_REPLAY_CHARS : LOCAL_TOOL_RESULT_REPLAY_CHARS,
        );
        const toolSummary = `${tc.name}: ${replayToolResult.success ? 'success' : 'failed'} - ${replayToolResult.success ? String(replayToolResult.result || '') : String(replayToolResult.error || '')}`;
        lastToolActivitySummary = appendBounded(lastToolActivitySummary, toolSummary, 4000);
        toolEvidenceTranscript = appendBounded(toolEvidenceTranscript, toolSummary, 24000);
        
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(replayToolResult),
        });
      }

      const badToolTurn = executedValidCallsThisIteration === 0 &&
        (parseErrorCallsThisIteration > 0 || invalidValidationCallsThisIteration > 0);
      if (executedValidCallsThisIteration > 0) {
        emptyAfterToolContinueCount = 0;
        badToolCallTurns = 0;
      } else if (badToolTurn) {
        badToolCallTurns++;
      } else {
        badToolCallTurns = 0;
      }

      if (badToolCallTurns >= BAD_TOOL_CALL_FLUSH_THRESHOLD) {
        flushMessagesAfterAnchor(messages, toolFlushAnchorIndex);
        messages.push({
          role: 'user',
          content: buildToolRecoveryFlushPrompt(workingDir),
        });
        actionsTaken.push(`Flushed AutoPrompt tool-call state after ${BAD_TOOL_CALL_FLUSH_THRESHOLD} invalid tool-call turns`);
        forceNoToolsNextTurn = true;
        badToolCallTurns = 0;
      } else if (badToolTurn && badToolCallTurns < BAD_TOOL_CALL_FLUSH_THRESHOLD) {
        messages.push({
          role: 'user',
          content: [
            'AUTOPROMPT TOOL ARGUMENT RECOVERY:',
            'Your last AutoPrompt tool turn used invalid or empty JSON arguments and no tool executed.',
            'Retry the stage with complete tool arguments. For read_file, include a concrete path such as index.html, app.js, styles.css, package.json, or README.md when present.',
            'If you do not need tools, return the required JSON object with evidence from successful prior tool results.',
            `Known working directory: ${workingDir}`,
          ].join('\n'),
        });
        emptyAfterToolContinueCount++;
        continue;
      }
    }

    let content = [fullContent.trim(), toolEvidenceTranscript ? `Tool evidence:\n${toolEvidenceTranscript}` : '']
      .filter(Boolean)
      .join('\n\n') || 'No content generated';
    const toolActions = actionsTaken.filter(a => a.startsWith('Executed tool:'));
    const editActions = toolActions.filter(a => a.includes('edit_file') || a.includes('create_file') || a.includes('multi_edit'));
    let structured = parseAutoPromptStructuredResult(fullContent) || parseAutoPromptStructuredResult(content);

    if (!structured) {
      const finalizerMessages: ApiMessage[] = [
        {
          role: 'system',
          content: [
            `${stageName} finalizer.`,
            'The stage has already completed its tool work. Do not call tools.',
            'Return exactly one JSON object and no markdown.',
            'Schema: {"verdict":"pass|fixed|fail","summary":"short result","issues_found":[],"actions":[],"files_changed":[],"verification":[],"remaining_issues":[]}',
            'You decide the verdict from the completed stage output and tool evidence.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Original user request:\n${userMessage}`,
            `Stage output so far:\n${truncateMiddle(content, 12000, 'stage output')}`,
            `Actions taken:\n${actionsTaken.join('\n') || 'No tool actions recorded.'}`,
          ].join('\n\n'),
        },
      ];
      const finalResponse = await chatCompletion(baseUrl, {
        messages: finalizerMessages,
        model,
        temperature: 0.1,
        maxTokens: 1200,
        topP: 0.8,
        repeatPenalty: 1.05,
        lmOpti,
        apiKey,
        apiProtocol,
      });
      if (finalResponse.content) {
        content = `${content}\n\n[Structured Finalizer]\n${finalResponse.content}`;
        structured = parseAutoPromptStructuredResult(finalResponse.content);
      }
    }

    structured = structured || legacyStructuredAutoPromptResult(content, stageName);
    const validationNotes: string[] = [];
    if (!structured) {
      structured = {
        verdict: 'fail',
        summary: `${stageName}: invalid structured result`,
        issues_found: [],
        actions: actionsTaken.map((detail) => ({ type: 'other', detail })),
        files_changed: [],
        verification: [],
        remaining_issues: ['AutoPrompt stage did not return the required structured JSON result.'],
      };
      validationNotes.push('Stage did not return valid structured JSON; marked fail with a format error.');
    }

    const needsVerificationCommand = canonicalStage === 'run_fix';
    const hasVerificationEvidence = meaningfulVerificationCommands > 0 || hasMeaningfulVerificationEvidence(content);
    const latestSuccessfulVerificationIsFresh =
      lastSuccessfulVerificationEventIndex > 0 &&
      lastSuccessfulVerificationEventIndex >= lastEditToolEventIndex &&
      lastSuccessfulVerificationEventIndex >= lastFailedToolEventIndex;
    const structuredHasPassedVerification = structured.verification.some((item) => item.passed);

    if (structured.verdict === 'fixed' && editActions.length === 0 && structured.files_changed.length === 0) {
      structured = {
        ...structured,
        verdict: 'fail',
        remaining_issues: [
          ...structured.remaining_issues,
          'Stage reported fixed but no successful edit action or changed file was recorded.',
        ],
      };
      validationNotes.push('Fixed verdict requires a successful edit action or changed file.');
    }
    if ((structured.verdict === 'pass' || structured.verdict === 'fixed') && needsVerificationCommand && !hasVerificationEvidence && !structuredHasPassedVerification) {
      structured = {
        ...structured,
        verdict: 'fail',
        remaining_issues: [
          ...structured.remaining_issues,
          'Run & Fix reported success without a meaningful runtime/build/test verification.',
        ],
      };
      validationNotes.push('Run & Fix pass/fixed requires runtime, build, or test evidence.');
    }
    if (
      (structured.verdict === 'pass' || structured.verdict === 'fixed') &&
      needsVerificationCommand &&
      lastEditToolEventIndex > 0 &&
      lastSuccessfulVerificationEventIndex < lastEditToolEventIndex
    ) {
      structured = {
        ...structured,
        verdict: 'fail',
        remaining_issues: [
          ...structured.remaining_issues,
          'Run & Fix edited files after its last successful verification command.',
        ],
      };
      validationNotes.push('Run & Fix must verify after the final edit.');
    }
    if (structured.files_changed.length === 0 && editActions.length > 0 && modifiedFiles?.size) {
      structured = { ...structured, files_changed: Array.from(modifiedFiles) };
    }
    if (structured.actions.length === 0 && actionsTaken.length > 0) {
      structured = { ...structured, actions: actionsTaken.map((detail) => ({ type: 'other', detail })) };
    }

    const passed = structured.verdict === 'pass' || structured.verdict === 'fixed';
    const fixed = structured.verdict === 'fixed';
    let summary = fixed
      ? `${stageName}: Fixed`
      : passed
      ? `${stageName}: Passed`
      : `${stageName}: Remaining issues`;
    
    if (editActions.length > 0) {
      summary += ` (${editActions.length} file${editActions.length !== 1 ? 's' : ''} modified)`;
    } else if (toolActions.length > 0) {
      summary += ` (${toolActions.length} tool${toolActions.length !== 1 ? 's' : ''} used)`;
    }

    return {
      stage: canonicalStage,
      passed,
      fixed,
      verdict: structured.verdict,
      summary,
      details: formatAutoPromptStructuredDetails(structured, content, toolEvidenceTranscript, validationNotes),
      structured,
      duration: Date.now() - startTime,
    };
  } catch (error: unknown) {
    const err = error as { message?: string };
    return {
      stage: canonicalStage,
      passed: false,
      verdict: 'fail',
      summary: `${stageName}: Error - ${err.message}`,
      details: `Error occurred after ${iterationCount} iterations. Actions taken: ${actionsTaken.join(', ')}`,
      structured: {
        verdict: 'fail',
        summary: `${stageName}: Error - ${err.message}`,
        issues_found: [],
        actions: actionsTaken.map((detail) => ({ type: 'other', detail })),
        files_changed: [],
        verification: [],
        remaining_issues: [err.message || 'AutoPrompt stage error'],
      },
      duration: Date.now() - startTime,
    };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      messages,
      clientMessages,
      model,
      temperature,
      maxTokens,
      topP,
      topK,
      repeatPenalty,
      lmOpti,
      systemPrompt: legacySystemPrompt,
      workingDirectory,
      lmstudioUrl,
      apiKey,
      apiProtocol,
      conversationId,
      assistantMessageId,
      autoPrompt,
      subAgentEnabled,
      subagentFileScopeEnforcement,
      skillAutoLoad,
      structuredPlanningEnabled,
      goalModeEnabled,
      planningPassEnabled,
      planningPassTimeout,
      autoCompaction,
      contextOverloadProtection,
      cloudMode,
      agent: requestedAgent,
      project_id: requestedProjectId,
    } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Messages array is required' }, { status: 400 });
    }

    const baseUrl = lmstudioUrl || process.env.LMSTUDIO_URL || 'http://localhost:1234';
    const providerApiKey = typeof apiKey === 'string' && apiKey.trim()
      ? apiKey.trim()
      : process.env.LMSTUDIO_API_KEY || process.env.OPENROUTER_API_KEY || undefined;
    const providerApiProtocol: ModelApiProtocol = resolveProviderApiProtocol(baseUrl, apiProtocol, model);
    const lmOptiEnabled = Boolean(lmOpti);
    const cloudModeEnabled = Boolean(cloudMode?.enabled);
    const effectiveTemperature = lmOptiEnabled ? 1 : temperature;
    const effectiveTopP = lmOptiEnabled ? 0.95 : topP;
    const effectiveTopK = lmOptiEnabled ? 20 : topK;
    const effectiveRepeatPenalty = lmOptiEnabled ? undefined : repeatPenalty;
    const workingDir = getWorkingDir(workingDirectory);
    const projectId = typeof requestedProjectId === 'string' && requestedProjectId.trim()
      ? requestedProjectId.trim()
      : crypto.createHash('sha1').update(workingDir).digest('hex').slice(0, 12);
    const todoConversationId = conversationId ? String(conversationId) : '';
    if (structuredPlanningEnabled !== false) getTodoProtocol(todoConversationId, projectId, workingDir);
    const conversationStore = conversationId ? new ConversationStore(workingDir) : undefined;
    const assistantMessageStorageId = typeof assistantMessageId === 'string' && assistantMessageId.trim()
      ? assistantMessageId.trim()
      : `assistant-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const fileChunkOptions: FileChunkOptions = {
      enabled: cloudModeEnabled || contextOverloadProtection?.enabled !== false,
      ...(cloudModeEnabled ? { maxInlineBytes: 24 * 1024, chunkBytes: 12 * 1024 } : {}),
    };
    const cloudToolResultChars = cloudModeEnabled
      ? CLOUD_TOOL_RESULT_REPLAY_CHARS
      : LOCAL_TOOL_RESULT_REPLAY_CHARS;
    const transcriptChars = cloudModeEnabled ? CLOUD_TRANSCRIPT_CHARS : MAX_TRANSCRIPT_CHARS;

    let sessionContext = '';
    try {
      const sessionPath = path.join(workingDir, 'session.json');
      if (fsSync.existsSync(sessionPath)) {
        const session = JSON.parse(fsSync.readFileSync(sessionPath, 'utf8')) as {
          last_run?: string;
          compressed_summary?: string;
          open_issues?: string[];
        };
        sessionContext = `\n\n## Previous session summary (${session.last_run || 'unknown'})\n${session.compressed_summary || ''}`;
        if (session.open_issues?.length) {
          sessionContext += `\n\nOpen issues from last run:\n${session.open_issues.map((i: string) => `- ${i}`).join('\n')}`;
        }
      }
    } catch { /* ignore */ }

    const cloudStateContext = cloudModeEnabled
      ? formatCloudStateForPrompt(readCloudState(workingDir))
      : '';
    const cloudModeContext = cloudModeEnabled
      ? [
          '## Cloud Mode',
          'Use a search-first workflow to minimize remote context usage. Do not request, enumerate, or inject the entire codebase.',
          'Start with grep, glob, and list_directory. Read only the specific files and line ranges needed for the active step.',
          'Large tool results are trimmed for model replay. When trimming is reported, narrow the next search or read instead of requesting a full dump.',
          `Durable cloud state is stored outside the chat prompt at ${CLOUD_STATE_RELATIVE_PATH}. Conversation payloads remain externalized under .ec9v3/payloads.`,
          `Durable cloud state:\n${cloudStateContext}`,
        ].join('\n')
      : '';

    const lastUserContent = messages.filter((m: { role: string }) => m.role === 'user').pop()?.content;
    const lastUserMessage = messageContentToText(lastUserContent);
    const hasImageInput = messages.some((msg: { content?: unknown }) => contentHasImage(msg.content)) ||
      (Array.isArray(clientMessages) && clientMessages.some(chatMessageHasImage));
    const visualContext = hasImageInput
      ? '## Visual Input\nThe current request includes image attachments as image_url content. Treat them as directly visible input. Describe and reason from the image pixels. Do not write phrases like "I can\'t view images", "I can\'t actually see the image", or "based on your description" for this turn unless the image payload is missing or unreadable.'
      : '';
    const effectiveSubAgentEnabled = Boolean(subAgentEnabled) && !hasImageInput;
    const agentSystemPrompt = await loadAgentSystemPrompt(requestedAgent, legacySystemPrompt || '');
    const baseSystemPrompt = skillAutoLoad !== false ? buildSkillPrompt(agentSystemPrompt, lastUserMessage) : agentSystemPrompt;
    let agentsContext = '';
    try {
      const agentsPath = path.join(workingDir, 'AGENTS.md');
      if (fsSync.existsSync(agentsPath)) {
        const content = fsSync.readFileSync(agentsPath, 'utf8').trim();
        if (content) {
          agentsContext += `\n\n## Project patterns (from AGENTS.md — follow these exactly)\n\n${content}`;
        }
      }
    } catch { /* ignore */ }

    const enhancedSystemPrompt = [
      baseSystemPrompt,
      visualContext,
      sessionContext,
      agentsContext,
      cloudModeContext,
      TOOL_USAGE_GUIDANCE,
      QUALITY_GATES,
      structuredPlanningEnabled !== false ? TODO_DISCIPLINE_PROTOCOL : '',
      contextOverloadProtection?.enabled !== false
        ? '## Context Overload Protection\nWhen read_file returns a chunk manifest for a large file, do not ask for the whole original file again. Read only the listed chunk files needed for the task. Edit the original file path, never the generated .ec9v3-context-chunks copies.'
        : '',
    ].filter(Boolean).join('\n\n');

    const loadedSkills: string[] = [];
    if (skillAutoLoad !== false) {
      try {
        const { matchSkills } = await import('@/skills/registry');
        const matches = matchSkills(lastUserMessage);
        loadedSkills.push(...matches.map(m => m.skill.name));
      } catch { /* ignore */ }
    }

    if (conversationStore && conversationId) {
      const conversationAgent = validAgent(requestedAgent);
      const existingConversation = conversationStore.getConversation(String(conversationId));
      const importedMessages = Array.isArray(clientMessages)
        ? (clientMessages as ChatMessage[]).slice(-200)
        : [];
      const firstUserMessage = importedMessages.find((msg) => msg.role === 'user')?.content || lastUserMessage;
      conversationStore.upsertConversation({
        id: String(conversationId),
        title: firstUserMessage ? firstUserMessage.slice(0, 80) : 'New Chat',
        agent: conversationAgent,
        updatedAt: new Date().toISOString(),
      });
      if (existingConversation) {
        const latestUserMessage = [...importedMessages].reverse().find((msg) => msg.role === 'user');
        if (latestUserMessage) {
          conversationStore.upsertMessage(String(conversationId), {
            ...latestUserMessage,
            agent: validAgent(latestUserMessage.agent || conversationAgent),
            isStreaming: false,
          });
        }
      } else {
        importedMessages.forEach((msg, index) => {
          conversationStore.upsertMessage(String(conversationId), {
            ...msg,
            agent: validAgent(msg.agent || conversationAgent),
            isStreaming: false,
          }, index + 1);
        });
      }
    }

    // Filter to only valid conversational API roles. Historical tool calls are
    // summarized as text below instead of replayed as active tool protocol
    // messages; stale or malformed tool history can otherwise trigger provider
    // 500s or trap the model in repeated invalid tool calls on resume.
    const validApiRoles = ['user', 'assistant', 'system'];
    const historyMessages: ApiMessage[] = [];
    for (const msg of messages) {
      if (!validApiRoles.includes(msg.role)) continue;
      const historicalToolSummary = msg.role === 'assistant'
        ? summarizeHistoricalToolCalls(msg.toolCalls)
        : '';
      const content = contentWithVisualInstruction(msg.content ?? null);
      const apiMsg: ApiMessage = {
        role: msg.role,
        content: typeof content === 'string'
          ? `${content}${historicalToolSummary}`
          : content,
      };
      historyMessages.push(apiMsg);
    }
    const persistedHistoryMessages = conversationStore && conversationId
      ? chatMessagesToApiMessages(conversationStore.getMessages(String(conversationId), { limit: cloudModeEnabled ? CLOUD_HISTORY_MESSAGE_LIMIT : 80 }))
      : [];
    const contextHistoryMessages = hasImageInput
      ? historyMessages
      : persistedHistoryMessages.length > 0
      ? persistedHistoryMessages
      : historyMessages;

    const modifiedFiles = new Set<string>();
    const readFiles = new Set<string>();
    const editState: EditLoopState = new Map();
    const unresolvedGoalIssues: string[] = [];
    const encoder = new TextEncoder();
    const streamResponse = new ReadableStream({
      async start(controller) {
        let streamErrorSent = false;
        function send(data: object) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }

        try {
          if (providerApiProtocol === 'anthropic' && (!model || !String(model).trim() || model === 'local-model')) {
            throw new Error('Anthropic-compatible providers require a selected model. Open Settings, refresh API models, and select the Qwen/MiniMax model explicitly.');
          }

          let plan: ExecutionPlan = getDefaultPlan();
          if (planningPassEnabled !== false && effectiveSubAgentEnabled && lastUserMessage) {
            send({ type: 'pipeline_status', summary: 'Planning request with selected model' });
            // Client strips `agent` from API-shape messages, so read it from the
            // request body. Fall back to 'general' rather than scanning messages.
            const planningAgent = requestedAgent || 'general';
            plan = await runPlanningPass(lastUserMessage, planningAgent, workingDir, projectId, loadedSkills, baseUrl, model, planningPassTimeout, lmOptiEnabled, providerApiKey, providerApiProtocol);
          }

          send({ type: 'pipeline_status', summary: 'Preparing conversation context' });
          const compaction = await compactHistoryIfNeeded(
            baseUrl,
            model,
            enhancedSystemPrompt,
            contextHistoryMessages,
            cloudModeEnabled
              ? {
                  ...autoCompaction,
                  enabled: true,
                  limitType: 'percent',
                  percent: Math.min(Number(autoCompaction?.percent || 90), 70),
                }
              : autoCompaction,
            providerApiKey,
            providerApiProtocol,
          );
          const allMessages: ApiMessage[] = [];
          if (enhancedSystemPrompt) {
            allMessages.push({ role: 'system', content: enhancedSystemPrompt });
          }
          allMessages.push(...compaction.messages);
          const loopMessages = [...allMessages];
          const toolFlushAnchorIndex = findLastUserMessageIndex(loopMessages);
          let finalContent = '';
          let assistantTranscript = '';
          let assistantVisibleContent = '';
          const assistantServerToolCalls: ToolCall[] = [];
          let toolLoopCount = 0;
          let planningGateReminderInjected = false;
          let protocolContinueReminderInjected = false;
          let emptyAfterToolContinueCount = 0;
          let lastToolActivitySummary = '';
          let badToolCallTurns = 0;
          let forceNoToolsNextTurn = false;

          if (compaction.event) {
            send({ type: 'auto_compaction', ...compaction.event });
          }

          while (!request.signal.aborted) {
            while (!request.signal.aborted && (goalModeEnabled || toolLoopCount < TOOL_MAX_ITERATIONS)) {
              const contentAccumulator: string[] = [];
              const reasoningAccumulator: string[] = [];
              const pendingToolCalls: Map<string, { name: string; arguments: string }> = new Map();

              const chatOptions: Record<string, unknown> = {
                messages: loopMessages,
                temperature: effectiveTemperature ?? 1,
                maxTokens: maxTokens ?? 30000,
                topP: effectiveTopP ?? 0.95,
                topK: effectiveTopK ?? 20,
                repeatPenalty: effectiveRepeatPenalty,
                lmOpti: lmOptiEnabled,
                apiKey: providerApiKey,
                apiProtocol: providerApiProtocol,
                stream: true,
                signal: request.signal,
              };
              if (forceNoToolsNextTurn) {
                chatOptions.tool_choice = 'none';
              } else {
                chatOptions.tools = TOOL_DEFINITIONS;
              }
              if (model) chatOptions.model = model;
              forceNoToolsNextTurn = false;

              send({
                type: 'pipeline_status',
                stage: 'model_stream',
                summary: `Contacting ${providerApiProtocol === 'anthropic' ? 'Anthropic-compatible' : 'OpenAI-compatible'} model${model ? `: ${model}` : ''}`,
              });

              for await (const chunk of streamChatCompletion(baseUrl, chatOptions as any)) {
                if (request.signal.aborted) throw new Error('Stopped by user');
                if (chunk.type === 'content' && chunk.content) {
                  contentAccumulator.push(chunk.content);
                  assistantVisibleContent = appendBounded(assistantVisibleContent, chunk.content, MAX_TRANSCRIPT_CHARS);
                  send({ type: 'content', content: chunk.content });
                } else if (chunk.type === 'reasoning_content' && chunk.reasoningContent) {
                  reasoningAccumulator.push(chunk.reasoningContent);
                } else if (chunk.type === 'tool_call') {
                  if (chunk.toolCallId && chunk.toolName) {
                    pendingToolCalls.set(chunk.toolCallId, {
                      name: chunk.toolName,
                      arguments: chunk.toolArguments || '{}',
                    });
                  }
                } else if (chunk.type === 'error') {
                  send({ type: 'error', error: chunk.error });
                  streamErrorSent = true;
                  throw new Error(chunk.error || 'LM Studio stream error');
                }
              }

              const assistantContent = contentAccumulator.join('');
              const assistantReasoningContent = reasoningAccumulator.join('');
              if (assistantContent) {
                emptyAfterToolContinueCount = 0;
                assistantTranscript = appendBounded(assistantTranscript, assistantContent, transcriptChars);
                finalContent = assistantContent;
              }

              if (pendingToolCalls.size === 0) {
                if (assistantContent.trim()) badToolCallTurns = 0;
                if (structuredPlanningEnabled !== false && getTodos(todoConversationId, projectId).length === 0) {
                  const reminder = 'STRUCTURED PLANNING GATE FAILED: Structured Planning is enabled, but no conversation-scoped TODO plan exists. Your next response must call todo.write before answering or using any other tool.';
                  if (!planningGateReminderInjected) {
                    loopMessages.push({ role: 'user', content: reminder });
                    planningGateReminderInjected = true;
                  } else if (loopMessages[loopMessages.length - 1]?.role !== 'user') {
                    loopMessages.push({ role: 'user', content: reminder });
                  }
                  continue;
                }
                const activeProtocol = structuredPlanningEnabled !== false
                  ? todoProtocols.get(todoProtocolKey(todoConversationId, projectId))
                  : undefined;
                const hasActiveTodo = activeProtocol?.todos.some((todo) => todo.status === 'in_progress') ?? false;
                if (
                  activeProtocol?.mode === 'PROTOCOL' &&
                  activeProtocol.phase === 'EXECUTE' &&
                  hasActiveTodo &&
                  !assistantContent.trim() &&
                  !protocolContinueReminderInjected
                ) {
                  loopMessages.push({
                    role: 'user',
                    content: [
                      'STRUCTURED PLANNING CONTINUE:',
                      'You declared an in_progress TODO but produced no answer or tool call.',
                      'Continue executing the active TODO now using complete tool arguments.',
                      'Do not stop immediately after creating a TODO plan.',
                      `Known working directory: ${workingDir}`,
                    ].join('\n'),
                  });
                  protocolContinueReminderInjected = true;
                  continue;
                }
                if (!assistantContent.trim() && lastToolActivitySummary && emptyAfterToolContinueCount < 3) {
                  loopMessages.push({
                    role: 'user',
                    content: [
                      'TOOL LOOP CONTINUE:',
                      'Your previous response returned no text and no tool call after receiving tool results.',
                      'Continue the requested task now. If the task requires more tool work, call the next tool with complete JSON arguments.',
                      'If the task is fully complete, answer with the final verified result.',
                      `Recent tool activity:\n${lastToolActivitySummary}`,
                      `Known working directory: ${workingDir}`,
                    ].join('\n'),
                  });
                  emptyAfterToolContinueCount++;
                  continue;
                }
                break;
              }

              // Only real tool-using iterations count against the loop budget;
              // planning-gate retries above use `continue` and must not consume it.
              toolLoopCount++;

              // Sanitize tool-call arguments before replaying to model: a truncated stream
              // can leave partial/invalid JSON that confuses the next turn.
              const toolCallEntries = Array.from(pendingToolCalls.entries());
              const toolCallArray = toolCallEntries.map(([id, tc]) => {
                let safeArgs = tc.arguments || '{}';
                try {
                  JSON.parse(safeArgs);
                } catch {
                  safeArgs = '{}';
                }
                return {
                  id,
                  type: 'function',
                  function: { name: tc.name, arguments: safeArgs },
                };
              });

              const parsedToolCalls: Array<{
                id: string;
                name: string;
                rawArguments: string;
                args: Record<string, unknown>;
                parseError?: string;
              }> = [];

              for (const [tcId, tc] of toolCallEntries) {
                let parsedArgs: Record<string, unknown> = {};
                let parseError: string | undefined;
                try {
                  const argsStr = (tc.arguments || '{}').trim();
                  if (argsStr && argsStr !== '{}') {
                    parsedArgs = JSON.parse(argsStr);
                  }
                } catch (error) {
                  parseError = `Failed to parse tool arguments as JSON. ${error instanceof Error ? error.message : String(error)}. Raw arguments: "${tc.arguments || ''}"`;
                }
                parsedToolCalls.push({
                  id: tcId,
                  name: tc.name,
                  rawArguments: tc.arguments,
                  args: parsedArgs,
                  parseError,
                });
              }
              let parseErrorCallsThisIteration = 0;
              let invalidValidationCallsThisIteration = 0;
              let executedValidCallsThisIteration = 0;

              // beginResponse MUST run before the assistant tool_calls turn is
              // recorded so its todo/non-todo flags stay aligned with the turn
              // they describe (a mid-turn validate_tool_call rejection would
              // otherwise leave the protocol pointing at the previous turn).
              let todoProtocol: TodoProtocol | undefined;
              if (structuredPlanningEnabled !== false) {
                todoProtocol = getTodoProtocol(todoConversationId, projectId, workingDir);
                todoProtocol.beginResponse(parsedToolCalls.map((call) => ({ name: call.name, args: call.args })));
              }
              const planningReminders = new Set<string>();

              loopMessages.push({
                role: 'assistant',
                content: assistantContent || null,
                ...(assistantReasoningContent ? { reasoning_content: assistantReasoningContent } : {}),
                tool_calls: toolCallArray,
              });

              for (const call of parsedToolCalls) {
                send({
                  type: 'tool_call',
                  toolCall: { id: call.id, name: call.name, arguments: call.rawArguments },
                });

                if (call.parseError) {
                  parseErrorCallsThisIteration++;
                  console.error('[Tool Call Parse Error]', call.parseError);
                  assistantTranscript = appendBounded(
                    assistantTranscript,
                    `[Tool ${call.name} rejected]\n${call.parseError}`,
                    transcriptChars,
                  );
                  loopMessages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: JSON.stringify({ success: false, error: call.parseError }),
                  });
                  send({
                    type: 'tool_result',
                    toolCall: {
                      id: call.id,
                      name: call.name,
                      result: call.parseError,
                      isError: true,
                    },
                  });
                  continue;
                }

                const parsedArgs = call.args;
                if (call.name === 'todo' && conversationId) {
                  parsedArgs._conversationId = conversationId;
                  parsedArgs._projectId = projectId;
                  parsedArgs._workingDirectory = workingDir;
                }

                let result: ToolResult;
                let suppressVisibleInvalidTool = false;
                if (structuredPlanningEnabled !== false) {
                  const validation = todoProtocol!.validate_tool_call(call.name, parsedArgs);
                  if (!validation.allowed) {
                    result = { success: false, error: validation.error };
                  } else {
                    if (validation.reminder) planningReminders.add(validation.reminder);
                    const argValidation = validateToolArgsBeforeExecution(call.name, parsedArgs, call.rawArguments);
                    if (!argValidation.allowed) {
                      invalidValidationCallsThisIteration++;
                      suppressVisibleInvalidTool = true;
                    }
                    result = argValidation.allowed
                      ? await executeTool(call.name, parsedArgs, workingDir, fileChunkOptions, modifiedFiles, readFiles, editState, cloudModeEnabled)
                      : { success: false, error: argValidation.error };
                    if (argValidation.allowed) executedValidCallsThisIteration++;
                  }
                } else {
                  const argValidation = validateToolArgsBeforeExecution(call.name, parsedArgs, call.rawArguments);
                  if (!argValidation.allowed) {
                    invalidValidationCallsThisIteration++;
                    suppressVisibleInvalidTool = true;
                  }
                  result = argValidation.allowed
                    ? await executeTool(call.name, parsedArgs, workingDir, fileChunkOptions, modifiedFiles, readFiles, editState, cloudModeEnabled)
                    : { success: false, error: argValidation.error };
                  if (argValidation.allowed) executedValidCallsThisIteration++;
                }

                if (structuredPlanningEnabled !== false) {
                  todoProtocol!.record_tool_result(call.name, result);
                }

                const toolResultText = result.success ? String(result.result || '') : String(result.error || '');
                let streamedToolResult = toolResultText;
                let streamedToolPayloadId: string | undefined;
                const memoryResult = compactToolResultForMemory(result, cloudToolResultChars);
                assistantTranscript = appendBounded(
                  assistantTranscript,
                  `[Tool ${call.name} ${memoryResult.success ? 'success' : 'failed'}]\n${memoryResult.success ? memoryResult.result : memoryResult.error}`,
                  transcriptChars,
                );
                if (!suppressVisibleInvalidTool) {
                  const completedToolCall: ToolCall = {
                    id: call.id,
                    name: call.name,
                    arguments: call.args,
                    result: toolResultText,
                    isError: !result.success,
                    status: result.success ? 'completed' : 'error',
                  };
                  const serverToolCallIndex = assistantServerToolCalls.findIndex((toolCall) => toolCall.id === call.id);
                  if (serverToolCallIndex >= 0) {
                    assistantServerToolCalls[serverToolCallIndex] = completedToolCall;
                  } else {
                    assistantServerToolCalls.push(completedToolCall);
                  }
                  if (conversationStore && conversationId) {
                    const storedMessage = conversationStore.upsertMessage(String(conversationId), {
                      id: assistantMessageStorageId,
                      role: 'assistant',
                      content: assistantVisibleContent,
                      agent: validAgent(requestedAgent),
                      isStreaming: true,
                      toolCalls: assistantServerToolCalls,
                      createdAt: new Date().toISOString(),
                    });
                    const storedToolCall = storedMessage.toolCalls?.find((toolCall) => toolCall.id === call.id);
                    streamedToolResult = storedToolCall?.result ?? streamedToolResult;
                    streamedToolPayloadId = storedToolCall?.resultPayloadId;
                  }
                  send({
                    type: 'tool_result',
                    toolCall: {
                      id: call.id,
                      name: call.name,
                      result: streamedToolPayloadId ? streamedToolResult : (memoryResult.success ? memoryResult.result : memoryResult.error),
                      resultPayloadId: streamedToolPayloadId,
                      isError: !result.success,
                    },
                  });
                } else {
                  send({
                    type: 'tool_result',
                    toolCall: {
                      id: call.id,
                      name: call.name,
                      result: memoryResult.success ? memoryResult.result : memoryResult.error,
                      isError: !result.success,
                    },
                  });
                }
                lastToolActivitySummary = appendBounded(
                  lastToolActivitySummary,
                  `${call.name}: ${memoryResult.success ? 'success' : 'failed'} - ${memoryResult.success ? memoryResult.result : memoryResult.error}`,
                  4000,
                );
                loopMessages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  content: JSON.stringify(memoryResult),
                });
              }

              if (structuredPlanningEnabled !== false) {
                todoProtocol!.finishResponse();
                if (planningReminders.size > 0 && !areTodosComplete(todoProtocol!.todos)) {
                  loopMessages.push({
                    role: 'user',
                    content: `STRUCTURED PLANNING REMINDER: ${Array.from(planningReminders).join(' ')}`,
                  });
                }
              }

              const badToolTurn = executedValidCallsThisIteration === 0 &&
                (parseErrorCallsThisIteration > 0 || invalidValidationCallsThisIteration > 0);
              if (executedValidCallsThisIteration > 0) {
                badToolCallTurns = 0;
              } else if (badToolTurn) {
                badToolCallTurns++;
              } else {
                badToolCallTurns = 0;
              }

              if (badToolCallTurns >= BAD_TOOL_CALL_FLUSH_THRESHOLD) {
                const activeProtocol = structuredPlanningEnabled !== false
                  ? todoProtocols.get(todoProtocolKey(todoConversationId, projectId))
                  : undefined;
                flushMessagesAfterAnchor(loopMessages, toolFlushAnchorIndex);
                loopMessages.push({
                  role: 'user',
                  content: buildToolRecoveryFlushPrompt(workingDir, activeProtocol?.todos),
                });
                send({
                  type: 'tool_recovery_flush',
                  summary: `Recovered from ${BAD_TOOL_CALL_FLUSH_THRESHOLD} consecutive invalid tool-call turns.`,
                  count: BAD_TOOL_CALL_FLUSH_THRESHOLD,
                });
                forceNoToolsNextTurn = true;
                badToolCallTurns = 0;
                continue;
              }
            }

            if (!goalModeEnabled && structuredPlanningEnabled !== false && toolLoopCount >= TOOL_MAX_ITERATIONS) {
              getTodoProtocol(todoConversationId, projectId, workingDir).forceResolveAfterMaxIterations();
            }

            if (!goalModeEnabled) break;

            const todos = getTodos(todoConversationId, projectId);
            send({ type: 'verification_start', summary: 'Goal Mode verification running' });
            const verification = await verifyGoalReached(
              baseUrl,
              model,
              lastUserMessage,
              assistantTranscript || finalContent,
              todos,
              lmOptiEnabled,
              providerApiKey,
              providerApiProtocol,
              request.signal,
            );
            send({
              type: 'verification_result',
              passed: verification.passed,
              summary: verification.summary,
            });

            if (verification.passed) {
              unresolvedGoalIssues.length = 0;
              send({ type: 'content', content: `\n\n**Goal Mode:** ${verification.summary || 'Goal verified.'}` });
              break;
            }

            unresolvedGoalIssues.push(verification.summary || 'Goal Mode verification failed without a summary.');
            send({ type: 'content', content: `\n\n**Goal Mode continuing:** ${verification.summary}\n\n${verification.nextAction}` });
            loopMessages.push({
              role: 'user',
              content: `GOAL MODE VERIFICATION FAILED: ${verification.summary}\n\nContinue until the original goal is fully reached. Next action: ${verification.nextAction || 'inspect, fix, and verify the remaining gap.'}`,
            });
            toolLoopCount = 0;
          }

          if (request.signal.aborted) throw new Error('Stopped by user');

          if (effectiveSubAgentEnabled && finalContent && lastUserMessage) {
            if (plan.subagent_strategy !== 'none' && plan.tasks.length > 0) {
              send({
                type: 'sub_agent_start',
                agentType: plan.subagent_strategy,
                count: plan.tasks.length,
              });
            }

            const subAgentResults = await dispatchSubAgents(
              plan,
              finalContent,
              lastUserMessage,
              baseUrl,
              model,
              workingDir,
              subagentFileScopeEnforcement !== false,
              fileChunkOptions,
              lmOptiEnabled,
              providerApiKey,
              providerApiProtocol,
              cloudModeEnabled,
            );

            if (subAgentResults) {
              for (const sr of subAgentResults) {
                sr.filesWritten.forEach((file) => modifiedFiles.add(file.replace(/\\/g, '/')));
                send({
                  type: 'sub_agent_result',
                  agentType: sr.agentType,
                  result: {
                    content: sr.content,
                    toolCalls: sr.toolCalls,
                    duration: sr.duration,
                  },
                });
                if (conversationStore && conversationId) {
                  conversationStore.upsertMessage(String(conversationId), {
                    id: `subagent-${sr.agentType}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
                    role: 'assistant',
                    content: `Sub-Agent ${sr.agentType} completed:\n\n${sr.content || 'No output'}`,
                    agent: validAgent(requestedAgent),
                    duration: sr.duration,
                    createdAt: new Date().toISOString(),
                  });
                }
              }
            }
          }

          const autoPromptContext = assistantTranscript || finalContent;

          if (autoPrompt && autoPrompt.enabled) {
            const enabledStages = (Object.entries(autoPrompt.stages || {}) as [string, boolean][])
              .filter(([, v]) => v);
            const enabledStageMap = Object.fromEntries(enabledStages);
            const normalizedEnabledStages = normalizeAutoPromptStages(enabledStageMap);

            if (normalizedEnabledStages.length > 0 && autoPromptContext) {
              let previousSummary = '';
              let currentContent = autoPromptContext;
              const allPriorStageResults: AutoPromptStageResult[] = [];

              for (const stageId of normalizedEnabledStages) {
                send({ type: 'auto_prompt_stage_start', stage: stageId });

                const result = await runAutoPromptStage(
                  stageId,
                  currentContent,
                  lastUserMessage,
                  previousSummary,
                  baseUrl,
                  model,
                  workingDir,
                  maxTokens,
                  loopMessages,
                  allPriorStageResults,
                  fileChunkOptions,
                  modifiedFiles,
                  readFiles,
                  lmOptiEnabled,
                  providerApiKey,
                  providerApiProtocol,
                  cloudModeEnabled,
                );

                allPriorStageResults.push(result);
                currentContent += `\n\n[AutoPrompt ${result.stage}]\n${result.summary}\n${result.structured ? JSON.stringify({
                  verdict: result.structured.verdict,
                  files_changed: result.structured.files_changed,
                  remaining_issues: result.structured.remaining_issues,
                }, null, 2) : ''}`;

                send({
                  type: 'auto_prompt_stage',
                  stageResult: result,
                });
                if (conversationStore && conversationId) {
                  conversationStore.upsertMessage(String(conversationId), {
                    id: `autoprompt-${result.stage}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
                    role: 'autoprompt',
                    content: result.summary,
                    agent: validAgent(requestedAgent),
                    autopromptStage: result.stage,
                    autopromptPass: result.passed,
                    autopromptDetails: result.details,
                    duration: result.duration,
                    createdAt: new Date().toISOString(),
                  });
                }

                if (!result.passed) {
                  previousSummary += `\n${result.stage}: ${result.details || result.summary}`;
                }
              }
            } else if (normalizedEnabledStages.length > 0) {
              const skippedResult: AutoPromptStageResult = {
                stage: normalizedEnabledStages[0],
                passed: false,
                verdict: 'fail',
                summary: 'AutoPrompt skipped: no assistant output was available to review',
                details: 'The chat response produced neither assistant content nor usable tool output, so AutoPrompt had no context to evaluate.',
                structured: {
                  verdict: 'fail',
                  summary: 'AutoPrompt skipped: no assistant output was available to review',
                  issues_found: [],
                  actions: [],
                  files_changed: [],
                  verification: [],
                  remaining_issues: ['No assistant output was available to review.'],
                },
                duration: 0,
              };
              send({
                type: 'auto_prompt_stage',
                stageResult: skippedResult,
              });
              if (conversationStore && conversationId) {
                conversationStore.upsertMessage(String(conversationId), {
                  id: `autoprompt-${skippedResult.stage}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
                  role: 'autoprompt',
                  content: skippedResult.summary,
                  agent: validAgent(requestedAgent),
                  autopromptStage: skippedResult.stage,
                  autopromptPass: skippedResult.passed,
                  autopromptDetails: skippedResult.details,
                  duration: skippedResult.duration,
                  createdAt: new Date().toISOString(),
                });
              }
            }
          }

          if (conversationStore && conversationId) {
            conversationStore.upsertMessage(String(conversationId), {
              id: assistantMessageStorageId,
              role: 'assistant',
              content: assistantVisibleContent || finalContent,
              agent: validAgent(requestedAgent),
              isStreaming: false,
              toolCalls: assistantServerToolCalls,
              createdAt: new Date().toISOString(),
            });
          }

          const todoProtocol = todoProtocols.get(todoProtocolKey(todoConversationId, projectId));
          const lastTodo = todoProtocol?.todos
            .slice()
            .reverse()
            .find((todo) => todo.status === 'completed' || todo.status === 'in_progress' || todo.status === 'pending');
          const finalSummarySource = compaction.event?.summary || assistantTranscript || finalContent;
          try {
            const session = {
              project_id: projectId,
              last_run: new Date().toISOString(),
              last_task_id: lastTodo?.id ?? null,
              compressed_summary: tailAtNaturalBoundary(finalSummarySource, 2000),
              files_modified: Array.from(modifiedFiles).sort(),
              open_issues: unresolvedGoalIssues,
            };
            fsSync.writeFileSync(path.join(workingDir, 'session.json'), JSON.stringify(session, null, 2), 'utf-8');
          } catch (sessionError: unknown) {
            const err = sessionError as { message?: string };
            console.warn('Failed to write session.json:', err.message || String(sessionError));
          }

          if (cloudModeEnabled) {
            try {
              writeCloudState({
                projectId,
                workingDirectory: workingDir,
                conversationId: conversationId ? String(conversationId) : null,
                lastTaskId: lastTodo?.id ?? null,
                summary: finalSummarySource,
                filesModified: modifiedFiles,
                filesRead: readFiles,
                openIssues: unresolvedGoalIssues,
                todos: todoProtocol?.todos || [],
              });
            } catch (cloudStateError: unknown) {
              const err = cloudStateError as { message?: string };
              console.warn('Failed to write cloud-state.json:', err.message || String(cloudStateError));
            }
          }

          send({ type: 'done', finalContent: assistantTranscript || finalContent });
          conversationStore?.close();
          controller.close();
        } catch (error: unknown) {
          const err = error as { message?: string };
          if (!streamErrorSent) {
            send({ type: 'error', error: err.message || 'Unknown error' });
          }
          conversationStore?.close();
          controller.close();
        }
      },
    });

    return new Response(streamResponse, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Chat route failed before stream startup:', err.message || String(error));
    return createStreamingErrorResponse(err.message || 'Internal server error');
  }
}
