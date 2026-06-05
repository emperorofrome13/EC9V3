import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

export interface Project {
  id: string;
  name: string;
  workingDirectory: string;
  createdAt: string;
  lastActive: string;
}

export interface TaskRow {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  dependsOn: string[];
  filesInvolved: string[];
  successCriteria?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  error?: string | null;
  retryCount: number;
}

export interface AuditEntry {
  type: string;
  ts?: string;
  project_id?: string;
  task_id?: string;
  summary?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ProjectDbRow {
  id: string;
  name: string;
  working_directory: string;
  created_at: string;
  last_active: string;
}

interface TaskDbRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  depends_on: string | null;
  files_involved: string | null;
  success_criteria: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
  retry_count: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function projectFromDb(row: ProjectDbRow): Project {
  return {
    id: row.id,
    name: row.name,
    workingDirectory: row.working_directory,
    createdAt: row.created_at,
    lastActive: row.last_active,
  };
}

function taskFromDb(row: TaskDbRow): TaskRow {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    dependsOn: parseStringArray(row.depends_on),
    filesInvolved: parseStringArray(row.files_involved),
    successCriteria: row.success_criteria,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    error: row.error,
    retryCount: row.retry_count,
  };
}

export class TaskStore {
  private readonly db: SqliteDatabase;
  private readonly workingDirectory: string;

  constructor(workingDirectory: string) {
    this.workingDirectory = path.resolve(workingDirectory);
    fs.mkdirSync(this.workingDirectory, { recursive: true });
    this.db = new Database(path.join(this.workingDirectory, 'tasks.db'));
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  upsertProject(project: { id: string; name: string; workingDirectory: string }): void {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO projects (id, name, working_directory, created_at, last_active)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        working_directory = excluded.working_directory,
        last_active = excluded.last_active
    `).run(project.id, project.name, project.workingDirectory, timestamp, timestamp);
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare<string, ProjectDbRow>('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? projectFromDb(row) : undefined;
  }

  upsertTask(task: TaskRow): void {
    this.ensureProjectExists(task.projectId);
    this.db.prepare(`
      INSERT INTO tasks (
        id, project_id, title, description, status, depends_on, files_involved,
        success_criteria, created_at, updated_at, completed_at, error, retry_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        depends_on = excluded.depends_on,
        files_involved = excluded.files_involved,
        success_criteria = excluded.success_criteria,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        error = excluded.error,
        retry_count = excluded.retry_count
    `).run(
      task.id,
      task.projectId,
      task.title,
      task.description ?? null,
      task.status,
      JSON.stringify(task.dependsOn),
      JSON.stringify(task.filesInvolved),
      task.successCriteria ?? null,
      task.createdAt,
      task.updatedAt,
      task.completedAt ?? null,
      task.error ?? null,
      task.retryCount,
    );
  }

  getTask(id: string): TaskRow | undefined {
    const row = this.db.prepare<string, TaskDbRow>('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? taskFromDb(row) : undefined;
  }

  getNextPendingTask(projectId: string): TaskRow | undefined {
    const pendingRows = this.db.prepare<string, TaskDbRow>(`
      SELECT * FROM tasks
      WHERE project_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `).all(projectId);
    const allRows = this.db.prepare<string, Pick<TaskDbRow, 'id' | 'status'>>(`
      SELECT id, status FROM tasks WHERE project_id = ?
    `).all(projectId);
    const statuses = new Map(allRows.map((row) => [row.id, row.status]));

    for (const row of pendingRows) {
      const dependencies = parseStringArray(row.depends_on);
      if (dependencies.every((id) => statuses.get(id) === 'done')) {
        return taskFromDb(row);
      }
    }
    return undefined;
  }

  getAllTasks(projectId: string): TaskRow[] {
    const rows = this.db.prepare<string, TaskDbRow>(`
      SELECT * FROM tasks
      WHERE project_id = ?
      ORDER BY created_at ASC
    `).all(projectId);
    return rows.map(taskFromDb);
  }

  setTaskStatus(id: string, status: TaskStatus, extra?: { error?: string; completedAt?: string }): void {
    const completedAt = extra?.completedAt ?? (status === 'done' ? nowIso() : null);
    this.db.prepare(`
      UPDATE tasks
      SET status = ?, updated_at = ?, completed_at = ?, error = ?
      WHERE id = ?
    `).run(status, nowIso(), completedAt, extra?.error ?? null, id);
  }

  incrementRetry(id: string): void {
    this.db.prepare(`
      UPDATE tasks
      SET retry_count = retry_count + 1, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), id);
  }

  appendAuditLog(entry: AuditEntry): void {
    const auditPath = path.join(this.workingDirectory, 'tasks.jsonl');
    const line = JSON.stringify({ ts: entry.ts ?? nowIso(), ...entry });
    fs.appendFileSync(auditPath, `${line}\n`, 'utf-8');
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','in_progress','done','failed','skipped')),
        depends_on TEXT DEFAULT '[]',
        files_involved TEXT DEFAULT '[]',
        success_criteria TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        retry_count INTEGER DEFAULT 0,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
    `);
  }

  private ensureProjectExists(projectId: string): void {
    if (this.getProject(projectId)) return;
    this.upsertProject({
      id: projectId,
      name: path.basename(this.workingDirectory) || projectId,
      workingDirectory: this.workingDirectory,
    });
  }
}
