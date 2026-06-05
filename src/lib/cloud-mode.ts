import fs from 'fs';
import path from 'path';
import { tailAtNaturalBoundary } from '@/lib/tool-output';

export const CLOUD_STATE_RELATIVE_PATH = '.ec9v3/cloud-state.json';
export const CLOUD_HISTORY_MESSAGE_LIMIT = 24;
export const CLOUD_TRANSCRIPT_CHARS = 80_000;

const MAX_SUMMARY_CHARS = 4_000;
const MAX_FILES = 120;
const MAX_ISSUES = 40;
const MAX_TODOS = 80;
const MAX_STATE_STRING_CHARS = 500;

export interface CloudStateTodo {
  id: string;
  content: string;
  status: string;
  priority: string;
}

export interface CloudStateFile {
  version: 1;
  project_id: string;
  working_directory: string;
  updated_at: string;
  last_conversation_id: string | null;
  last_task_id: string | null;
  summary: string;
  files_modified: string[];
  files_read: string[];
  open_issues: string[];
  todos: CloudStateTodo[];
}

export interface CloudStateUpdate {
  projectId: string;
  workingDirectory: string;
  conversationId?: string | null;
  lastTaskId?: string | null;
  summary?: string;
  filesModified?: Iterable<string>;
  filesRead?: Iterable<string>;
  openIssues?: Iterable<string>;
  todos?: CloudStateTodo[];
}

function boundedStrings(values: Iterable<string> | undefined, limit: number): string[] {
  if (!values) return [];
  return Array.from(new Set(Array.from(values).map((value) => String(value).trim().slice(0, MAX_STATE_STRING_CHARS)).filter(Boolean)))
    .slice(-limit);
}

function normalizeState(value: Partial<CloudStateFile>): CloudStateFile | undefined {
  if (!value.project_id || !value.working_directory) return undefined;
  return {
    version: 1,
    project_id: String(value.project_id),
    working_directory: String(value.working_directory),
    updated_at: String(value.updated_at || ''),
    last_conversation_id: value.last_conversation_id ? String(value.last_conversation_id) : null,
    last_task_id: value.last_task_id ? String(value.last_task_id) : null,
    summary: tailAtNaturalBoundary(String(value.summary || ''), MAX_SUMMARY_CHARS),
    files_modified: boundedStrings(value.files_modified, MAX_FILES),
    files_read: boundedStrings(value.files_read, MAX_FILES),
    open_issues: boundedStrings(value.open_issues, MAX_ISSUES),
    todos: Array.isArray(value.todos)
      ? value.todos.slice(-MAX_TODOS).map((todo) => ({
          id: String(todo.id || ''),
          content: String(todo.content || '').slice(0, MAX_STATE_STRING_CHARS),
          status: String(todo.status || 'pending'),
          priority: String(todo.priority || 'medium'),
        }))
      : [],
  };
}

export function readCloudState(workingDirectory: string): CloudStateFile | undefined {
  const filePath = path.join(path.resolve(workingDirectory), CLOUD_STATE_RELATIVE_PATH);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CloudStateFile>);
  } catch {
    return undefined;
  }
}

export function formatCloudStateForPrompt(state: CloudStateFile | undefined): string {
  if (!state) return 'No prior cloud-mode state file exists for this project.';
  const bullets = (values: string[]) => values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : '- (none)';
  return [
    `Updated: ${state.updated_at || 'unknown'}`,
    `Last task: ${state.last_task_id || '(none)'}`,
    `Summary:\n${state.summary || '(none)'}`,
    `Files modified:\n${bullets(state.files_modified)}`,
    `Files read:\n${bullets(state.files_read)}`,
    `Open issues:\n${bullets(state.open_issues)}`,
    `TODO state:\n${state.todos.length > 0 ? state.todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`).join('\n') : '- (none)'}`,
  ].join('\n\n');
}

export function writeCloudState(update: CloudStateUpdate): void {
  const rootDir = path.join(path.resolve(update.workingDirectory), '.ec9v3');
  fs.mkdirSync(rootDir, { recursive: true });
  const state: CloudStateFile = {
    version: 1,
    project_id: update.projectId,
    working_directory: path.resolve(update.workingDirectory),
    updated_at: new Date().toISOString(),
    last_conversation_id: update.conversationId ? String(update.conversationId) : null,
    last_task_id: update.lastTaskId ? String(update.lastTaskId) : null,
    summary: tailAtNaturalBoundary(String(update.summary || ''), MAX_SUMMARY_CHARS),
    files_modified: boundedStrings(update.filesModified, MAX_FILES),
    files_read: boundedStrings(update.filesRead, MAX_FILES),
    open_issues: boundedStrings(update.openIssues, MAX_ISSUES),
    todos: (update.todos || []).slice(-MAX_TODOS).map((todo) => ({
      id: String(todo.id || ''),
      content: String(todo.content || '').slice(0, MAX_STATE_STRING_CHARS),
      status: String(todo.status || 'pending'),
      priority: String(todo.priority || 'medium'),
    })),
  };
  fs.writeFileSync(path.join(rootDir, 'cloud-state.json'), JSON.stringify(state, null, 2), 'utf8');
}
