"use client";

import { useEffect, useMemo, useState } from "react";
import { AGENTS, resolveActiveModelProvider, useSettingsStore } from "@/stores/settings-store";
import { useChatStore } from "@/stores/chat-store";
import { QUALITY_GATES, TODO_DISCIPLINE_PROTOCOL } from "@/lib/planning";
import { estimateTextTokens } from "@/lib/context-window";
import type { ChatMessage } from "@/types/ec9v3";

function estimateMessageTokens(message: ChatMessage): number {
  const toolCalls = message.toolCalls?.length ? `\n${JSON.stringify(message.toolCalls)}` : "";
  return estimateTextTokens(`${message.role}\n${message.content || ""}${toolCalls}`) + 4;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`;
  return String(tokens);
}

export function ContextTokenMeter() {
  const activeConversation = useChatStore((s) => s.getActiveConversation());
  const lmstudioUrl = useSettingsStore((s) => s.lmstudioUrl);
  const activeProviderId = useSettingsStore((s) => s.activeProviderId);
  const modelProviders = useSettingsStore((s) => s.modelProviders);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const maxContextTokens = useSettingsStore((s) => s.maxContextTokens);
  const structuredPlanningEnabled = useSettingsStore((s) => s.structuredPlanningEnabled);
  const skillAutoLoad = useSettingsStore((s) => s.skillAutoLoad);

  const [contextLimit, setContextLimit] = useState(maxContextTokens);
  const [contextSource, setContextSource] = useState<"runtime_metadata" | "model_metadata" | "manual_fallback">("manual_fallback");

  useEffect(() => {
    let cancelled = false;

    async function loadContextLimit() {
      try {
        const provider = resolveActiveModelProvider(modelProviders, activeProviderId, lmstudioUrl, selectedModel);
        const res = await fetch("/api/context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          url: provider.baseUrl || lmstudioUrl || "http://localhost:1234",
          fallback: String(maxContextTokens || 30000),
          model: provider.model || (provider.type === "local" ? selectedModel : undefined) || undefined,
          apiKey: provider.apiKey || undefined,
          apiProtocol: provider.apiProtocol,
          }),
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && Number.isFinite(data.contextLimit)) {
          setContextLimit(Math.max(1024, Number(data.contextLimit)));
          setContextSource(data.source === "runtime_metadata" || data.source === "model_metadata" ? data.source : "manual_fallback");
        }
      } catch {
        if (!cancelled) {
          setContextLimit(maxContextTokens || 30000);
          setContextSource("manual_fallback");
        }
      }
    }

    loadContextLimit();
    const interval = setInterval(loadContextLimit, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [modelProviders, activeProviderId, lmstudioUrl, selectedModel, maxContextTokens]);

  const tokenEstimate = useMemo(() => {
    const agent = activeConversation?.agent || "general";
    const agentPromptHint = AGENTS[agent]?.promptPath
      ? `Agent system prompt loaded from ${AGENTS[agent].promptPath}`
      : "";
    const promptOverhead = [
      agentPromptHint,
      QUALITY_GATES,
      structuredPlanningEnabled ? TODO_DISCIPLINE_PROTOCOL : "",
      skillAutoLoad ? "Skill auto-load prompt overhead" : "",
    ].filter(Boolean).join("\n\n");

    const messageTokens = activeConversation?.messages.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    ) || 0;

    return estimateTextTokens(promptOverhead) + messageTokens;
  }, [activeConversation, structuredPlanningEnabled, skillAutoLoad]);

  const percent = contextLimit > 0 ? Math.min(100, Math.round((tokenEstimate / contextLimit) * 100)) : 0;
  const colorClass = percent >= 90 ? "bg-red-500" : percent >= 75 ? "bg-amber-500" : "bg-emerald-500";
  const textClass = percent >= 90 ? "text-red-400" : percent >= 75 ? "text-amber-400" : "text-muted-foreground";

  return (
    <div
      className="flex items-center gap-2 min-w-[190px]"
      title={`Estimated active context usage. Limit source: ${contextSource === "manual_fallback" ? "manual Max Context Tokens setting" : "provider metadata"}.`}
    >
      <span className={`tabular-nums ${textClass}`}>
        Context {formatTokens(tokenEstimate)} / {formatTokens(contextLimit)} ({percent}%)
      </span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${colorClass}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
