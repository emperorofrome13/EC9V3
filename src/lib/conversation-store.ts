import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Agent, ChatImageAttachment, ChatMessage, Conversation, ToolCall, UIMessageRole } from '@/types/ec9v3';

const LARGE_TEXT_THRESHOLD = 24_000;
const PREVIEW_CHARS = 8_000;

type PayloadKind = 'message_content' | 'tool_arguments' | 'tool_result' | 'autoprompt_details' | 'attachment_data_url' | 'import';

interface ConversationDbRow {
  id: string;
  title: string;
  agent: Agent;
  plan_state: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageDbRow {
  id: string;
  conversation_id: string;
  role: UIMessageRole;
  content: string;
  content_payload_id: string | null;
  model: string | null;
  agent: Agent;
  autoprompt_stage: string | null;
  autoprompt_pass: number | null;
  autoprompt_details: string | null;
  autoprompt_details_payload_id: string | null;
  tokens: number | null;
  duration: number | null;
  is_streaming: number;
  attachments: string | null;
  tool_calls: string | null;
  tool_results: string | null;
  created_at: string;
  ordinal: number;
}

interface PayloadDbRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  kind: PayloadKind;
  path: string;
  mime_type: string;
  bytes: number;
  created_at: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  agent: Agent;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface PayloadRecord {
  id: string;
  kind: PayloadKind;
  mimeType: string;
  bytes: number;
  fullPath: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function previewText(value: string, maxChars = PREVIEW_CHARS): string {
  if (value.length <= maxChars) return value;
  const marker = `\n\n[Full content stored on disk: ${value.length} characters. Preview preserves natural boundaries where possible.]\n\n`;
  const contentBudget = Math.max(0, maxChars - marker.length);
  const headBudget = Math.floor(contentBudget * 0.72);
  const tailBudget = Math.max(0, contentBudget - headBudget);
  const headCandidate = value.slice(0, headBudget);
  const headBreak = headCandidate.lastIndexOf('\n');
  const head = headBreak >= Math.floor(headBudget * 0.55) ? headCandidate.slice(0, headBreak) : headCandidate;
  const tailStart = Math.max(0, value.length - tailBudget);
  const tailBreak = value.indexOf('\n', tailStart);
  const tail = value.slice(tailBreak !== -1 && tailBreak <= tailStart + Math.floor(tailBudget * 0.45) ? tailBreak + 1 : tailStart);
  return `${head}${marker}${tail}`.slice(0, maxChars);
}

function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[Unserializable payload]';
  }
}

function validAgent(value: unknown): Agent {
  return value === 'cpp_expert' ||
    value === 'python_ml' ||
    value === 'full-stack-developer' ||
    value === 'frontend-styling-expert'
    ? value
    : 'general';
}

function validRole(value: unknown): UIMessageRole {
  return value === 'user' ||
    value === 'assistant' ||
    value === 'system' ||
    value === 'autoprompt' ||
    value === 'tool_use'
    ? value
    : 'assistant';
}

function conversationFromDb(row: ConversationDbRow, messages: ChatMessage[]): Conversation {
  return {
    id: row.id,
    title: row.title,
    agent: validAgent(row.agent),
    messages,
    planState: safeJsonParse(row.plan_state, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromDb(row: MessageDbRow): ChatMessage {
  return {
    id: row.id,
    role: validRole(row.role),
    content: row.content,
    contentPayloadId: row.content_payload_id ?? undefined,
    model: row.model ?? undefined,
    agent: validAgent(row.agent),
    autopromptStage: row.autoprompt_stage ?? undefined,
    autopromptPass: row.autoprompt_pass === null ? undefined : row.autoprompt_pass === 1,
    autopromptDetails: row.autoprompt_details ?? undefined,
    autopromptDetailsPayloadId: row.autoprompt_details_payload_id ?? undefined,
    tokens: row.tokens ?? undefined,
    duration: row.duration ?? undefined,
    isStreaming: Boolean(row.is_streaming),
    attachments: safeJsonParse(row.attachments, undefined),
    toolCalls: safeJsonParse<ToolCall[] | undefined>(row.tool_calls, undefined),
    toolResults: safeJsonParse<ToolCall[] | undefined>(row.tool_results, undefined),
    createdAt: row.created_at,
    serverOrdinal: row.ordinal,
  };
}

export class ConversationStore {
  private readonly db: SqliteDatabase;
  private readonly rootDir: string;
  private readonly payloadsDir: string;

  constructor(workingDirectory: string) {
    this.rootDir = path.join(path.resolve(workingDirectory), '.ec9v3');
    this.payloadsDir = path.join(this.rootDir, 'payloads');
    fs.mkdirSync(this.payloadsDir, { recursive: true });
    this.db = new Database(path.join(this.rootDir, 'conversations.db'));
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  upsertConversation(conversation: {
    id: string;
    title: string;
    agent: Agent;
    planState?: Conversation['planState'];
    createdAt?: string;
    updatedAt?: string;
  }): void {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO conversations (id, title, agent, plan_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        agent = excluded.agent,
        plan_state = excluded.plan_state,
        updated_at = excluded.updated_at
    `).run(
      conversation.id,
      conversation.title || 'New Chat',
      validAgent(conversation.agent),
      conversation.planState ? JSON.stringify(conversation.planState) : null,
      conversation.createdAt ?? timestamp,
      conversation.updatedAt ?? timestamp,
    );
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare<string, ConversationDbRow>('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!row) return undefined;
    return conversationFromDb(row, this.getMessages(id, { limit: 80 }));
  }

  listConversations(limit = 80): ConversationSummary[] {
    const rows = this.db.prepare<number, ConversationDbRow>(`
      SELECT * FROM conversations
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit);

    return rows.map((row) => {
      const messageCount = this.db.prepare<string, { count: number }>(`
        SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?
      `).get(row.id)?.count ?? 0;
      const last = this.db.prepare<string, Pick<MessageDbRow, 'content'> & { ordinal: number }>(`
        SELECT content, ordinal FROM messages
        WHERE conversation_id = ?
        ORDER BY ordinal DESC
        LIMIT 1
      `).get(row.id);
      return {
        id: row.id,
        title: row.title,
        agent: validAgent(row.agent),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount,
        lastMessagePreview: last?.content?.slice(0, 300) ?? '',
      };
    });
  }

  getMessages(conversationId: string, options?: { limit?: number; before?: number }): ChatMessage[] {
    const limit = Math.min(Math.max(options?.limit ?? 80, 1), 200);
    const rows = options?.before !== undefined
      ? this.db.prepare<[string, number, number], MessageDbRow>(`
          SELECT * FROM messages
          WHERE conversation_id = ? AND ordinal < ?
          ORDER BY ordinal DESC
          LIMIT ?
        `).all(conversationId, options.before, limit)
      : this.db.prepare<[string, number], MessageDbRow>(`
          SELECT * FROM messages
          WHERE conversation_id = ?
          ORDER BY ordinal DESC
          LIMIT ?
        `).all(conversationId, limit);

    return rows.reverse().map(messageFromDb);
  }

  upsertMessage(conversationId: string, message: ChatMessage, ordinal?: number): ChatMessage {
    this.ensureConversation(conversationId, message);
    const stored = this.externalizeMessage(conversationId, message);
    const existingOrdinal = this.db.prepare<string, { ordinal: number }>(`
      SELECT ordinal FROM messages WHERE id = ?
    `).get(stored.id)?.ordinal;
    const nextOrdinal = ordinal ?? existingOrdinal ?? this.nextOrdinal(conversationId);

    this.db.prepare(`
      INSERT INTO messages (
        id, conversation_id, role, content, content_payload_id, model, agent,
        autoprompt_stage, autoprompt_pass, autoprompt_details, autoprompt_details_payload_id,
        tokens, duration, is_streaming, attachments, tool_calls, tool_results, created_at, ordinal
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        content_payload_id = excluded.content_payload_id,
        model = excluded.model,
        agent = excluded.agent,
        autoprompt_stage = excluded.autoprompt_stage,
        autoprompt_pass = excluded.autoprompt_pass,
        autoprompt_details = excluded.autoprompt_details,
        autoprompt_details_payload_id = excluded.autoprompt_details_payload_id,
        tokens = excluded.tokens,
        duration = excluded.duration,
        is_streaming = excluded.is_streaming,
        attachments = excluded.attachments,
        tool_calls = excluded.tool_calls,
        tool_results = excluded.tool_results,
        created_at = excluded.created_at
    `).run(
      stored.id,
      conversationId,
      stored.role,
      stored.content,
      stored.contentPayloadId ?? null,
      stored.model ?? null,
      validAgent(stored.agent),
      stored.autopromptStage ?? null,
      stored.autopromptPass === undefined ? null : stored.autopromptPass ? 1 : 0,
      stored.autopromptDetails ?? null,
      stored.autopromptDetailsPayloadId ?? null,
      stored.tokens ?? null,
      stored.duration ?? null,
      stored.isStreaming ? 1 : 0,
      stored.attachments ? JSON.stringify(stored.attachments) : null,
      stored.toolCalls ? JSON.stringify(stored.toolCalls) : null,
      stored.toolResults ? JSON.stringify(stored.toolResults) : null,
      stored.createdAt,
      nextOrdinal,
    );

    this.touchConversation(conversationId, stored.createdAt);
    return stored;
  }

  importConversations(conversations: Conversation[]): { conversations: number; messages: number; payloads: number } {
    let conversationCount = 0;
    let messageCount = 0;
    const beforePayloads = this.payloadCount();

    const importOne = this.db.transaction((items: Conversation[]) => {
      for (const conversation of items) {
        this.upsertConversation({
          id: conversation.id,
          title: conversation.title,
          agent: validAgent(conversation.agent),
          planState: conversation.planState,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        });
        conversationCount++;
        conversation.messages.forEach((message, index) => {
          this.upsertMessage(conversation.id, {
            ...message,
            agent: validAgent(message.agent || conversation.agent),
          }, index + 1);
          messageCount++;
        });
      }
    });

    importOne(conversations);
    return {
      conversations: conversationCount,
      messages: messageCount,
      payloads: Math.max(0, this.payloadCount() - beforePayloads),
    };
  }

  getPayload(id: string): PayloadRecord | undefined {
    const row = this.db.prepare<string, PayloadDbRow>('SELECT * FROM payloads WHERE id = ?').get(id);
    if (!row) return undefined;
    const fullPath = path.resolve(this.rootDir, row.path);
    const payloadRoot = path.resolve(this.payloadsDir);
    const relativeToPayloadRoot = path.relative(payloadRoot, fullPath);
    if (relativeToPayloadRoot.startsWith('..') || path.isAbsolute(relativeToPayloadRoot)) return undefined;
    if (!fs.existsSync(fullPath)) return undefined;
    return {
      id: row.id,
      kind: row.kind,
      mimeType: row.mime_type,
      bytes: row.bytes,
      fullPath,
    };
  }

  close(): void {
    this.db.close();
  }

  private externalizeMessage(conversationId: string, message: ChatMessage): ChatMessage {
    const next: ChatMessage = { ...message };
    if (next.content && next.content.length > LARGE_TEXT_THRESHOLD) {
      next.contentPayloadId = this.writePayload(conversationId, next.id, 'message_content', next.content);
      next.content = previewText(next.content);
    }
    if (next.autopromptDetails && next.autopromptDetails.length > LARGE_TEXT_THRESHOLD) {
      next.autopromptDetailsPayloadId = this.writePayload(conversationId, next.id, 'autoprompt_details', next.autopromptDetails);
      next.autopromptDetails = previewText(next.autopromptDetails);
    }
    next.attachments = next.attachments?.map((attachment) => this.externalizeAttachment(conversationId, next.id, attachment));
    next.toolCalls = next.toolCalls?.map((toolCall) => this.externalizeToolCall(conversationId, next.id, toolCall));
    next.toolResults = next.toolResults?.map((toolCall) => this.externalizeToolCall(conversationId, next.id, toolCall));
    return next;
  }

  private externalizeAttachment(conversationId: string, messageId: string, attachment: ChatImageAttachment): ChatImageAttachment {
    if (!attachment.dataUrl || attachment.dataUrl.length <= LARGE_TEXT_THRESHOLD) return attachment;
    return {
      ...attachment,
      dataUrlPayloadId: this.writePayload(conversationId, messageId, 'attachment_data_url', attachment.dataUrl),
      dataUrl: '',
    };
  }

  private externalizeToolCall(conversationId: string, messageId: string, toolCall: ToolCall): ToolCall {
    const next: ToolCall = { ...toolCall };
    const argsText = stringifyPayload(next.arguments);
    if (argsText.length > LARGE_TEXT_THRESHOLD) {
      next.argumentsPayloadId = this.writePayload(conversationId, messageId, 'tool_arguments', argsText);
      next.arguments = previewText(argsText);
    }
    if (next.result && next.result.length > LARGE_TEXT_THRESHOLD) {
      next.resultPayloadId = this.writePayload(conversationId, messageId, 'tool_result', next.result);
      next.result = previewText(next.result);
    }
    return next;
  }

  private writePayload(conversationId: string, messageId: string, kind: PayloadKind, content: string): string {
    const hash = crypto.createHash('sha256').update(`${conversationId}:${messageId}:${kind}:${content}`).digest('hex');
    const id = `${kind}-${hash.slice(0, 32)}`;
    const shard = id.slice(0, 2);
    const dir = path.join(this.payloadsDir, shard);
    fs.mkdirSync(dir, { recursive: true });
    const fullPath = path.join(dir, `${id}.txt`);
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, content, 'utf-8');
    }
    const relativePath = path.relative(this.rootDir, fullPath).replace(/\\/g, '/');
    this.db.prepare(`
      INSERT INTO payloads (id, conversation_id, message_id, kind, path, mime_type, bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        message_id = excluded.message_id,
        kind = excluded.kind,
        path = excluded.path,
        mime_type = excluded.mime_type,
        bytes = excluded.bytes
    `).run(
      id,
      conversationId,
      messageId,
      kind,
      relativePath,
      'text/plain; charset=utf-8',
      Buffer.byteLength(content, 'utf-8'),
      nowIso(),
    );
    return id;
  }

  private nextOrdinal(conversationId: string): number {
    const row = this.db.prepare<string, { max_ordinal: number | null }>(`
      SELECT MAX(ordinal) AS max_ordinal FROM messages WHERE conversation_id = ?
    `).get(conversationId);
    return (row?.max_ordinal ?? 0) + 1;
  }

  private payloadCount(): number {
    return this.db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM payloads').get()?.count ?? 0;
  }

  private ensureConversation(conversationId: string, message: ChatMessage): void {
    const existing = this.db.prepare<string, { id: string }>('SELECT id FROM conversations WHERE id = ?').get(conversationId);
    if (existing) return;
    this.upsertConversation({
      id: conversationId,
      title: message.content ? message.content.slice(0, 80) : 'New Chat',
      agent: validAgent(message.agent),
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
    });
  }

  private touchConversation(conversationId: string, updatedAt: string): void {
    this.db.prepare(`
      UPDATE conversations
      SET updated_at = ?
      WHERE id = ?
    `).run(updatedAt || nowIso(), conversationId);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent TEXT NOT NULL,
        plan_state TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_payload_id TEXT,
        model TEXT,
        agent TEXT NOT NULL,
        autoprompt_stage TEXT,
        autoprompt_pass INTEGER,
        autoprompt_details TEXT,
        autoprompt_details_payload_id TEXT,
        tokens INTEGER,
        duration INTEGER,
        is_streaming INTEGER NOT NULL DEFAULT 0,
        attachments TEXT,
        tool_calls TEXT,
        tool_results TEXT,
        created_at TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_ordinal
        ON messages(conversation_id, ordinal);

      CREATE TABLE IF NOT EXISTS payloads (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        message_id TEXT,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
}
