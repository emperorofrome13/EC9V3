import { create } from 'zustand';
import type { Agent, ChatMessage, Conversation, PlanState } from '@/types/ec9v3';

const MAX_STORED_CONVERSATIONS = 30;
const MAX_STORED_MESSAGES_PER_CONVERSATION = 80;
const MAX_STORED_MESSAGE_CHARS = 120_000;
const MAX_STORED_TOOL_PAYLOAD_CHARS = 30_000;
const MAX_STORED_AUTOPROMPT_DETAILS_CHARS = 60_000;
const MAX_STORED_ATTACHMENTS = 6;
const MAX_STORED_ATTACHMENT_DATA_URL_CHARS = 12_000_000;

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Truncated ${value.length - limit} characters for browser performance]`;
}

function truncateUnknown(value: unknown, limit: number): unknown {
  if (typeof value === 'string') return truncateString(value, limit);
  if (value === undefined || value === null) return value;

  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length <= limit) return value;
    return `[Large payload omitted for browser performance: ${serialized.length} characters]`;
  } catch {
    return '[Unserializable payload omitted for browser performance]';
  }
}

function sanitizeMessageForStorage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: truncateString(message.content || '', MAX_STORED_MESSAGE_CHARS),
    attachments: message.attachments
      ?.filter((attachment) => attachment.dataUrl.length <= MAX_STORED_ATTACHMENT_DATA_URL_CHARS)
      .slice(0, MAX_STORED_ATTACHMENTS),
    autopromptDetails: message.autopromptDetails
      ? truncateString(message.autopromptDetails, MAX_STORED_AUTOPROMPT_DETAILS_CHARS)
      : message.autopromptDetails,
    toolCalls: message.toolCalls?.map((toolCall) => ({
      ...toolCall,
      arguments: truncateUnknown(toolCall.arguments, MAX_STORED_TOOL_PAYLOAD_CHARS) as typeof toolCall.arguments,
      result: toolCall.result
        ? truncateString(toolCall.result, MAX_STORED_TOOL_PAYLOAD_CHARS)
        : toolCall.result,
    })),
    toolResults: message.toolResults?.map((toolCall) => ({
      ...toolCall,
      arguments: truncateUnknown(toolCall.arguments, MAX_STORED_TOOL_PAYLOAD_CHARS) as typeof toolCall.arguments,
      result: toolCall.result
        ? truncateString(toolCall.result, MAX_STORED_TOOL_PAYLOAD_CHARS)
        : toolCall.result,
    })),
  };
}

function sanitizeConversationsForStorage(conversations: Conversation[]): Conversation[] {
  return conversations
    .slice(0, MAX_STORED_CONVERSATIONS)
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.slice(-MAX_STORED_MESSAGES_PER_CONVERSATION).map(sanitizeMessageForStorage),
    }));
}

function trimConversationMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_STORED_MESSAGES_PER_CONVERSATION);
}

export interface ActiveAgent {
  id: string;
  name: string;
  type: 'main' | 'sub';
  status: 'idle' | 'running' | 'completed';
  startTime: number;
}

export interface ActiveTool {
  id: string;
  name: string;
  status: 'running' | 'completed';
  startTime: number;
}

export interface ActiveSkill {
  id: string;
  name: string;
  description: string;
  status: 'active';
}

export type RunStatus = 'idle' | 'running' | 'success' | 'error' | 'stopped';

export interface RunState {
  status: RunStatus;
  startedAt: number | null;
  completedAt: number | null;
  message?: string;
}

export interface StreamChunkTrace {
  id: string;
  type: string;
  preview: string;
  timestamp: number;
}

export interface AIActivityState {
  activeAgents: ActiveAgent[];
  activeTools: ActiveTool[];
  activeSkills: ActiveSkill[];
  streamChunks: StreamChunkTrace[];
  runState: RunState;
  
  // Activity tracking actions
  addActiveAgent: (agent: Omit<ActiveAgent, 'startTime'>) => void;
  updateAgentStatus: (id: string, status: ActiveAgent['status']) => void;
  removeActiveAgent: (id: string) => void;
  addActiveTool: (tool: Omit<ActiveTool, 'startTime'>) => void;
  completeTool: (id: string) => void;
  removeActiveTool: (id: string) => void;
  clearCompletedTools: () => void;
  setActiveSkills: (skills: ActiveSkill[]) => void;
  addStreamChunk: (chunk: Omit<StreamChunkTrace, 'id' | 'timestamp'>) => void;
  clearStreamChunks: () => void;
  setRunState: (state: Partial<RunState> & { status: RunStatus }) => void;
  clearAllActivity: () => void;
}

interface ChatState extends AIActivityState {
  conversations: Conversation[];
  activeConversationId: string | null;
  isStreaming: boolean;
  abortController: AbortController | null;
  _hasHydrated: boolean;

  getActiveConversation: () => Conversation | null;
  getActiveMessages: () => ChatMessage[];

  createConversation: (agent?: Agent) => string;
  deleteConversation: (id: string) => void;
  setActiveConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  addMessage: (conversationId: string, message: ChatMessage) => void;
  setConversationMessages: (conversationId: string, messages: ChatMessage[]) => void;
  compactConversation: (conversationId: string, summary: string) => void;
  setPlanState: (conversationId: string, planState: PlanState | null) => void;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  appendToMessage: (conversationId: string, messageId: string, content: string) => void;
  clearMessages: (conversationId: string) => void;
  setStreaming: (val: boolean) => void;
  setAbortController: (ctrl: AbortController | null) => void;
  ensureActiveConversation: (agent: Agent) => string;
  setHasHydrated: (state: boolean) => void;
}

export const useChatStore = create<ChatState>()(
  (set, get) => ({
      // Core chat state
      conversations: [],
      activeConversationId: null,
      isStreaming: false,
      abortController: null,
      _hasHydrated: true,

      // AI Activity tracking (transient - not persisted)
      activeAgents: [],
      activeTools: [],
      activeSkills: [],
      streamChunks: [],
      runState: { status: 'idle', startedAt: null, completedAt: null },

      // Activity tracking actions
      addActiveAgent: (agent) =>
        set((state) => ({
          activeAgents: [
            ...state.activeAgents.filter((a) => a.id !== agent.id),
            { ...agent, startTime: Date.now() },
          ],
        })),

      updateAgentStatus: (id, status) =>
        set((state) => ({
          activeAgents: state.activeAgents.map((a) =>
            a.id === id ? { ...a, status } : a
          ),
        })),

      removeActiveAgent: (id) =>
        set((state) => ({
          activeAgents: state.activeAgents.filter((a) => a.id !== id),
        })),

      addActiveTool: (tool) =>
        set((state) => ({
          activeTools: [...state.activeTools, { ...tool, startTime: Date.now() }],
        })),

      completeTool: (id) =>
        set((state) => ({
          activeTools: state.activeTools.map((t) =>
            t.id === id ? { ...t, status: 'completed' } : t
          ),
        })),

      removeActiveTool: (id) =>
        set((state) => ({
          activeTools: state.activeTools.filter((t) => t.id !== id),
        })),

      clearCompletedTools: () =>
        set((state) => ({
          activeTools: state.activeTools.filter((t) => t.status !== 'completed'),
        })),

      setActiveSkills: (skills) =>
        set({ activeSkills: skills }),

      addStreamChunk: (chunk) =>
        set((state) => ({
          streamChunks: [
            ...state.streamChunks.slice(-159),
            {
              ...chunk,
              id: `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              timestamp: Date.now(),
            },
          ],
        })),

      clearStreamChunks: () => set({ streamChunks: [] }),

      setRunState: (runState) =>
        set((state) => {
          const prev = state.runState;
          const nextStatus = runState.status;
          const enteringRun = nextStatus === 'running' && prev.status !== 'running';
          const leavingRun = nextStatus !== 'running' && prev.status === 'running';
          return {
            runState: {
              ...prev,
              ...runState,
              startedAt: enteringRun
                ? Date.now()
                : runState.startedAt ?? prev.startedAt,
              completedAt: nextStatus === 'running'
                ? null
                : runState.completedAt ?? (leavingRun ? Date.now() : prev.completedAt),
            },
          };
        }),

      clearAllActivity: () =>
        set({
          activeAgents: [],
          activeTools: [],
          activeSkills: [],
          streamChunks: [],
          runState: { status: 'idle', startedAt: null, completedAt: null },
        }),

      getActiveConversation: () => {
        const state = get();
        return state.conversations.find((c) => c.id === state.activeConversationId) || null;
      },

      getActiveMessages: () => {
        const state = get();
        if (!state.activeConversationId) return [];
        return state.conversations.find((c) => c.id === state.activeConversationId)?.messages || [];
      },

      createConversation: (agent = 'general') => {
        const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const conversation: Conversation = {
          id,
          title: 'New Chat',
          agent,
          messages: [],
          planState: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
        }));
        return id;
      },

      deleteConversation: (id) =>
        set((state) => {
          const conversations = state.conversations.filter((c) => c.id !== id);
          const activeConversationId =
            state.activeConversationId === id
              ? (conversations[0]?.id || null)
              : state.activeConversationId;
          return { conversations, activeConversationId };
        }),

      setActiveConversation: (id) => set({ activeConversationId: id }),

      renameConversation: (id, title) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: new Date().toISOString() } : c
          ),
        })),

      addMessage: (conversationId, message) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: trimConversationMessages([...c.messages, sanitizeMessageForStorage(message)]),
                  updatedAt: new Date().toISOString(),
                }
              : c
          ),
        })),

      setConversationMessages: (conversationId, messages) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: trimConversationMessages(messages.map(sanitizeMessageForStorage)),
                  updatedAt: new Date().toISOString(),
                }
              : c
          ),
        })),

      compactConversation: (conversationId, summary) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const lastUserIndex = c.messages.map((m) => m.role).lastIndexOf('user');
            const activeTail = lastUserIndex >= 0 ? c.messages.slice(lastUserIndex) : c.messages.slice(-1);
            const summaryMessage: ChatMessage = {
              id: generateId(),
              role: 'system',
              content: `Conversation compacted:\n\n${summary}`,
              agent: c.agent,
              createdAt: new Date().toISOString(),
            };
            return {
              ...c,
              messages: [summaryMessage, ...activeTail],
              updatedAt: new Date().toISOString(),
            };
          }),
        })),

      setPlanState: (conversationId, planState) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, planState, updatedAt: new Date().toISOString() }
              : c
          ),
        })),

      updateMessage: (conversationId, messageId, updates) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: trimConversationMessages(c.messages.map((m) =>
                    m.id === messageId ? sanitizeMessageForStorage({ ...m, ...updates }) : m
                  )),
                }
              : c
          ),
        })),

      appendToMessage: (conversationId, messageId, content) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: trimConversationMessages(c.messages.map((m) =>
                    m.id === messageId
                      ? {
                          ...m,
                          content: truncateString((m.content ?? '') + content, MAX_STORED_MESSAGE_CHARS),
                        }
                      : m
                  )),
                }
              : c
          ),
        })),

      clearMessages: (conversationId) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, messages: [], planState: null, updatedAt: new Date().toISOString() }
              : c
          ),
        })),

      setStreaming: (val) => set({ isStreaming: val }),
      setAbortController: (ctrl) => set({ abortController: ctrl }),
      setHasHydrated: (state) => set({ _hasHydrated: state }),

      ensureActiveConversation: (agent) => {
        const state = get();
        if (state.activeConversationId && state.conversations.find(c => c.id === state.activeConversationId)) {
          return state.activeConversationId;
        }
        return get().createConversation(agent);
      },
    })
);

export { generateId };
