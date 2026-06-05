export type Agent = 'general' | 'cpp_expert' | 'python_ml' | 'full-stack-developer' | 'frontend-styling-expert';

export interface AgentInfo {
  id: Agent;
  name: string;
  description: string;
  icon: string;
  promptPath: string;
  color: string;
}

export type SubAgentType =
  | 'general-purpose'
  | 'explore'
  | 'plan'
  | 'frontend-styling-expert'
  | 'full-stack-developer';

export interface SubAgentConfig {
  id: SubAgentType;
  name: string;
  description: string;
  icon: string;
  tools: string[];
  model?: string;
  promptPath: string;
}

export interface SubAgentTask {
  id: string;
  type: SubAgentType;
  description: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  argumentsPayloadId?: string;
  result?: string;
  resultPayloadId?: string;
  isError?: boolean;
  status: 'pending' | 'running' | 'completed' | 'error';
}

export interface ChatImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  dataUrlPayloadId?: string;
}

// Roles used in the UI (includes display-only roles)
export type UIMessageRole = 'user' | 'assistant' | 'system' | 'autoprompt' | 'tool_use';

// Roles valid for LLM API calls
export type APIMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  id: string;
  role: UIMessageRole;
  content: string;
  contentPayloadId?: string;
  model?: string;
  agent: Agent;
  autopromptStage?: string;
  autopromptPass?: boolean;
  autopromptDetails?: string;
  autopromptDetailsPayloadId?: string;
  tokens?: number;
  duration?: number;
  isStreaming?: boolean;
  attachments?: ChatImageAttachment[];
  toolCalls?: ToolCall[];
  toolResults?: ToolCall[];
  createdAt: string;
  serverOrdinal?: number;
}

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'removed';
  reason?: string;
}

export interface PlanState {
  mode: 'on' | 'off';
  steps: PlanStep[];
  currentStep?: string;
  updatedAt: string;
}

export type APIMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
    >;

// Message format for API calls (only valid roles)
export interface APIMessage {
  role: APIMessageRole;
  content: APIMessageContent | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface Conversation {
  id: string;
  title: string;
  agent: Agent;
  messages: ChatMessage[];
  planState?: PlanState | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoPromptConfig {
  review: boolean;
  placeholder_cleanup: boolean;
  run_fix: boolean;
  senior_review: boolean;
  completeness: boolean;
  /** @deprecated task_verify is treated as final completeness for old saved configs. */
  task_verify: boolean;
}

export type AutoPromptStage = 'review' | 'placeholder_cleanup' | 'run_fix' | 'senior_review' | 'completeness' | 'task_verify';

export type AutoPromptStructuredVerdict = 'pass' | 'fixed' | 'fail';

export interface AutoPromptIssue {
  severity?: string;
  description: string;
  file?: string;
}

export interface AutoPromptAction {
  type: 'inspected' | 'edited' | 'verified' | 'other';
  detail: string;
}

export interface AutoPromptVerification {
  command?: string;
  passed: boolean;
  evidence: string;
}

export interface AutoPromptStructuredResult {
  verdict: AutoPromptStructuredVerdict;
  summary: string;
  issues_found: AutoPromptIssue[];
  actions: AutoPromptAction[];
  files_changed: string[];
  verification: AutoPromptVerification[];
  remaining_issues: string[];
}

export interface AutoPromptStageResult {
  stage: AutoPromptStage;
  passed: boolean;
  fixed?: boolean;
  verdict?: AutoPromptStructuredVerdict;
  summary: string;
  details?: string;
  structured?: AutoPromptStructuredResult;
  duration?: number;
}

export interface LMStudioModel {
  id: string;
  object: string;
  owned_by: string;
  [key: string]: unknown;
}

export type ModelApiProtocol = 'openai' | 'anthropic';

export interface LMStudioChatOptions {
  messages: { role: string; content: APIMessageContent | null; tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string }[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  lmOpti?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required';
  stream?: boolean;
  apiKey?: string;
  apiProtocol?: ModelApiProtocol;
  signal?: AbortSignal;
}

export interface LMStudioStreamEvent {
  type: 'content' | 'reasoning_content' | 'tool_call' | 'done' | 'error';
  content?: string;
  reasoningContent?: string;
  toolCallId?: string;
  toolName?: string;
  toolArguments?: string;
  error?: string;
}

export interface StreamingChunk {
  type: 'content' | 'tool_call' | 'tool_result' | 'error' | 'done' | 'auto_prompt_stage' | 'sub_agent_start' | 'sub_agent_result' | 'auto_prompt_stage_start' | 'auto_compaction' | 'verification_start' | 'verification_result' | 'tool_recovery_flush';
  content?: string;
  toolCall?: Partial<ToolCall>;
  stageResult?: AutoPromptStageResult;
  error?: string;
  agentType?: string;
  count?: number;
  stage?: string;
  attempt?: number;
  result?: {
    content: string;
    toolCalls?: ToolCall[];
    duration?: number;
  };
  passed?: boolean;
  output?: string;
  summary?: string;
  originalTokenEstimate?: number;
  compactedTokenEstimate?: number;
  contextLimit?: number;
  threshold?: number;
}

export interface Skill {
  name: string;
  description: string;
  version: string;
  triggerPatterns: string[];
  instructions: string;
  tools: string[];
  subAgents?: SubAgentType[];
}

export interface ThemeConfig {
  id: string;
  name: string;
  category: string;
  colors: {
    background: string;
    foreground: string;
    primary: string;
    primaryForeground: string;
    secondary: string;
    secondaryForeground: string;
    muted: string;
    mutedForeground: string;
    accent: string;
    accentForeground: string;
    border: string;
    card: string;
    cardForeground: string;
    input: string;
    ring: string;
    destructive: string;
    popover: string;
    popoverForeground: string;
    sidebar: string;
    sidebarForeground: string;
    sidebarPrimary: string;
    sidebarPrimaryForeground: string;
    sidebarAccent: string;
    sidebarAccentForeground: string;
    sidebarBorder: string;
    sidebarRing: string;
  };
}
