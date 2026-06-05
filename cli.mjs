#!/usr/bin/env node
// EC9v3 CLI — drives the running Next.js app over HTTP so an external
// agent (or test) can issue prompts, receive the streaming SSE events,
// and capture a structured log of the entire interaction.
//
// Usage:
//   node cli.mjs health
//   node cli.mjs models [--lmstudio http://localhost:1234]
//   node cli.mjs chat "your message" [options]
//   node cli.mjs test [--quick|--full]
//
// All runs append JSONL events to logs/cli-<timestamp>.jsonl and a
// human-readable transcript to logs/cli-<timestamp>.log.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, env, stdout, stderr } from 'node:process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// ── arg parsing ─────────────────────────────────────────────────────────

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const [, , command, ...rest] = argv;
const { positional, flags } = parseArgs(rest);

const SERVER_URL = flags.server || env.EC9V3_SERVER || 'http://localhost:3000';
const LMSTUDIO_URL = flags.lmstudio || env.LMSTUDIO_URL || 'http://localhost:1234';
const MODEL = flags.model || env.EC9V3_MODEL || '';
const WORKING_DIR = flags.cwd || env.WORKING_DIRECTORY || process.cwd();
const API_KEY = flags['api-key'] || env.EC9V3_API_KEY || env.LMSTUDIO_API_KEY || env.OPENROUTER_API_KEY || '';
const API_PROTOCOL = flags['api-protocol'] === 'anthropic' ? 'anthropic' : 'openai';

// ── logging ─────────────────────────────────────────────────────────────

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const jsonlPath = path.join(LOG_DIR, `cli-${ts}.jsonl`);
const textPath = path.join(LOG_DIR, `cli-${ts}.log`);
const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' });
const textStream = fs.createWriteStream(textPath, { flags: 'a' });

function logEvent(type, payload) {
  const entry = { t: new Date().toISOString(), type, ...payload };
  jsonlStream.write(JSON.stringify(entry) + '\n');
}

function logHuman(line) {
  textStream.write(line + '\n');
}

function redactedBody(body) {
  return {
    ...body,
    apiKey: body.apiKey ? '[redacted]' : undefined,
  };
}

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const useColor = stdout.isTTY && !flags['no-color'];
const c = (color, s) => (useColor ? `${COLORS[color]}${s}${COLORS.reset}` : s);

function info(msg)  { stderr.write(c('dim',    `[info]  ${msg}\n`)); logHuman(`[info]  ${msg}`); }
function ok(msg)    { stderr.write(c('green',  `[ok]    ${msg}\n`)); logHuman(`[ok]    ${msg}`); }
function warn(msg)  { stderr.write(c('yellow', `[warn]  ${msg}\n`)); logHuman(`[warn]  ${msg}`); }
function fail(msg)  { stderr.write(c('red',    `[fail]  ${msg}\n`)); logHuman(`[fail]  ${msg}`); }

// ── HTTP helpers ────────────────────────────────────────────────────────

async function getJSON(urlPath) {
  const res = await fetch(`${SERVER_URL}${urlPath}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${urlPath}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function postSSE(urlPath, body, onEvent, signal) {
  const res = await fetch(`${SERVER_URL}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} on ${urlPath}: ${text}`);
  }
  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const chunk = JSON.parse(trimmed.slice(6));
        await onEvent(chunk);
      } catch (e) {
        logEvent('parse_error', { line: trimmed, error: String(e) });
      }
    }
  }
}

// ── commands ────────────────────────────────────────────────────────────

async function cmdHealth() {
  info(`server: ${SERVER_URL}`);
  info(`lmstudio: ${LMSTUDIO_URL}`);
  logEvent('health.start', { server: SERVER_URL, lmstudio: LMSTUDIO_URL });

  let serverOk = false, lmOk = false;
  try {
    const res = await fetch(`${SERVER_URL}/`, { signal: AbortSignal.timeout(5000) });
    serverOk = res.status < 500;
    if (serverOk) ok(`server reachable (HTTP ${res.status})`);
    else fail(`server HTTP ${res.status}`);
  } catch (e) {
    fail(`server unreachable: ${e.message}`);
  }
  try {
    const res = await fetch(`${LMSTUDIO_URL}/v1/models`, { signal: AbortSignal.timeout(5000) });
    lmOk = res.ok;
    if (res.ok) {
      let loaded = [];
      try {
        const stateRes = await fetch(`${LMSTUDIO_URL}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
        if (stateRes.ok) {
          const stateData = await stateRes.json();
          loaded = Array.isArray(stateData.data)
            ? stateData.data.filter((m) => m && m.type !== 'embeddings' && m.state === 'loaded')
            : [];
        }
      } catch {
        // Older LM Studio servers may not expose model state.
      }
      if (loaded.length > 0) {
        ok(`lmstudio reachable (${loaded.length} loaded: ${loaded.map((m) => m.id).join(', ')})`);
      } else {
        lmOk = false;
        fail(`lmstudio reachable, but no chat model is loaded`);
      }
    } else fail(`lmstudio HTTP ${res.status}`);
  } catch (e) {
    fail(`lmstudio unreachable: ${e.message}`);
  }
  logEvent('health.done', { serverOk, lmOk });
  return serverOk && lmOk ? 0 : 1;
}

async function cmdModels() {
  info(`listing models from ${LMSTUDIO_URL}`);
  logEvent('models.start', { lmstudio: LMSTUDIO_URL });
  const response = await fetch(`${SERVER_URL}/api/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: LMSTUDIO_URL,
      apiKey: API_KEY || undefined,
      apiProtocol: API_PROTOCOL,
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} on /api/models: ${await response.text().catch(() => '')}`);
  const data = await response.json();
  const models = data.models || [];
  logEvent('models.result', { count: models.length, models });
  if (models.length === 0) {
    warn('no models found');
  } else {
    for (const m of models) stdout.write(`${m.id}\n`);
  }
  return 0;
}

async function cmdChat(message) {
  if (!message) {
    fail('chat requires a message argument');
    return 2;
  }

  const singleAutoPromptStage = flags['autoprompt-stage'];
  const normalizedAutoPromptStage = singleAutoPromptStage === 'task_verify'
    ? 'completeness'
    : singleAutoPromptStage;
  const autoPromptStages = singleAutoPromptStage
    ? {
        review: normalizedAutoPromptStage === 'review',
        placeholder_cleanup: normalizedAutoPromptStage === 'placeholder_cleanup',
        run_fix: normalizedAutoPromptStage === 'run_fix',
        senior_review: normalizedAutoPromptStage === 'senior_review',
        completeness: normalizedAutoPromptStage === 'completeness',
        task_verify: false,
      }
    : {
        review: !!flags.autoprompt,
        placeholder_cleanup: !!flags.autoprompt,
        run_fix: flags.autoprompt === 'full',
        senior_review: flags.autoprompt === 'full',
        completeness: !!flags.autoprompt,
        task_verify: false,
      };

  const body = {
    messages: [{ role: 'user', content: message }],
    model: MODEL || undefined,
    temperature: flags.temperature ? Number(flags.temperature) : 1,
    maxTokens: flags['max-tokens'] ? Number(flags['max-tokens']) : 30000,
    topP: flags['top-p'] ? Number(flags['top-p']) : 0.95,
    topK: flags['top-k'] ? Number(flags['top-k']) : 20,
    repeatPenalty: flags['repeat-penalty'] ? Number(flags['repeat-penalty']) : undefined,
    lmOpti: !!flags['lm-opti'],
    cloudMode: { enabled: !!flags['cloud-mode'] },
    apiKey: API_KEY || undefined,
    apiProtocol: API_PROTOCOL,
    systemPrompt: flags.system || '',
    workingDirectory: WORKING_DIR,
    lmstudioUrl: LMSTUDIO_URL,
    conversationId: `cli-${ts}`,
    autoPrompt: {
      enabled: !!flags.autoprompt || !!singleAutoPromptStage,
      stages: autoPromptStages,
    },
    subAgentEnabled: !!flags['sub-agents'],
    skillAutoLoad: flags['no-skills'] ? false : true,
    planningPassEnabled: !!flags.planning,
    agent: flags.agent || 'general',
  };

  info(`POST /api/chat (model=${body.model || 'auto'}, agent=${body.agent})`);
  info(`logs: ${jsonlPath}`);
  logEvent('chat.start', { message, body: redactedBody({ ...body, messages: undefined }), msgCount: 1 });

  const startedAt = Date.now();
  let assistantText = '';
  const toolCalls = new Map();
  let stageCount = 0;
  let errorSeen = null;

  const controller = new AbortController();
  const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 5 * 60 * 1000;
  const timer = setTimeout(() => {
    warn(`timeout after ${timeoutMs}ms — aborting`);
    controller.abort();
  }, timeoutMs);

  try {
    await postSSE('/api/chat', body, (chunk) => {
      logEvent('sse', chunk);
      switch (chunk.type) {
        case 'content':
          if (chunk.content) {
            assistantText += chunk.content;
            stdout.write(chunk.content);
          }
          break;
        case 'tool_call':
          if (chunk.toolCall) {
            const id = chunk.toolCall.id || `t-${toolCalls.size}`;
            toolCalls.set(id, { ...chunk.toolCall, status: 'running' });
            stdout.write('\n');
            info(`tool call → ${chunk.toolCall.name} ${truncate(chunk.toolCall.arguments, 200)}`);
          }
          break;
        case 'tool_result':
          if (chunk.toolCall) {
            const id = chunk.toolCall.id;
            const prior = toolCalls.get(id) || {};
            toolCalls.set(id, { ...prior, ...chunk.toolCall, status: chunk.toolCall.isError ? 'error' : 'done' });
            const tag = chunk.toolCall.isError ? c('red', 'tool fail') : c('green', 'tool ok  ');
            stderr.write(`[${tag}] ${chunk.toolCall.name}: ${truncate(chunk.toolCall.result, 300)}\n`);
            logHuman(`[tool_result] ${chunk.toolCall.name} ${chunk.toolCall.isError ? 'ERROR' : 'OK'}`);
          }
          break;
        case 'auto_prompt_stage_start':
          info(`autoprompt stage start: ${chunk.stage}${chunk.attempt ? ` (attempt ${chunk.attempt})` : ''}`);
          break;
        case 'auto_compaction':
          info(`auto-compacted history: ${chunk.originalTokenEstimate} -> ${chunk.compactedTokenEstimate} estimated tokens (limit ${chunk.contextLimit}, threshold ${chunk.threshold})`);
          break;
        case 'tool_recovery_flush':
          info(chunk.summary || 'recovered from repeated invalid tool calls');
          break;
        case 'auto_prompt_stage':
          if (chunk.stageResult) {
            stageCount++;
            const r = chunk.stageResult;
            const tag = r.passed ? c('green', 'PASS') : c('red', 'FAIL');
            stderr.write(`\n[autoprompt ${tag}] ${r.stage}: ${r.summary}\n`);
            logHuman(`[autoprompt] ${r.stage} ${r.passed ? 'PASS' : 'FAIL'} — ${r.summary}`);
          }
          break;
        case 'sub_agent_start':
          info(`sub-agent start: ${chunk.agentType}`);
          break;
        case 'sub_agent_result':
          info(`sub-agent done: ${chunk.agentType} (${chunk.result?.duration ?? '?'}ms)`);
          break;
        case 'error':
          errorSeen = chunk.error;
          fail(`stream error: ${chunk.error}`);
          break;
        case 'done':
          // emitted at end of stream by the route
          break;
      }
    }, controller.signal);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      logEvent('chat.aborted', { elapsed: Date.now() - startedAt });
      return 124;
    }
    fail(e.message);
    logEvent('chat.error', { error: String(e) });
    return 1;
  }
  clearTimeout(timer);

  stdout.write('\n');
  const elapsed = Date.now() - startedAt;
  ok(`done in ${elapsed}ms — ${assistantText.length} chars, ${toolCalls.size} tool calls, ${stageCount} autoprompt stages`);
  logEvent('chat.done', {
    elapsed,
    assistantChars: assistantText.length,
    toolCalls: toolCalls.size,
    stages: stageCount,
    error: errorSeen,
  });
  logHuman(`\n=== ASSISTANT FINAL ===\n${assistantText}\n=== END ===\n`);

  return errorSeen ? 1 : 0;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function getRunProjectId(db) {
  if (flags['project-id']) return String(flags['project-id']);
  const projects = db.prepare('SELECT id FROM projects ORDER BY last_active DESC, created_at DESC').all();
  if (projects.length === 1) return projects[0].id;
  return crypto.createHash('sha1').update(WORKING_DIR).digest('hex').slice(0, 12);
}

function getNextPendingTask(db, projectId) {
  const pending = db.prepare(`
    SELECT * FROM tasks
    WHERE project_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `).all(projectId);
  const statusRows = db.prepare('SELECT id, status FROM tasks WHERE project_id = ?').all(projectId);
  const statuses = new Map(statusRows.map((row) => [row.id, row.status]));
  return pending.find((task) => parseJsonArray(task.depends_on).every((depId) => statuses.get(depId) === 'done')) || null;
}

function markTaskStatus(db, id, status, error = null) {
  const now = new Date().toISOString();
  const completedAt = status === 'done' ? now : null;
  db.prepare(`
    UPDATE tasks
    SET status = ?, updated_at = ?, completed_at = ?, error = ?
    WHERE id = ?
  `).run(status, now, completedAt, error, id);
}

function incrementTaskRetry(db, id) {
  db.prepare('UPDATE tasks SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

function appendTaskAudit(entry) {
  fs.appendFileSync(
    path.join(WORKING_DIR, 'tasks.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
    'utf-8',
  );
}

function printTaskSummary(db, projectId) {
  const rows = db.prepare(`
    SELECT id, status, retry_count, title
    FROM tasks
    WHERE project_id = ?
    ORDER BY created_at ASC
  `).all(projectId);
  stdout.write('\nTask summary\n');
  stdout.write('ID             Status       Retries  Title\n');
  stdout.write('-------------  -----------  -------  -----\n');
  for (const row of rows) {
    stdout.write(`${String(row.id).padEnd(13).slice(0, 13)}  ${String(row.status).padEnd(11)}  ${String(row.retry_count).padStart(7)}  ${row.title}\n`);
  }
}

async function cmdRun() {
  const maxTasks = Math.max(1, Number(flags['max-tasks'] || 50));
  const onFail = ['skip', 'stop', 'retry'].includes(flags['on-fail']) ? flags['on-fail'] : 'retry';
  const Database = require('better-sqlite3');
  const dbPath = path.join(WORKING_DIR, 'tasks.db');
  if (!fs.existsSync(dbPath)) {
    fail(`tasks.db not found at ${dbPath}`);
    return 1;
  }

  const db = new Database(dbPath);
  const projectId = getRunProjectId(db);
  info(`run project=${projectId} maxTasks=${maxTasks} onFail=${onFail}`);
  logEvent('run.start', { projectId, maxTasks, onFail, dbPath });

  let processed = 0;
  let failures = 0;

  try {
    while (processed < maxTasks) {
      const task = getNextPendingTask(db, projectId);
      if (!task) {
        ok('no pending runnable tasks');
        printTaskSummary(db, projectId);
        return failures > 0 && onFail === 'stop' ? 1 : 0;
      }

      if (task.retry_count >= 3 && onFail !== 'retry') {
        warn(`skipping ${task.id}: retry_count is ${task.retry_count}`);
        markTaskStatus(db, task.id, 'skipped', 'retry limit reached');
        appendTaskAudit({ type: 'task_skipped', project_id: projectId, task_id: task.id, summary: task.title });
        continue;
      }

      processed++;
      markTaskStatus(db, task.id, 'in_progress');
      const message = [task.title, task.description].filter(Boolean).join('\n\n');
      info(`task ${processed}/${maxTasks}: ${task.id} ${task.title}`);
      logEvent('run.task.start', { taskId: task.id, title: task.title });

      const controller = new AbortController();
      const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 30 * 60 * 1000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let doneSeen = false;
      let errorSeen = null;

      const body = {
        messages: [{ role: 'user', content: message }],
        model: MODEL || undefined,
        temperature: flags.temperature ? Number(flags.temperature) : 1,
        maxTokens: flags['max-tokens'] ? Number(flags['max-tokens']) : 30000,
        topP: flags['top-p'] ? Number(flags['top-p']) : 0.95,
        topK: flags['top-k'] ? Number(flags['top-k']) : 20,
        repeatPenalty: flags['repeat-penalty'] ? Number(flags['repeat-penalty']) : undefined,
        lmOpti: !!flags['lm-opti'],
        cloudMode: { enabled: !!flags['cloud-mode'] },
        apiKey: API_KEY || undefined,
        apiProtocol: API_PROTOCOL,
        systemPrompt: flags.system || '',
        workingDirectory: WORKING_DIR,
        project_id: projectId,
        lmstudioUrl: LMSTUDIO_URL,
        conversationId: `cli-run-${projectId}-${task.id}-${Date.now()}`,
        autoPrompt: { enabled: false, stages: {} },
        subAgentEnabled: !!flags['sub-agents'],
        skillAutoLoad: flags['no-skills'] ? false : true,
        planningPassEnabled: false,
        structuredPlanningEnabled: false,
        agent: flags.agent || 'general',
      };

      try {
        await postSSE('/api/chat', body, (chunk) => {
          logEvent('run.sse', { taskId: task.id, chunk });
          switch (chunk.type) {
            case 'content':
              if (chunk.content) stdout.write(chunk.content);
              break;
            case 'tool_call':
              if (chunk.toolCall) info(`tool call -> ${chunk.toolCall.name}`);
              break;
            case 'tool_result':
              if (chunk.toolCall) info(`tool result -> ${chunk.toolCall.name} ${chunk.toolCall.isError ? 'failed' : 'ok'}`);
              break;
            case 'tool_recovery_flush':
              info(chunk.summary || 'recovered from repeated invalid tool calls');
              break;
            case 'error':
              errorSeen = chunk.error || 'stream error';
              fail(`task ${task.id}: ${errorSeen}`);
              break;
            case 'done':
              doneSeen = true;
              break;
          }
        }, controller.signal);
      } catch (e) {
        errorSeen = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message;
      } finally {
        clearTimeout(timer);
      }

      stdout.write('\n');
      if (doneSeen && !errorSeen) {
        markTaskStatus(db, task.id, 'done');
        appendTaskAudit({ type: 'task_complete', project_id: projectId, task_id: task.id, summary: task.title });
        ok(`task done: ${task.id}`);
        continue;
      }

      failures++;
      markTaskStatus(db, task.id, 'failed', errorSeen || 'connection ended before done');
      incrementTaskRetry(db, task.id);
      logEvent('run.task.failed', { taskId: task.id, error: errorSeen });

      if (onFail === 'skip') {
        markTaskStatus(db, task.id, 'skipped', errorSeen || 'failed and skipped by policy');
        continue;
      }
      if (onFail === 'stop') {
        printTaskSummary(db, projectId);
        return 1;
      }
      markTaskStatus(db, task.id, 'pending', errorSeen || 'retry scheduled');
    }

    warn(`max task cap reached (${maxTasks})`);
    printTaskSummary(db, projectId);
    return failures > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

function truncate(v, n) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── test runner ─────────────────────────────────────────────────────────

async function cmdTest() {
  const full = !!flags.full;
  info(`running ${full ? 'full' : 'quick'} test suite`);
  logEvent('test.start', { full });

  const results = [];
  const cases = [
    {
      name: 'health',
      fn: async () => {
        const code = await cmdHealth();
        return { ok: code === 0 };
      },
    },
    {
      name: 'models_listed',
      fn: async () => {
        const data = await getJSON(`/api/models?url=${encodeURIComponent(LMSTUDIO_URL)}`);
        return { ok: Array.isArray(data.models), count: data.models?.length ?? 0 };
      },
    },
    {
      name: 'chat_simple',
      fn: () => runChatProbe('Reply with the single word: pong', {
        check: (text) => /pong/i.test(text),
      }),
    },
  ];
  if (full) {
    cases.push({
      name: 'chat_tool_use',
      fn: () => runChatProbe('List the files in the current directory using the list_directory tool.', {
        check: (text, events) => events.some((e) => e.type === 'tool_call'),
        timeoutMs: 120_000,
      }),
    });
    cases.push({
      name: 'chat_autoprompt_review',
      fn: () => runChatProbe('Say hello.', {
        autoPrompt: { enabled: true, stages: { review: true, placeholder_cleanup: false, run_fix: false, senior_review: false, completeness: false, task_verify: false } },
        check: (text, events) => events.some((e) => e.type === 'auto_prompt_stage'),
        timeoutMs: 180_000,
      }),
    });
  }

  for (const tc of cases) {
    stderr.write(`\n${c('bold', '▶')} ${tc.name}\n`);
    const start = Date.now();
    let outcome;
    try {
      outcome = await tc.fn();
      const passed = !!outcome?.ok;
      const dur = Date.now() - start;
      results.push({ name: tc.name, passed, ms: dur, detail: outcome });
      if (passed) ok(`${tc.name} (${dur}ms)`);
      else fail(`${tc.name} (${dur}ms): ${JSON.stringify(outcome)}`);
      logEvent('test.case', { name: tc.name, passed, ms: dur, outcome });
    } catch (e) {
      const dur = Date.now() - start;
      results.push({ name: tc.name, passed: false, ms: dur, error: String(e) });
      fail(`${tc.name} threw: ${e.message}`);
      logEvent('test.case', { name: tc.name, passed: false, ms: dur, error: String(e) });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  stderr.write(`\n${passed === total ? c('green', '✓') : c('red', '✗')} ${passed}/${total} passed\n`);
  logEvent('test.done', { passed, total, results });
  return passed === total ? 0 : 1;
}

async function runChatProbe(message, opts = {}) {
  const events = [];
  let assistantText = '';
  const body = {
    messages: [{ role: 'user', content: message }],
    model: MODEL || undefined,
    temperature: 0.3,
    maxTokens: 4096,
    topP: flags['top-p'] ? Number(flags['top-p']) : 0.95,
    topK: flags['top-k'] ? Number(flags['top-k']) : 20,
    repeatPenalty: flags['repeat-penalty'] ? Number(flags['repeat-penalty']) : undefined,
    cloudMode: { enabled: !!flags['cloud-mode'] },
    apiKey: API_KEY || undefined,
    apiProtocol: API_PROTOCOL,
    systemPrompt: '',
    workingDirectory: WORKING_DIR,
    lmstudioUrl: LMSTUDIO_URL,
    conversationId: `cli-test-${Date.now()}`,
    autoPrompt: opts.autoPrompt || { enabled: false, stages: {} },
    subAgentEnabled: false,
    skillAutoLoad: false,
    planningPassEnabled: false,
    agent: 'general',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 60_000);
  try {
    await postSSE('/api/chat', body, (chunk) => {
      events.push(chunk);
      logEvent('test.sse', { probe: message.slice(0, 60), chunk });
      if (chunk.type === 'content' && chunk.content) assistantText += chunk.content;
    }, controller.signal);
  } finally {
    clearTimeout(timer);
  }
  const checkOk = opts.check ? !!opts.check(assistantText, events) : assistantText.length > 0;
  return { ok: checkOk, chars: assistantText.length, events: events.length, sample: assistantText.slice(0, 200) };
}

// ── main ────────────────────────────────────────────────────────────────

function usage() {
  stderr.write(`EC9v3 CLI

  node cli.mjs health
  node cli.mjs models                       List LM Studio models
  node cli.mjs chat "<message>" [opts]      Send a message, stream response
  node cli.mjs run [opts]                   Run pending tasks from tasks.db
  node cli.mjs test [--full]                Run smoke tests against the server

Options:
  --server <url>        EC9v3 server (default ${SERVER_URL})
  --lmstudio <url>      LM Studio (default ${LMSTUDIO_URL})
  --model <id>          Model to use (default: server-loaded)
  --cwd <path>          Working directory for tools
  --agent <name>        Agent name (default: general)
  --system <text>       Override system prompt
  --autoprompt [full]   Enable autoprompt stages (review+placeholder_cleanup+completeness; 'full' adds run_fix+senior_review)
  --autoprompt-stage <stage>
                        Enable one autoprompt stage: review, placeholder_cleanup, run_fix, senior_review, completeness
  --sub-agents          Enable sub-agent dispatch
  --planning            Enable planning pass
  --no-skills           Disable skill auto-load
  --temperature <n>     Sampling temperature
  --top-p <n>           Top-p sampling value (default 0.95)
  --top-k <n>           Top-k sampling value (default 20)
  --repeat-penalty <n>  Repeat penalty; omitted by default
  --lm-opti             Enable LM Studio/Qwen thinking fields and LM sampling profile
  --cloud-mode          Use external state files, search-first discovery, and tighter tool-output replay limits
  --api-key <key>       Provider API key; can also use OPENROUTER_API_KEY
  --api-protocol <name> Provider wire protocol: openai or anthropic (default openai)
  --max-tokens <n>      Max output tokens
  --timeout <sec>       Per-request timeout (default 300)
  --project-id <id>     For 'run': project id to process
  --max-tasks <n>       For 'run': max tasks to process (default 50)
  --on-fail <policy>    For 'run': retry, skip, or stop (default retry)
  --no-color            Disable ANSI colors
  --full                For 'test': run extended probes (tools + autoprompt)

Logs: ${LOG_DIR}\\cli-<timestamp>.jsonl  +  .log
`);
}

async function main() {
  logEvent('cli.start', { command, flags, server: SERVER_URL, lmstudio: LMSTUDIO_URL, model: MODEL, cwd: WORKING_DIR });
  let code = 0;
  try {
    switch (command) {
      case 'health':  code = await cmdHealth(); break;
      case 'models':  code = await cmdModels(); break;
      case 'chat':    code = await cmdChat(positional.join(' ')); break;
      case 'run':     code = await cmdRun(); break;
      case 'test':    code = await cmdTest(); break;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        usage();
        code = command ? 0 : 2;
        break;
      default:
        fail(`unknown command: ${command}`);
        usage();
        code = 2;
    }
  } catch (e) {
    fail(e.message || String(e));
    logEvent('cli.fatal', { error: String(e), stack: e?.stack });
    code = 1;
  }
  logEvent('cli.end', { code });
  jsonlStream.end();
  textStream.end();
  process.exitCode = code;
}

main();
