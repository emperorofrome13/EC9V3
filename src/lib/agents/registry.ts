import type { ModelApiProtocol, SubAgentType, SubAgentConfig } from '@/types/ec9v3';
import { SUB_AGENTS } from '@/stores/settings-store';
import { chatCompletion } from '@/lib/lmstudio';
import { TOOL_DEFINITIONS } from '@/lib/tools';
import { chunkFileForContext, type FileChunkOptions } from '@/lib/file-chunking';
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
import {
  CLOUD_DIRECTORY_RESULT_LIMIT,
  CLOUD_SEARCH_RESULT_LIMIT,
  CLOUD_TOOL_RESULT_REPLAY_CHARS,
  LOCAL_DIRECTORY_RESULT_LIMIT,
  LOCAL_SEARCH_RESULT_LIMIT,
  LOCAL_TOOL_RESULT_REPLAY_CHARS,
  clampResultLimit,
  formatLineResultWindow,
  trimToolResultForReplay,
} from '@/lib/tool-output';
import { loadPrompt } from '@/lib/prompts';
import type { ExecutionPlan } from '@/lib/planning';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const shellExecOptions = process.platform === 'win32' ? { shell: 'powershell.exe' } : {};

function normalizeWindowsShellCommand(command: string): string {
  if (process.platform !== 'win32') return command;
  return command
    .replace(/(^|[;&|]\s*)(npm|npx|pnpm|yarn)(?=\s)/gi, (_match, prefix: string, bin: string) => `${prefix}${bin}.cmd`)
    .replace(/(^|[;&|]\s*)(npm|npx|pnpm|yarn)$/gi, (_match, prefix: string, bin: string) => `${prefix}${bin}.cmd`);
}

async function execShellCommandForAgent(command: string, options: { cwd: string; timeout: number; maxBuffer: number }) {
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
  } catch (error: any) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    if (/InvalidEndOfLine|not a valid statement separator|The token '&&'/i.test(output)) {
      return execAsync(normalizedCommand, { ...execOptions, shell: 'cmd.exe' });
    }
    throw error;
  }
}

function isNodeSyntaxCheckableForAgent(filePath: string): boolean {
  return Boolean(sourceSyntaxExtension(filePath));
}

const BINARY_FILE_EXTENSIONS = new Set([
  '.db', '.sqlite', '.sqlite3', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.exe', '.dll', '.bin', '.wasm',
]);

async function shouldBlockAgentTextRead(filePath: string): Promise<boolean> {
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

async function validateAgentSourceBeforeWrite(filePath: string, content: string): Promise<string | undefined> {
  if (!isNodeSyntaxCheckableForAgent(filePath)) return undefined;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ec9v3-jscheck-'));
  const tempPath = path.join(tempDir, `candidate${sourceSyntaxExtension(filePath) || '.js'}`);
  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await execFileAsync(process.execPath, ['--check', tempPath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return undefined;
  } catch (error: any) {
    const output = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim();
    return `JavaScript syntax check failed for ${path.basename(filePath)}. The edit was not written. Fix the proposed content and retry.\n${output}`;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexPattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
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

export interface SubAgentTaskSpec {
  id: string;
  objective: string;
  inputFiles?: string[];
  outputFiles?: string[];
  successCriteria?: string[];
  constraints?: string;
  fileScope?: {
    allowed_write: string[];
    allowed_read: string[];
  };
}

export interface SubAgentResult {
  agentType: SubAgentType;
  content: string;
  toolCalls: number;
  duration: number;
  filesWritten: string[];
}

export interface WorklogEntry {
  ts: string;
  type: 'plan' | 'task_complete' | 'subagent_result' | 'goal_verify' | 'repair';
  project_id?: string;
  task_id?: string;
  subagent?: string;
  summary: string;
  data?: Record<string, unknown>;
}

type LegacyAgentSpec = {
  type: string;
  objective: string;
  depends_on?: unknown;
  taskId?: string;
  taskIndex?: number;
};

export function formatTaskSpec(spec: SubAgentTaskSpec): string {
  let formatted = `## Task Specification\n\n`;
  formatted += `**Task ID:** ${spec.id}\n`;
  formatted += `**Objective:** ${spec.objective}\n`;
  if (spec.inputFiles?.length) formatted += `**Input Files:**\n${spec.inputFiles.map(f => `- ${f}`).join('\n')}\n`;
  if (spec.outputFiles?.length) formatted += `**Output Files:**\n${spec.outputFiles.map(f => `- ${f}`).join('\n')}\n`;
  if (spec.successCriteria?.length) formatted += `**Success Criteria:**\n${spec.successCriteria.map(c => `- ${c}`).join('\n')}\n`;
  if (spec.fileScope) {
    formatted += `**File Scope - Allowed Writes:**\n${spec.fileScope.allowed_write.map(f => `- ${f}`).join('\n') || '  (none specified)'}\n`;
    formatted += `**File Scope - Allowed Reads:**\n${spec.fileScope.allowed_read.map(f => `- ${f}`).join('\n') || '  **/*'}\n`;
  }
  if (spec.constraints) formatted += `**Constraints:** ${spec.constraints}\n`;
  return formatted;
}

export async function readWorklog(workingDir: string): Promise<string> {
  try {
    const jsonlPath = path.join(workingDir, 'worklog.jsonl');
    const content = await fs.readFile(jsonlPath, 'utf-8');
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          const entry = JSON.parse(line) as WorklogEntry;
          return `[${entry.ts}] ${entry.type}${entry.subagent ? `/${entry.subagent}` : ''}: ${entry.summary}`;
        } catch {
          return line;
        }
      })
      .join('\n');
  } catch {
    try {
      return await fs.readFile(path.join(workingDir, 'worklog.md'), 'utf-8');
    } catch {
      return '';
    }
  }
}

const worklogQueues = new Map<string, Promise<void>>();

export async function appendWorklog(workingDir: string, entry: WorklogEntry | string): Promise<void> {
  const worklogPath = path.join(workingDir, 'worklog.jsonl');
  const normalizedEntry: WorklogEntry = typeof entry === 'string'
    ? {
      ts: new Date().toISOString(),
      type: 'subagent_result',
      summary: entry,
    }
    : { ...entry, ts: entry.ts || new Date().toISOString() };

  const key = path.resolve(worklogPath);
  const previous = worklogQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      try {
        fsSync.appendFileSync(worklogPath, `${JSON.stringify(normalizedEntry)}\n`, 'utf-8');
      } catch (appendErr: unknown) {
        const err = appendErr as { message?: string };
        console.warn(`Failed to append worklog in ${workingDir}:`, err.message || String(appendErr));
      }
    });
  worklogQueues.set(key, next);
  try {
    await next;
  } finally {
    if (worklogQueues.get(key) === next) worklogQueues.delete(key);
  }
}

export async function buildSubAgentPrompt(
  agentType: SubAgentType,
  taskDescription: string,
  context?: string,
  taskSpec?: SubAgentTaskSpec,
  worklog?: string,
): Promise<string> {
  const agent = SUB_AGENTS[agentType];
  if (!agent) return taskDescription;

  let prompt = await loadPrompt(agent.promptPath);
  if (!prompt) prompt = taskDescription;
  
  if (taskSpec) {
    prompt += `\n\n${formatTaskSpec(taskSpec)}`;
  } else {
    prompt += `\n\n## Task\n${taskDescription}`;
  }

  if (context) {
    prompt += `\n\n## Context\n${context}`;
  }

  if (worklog) {
    prompt += `\n\n## Previous Work Log\n${worklog}\n\nRead the worklog above to understand what has already been done. Build on previous work, don't duplicate it.`;
  }

  prompt += `\n\n## Available Tools\n${agent.tools.join(', ')}`;
  prompt += [
    '\n\n## Tool Instructions',
    'The shell_command tool runs in PowerShell on Windows. Prefer PowerShell commands like Get-ChildItem, Get-Content, Select-Object, Select-String, Test-Path, and Start-Process.',
    'For existing files, read_file first. If exact edit_file matching fails, read_file with numbered:true and use edit_file replace_range/start_line/end_line/new_text.',
    'Do not recover from edit failures by deleting, recreating, or shell-overwriting existing source files.',
    '\n## Instructions',
    'Complete the task thoroughly. Report your findings and any actions taken.',
  ].join('\n');

  return prompt;
}

export function getAgentToolNames(agentType: SubAgentType): string[] {
  return SUB_AGENTS[agentType]?.tools || [];
}

export function getAgentToolDefs(agentType: SubAgentType) {
  const names = getAgentToolNames(agentType);
  return TOOL_DEFINITIONS.filter((t) => names.includes(t.function.name));
}

export function getAllSubAgents(): SubAgentConfig[] {
  return Object.values(SUB_AGENTS);
}

function buildTaskSpec(
  agentConfig: LegacyAgentSpec,
  plan: ExecutionPlan,
  agentIndex: number,
  worklogContext: string[],
): SubAgentTaskSpec {
  const planTasks = plan.tasks || [];
  const task = (
    agentConfig.taskId ? planTasks.find((item) => item.id === agentConfig.taskId) : undefined
  ) || (
    typeof agentConfig.taskIndex === 'number' ? planTasks[agentConfig.taskIndex] : undefined
  ) || planTasks[agentIndex] || planTasks[0];
  const taskScope = task ? plan.file_scoping?.[task.id] : undefined;
  const filesToRead = Array.from(new Set(planTasks.flatMap((item) => item.files_to_read)));
  const successCriteria = planTasks.map((item) => item.success_criteria).filter(Boolean);
  return {
    id: `task-${Date.now()}-${agentConfig.type}`,
    objective: agentConfig.objective,
    inputFiles: task?.files_to_read.length ? task.files_to_read : filesToRead,
    successCriteria: task?.success_criteria ? [task.success_criteria] : successCriteria,
    constraints: [
      taskScope?.allowed_write?.length ? `Only write to files: ${taskScope.allowed_write.join(', ')}` : '',
      'Read the worklog before starting to understand prior context',
      'Append your results to the worklog when done',
    ].filter(Boolean).join('. '),
    fileScope: taskScope ? {
      allowed_write: taskScope.allowed_write || [],
      allowed_read: taskScope.allowed_read || [],
    } : undefined,
  };
}

function topologicalSort(agents: LegacyAgentSpec[]): LegacyAgentSpec[] {
  const visited = new Set<number>();
  const sorted: LegacyAgentSpec[] = [];

  function normalizeDeps(dep: unknown): string[] {
    if (dep == null || dep === false) return [];
    if (Array.isArray(dep)) return dep.flatMap(normalizeDeps);
    if (typeof dep === 'string' || typeof dep === 'number') return [String(dep)];
    if (typeof dep === 'object') {
      const record = dep as Record<string, unknown>;
      return [
        ...normalizeDeps(record.type),
        ...normalizeDeps(record.agent),
        ...normalizeDeps(record.agent_type),
        ...normalizeDeps(record.index),
        ...normalizeDeps(record.task),
        ...normalizeDeps(record.id),
        ...normalizeDeps(record.objective),
      ];
    }
    return [];
  }

  function findDep(dep: string): number {
    // Planners produce dependencies in several shapes; try each in turn:
    //   - exact task id
    //   - "type" of another agent
    //   - "task-N" / numeric index
    //   - exact objective match (legacy)
    let idx = agents.findIndex(a => a.taskId === dep);
    if (idx !== -1) return idx;
    idx = agents.findIndex(a => a.type === dep);
    if (idx !== -1) return idx;
    const numMatch = dep.match(/(\d+)/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (!isNaN(n) && n >= 0 && n < agents.length) return n;
    }
    idx = agents.findIndex(a => a.objective === dep);
    return idx;
  }

  function visit(index: number, stack: Set<number>) {
    if (visited.has(index)) return;
    if (stack.has(index)) return; // cycle guard
    stack.add(index);
    const agent = agents[index];
    if (agent.depends_on) {
      for (const dep of normalizeDeps(agent.depends_on)) {
        const depIndex = findDep(dep);
        if (depIndex !== -1 && depIndex !== index) visit(depIndex, stack);
      }
    }
    stack.delete(index);
    visited.add(index);
    sorted.push(agent);
  }

  agents.forEach((_, i) => visit(i, new Set()));
  return sorted;
}

async function runSingleAgent(
  agentType: SubAgentType,
  taskDescription: string,
  context: string,
  baseUrl: string,
  model: string | undefined,
  workingDir: string,
  taskSpec?: SubAgentTaskSpec,
  worklog?: string,
  enforceFileScope = true,
  fileChunkOptions?: FileChunkOptions,
  lmOpti = false,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
  cloudModeEnabled = false,
): Promise<SubAgentResult> {
  const agent = SUB_AGENTS[agentType];
  if (!agent) return { agentType, content: 'Unknown agent type', toolCalls: 0, duration: 0, filesWritten: [] };

  const startTime = Date.now();
  const systemPrompt = await buildSubAgentPrompt(agentType, taskDescription, context, taskSpec, worklog);
  const toolDefs = getAgentToolDefs(agentType);

  const messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: taskSpec ? formatTaskSpec(taskSpec) : taskDescription },
  ];

  let fullContent = '';
  let totalToolCalls = 0;
  const filesWritten: string[] = [];
  const readFiles = new Set<string>();
  const editState: EditLoopState = new Map();
  const maxIterations = 10;

  for (let i = 0; i < maxIterations; i++) {
    try {
      const chatOpts: Record<string, unknown> = {
        messages: messages as any,
        temperature: 0.3,
        maxTokens: 30000,
        topP: 0.9,
        repeatPenalty: 1.1,
        lmOpti,
        apiKey,
        apiProtocol,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      };
      if (model) chatOpts.model = model;

      const response = await chatCompletion(baseUrl, chatOpts as any);

      if (response.content) {
        fullContent += response.content;
      }

      if (!response.toolCalls || response.toolCalls.length === 0) break;

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

      for (const tc of response.toolCalls) {
        totalToolCalls++;
        let args: Record<string, unknown> = {};
        let parseError: string | undefined;
        try {
          args = JSON.parse(tc.arguments || '{}');
        } catch (error) {
          parseError = `Failed to parse tool arguments as JSON. ${error instanceof Error ? error.message : String(error)}. Raw arguments: "${tc.arguments || ''}"`;
        }

        const argValidation = parseError
          ? { success: false as const, error: parseError }
          : validateAgentToolArgsBeforeExecution(tc.name, args, tc.arguments);
        const toolResult = argValidation.success === false
          ? argValidation
          : await executeToolForAgent(
            tc.name,
            args,
            workingDir,
            taskSpec?.fileScope?.allowed_write,
            enforceFileScope,
            fileChunkOptions,
            readFiles,
            editState,
            cloudModeEnabled,
          );

        if (toolResult.success && (tc.name === 'create_file' || tc.name === 'edit_file' || tc.name === 'multi_edit')) {
          const filePath = String(args.path || args.file_path || '');
          if (filePath) filesWritten.push(filePath);
        }

        const replayToolResult = trimToolResultForReplay(
          toolResult,
          cloudModeEnabled ? CLOUD_TOOL_RESULT_REPLAY_CHARS : LOCAL_TOOL_RESULT_REPLAY_CHARS,
        );
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(replayToolResult),
        });
      }
    } catch (error: unknown) {
      const err = error as { message?: string };
      fullContent += `\n\n[Sub-agent error: ${err.message}]`;
      break;
    }
  }

  if (fullContent) {
    const taskId = taskSpec?.id || agentType;
    await appendWorklog(workingDir, {
      ts: new Date().toISOString(),
      type: 'subagent_result',
      task_id: taskId,
      subagent: agent.name,
      summary: fullContent.slice(0, 2000),
      data: {
        task: taskDescription,
        tool_calls: totalToolCalls,
        files_written: filesWritten,
      },
    });
  }

  return {
    agentType,
    content: fullContent,
    toolCalls: totalToolCalls,
    duration: Date.now() - startTime,
    filesWritten,
  };
}

async function dispatchSequential(
  agents: LegacyAgentSpec[],
  plan: ExecutionPlan,
  context: string,
  userMessage: string,
  baseUrl: string,
  model: string | undefined,
  workingDir: string,
  enforceFileScope: boolean,
  fileChunkOptions?: FileChunkOptions,
  lmOpti = false,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
  cloudModeEnabled = false,
): Promise<SubAgentResult[]> {
  const worklogContext: string[] = [];
  const results: SubAgentResult[] = [];

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const agentType = agent.type as SubAgentType;
    const taskSpec = buildTaskSpec(agent, plan, i, worklogContext);

    const worklog = worklogContext.length > 0
      ? worklogContext.join('\n\n---\n\n')
      : await readWorklog(workingDir);

    const result = await runSingleAgent(agentType, userMessage, context, baseUrl, model, workingDir, taskSpec, worklog || undefined, enforceFileScope, fileChunkOptions, lmOpti, apiKey, apiProtocol, cloudModeEnabled);
    results.push(result);
    worklogContext.push(result.content);
  }

  return results;
}

async function dispatchParallel(
  agents: LegacyAgentSpec[],
  plan: ExecutionPlan,
  context: string,
  userMessage: string,
  baseUrl: string,
  model: string | undefined,
  workingDir: string,
  enforceFileScope: boolean,
  fileChunkOptions?: FileChunkOptions,
  lmOpti = false,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
  cloudModeEnabled = false,
): Promise<SubAgentResult[]> {
  const taskSpecs = agents.map((agent, i) => buildTaskSpec(agent, plan, i, []));
  const worklog = await readWorklog(workingDir);

  const results = await Promise.all(
    agents.map((agent, i) =>
      runSingleAgent(
        agent.type as SubAgentType,
        userMessage,
        context,
        baseUrl,
        model,
        workingDir,
        taskSpecs[i],
        worklog || undefined,
        enforceFileScope,
        fileChunkOptions,
        lmOpti,
        apiKey,
        apiProtocol,
        cloudModeEnabled,
      )
    )
  );

  const conflicts: Array<{ agent: string; file: string; violation: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const task = agents[i].taskId
      ? plan.tasks.find((item) => item.id === agents[i].taskId)
      : plan.tasks[agents[i].taskIndex ?? i];
    const scope = task ? plan.file_scoping?.[task.id] : undefined;
    if (!scope) continue;
    for (const file of results[i].filesWritten) {
      const allowedWrite = scope.allowed_write || [];
      if (!allowedWrite.includes(file) && allowedWrite.length > 0) {
        conflicts.push({
          agent: agents[i].type,
          file,
          violation: `wrote to ${file} which is outside allowed scope`,
        });
      }
    }
  }

  if (conflicts.length > 0) {
    console.warn('File scope conflicts detected:', conflicts);
  }

  return results;
}

export async function dispatchSubAgents(
  plan: ExecutionPlan,
  context: string,
  userMessage: string,
  baseUrl: string,
  model: string | undefined,
  workingDir: string,
  enforceFileScope = true,
  fileChunkOptions?: FileChunkOptions,
  lmOpti = false,
  apiKey?: string,
  apiProtocol: ModelApiProtocol = 'openai',
  cloudModeEnabled = false,
): Promise<SubAgentResult[] | null> {
  if (!plan || !plan.subagent_strategy || plan.subagent_strategy === 'none') {
    return null;
  }

  const mode = plan.subagent_strategy;
  const agents: LegacyAgentSpec[] = plan.tasks.map((task, index) => ({
    type: 'general-purpose',
    objective: [task.title, task.description].filter(Boolean).join('\n\n'),
    depends_on: task.depends_on,
    taskId: task.id,
    taskIndex: index,
  }));

  if (!agents || agents.length === 0) return null;

  switch (mode) {
    case 'single':
      return dispatchSequential(agents.slice(0, 1), plan, context, userMessage, baseUrl, model, workingDir, enforceFileScope, fileChunkOptions, lmOpti, apiKey, apiProtocol, cloudModeEnabled);

    case 'sequential':
      return dispatchSequential(topologicalSort(agents), plan, context, userMessage, baseUrl, model, workingDir, enforceFileScope, fileChunkOptions, lmOpti, apiKey, apiProtocol, cloudModeEnabled);

    case 'parallel':
      return dispatchParallel(agents, plan, context, userMessage, baseUrl, model, workingDir, enforceFileScope, fileChunkOptions, lmOpti, apiKey, apiProtocol, cloudModeEnabled);

    default:
      console.warn(`Unknown subagent mode: ${mode}, skipping dispatch`);
      return null;
  }
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

function safePathForAgent(base: string, relative: string): string {
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.includes('..')) throw new Error('Path traversal denied');
  const resolved = path.resolve(base, normalized);
  const baseResolved = path.resolve(base);
  const relativeToBase = path.relative(baseResolved, resolved);
  if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
    throw new Error('Path traversal denied');
  }
  return resolved;
}

function formatRecoverableAgentToolError(name: string, args: Record<string, unknown>, error: unknown): string {
  const err = error as { code?: string; path?: string; message?: string };
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

async function searchFilesFallbackForAgent(
  workingDir: string,
  searchPath: string,
  pattern: string,
  globPattern?: string,
  caseInsensitive = false,
  maxResults = 50,
): Promise<string> {
  const regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
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
      if (globRegexes && !globRegexes.some((candidate) => candidate.test(relativePath) || candidate.test(entry.name))) continue;
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
      return '(no matches)';
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
  return results.join('\n') || '(no matches)';
}

function isAllowedScopedWrite(workingDir: string, filePath: string, allowedWrite?: string[]): boolean {
  if (!allowedWrite || allowedWrite.length === 0) return true;
  const relativePath = path.relative(path.resolve(workingDir), path.resolve(filePath)).replace(/\\/g, '/');
  return allowedWrite.some((entry) => {
    const normalizedEntry = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    return relativePath === normalizedEntry || globToRegex(normalizedEntry).test(relativePath);
  });
}

function blockedScopedWriteResult(filePath: string): { success: false; error: string } {
  return {
    success: false,
    error: `Write blocked by file scope: ${filePath}`,
  };
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAgentToolArgsBeforeExecution(
  name: string,
  args: Record<string, unknown>,
  rawArguments?: string,
): { success: true } | { success: false; error: string } {
  const emptyArgs = Object.keys(args || {}).length === 0;
  const rawHint = rawArguments ? ` Raw arguments: ${rawArguments.slice(0, 300)}` : '';
  const emptyArgsHint = emptyArgs
    ? `The ${name} tool call arrived with empty arguments ({}). Retry the same tool with complete JSON arguments.${rawHint}`
    : '';

  switch (name) {
    case 'create_file':
      if (!isNonEmptyString(args.path)) {
        return { success: false, error: emptyArgsHint || "create_file requires a non-empty 'path' argument." };
      }
      if (args.content === undefined || args.content === null) {
        return { success: false, error: emptyArgsHint || "create_file requires a 'content' argument." };
      }
      return { success: true };
    case 'edit_file':
      if (!isNonEmptyString(args.path)) {
        return { success: false, error: emptyArgsHint || "edit_file requires a non-empty 'path' argument." };
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
        return { success: false, error: "edit_file requires old_text/new_text, replace_entire_file/new_text, replace_range/start_line/end_line/new_text, insert_at_line/new_text, insert_before/new_text, insert_after/new_text, or append." };
      }
      return { success: true };
    case 'multi_edit':
      if (!isNonEmptyString(args.file_path) || !Array.isArray(args.edits) || args.edits.length === 0) {
        return { success: false, error: emptyArgsHint || "multi_edit requires 'file_path' and a non-empty 'edits' array." };
      }
      return { success: true };
    default:
      return { success: true };
  }
}

async function executeToolForAgent(
  name: string,
  args: Record<string, unknown>,
  workingDir: string,
  allowedWrite?: string[],
  enforceFileScope = true,
  fileChunkOptions?: FileChunkOptions,
  readFiles?: Set<string>,
  editState?: EditLoopState,
  cloudModeEnabled = false,
): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    switch (name) {
    case 'read_file': {
      const p = safePathForAgent(workingDir, String(args.path || ''));
      if (await shouldBlockAgentTextRead(p)) {
        return { success: false, error: `read_file only reads text files. ${args.path} appears to be binary; use an appropriate structured tool or inspect metadata instead.` };
      }
      const hasRequestedLineRange = args.start_line !== undefined || args.end_line !== undefined;
      const chunked = hasRequestedLineRange
        ? null
        : await chunkFileForContext(workingDir, p, String(args.path || ''), fileChunkOptions);
      if (chunked) {
        markFileRead(readFiles, workingDir, p);
        resetEditLoopForPath(editState, workingDir, p);
        return { success: true, result: chunked };
      }
      const c = await fs.readFile(p, 'utf-8');
      markFileRead(readFiles, workingDir, p);
      resetEditLoopForPath(editState, workingDir, p);
      return { success: true, result: formatReadFileContent(c, args) };
    }
    case 'list_directory': {
      const p = args.path ? safePathForAgent(workingDir, String(args.path)) : workingDir;
      const entries = (await fs.readdir(p, { withFileTypes: true }))
        .filter((entry) => !cloudModeEnabled || (entry.name !== '.ec9v3' && entry.name !== '.ec9v3-context-chunks'));
      const maxResults = clampResultLimit(
        args.max_results,
        cloudModeEnabled ? CLOUD_DIRECTORY_RESULT_LIMIT : LOCAL_DIRECTORY_RESULT_LIMIT,
        cloudModeEnabled ? CLOUD_DIRECTORY_RESULT_LIMIT : 500,
      );
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      return {
        success: true,
        result: formatLineResultWindow(entries
          .sort((a: any, b: any) => a.name.localeCompare(b.name))
          .map((e: any) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`), {
            label: 'directory entries',
            maxItems: maxResults,
            offset,
            knownTotal: entries.length,
            continuation: `Call list_directory again with {"path":${JSON.stringify(String(args.path || '.'))},"offset":${offset + maxResults},"max_results":${maxResults}} to continue.`,
          }),
      };
    }
    case 'grep': {
      try {
        const maxResults = clampResultLimit(
          args.max_results,
          cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : LOCAL_SEARCH_RESULT_LIMIT,
          cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 300,
        );
        const rgArgs = ['rg', '--no-heading', '--max-count', String(maxResults)];
        if (args.glob) rgArgs.push('--glob', escapeShellArg(String(args.glob)));
        if (args.case_insensitive) rgArgs.push('-i');
        rgArgs.push('-e', escapeShellArg(String(args.pattern)));
        rgArgs.push(args.path ? safePathForAgent(workingDir, String(args.path)) : workingDir);
        const { stdout } = await execShellCommandForAgent(rgArgs.join(' '), { timeout: 10000, maxBuffer: 2 * 1024 * 1024, cwd: workingDir });
        return {
          success: true,
          result: stdout.trim()
            ? formatLineResultWindow(stdout.trim().split(/\r?\n/).filter(Boolean), {
                label: 'grep matches',
                maxItems: maxResults,
                continuation: 'Narrow the grep pattern, path, or glob to inspect the relevant matches.',
              })
            : '(no matches)',
        };
      } catch (e: any) {
        if (e.stdout) {
          const maxResults = clampResultLimit(
            args.max_results,
            cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : LOCAL_SEARCH_RESULT_LIMIT,
            cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 300,
          );
          return {
            success: true,
            result: formatLineResultWindow(e.stdout.trim().split(/\r?\n/).filter(Boolean), {
              label: 'grep matches',
              maxItems: maxResults,
              continuation: 'Narrow the grep pattern, path, or glob to inspect the relevant matches.',
            }),
          };
        }
        try {
          const fallback = await searchFilesFallbackForAgent(
            workingDir,
            args.path ? safePathForAgent(workingDir, String(args.path)) : workingDir,
            String(args.pattern || ''),
            args.glob ? String(args.glob) : undefined,
            Boolean(args.case_insensitive),
            clampResultLimit(
              args.max_results,
              cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : LOCAL_SEARCH_RESULT_LIMIT,
              cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 300,
            ),
          );
          return { success: true, result: fallback };
        } catch (fallbackError: any) {
          return { success: false, error: `${e.message}; fallback failed: ${fallbackError.message || String(fallbackError)}` };
        }
      }
    }
    case 'glob': {
      try {
        const searchPath = args.path ? safePathForAgent(workingDir, String(args.path)) : workingDir;
        const pattern = String(args.pattern || '*');
        const patternVariants = globPatternVariants(pattern);
        const regexes = patternVariants.map((variant) => globToRegex(variant));
        const excludeDirs = ['node_modules', '.git', '.next', 'dist', 'build', '.ec9v3', '.ec9v3-context-chunks'];
        const maxResults = clampResultLimit(
          args.max_results,
          cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 100,
          cloudModeEnabled ? CLOUD_SEARCH_RESULT_LIMIT : 300,
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
                results.push(fullPath);
                if (results.length > maxResults) return;
              }
            }
          }
        }
        
        await walk(searchPath);
        return {
          success: true,
          result: results.length > 0
            ? formatLineResultWindow(results.sort(), {
                label: 'glob matches',
                maxItems: maxResults,
                continuation: 'Narrow the glob pattern or path to inspect additional files.',
              })
            : '(no files found)',
        };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'shell_command': {
      const cmd = String(args.command || '');
      if (process.platform === 'win32' && /&&|\|\|/.test(cmd)) {
        return {
          success: false,
          error: 'PowerShell command rejected: do not use CMD/Unix && or || chaining. Use PowerShell syntax such as `;`, `if (Test-Path app.js) { ... } else { ... }`, or run one command at a time.',
        };
      }
      const lockedRewriteError = shellCommandWouldRewriteLockedFile(cmd, workingDir, editState);
      if (lockedRewriteError) return { success: false, error: lockedRewriteError };
      const trackedSourceDeleteError = shellCommandWouldDeleteTrackedSourceFile(cmd, workingDir, readFiles);
      if (trackedSourceDeleteError) return { success: false, error: trackedSourceDeleteError };
      if (shellCommandLooksLikeWholeFileRewrite(cmd)) {
        return { success: false, error: 'Shell whole-file rewrite blocked. Use create_file for new files, or read_file plus edit_file for existing files. If the whole existing file is malformed, use edit_file with replace_entire_file:true and new_text after reading it.' };
      }
      for (const p of DANGEROUS_PATTERNS) { if (p.test(cmd)) return { success: false, error: 'Blocked for safety' }; }
      try {
        const { stdout, stderr } = await execShellCommandForAgent(cmd, { cwd: workingDir, timeout: 30000, maxBuffer: 1024 * 1024 });
        return { success: true, result: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || '(no output)' };
      } catch (e: any) {
        const out = [e.stdout?.trim(), e.stderr?.trim()].filter(Boolean).join('\n');
        return { success: false, error: `Exit ${e.code}\n${out || e.message}` };
      }
    }
    case 'web_search': {
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(args.query))}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { success: false, error: `Web search failed: HTTP ${res.status}` };
        const html = await res.text();
        const results: Array<{ title: string; url: string; snippet: string }> = [];
        const regex = /<a[^>]+class="result__a"[^>]*>(.*?)<\/a>.*?<a[^>]+class="result__url"[^>]*>(.*?)<\/a>.*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;
        let m;
        while ((m = regex.exec(html)) !== null && results.length < 5) {
          const title = m[1].replace(/<[^>]+>/g, '').trim();
          const u = m[2].replace(/<[^>]+>/g, '').trim();
          const s = m[3].replace(/<[^>]+>/g, '').trim();
          if (title && u) results.push({ title, url: u, snippet: s });
        }
        return { success: true, result: results.length > 0 ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') : 'No results' };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'read_webpage': {
      try {
        const res = await fetch(String(args.url), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return { success: false, error: `Failed to read webpage: HTTP ${res.status}` };
        const html = await res.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return { success: true, result: text };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'create_file': {
      try {
        const filePath = safePathForAgent(workingDir, String(args.path || ''));
        if (enforceFileScope && !isAllowedScopedWrite(workingDir, filePath, allowedWrite)) {
          return blockedScopedWriteResult(String(args.path || ''));
        }
        if (fsSync.existsSync(filePath)) {
          return { success: false, error: 'File exists. Use edit_file or multi_edit after read_file.' };
        }
        if (isEditLoopLocked(editState, workingDir, filePath)) {
          return { success: false, error: editLoopRewriteBlockedError(workingDir, filePath) };
        }
        const content = String(args.content ?? '');
        const syntaxError = await validateAgentSourceBeforeWrite(filePath, content);
        if (syntaxError) return { success: false, error: syntaxError };
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true, result: `File created: ${args.path}` };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'edit_file': {
      try {
        const filePath = safePathForAgent(workingDir, String(args.path || ''));
        if (enforceFileScope && !isAllowedScopedWrite(workingDir, filePath, allowedWrite)) {
          return blockedScopedWriteResult(String(args.path || ''));
        }
        if (!hasReadFile(readFiles, workingDir, filePath)) {
          return { success: false, error: readBeforeEditError(String(args.path || '')) };
        }
        const content = await fs.readFile(filePath, 'utf-8');
        const editResult = applyEditFileArgs(content, args);
        if (!editResult.success) {
          const recovery = recordEditLoopOutcome(editState, workingDir, filePath, false);
          return recovery ? { success: false, error: `${editResult.error} ${recovery}` } : editResult;
        }
        const syntaxError = await validateAgentSourceBeforeWrite(filePath, editResult.content);
        if (syntaxError) {
          const recovery = lockEditLoopForPath(editState, workingDir, filePath);
          return { success: false, error: recovery ? `${syntaxError} ${recovery}` : syntaxError };
        }
        await fs.writeFile(filePath, editResult.content, 'utf-8');
        markFileRead(readFiles, workingDir, filePath);
        recordEditLoopOutcome(editState, workingDir, filePath, true);
        return { success: true, result: `Edited ${args.path}: ${editResult.summary}` };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'multi_edit': {
      try {
        const filePath = safePathForAgent(workingDir, String(args.file_path || ''));
        if (enforceFileScope && !isAllowedScopedWrite(workingDir, filePath, allowedWrite)) {
          return blockedScopedWriteResult(String(args.file_path || ''));
        }
        if (!hasReadFile(readFiles, workingDir, filePath)) {
          return { success: false, error: readBeforeEditError(String(args.file_path || '')) };
        }
        const edits = Array.isArray(args.edits) ? args.edits as Array<Record<string, unknown>> : [];
        if (edits.length === 0) {
          return { success: false, error: 'multi_edit requires a non-empty edits array' };
        }
        const content = await fs.readFile(filePath, 'utf-8');
        const editResult = applyMultiEditArgs(content, edits);
        if (!editResult.success) {
          const recovery = recordEditLoopOutcome(editState, workingDir, filePath, false);
          return recovery ? { success: false, error: `${editResult.error} ${recovery}` } : editResult;
        }
        const syntaxError = await validateAgentSourceBeforeWrite(filePath, editResult.content);
        if (syntaxError) {
          const recovery = lockEditLoopForPath(editState, workingDir, filePath);
          return { success: false, error: recovery ? `${syntaxError} ${recovery}` : syntaxError };
        }
        await fs.writeFile(filePath, editResult.content, 'utf-8');
        markFileRead(readFiles, workingDir, filePath);
        recordEditLoopOutcome(editState, workingDir, filePath, true);
        return { success: true, result: `Edited ${args.file_path}: ${editResult.summary}` };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    case 'delete_file': {
      try {
        const filePath = safePathForAgent(workingDir, String(args.path || ''));
        if (enforceFileScope && !isAllowedScopedWrite(workingDir, filePath, allowedWrite)) {
          return blockedScopedWriteResult(String(args.path || ''));
        }
        if (isEditLoopLocked(editState, workingDir, filePath)) {
          return { success: false, error: editLoopRewriteBlockedError(workingDir, filePath) };
        }
        if (isSourceLikeFilePath(String(args.path || ''))) {
          return { success: false, error: 'delete_file blocked for source-like files in subagents. Use edit_file or multi_edit for targeted corrections instead of delete/recreate.' };
        }
        await fs.unlink(filePath);
        return { success: true, result: `Deleted: ${args.path}` };
      } catch (e: any) { return { success: false, error: e.message }; }
    }
    default:
      return { success: false, error: `Tool "${name}" not available to sub-agents` };
    }
  } catch (error: unknown) {
    return { success: false, error: formatRecoverableAgentToolError(name, args || {}, error) };
  }
}
