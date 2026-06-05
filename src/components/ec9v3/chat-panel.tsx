"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  memo,
  type KeyboardEvent,
} from "react";
import {
  SendHorizontal,
  Square,
  Bot,
  User,
  Wrench,
  Copy,
  Check,
  Sparkles,
  Zap,
  Code,
  Search,
  Globe,
  Terminal,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  ImagePlus,
  X,
  ExternalLink,
} from "lucide-react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useChatStore, generateId } from "@/stores/chat-store";
import { useSettingsStore, AGENTS, detectAgent, resolveActiveModelProvider } from "@/stores/settings-store";
import type { APIMessageContent, ChatImageAttachment, ChatMessage, ToolCall, StreamingChunk, AutoPromptStageResult, PlanState, PlanStep } from "@/types/ec9v3";
import { cn } from "@/lib/utils";
import { parsePlanState } from "@/lib/planning";

const SUGGESTIONS = [
  { label: "Read a file", icon: Code, prompt: "Read the package.json file and explain the project dependencies." },
  { label: "Run a command", icon: Terminal, prompt: "Run `npm run build` and check for any errors." },
  { label: "Search the web", icon: Globe, prompt: "Search for the latest Next.js 16 release notes and summarize key features." },
  { label: "Write code", icon: Zap, prompt: "Create a TypeScript utility function for debouncing with generics." },
  { label: "Explore directory", icon: Search, prompt: "List the src directory structure and describe the project layout." },
];

const MAX_VISIBLE_MESSAGES = 80;
const MAX_MARKDOWN_RENDER_CHARS = 60_000;
const MAX_CODE_HIGHLIGHT_CHARS = 20_000;
const MAX_TOOL_DISPLAY_CHARS = 20_000;
const MAX_REPLAY_MESSAGE_CHARS = 80_000;
const MAX_REPLAY_TOOL_RESULT_CHARS = 30_000;
const MAX_LIVE_ASSISTANT_TEXT_CHARS = 120_000;
const MAX_IMAGE_ATTACHMENTS = 6;
const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024;

function truncateForDisplay(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Truncated ${value.length - limit} characters for browser performance]`;
}

function truncateMiddleForMemory(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.65);
  const tail = Math.max(0, limit - head);
  return `${value.slice(0, head)}\n\n[Truncated ${value.length - limit} characters for browser memory]\n\n${value.slice(value.length - tail)}`;
}

function truncateUnknownForReplay(value: unknown, limit: number): unknown {
  if (typeof value === "string") return truncateMiddleForMemory(value, limit);
  if (value === undefined || value === null) return value;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length <= limit) return value;
    return `[Large payload omitted for browser memory: ${serialized.length} characters]`;
  } catch {
    return "[Unserializable payload omitted for browser memory]";
  }
}

function compactToolCallForReplay(toolCall: ToolCall): ToolCall {
  return {
    ...toolCall,
    arguments: truncateUnknownForReplay(toolCall.arguments, MAX_REPLAY_TOOL_RESULT_CHARS) as ToolCall["arguments"],
    result: toolCall.result
      ? truncateMiddleForMemory(toolCall.result, MAX_REPLAY_TOOL_RESULT_CHARS)
      : toolCall.result,
  };
}

function formatToolPayload(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return truncateForDisplay(text || "", MAX_TOOL_DISPLAY_CHARS);
}

function parseToolArguments(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof args === "object") return args as Record<string, unknown>;
  return {};
}

function readImageFileAsAttachment(file: File): Promise<ChatImageAttachment> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error(`${file.name} is not an image file.`));
      return;
    }
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      reject(new Error(`${file.name} is larger than 8 MB.`));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: generateId(),
        name: file.name,
        mimeType: file.type,
        size: file.size,
        dataUrl: String(reader.result || ""),
      });
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function contentWithImages(text: string, attachments?: ChatImageAttachment[]): APIMessageContent {
  if (!attachments || attachments.length === 0) return text;
  const instruction = "Image attachment(s) are included in this message as vision input. Analyze the image pixels directly; do not say you cannot view images.";
  return [
    { type: "text", text: `${instruction}\n\n${text || "Please analyze the attached image."}` },
    ...attachments.map((attachment) => ({
      type: "image_url" as const,
      image_url: { url: attachment.dataUrl, detail: "auto" as const },
    })),
  ];
}

function planStateFromTodos(args: unknown): PlanState | null {
  const parsed = parseToolArguments(args);
  if (parsed.action !== "write" || !Array.isArray(parsed.todos)) return null;

  const steps = parsed.todos
    .map((todo: unknown, index): PlanStep | null => {
      const item = todo as { id?: unknown; content?: unknown; status?: unknown; priority?: unknown; reason?: unknown };
      const status = item.status === "completed" || item.status === "in_progress" || item.status === "removed"
        ? item.status
        : "pending";
      const description = String(item.content || "").trim();
      const id = String(item.id || index + 1);
      if (!description) return null;
      return {
        id,
        description,
        status,
        reason: item.reason ? String(item.reason) : undefined,
      };
    })
    .filter((step): step is PlanStep => Boolean(step));

  if (steps.length === 0) return null;

  return {
    mode: "on",
    steps,
    currentStep: steps.find((step) => step.status === "in_progress")?.id,
    updatedAt: new Date().toISOString(),
  };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="absolute top-1.5 right-1.5 p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      title={copied ? "Copied!" : "Copy code"}
    >
      {copied ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
    </button>
  );
}

function CodeBlock({ language, children }: { language: string; children: string }) {
  const visibleCode = truncateForDisplay(children, MAX_CODE_HIGHLIGHT_CHARS);
  if (children.length > MAX_CODE_HIGHLIGHT_CHARS) {
    return (
      <div className="relative group my-2 rounded-lg overflow-hidden border border-border">
        <div className="flex items-center justify-between px-3 py-1 bg-muted/50 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <span>{language || "text"}</span>
          <CopyButton text={children} />
        </div>
        <pre className="m-0 bg-card px-3 py-2 text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap">
          {visibleCode}
        </pre>
      </div>
    );
  }

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden border border-border">
      <div className="flex items-center justify-between px-3 py-1 bg-muted/50 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        <span>{language || "text"}</span>
        <CopyButton text={children} />
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={vscDarkPlus}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: 0,
          background: "var(--card)",
          padding: "0.625rem 0.75rem",
          fontSize: "0.75rem",
          lineHeight: 1.55,
        }}
        showLineNumbers={false}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
}

const ToolCallBlock = memo(function ToolCallBlock({ toolCall }: { toolCall: Partial<ToolCall> }) {
  const [expanded, setExpanded] = useState(false);
  const { workingDirectory } = useSettingsStore();
  const isError = toolCall.isError || toolCall.status === "error";
  const isPending = toolCall.status === "pending" || toolCall.status === "running";
  const payloadUrl = toolCall.resultPayloadId
    ? `/api/payloads/${encodeURIComponent(toolCall.resultPayloadId)}?workingDirectory=${encodeURIComponent(workingDirectory)}`
    : null;

  return (
    <div className={cn(
      "rounded-lg border my-1 overflow-hidden",
      isError ? "border-red-500/30 bg-red-500/5" : "border-border bg-muted/30"
    )}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <Wrench className="size-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-xs font-mono font-semibold">{toolCall.name}</span>
        {isPending && (
          <span className="text-[9px] text-cyan-400 animate-pulse ml-2">running</span>
        )}
        {!isPending && !isError && (
          <span className="text-[9px] text-green-400 ml-2">done</span>
        )}
        {isError && (
          <span className="text-[9px] text-red-400 ml-2">error</span>
        )}
        <ChevronRight className={cn("size-3 text-muted-foreground transition-transform", expanded && "rotate-90")} />
      </div>
      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Arguments</div>
          <pre className="text-xs whitespace-pre-wrap break-words bg-card rounded p-2 font-mono max-h-48 overflow-y-auto">
            {formatToolPayload(toolCall.arguments)}
          </pre>
          {toolCall.result && (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Result</div>
                {payloadUrl && (
                  <button
                    type="button"
                    onClick={() => window.open(payloadUrl, "_blank", "noopener,noreferrer")}
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <ExternalLink className="size-3" />
                    Full result
                  </button>
                )}
              </div>
              <pre className="text-xs whitespace-pre-wrap break-words bg-card rounded p-2 font-mono max-h-48 overflow-y-auto">
                {formatToolPayload(toolCall.result)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});

const AutoPromptStageBlock = memo(function AutoPromptStageBlock({ stageResult, details }: { 
  stageResult: AutoPromptStageResult;
  details?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = details && details.length > 0;
  const isFixed = stageResult.verdict === "fixed" || stageResult.fixed;
  const statusLabel = isFixed ? "Fixed" : stageResult.passed ? "Passed" : "Remaining issues";

  return (
    <div className={cn(
      "rounded-lg border my-1 overflow-hidden",
      stageResult.passed
        ? "border-green-500/30 bg-green-500/5"
        : "border-red-500/30 bg-red-500/5"
    )}>
      <div 
        className={cn("flex items-center gap-2 px-3 py-2", hasDetails && "cursor-pointer hover:bg-white/5")}
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        {stageResult.passed ? (
          <CheckCircle2 className="size-4 text-green-400 shrink-0" />
        ) : (
          <XCircle className="size-4 text-red-400 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold flex items-center gap-2">
            <span className="uppercase tracking-wider">AutoPrompt: {stageResult.stage}</span>
            <span className={cn(
              "text-[10px] rounded border px-1.5 py-0.5",
              stageResult.passed ? "border-green-500/30 text-green-400" : "border-red-500/30 text-red-400"
            )}>
              {statusLabel}
            </span>
            {stageResult.duration && (
              <span className="text-[10px] text-muted-foreground">
                ({(stageResult.duration / 1000).toFixed(1)}s)
              </span>
            )}
            {hasDetails && (
              <span className="text-muted-foreground ml-auto">
                {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{stageResult.summary}</p>
        </div>
      </div>
      
      {expanded && hasDetails && (
        <div className="border-t border-border px-3 py-2 bg-black/20">
          <div className="text-xs prose prose-invert prose-sm max-w-none max-h-64 overflow-y-auto">
            <Markdown>{details}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
});

function formatRunDuration(startedAt: number | null, completedAt: number | null): string {
  if (!startedAt) return "";
  const end = completedAt || Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function getChunkPreview(chunk: StreamingChunk): string {
  if (chunk.type === "content") return chunk.content || "";
  if (chunk.type === "tool_call") return chunk.toolCall?.name || "tool call";
  if (chunk.type === "tool_result") return String(chunk.toolCall?.result || chunk.toolCall?.name || "tool result");
  if (chunk.type === "error") return chunk.error || "error";
  if (chunk.type === "auto_prompt_stage") return chunk.stageResult?.summary || "autoprompt";
  if (chunk.type === "verification_start") return chunk.summary || "goal verification";
  if (chunk.type === "verification_result") return chunk.summary || (chunk.passed ? "goal verified" : "goal not reached");
  if (chunk.type === "sub_agent_start") return chunk.agentType || "sub-agent start";
  if (chunk.type === "sub_agent_result") return chunk.result?.content || chunk.agentType || "sub-agent result";
  if (chunk.type === "auto_compaction") return chunk.summary || "compacted";
  if (chunk.type === "tool_recovery_flush") return chunk.summary || "tool recovery";
  if (chunk.type === "done") return "done";
  return chunk.type;
}

function RunStatusBar({
  status,
  startedAt,
  completedAt,
  message,
}: {
  status: "idle" | "running" | "success" | "error" | "stopped";
  startedAt: number | null;
  completedAt: number | null;
  message?: string;
}) {
  if (status === "idle") return null;

  const config = {
    running: {
      icon: Zap,
      label: "Coder running",
      color: "text-primary",
      bar: "bg-primary",
      bg: "bg-primary/10",
    },
    success: {
      icon: CheckCircle2,
      label: "Run successful",
      color: "text-emerald-400",
      bar: "bg-emerald-500",
      bg: "bg-emerald-500/10",
    },
    error: {
      icon: XCircle,
      label: "Run stopped with error",
      color: "text-red-400",
      bar: "bg-red-500",
      bg: "bg-red-500/10",
    },
    stopped: {
      icon: Square,
      label: "Run stopped",
      color: "text-amber-400",
      bar: "bg-amber-500",
      bg: "bg-amber-500/10",
    },
    idle: {
      icon: Bot,
      label: "Idle",
      color: "text-muted-foreground",
      bar: "bg-muted",
      bg: "bg-muted/10",
    },
  }[status];

  const Icon = config.icon;
  const duration = formatRunDuration(startedAt, completedAt);

  return (
    <div className={cn("mb-2 overflow-hidden rounded-md border border-border", config.bg)}>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={cn("size-3.5 shrink-0", config.color)} />
          <span className={cn("text-xs font-medium", config.color)}>{config.label}</span>
          {message && (
            <span className="text-[10px] text-muted-foreground truncate">{message}</span>
          )}
        </div>
        {duration && (
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">{duration}</span>
        )}
      </div>
      <div className="h-1 bg-background/60">
        <div
          className={cn("h-full transition-all", config.bar, status === "running" && "animate-pulse")}
          style={{ width: status === "running" ? "70%" : "100%" }}
        />
      </div>
    </div>
  );
}

const MessageItem = memo(function MessageItem({ message }: { message: ChatMessage }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center py-1">
        <span className="text-[10px] italic px-3 py-0.5 rounded border text-muted-foreground border-border bg-muted/30">
          {message.content}
        </span>
      </div>
    );
  }

  if (message.role === "autoprompt" && message.autopromptStage) {
    return (
      <div className="px-6 py-1">
        <AutoPromptStageBlock
          stageResult={{
            stage: message.autopromptStage as AutoPromptStageResult['stage'],
            passed: message.autopromptPass ?? false,
            summary: message.content,
          }}
          details={message.autopromptDetails}
        />
      </div>
    );
  }

  const isUser = message.role === "user";
  const visibleContent = truncateForDisplay(message.content || "", MAX_MARKDOWN_RENDER_CHARS);
  const attachments = message.attachments || [];

  return (
    <div className={cn("py-2", isUser ? "justify-end pr-6" : "pl-6")}>
      <div className="max-w-[90%] min-w-0">
        <div className={cn("flex items-center gap-1.5 mb-1", isUser && "justify-end")}>
          {isUser ? (
            <>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">You</span>
              <User className="size-3 text-muted-foreground" />
            </>
          ) : (
            <>
              <Bot className="size-3 text-primary" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">EC9v3</span>
            </>
          )}
        </div>

        <div className={cn(
          "rounded-xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground ml-auto"
            : "bg-card border border-border"
        )}>
          {attachments.length > 0 && (
            <div className={cn("grid gap-2 mb-2", attachments.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
              {attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={attachment.dataUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-md border border-border/60 bg-background/20"
                  title={attachment.name}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="max-h-56 w-full object-contain"
                  />
                </a>
              ))}
            </div>
          )}
          {isUser ? (
            visibleContent ? <p className="whitespace-pre-wrap">{visibleContent}</p> : null
          ) : (
            <div className="prose prose-invert prose-sm max-w-none [&_pre]:bg-transparent [&_pre]:p-0 [&_code]:text-xs">
              <Markdown
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || "");
                    const isInline = !match;
                    return isInline ? (
                      <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono" {...props}>
                        {children}
                      </code>
                    ) : (
                      <CodeBlock language={match[1]}>{String(children).replace(/\n$/, "")}</CodeBlock>
                    );
                  },
                  p({ children }) {
                    return <p className="mb-2 last:mb-0">{children}</p>;
                  },
                  ul({ children }) {
                    return <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>;
                  },
                  ol({ children }) {
                    return <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>;
                  },
                  h1({ children }) {
                    return <h1 className="text-lg font-bold mb-2 mt-3">{children}</h1>;
                  },
                  h2({ children }) {
                    return <h2 className="text-base font-bold mb-2 mt-2">{children}</h2>;
                  },
                  h3({ children }) {
                    return <h3 className="text-sm font-bold mb-1 mt-2">{children}</h3>;
                  },
                }}
              >
                {visibleContent}
              </Markdown>
            </div>
          )}
        </div>

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.toolCalls.map((tc) => (
              <ToolCallBlock key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export function ChatPanel() {
  const [input, setInput] = useState("");
  const [imageAttachments, setImageAttachments] = useState<ChatImageAttachment[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const messages = useChatStore((state) => {
    if (!state.activeConversationId) return [];
    return state.conversations.find((conversation) => conversation.id === state.activeConversationId)?.messages || [];
  });
  const _hasHydrated = useChatStore((state) => state._hasHydrated);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const runState = useChatStore((state) => state.runState);
  const setStreaming = useChatStore((state) => state.setStreaming);
  const setAbortController = useChatStore((state) => state.setAbortController);
  const addMessage = useChatStore((state) => state.addMessage);
  const compactConversation = useChatStore((state) => state.compactConversation);
  const setPlanState = useChatStore((state) => state.setPlanState);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const appendToMessage = useChatStore((state) => state.appendToMessage);
  const renameConversation = useChatStore((state) => state.renameConversation);
  const ensureActiveConversation = useChatStore((state) => state.ensureActiveConversation);
  const addActiveAgent = useChatStore((state) => state.addActiveAgent);
  const updateAgentStatus = useChatStore((state) => state.updateAgentStatus);
  const addActiveTool = useChatStore((state) => state.addActiveTool);
  const completeTool = useChatStore((state) => state.completeTool);
  const setActiveSkills = useChatStore((state) => state.setActiveSkills);
  const addStreamChunk = useChatStore((state) => state.addStreamChunk);
  const clearStreamChunks = useChatStore((state) => state.clearStreamChunks);
  const setRunState = useChatStore((state) => state.setRunState);
  const clearAllActivity = useChatStore((state) => state.clearAllActivity);

  const {
    lmstudioUrl,
    activeProviderId,
    modelProviders,
    selectedModel,
    temperature,
    maxTokens,
    maxContextTokens,
    topP,
    repeatPenalty,
    lmOpti,
    cloudModeEnabled,
    workingDirectory,
    autoPromptConfig,
    subAgentEnabled,
    subagentFileScopeEnforcement,
    skillAutoLoad,
    structuredPlanningEnabled,
    goalModeEnabled,
    planningPassEnabled,
    planningPassTimeout,
    autoCompactionEnabled,
    autoCompactionLimitType,
    autoCompactionPercent,
    autoCompactionTokens,
    contextOverloadProtectionEnabled,
    setLmOpti,
    setCloudModeEnabled,
  } = useSettingsStore();

  const activeProvider = useMemo(
    () => resolveActiveModelProvider(modelProviders, activeProviderId, lmstudioUrl, selectedModel),
    [modelProviders, activeProviderId, lmstudioUrl, selectedModel],
  );
  const activeBaseUrl = activeProvider.baseUrl || lmstudioUrl || "http://localhost:1234";
  const activeModel = activeProvider.model || (activeProvider.type === "local" ? selectedModel || "local-model" : "");
  const activeApiKey = activeProvider.apiKey || undefined;
  const activeApiProtocol = activeProvider.apiProtocol;

  useEffect(() => {
    if (!_hasHydrated || !workingDirectory) return;
    fetch(`/api/conversations?limit=80&workingDirectory=${encodeURIComponent(workingDirectory)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((data: { conversations?: Array<{ id: string; title: string; agent: ChatMessage["agent"]; createdAt: string; updatedAt: string }> } | null) => {
        if (!data?.conversations?.length) return;
        const existing = new Set(useChatStore.getState().conversations.map((conversation) => conversation.id));
        const imported = data.conversations
          .filter((conversation) => !existing.has(conversation.id))
          .map((conversation) => ({ ...conversation, messages: [], planState: null }));
        if (imported.length === 0) return;
        useChatStore.setState((state) => ({
          conversations: [...state.conversations, ...imported],
        }));
      })
      .catch(() => {
        // Server conversation summaries are opportunistic; local visible state is enough to continue.
      });
  }, [_hasHydrated, workingDirectory]);

  useEffect(() => {
    // Only auto-scroll when the user is already near the bottom; otherwise
    // streaming would yank them away from earlier output they're trying to read.
    const container = document.getElementById("chat-messages");
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 120) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  const addImageFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;

    const remainingSlots = MAX_IMAGE_ATTACHMENTS - imageAttachments.length;
    if (remainingSlots <= 0) return;

    const nextAttachments = await Promise.all(
      files.slice(0, remainingSlots).map((file) => readImageFileAsAttachment(file))
    );
    setImageAttachments((current) => [...current, ...nextAttachments].slice(0, MAX_IMAGE_ATTACHMENTS));
  }, [imageAttachments.length]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if ((!trimmed && imageAttachments.length === 0) || isStreaming) return;

    // Auto-detect agent for this message
    const agent = detectAgent(trimmed);
    const convId = ensureActiveConversation(agent);
    if (!structuredPlanningEnabled) {
      setPlanState(convId, { mode: 'off', steps: [], updatedAt: new Date().toISOString() });
    }

    const userMsg: ChatMessage = {
      id: generateId(),
      role: "user",
      content: trimmed,
      attachments: imageAttachments,
      agent,
      createdAt: new Date().toISOString(),
    };
    addMessage(convId, userMsg);
    setInput("");
    setImageAttachments([]);

    const conv = useChatStore.getState().conversations.find(c => c.id === convId);
    if (conv && conv.messages.length <= 1) {
      const maxTitleLen = 80;
      renameConversation(convId, trimmed.slice(0, maxTitleLen) + (trimmed.length > maxTitleLen ? "..." : ""));
    }

    // Clear previous activity and track new session
    clearAllActivity();
    clearStreamChunks();
    setRunState({ status: "running", message: "Waiting for first chunk" });
    
    // Track main agent
    addActiveAgent({
      id: `agent-${agent}`,
      name: AGENTS[agent].name,
      type: 'main',
      status: 'running',
    });

    // Track active skills
    if (skillAutoLoad) {
      const { matchSkills } = await import('@/skills/registry');
      const matchedSkills = matchSkills(trimmed);
      if (matchedSkills.length > 0) {
        setActiveSkills(matchedSkills.map((match, idx) => ({
          id: `skill-${idx}`,
          name: match.skill.name,
          description: match.skill.description,
          status: 'active',
        })));
      }
    }

    const allMsgs = useChatStore.getState().conversations.find(c => c.id === convId)?.messages || [];
    // Preserve toolCalls so the model sees prior tool use trace; the API converts them to OpenAI shape.
    const apiMessages: Array<{
      role: string;
      content: APIMessageContent | null;
      toolCalls?: ToolCall[];
      tool_call_id?: string;
    }> = [];
    for (const m of allMsgs) {
      const allToolCalls = m.toolCalls || [];
      const completedToolCalls = allToolCalls.filter(
        (tc) => tc.status === "completed" || tc.status === "error" || tc.result !== undefined
      );
      // If a prior assistant turn had tool_calls but some were orphaned
      // (interrupted run), the OpenAI tool-call protocol requires every
      // tool_call id in `tool_calls` to have a matching `tool` response.
      // Synthesize a placeholder result for orphans so the model sees a
      // consistent trace instead of dangling unmatched ids.
      const orphanToolCalls = allToolCalls.filter(
        (tc) => !(tc.status === "completed" || tc.status === "error" || tc.result !== undefined)
      );
      const turnToolCalls = m.role === "assistant"
        ? [...completedToolCalls, ...orphanToolCalls].map(compactToolCallForReplay)
        : [];
      apiMessages.push({
        role: m.role,
        content: m.role === "user"
          ? contentWithImages(truncateMiddleForMemory(m.content, MAX_REPLAY_MESSAGE_CHARS), m.attachments)
          : truncateMiddleForMemory(m.content, MAX_REPLAY_MESSAGE_CHARS),
        ...(turnToolCalls.length > 0 ? { toolCalls: turnToolCalls } : {}),
      });
      if (m.role === "assistant" && turnToolCalls.length > 0) {
        for (const tc of completedToolCalls.map(compactToolCallForReplay)) {
          apiMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              success: !tc.isError && tc.status !== "error",
              ...(tc.isError || tc.status === "error" ? { error: tc.result } : { result: tc.result }),
            }),
          });
        }
        for (const tc of orphanToolCalls) {
          apiMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              success: false,
              error: "Tool call interrupted; no result was recorded.",
            }),
          });
        }
      }
    }

    const assistantMsgId = generateId();
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      agent,
      isStreaming: true,
      toolCalls: [],
      createdAt: new Date().toISOString(),
    };
    addMessage(convId, assistantMsg);

    setStreaming(true);
    const abortController = new AbortController();
    setAbortController(abortController);
    let sawErrorChunk = false;
    let sawDoneChunk = false;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          clientMessages: allMsgs,
          model: activeModel || undefined,
          temperature,
          maxTokens,
          topP,
          topK: lmOpti ? 20 : undefined,
          repeatPenalty,
          lmOpti,
          cloudMode: {
            enabled: cloudModeEnabled,
          },
          workingDirectory,
          lmstudioUrl: activeBaseUrl,
          apiKey: activeApiKey,
          apiProtocol: activeApiProtocol,
          conversationId: convId,
          assistantMessageId: assistantMsgId,
          autoPrompt: {
            enabled: Object.values(autoPromptConfig).some(Boolean),
            stages: autoPromptConfig,
          },
          subAgentEnabled,
          subagentFileScopeEnforcement,
          skillAutoLoad,
          structuredPlanningEnabled,
          goalModeEnabled,
          planningPassEnabled,
          planningPassTimeout,
          autoCompaction: {
            enabled: autoCompactionEnabled,
            limitType: autoCompactionLimitType,
            percent: autoCompactionPercent,
            tokens: autoCompactionTokens,
            fallbackContextTokens: maxContextTokens,
          },
          contextOverloadProtection: {
            enabled: contextOverloadProtectionEnabled,
          },
          agent,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          try {
            const chunk: StreamingChunk = JSON.parse(trimmed.slice(6));
            addStreamChunk({
              type: chunk.type,
              preview: getChunkPreview(chunk).slice(0, 220),
            });

            if (chunk.type === "content" && chunk.content) {
              assistantText = truncateMiddleForMemory(assistantText + chunk.content, MAX_LIVE_ASSISTANT_TEXT_CHARS);
              appendToMessage(convId, assistantMsgId, chunk.content);
              const previousPlan = useChatStore.getState().conversations.find(c => c.id === convId)?.planState;
              const nextPlan = parsePlanState(assistantText, previousPlan, structuredPlanningEnabled);
              if (nextPlan) setPlanState(convId, nextPlan);
            } else if (chunk.type === "tool_call" && chunk.toolCall) {
              const toolCallId = chunk.toolCall.id || "";
              const toolCallName = chunk.toolCall.name || "";
              const toolCallArgs = typeof chunk.toolCall.arguments === 'string' ? chunk.toolCall.arguments : JSON.stringify(chunk.toolCall.arguments || {});

              // Track active tool
              addActiveTool({
                id: toolCallId,
                name: toolCallName,
                status: 'running',
              });

              const newToolCall: ToolCall = {
                id: toolCallId,
                name: toolCallName,
                arguments: {},
                status: "running",
              };
              try {
                newToolCall.arguments = truncateUnknownForReplay(
                  JSON.parse(toolCallArgs || "{}"),
                  MAX_REPLAY_TOOL_RESULT_CHARS,
                ) as Record<string, unknown>;
              } catch { /* keep as empty */ }

              // Append atomically via setState so back-to-back tool_call chunks
              // don't both read the same snapshot and clobber each other.
              useChatStore.setState((state) => ({
                conversations: state.conversations.map((c) =>
                  c.id !== convId
                    ? c
                    : {
                        ...c,
                        messages: c.messages.map((m) => {
                          if (m.id !== assistantMsgId) return m;
                          const existing = m.toolCalls || [];
                          if (existing.some((tc) => tc.id === newToolCall.id)) return m;
                          return { ...m, toolCalls: [...existing, newToolCall] };
                        }),
                      },
                ),
              }));
            } else if (chunk.type === "tool_result" && chunk.toolCall) {
              // Mark tool as completed
              completeTool(chunk.toolCall.id || "");

              const targetId = chunk.toolCall.id;
              let completedToolCall: ToolCall | undefined;
              useChatStore.setState((state) => ({
                conversations: state.conversations.map((c) =>
                  c.id !== convId
                    ? c
                    : {
                        ...c,
                        messages: c.messages.map((m) => {
                          if (m.id !== assistantMsgId) return m;
                          const next = (m.toolCalls || []).map((tc) => {
                            if (tc.id !== targetId) return tc;
                            completedToolCall = tc;
                            return {
                              ...tc,
                              result: chunk.toolCall!.result
                                ? truncateMiddleForMemory(String(chunk.toolCall!.result), MAX_REPLAY_TOOL_RESULT_CHARS)
                                : chunk.toolCall!.result,
                              resultPayloadId: chunk.toolCall!.resultPayloadId,
                              isError: chunk.toolCall!.isError,
                              status: chunk.toolCall!.isError ? "error" as const : "completed" as const,
                            };
                          });
                          return { ...m, toolCalls: next };
                        }),
                      },
                ),
              }));
              if (
                completedToolCall?.name === "todo" &&
                !chunk.toolCall.isError &&
                completedToolCall.arguments
              ) {
                const todoPlanState = planStateFromTodos(completedToolCall.arguments);
                if (todoPlanState) setPlanState(convId, todoPlanState);
              }
            } else if (chunk.type === "verification_start") {
              setRunState({ status: "running", message: chunk.summary || "Verifying goal" });
            } else if (chunk.type === "verification_result") {
              setRunState({
                status: chunk.passed ? "success" : "running",
                message: chunk.summary || (chunk.passed ? "Goal verified" : "Goal not reached"),
              });
            } else if (chunk.type === "auto_prompt_stage" && chunk.stageResult) {
              const stageMsg: ChatMessage = {
                id: generateId(),
                role: "autoprompt",
                content: chunk.stageResult.summary,
                agent,
                autopromptStage: chunk.stageResult.stage,
                autopromptPass: chunk.stageResult.passed,
                autopromptDetails: chunk.stageResult.details,
                createdAt: new Date().toISOString(),
              };
              addMessage(convId, stageMsg);
            } else if (chunk.type === "error") {
              sawErrorChunk = true;
              setRunState({ status: "error", message: chunk.error || "Stream error" });
              appendToMessage(convId, assistantMsgId, `\n\n> Error: ${chunk.error}`);
            } else if (chunk.type === "auto_compaction" && chunk.summary) {
              compactConversation(convId, chunk.summary);
            } else if (chunk.type === "tool_recovery_flush") {
              setRunState({ status: "running", message: chunk.summary || "Recovered from repeated invalid tool calls" });
            } else if (chunk.type === "sub_agent_start" && chunk.agentType) {
              // Track sub-agent
              addActiveAgent({
                id: `subagent-${chunk.agentType}`,
                name: `${chunk.agentType} Agent`,
                type: 'sub',
                status: 'running',
              });

              const agentMsg: ChatMessage = {
                id: generateId(),
                role: "assistant",
                content: `🔧 **Sub-Agent ${chunk.agentType}${chunk.count ? ` (${chunk.count} agents)` : ''}** started...`,
                agent,
                createdAt: new Date().toISOString(),
              };
              addMessage(convId, agentMsg);
            } else if (chunk.type === "sub_agent_result" && chunk.agentType && chunk.result) {
              const resultMsg: ChatMessage = {
                id: generateId(),
                role: "assistant",
                content: `✅ **Sub-Agent ${chunk.agentType}** completed:\n\n${chunk.result.content || 'No output'}`,
                agent,
                createdAt: new Date().toISOString(),
              };
              updateAgentStatus(`subagent-${chunk.agentType}`, 'completed');
              addMessage(convId, resultMsg);
            } else if (chunk.type === "done") {
              sawDoneChunk = true;
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } catch (error: unknown) {
      const err = error as { name?: string; message?: string };
      if (err.name === "AbortError") {
        setRunState({ status: "stopped", message: "Stopped by user" });
      } else {
        setRunState({ status: "error", message: err.message || "Request failed" });
        appendToMessage(convId, assistantMsgId, `\n\n> Error: ${err.message || "Request failed"}`);
      }
    } finally {
      if (!abortController.signal.aborted && !sawErrorChunk) {
        setRunState({ status: sawDoneChunk ? "success" : "stopped", message: sawDoneChunk ? "Complete" : "Stream closed" });
      }
      updateMessage(convId, assistantMsgId, { isStreaming: false });
      updateAgentStatus(`agent-${agent}`, 'completed');
      setStreaming(false);
      setAbortController(null);
    }
  }, [input, imageAttachments, isStreaming, activeModel, activeBaseUrl, activeApiKey, activeApiProtocol, temperature, maxTokens, maxContextTokens, topP, repeatPenalty, lmOpti, cloudModeEnabled, workingDirectory, autoPromptConfig, subAgentEnabled, subagentFileScopeEnforcement, skillAutoLoad, structuredPlanningEnabled, goalModeEnabled, planningPassEnabled, planningPassTimeout, autoCompactionEnabled, autoCompactionLimitType, autoCompactionPercent, autoCompactionTokens, contextOverloadProtectionEnabled, addMessage, compactConversation, setPlanState, appendToMessage, updateMessage, renameConversation, ensureActiveConversation, setStreaming, setAbortController, updateAgentStatus, addStreamChunk, clearStreamChunks, setRunState]);

  const handleStop = useCallback(() => {
    const ctrl = useChatStore.getState().abortController;
    if (ctrl) ctrl.abort();
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const showSuggestions = messages.length === 0;
  const hiddenMessageCount = Math.max(0, messages.length - MAX_VISIBLE_MESSAGES);
  const visibleMessages = useMemo(
    () => hiddenMessageCount > 0 ? messages.slice(-MAX_VISIBLE_MESSAGES) : messages,
    [hiddenMessageCount, messages],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-2 py-4 space-y-1" id="chat-messages">
        {showSuggestions && (
          <div className="flex flex-col items-center justify-center h-full gap-8">
            <div className="text-center">
              <div
                className="flex items-center justify-center size-16 rounded-2xl mx-auto mb-4"
                style={{
                  background: "linear-gradient(135deg, rgba(0,212,255,0.12) 0%, rgba(0,212,255,0.03) 100%)",
                  border: "1px solid rgba(0,212,255,0.2)",
                  boxShadow: "0 0 30px rgba(0,212,255,0.08)",
                }}
              >
                <Sparkles className="size-7" style={{ color: "var(--primary, #00d4ff)" }} />
              </div>
              <h2 className="text-lg font-bold tracking-wide" style={{ color: "var(--foreground, #e0e4f0)" }}>
                EC9v3 AI Assistant
              </h2>
              <p className="text-sm mt-1" style={{ color: "var(--muted-foreground, #505878)" }}>
                12 tools &middot; 5 sub-agents &middot; 12 skills
              </p>
              <p className="text-xs mt-2" style={{ color: "var(--muted-foreground, #505878)", opacity: 0.6 }}>
                Start a conversation or pick a suggestion below
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 w-full max-w-2xl px-4">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => setInput(s.prompt)}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all text-left cursor-pointer"
                  style={{
                    border: "1px solid var(--border, #2a2a3e)",
                    background: "var(--card, #0f0f1a)",
                    color: "var(--foreground, #e0e4f0)",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,212,255,0.3)";
                    (e.currentTarget as HTMLElement).style.background = "rgba(0,212,255,0.05)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = "var(--border, #2a2a3e)";
                    (e.currentTarget as HTMLElement).style.background = "var(--card, #0f0f1a)";
                  }}
                >
                  <s.icon className="size-4 shrink-0" style={{ color: "var(--muted-foreground, #505878)" }} />
                  <span className="text-xs">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {hiddenMessageCount > 0 && (
          <div className="flex justify-center py-1">
            <span className="text-[10px] italic px-3 py-0.5 rounded border text-muted-foreground border-border bg-muted/30">
              {hiddenMessageCount} older messages hidden for browser performance
            </span>
          </div>
        )}

        {visibleMessages.map((msg) => (
          <MessageItem key={msg.id} message={msg} />
        ))}

        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-border bg-card/50 p-3 shrink-0">
        <div className="max-w-4xl mx-auto">
          <RunStatusBar {...runState} />
        </div>
        <div className="max-w-4xl mx-auto mb-2 flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setLmOpti(!lmOpti)}
              className={cn(
                "inline-flex h-7 items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors",
                lmOpti
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-muted"
              )}
              title="LM Opti sends LM Studio/Qwen thinking fields and the LM Studio sampling profile."
            >
              <Zap className="size-3.5" />
              LM Opti {lmOpti ? "On" : "Off"}
            </button>
            <button
              type="button"
              onClick={() => setCloudModeEnabled(!cloudModeEnabled)}
              className={cn(
                "inline-flex h-7 items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors",
                cloudModeEnabled
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-muted"
              )}
              title="Cloud Mode stores durable state outside the prompt, searches before reading files, and trims replayed tool output."
            >
              <Globe className="size-3.5" />
              Cloud Mode {cloudModeEnabled ? "On" : "Off"}
            </button>
          </div>
          {lmOpti && (
            <span className="truncate text-[10px] text-muted-foreground">
              thinking on · temp 1 · top-p .95 · top-k 20
            </span>
          )}
        </div>
        {imageAttachments.length > 0 && (
          <div className="max-w-4xl mx-auto mb-2 flex flex-wrap gap-2">
            {imageAttachments.map((attachment) => (
              <div key={attachment.id} className="relative h-16 w-16 overflow-hidden rounded-md border border-border bg-background">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={attachment.dataUrl} alt={attachment.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setImageAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 text-white hover:bg-black"
                  title="Remove image"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 max-w-4xl mx-auto">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.currentTarget.files) {
                addImageFiles(e.currentTarget.files).catch((error: unknown) => {
                  const err = error as { message?: string };
                  setRunState({ status: "error", message: err.message || "Could not attach image" });
                });
              }
              e.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming || imageAttachments.length >= MAX_IMAGE_ATTACHMENTS}
            className="shrink-0 p-2.5 rounded-xl border border-border bg-background hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            title="Attach image"
          >
            <ImagePlus className="size-4" />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
              if (files.length > 0) {
                e.preventDefault();
                addImageFiles(files).catch((error: unknown) => {
                  const err = error as { message?: string };
                  setRunState({ status: "error", message: err.message || "Could not paste image" });
                });
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a message or attach an image... (Shift+Enter for new line)"
            rows={1}
            className="flex-1 resize-none rounded-xl border border-border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground min-h-[40px] max-h-[200px]"
          />
          {isStreaming ? (
            <button
              onClick={handleStop}
              className="shrink-0 p-2.5 rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors cursor-pointer"
              title="Stop generation"
            >
              <Square className="size-4" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() && imageAttachments.length === 0}
              className="shrink-0 p-2.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              title="Send message"
            >
              <SendHorizontal className="size-4" />
            </button>
          )}
        </div>
        <div className="text-center mt-1.5">
          <span className="text-[10px] text-muted-foreground">
            {activeProvider.name} · {activeModel === 'local-model' ? 'Current model' : activeModel || 'Default'} · {maxTokens} max tokens · {temperature} temp
          </span>
        </div>
      </div>
    </div>
  );
}
