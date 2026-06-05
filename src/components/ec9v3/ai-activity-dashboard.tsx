"use client";

import React, { useMemo, useRef, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot,
  Wrench,
  Zap,
  Cpu,
  Search,
  FileCode,
  Globe,
  Terminal,
  Trash2,
  Edit3,
  FolderOpen,
  Layers,
  Sparkles,
  X,
} from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { AGENTS } from "@/stores/settings-store";

const TOOL_ICONS: Record<string, any> = {
  read_file: FileCode,
  create_file: FileCode,
  edit_file: Edit3,
  delete_file: Trash2,
  grep: Search,
  glob: FolderOpen,
  shell_command: Terminal,
  web_search: Globe,
  read_webpage: Globe,
  list_directory: FolderOpen,
};

const AGENT_ICONS: Record<string, any> = {
  general: Bot,
  cpp_expert: Cpu,
  python_ml: Zap,
  "full-stack-developer": Layers,
  "frontend-styling-expert": Sparkles,
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms / 100) / 10}s`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m`;
}

function formatChunkTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function chunkColor(type: string): string {
  if (type === "content") return "#00d4ff";
  if (type === "tool_call") return "#f59e0b";
  if (type === "tool_result") return "#22c55e";
  if (type === "error") return "#ef4444";
  if (type === "done") return "#34d399";
  if (type.startsWith("auto_")) return "#ec4899";
  if (type.startsWith("sub_agent")) return "#8b5cf6";
  return "#94a3b8";
}

interface ActivityBarProps {
  id: string;
  name: string;
  icon: React.ElementType;
  status: "idle" | "running" | "completed";
  color: string;
  duration?: number;
  type: "agent" | "tool" | "skill";
}

function ActivityBar({
  id,
  name,
  icon: Icon,
  status,
  color,
  duration,
  type,
}: ActivityBarProps & { icon: React.ElementType }) {
  const isRunning = status === "running";
  const isCompleted = status === "completed";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      className="relative overflow-hidden rounded-md px-2 py-1 mb-1"
      style={{
        background: isRunning
          ? `${color}15`
          : isCompleted
          ? "rgba(34, 197, 94, 0.1)"
          : "rgba(255, 255, 255, 0.03)",
        borderLeft: `2px solid ${isCompleted ? "#22c55e" : color}`,
      }}
    >
      {isRunning && (
        <motion.div
          className="absolute inset-0 pointer-events-none"
          animate={{
            boxShadow: [
              `inset 0 0 20px ${color}20`,
              `inset 0 0 40px ${color}30`,
              `inset 0 0 20px ${color}20`,
            ],
          }}
          transition={{
            duration: 1.5,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      )}

      <div className="flex items-center gap-2 relative z-10">
        <div
          className="relative"
          style={{ color: isCompleted ? "#22c55e" : color }}
        >
          <Icon className="size-3.5" />
          {isRunning && (
            <motion.div
              className="absolute inset-0"
              animate={{
                scale: [1, 1.4, 1],
                opacity: [0.5, 0, 0.5],
              }}
              transition={{
                duration: 1.2,
                repeat: Infinity,
                ease: "easeOut",
              }}
            >
              <Icon className="size-3.5" />
            </motion.div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] font-medium truncate max-w-[120px]"
              style={{
                color: isCompleted
                  ? "#22c55e"
                  : "var(--sidebar-foreground, #e0e4f0)",
              }}
            >
              {name}
            </span>
            {isRunning && duration !== undefined && (
              <span
                className="text-[9px] tabular-nums"
                style={{ color: "var(--muted-foreground, #505878)" }}
              >
                {formatDuration(duration)}
              </span>
            )}
            {isCompleted && (
              <span
                className="text-[9px]"
                style={{ color: "#22c55e" }}
              >
                Done
              </span>
            )}
          </div>
        </div>
      </div>

      {isRunning && (
        <motion.div
          className="absolute bottom-0 left-0 h-[1px]"
          style={{ backgroundColor: color }}
          initial={{ width: "0%" }}
          animate={{ width: "100%" }}
          transition={{ duration: 2, repeat: Infinity }}
        />
      )}
    </motion.div>
  );
}

export function AIActivityDashboard() {
  const {
    activeAgents,
    activeTools,
    activeSkills,
    streamChunks,
    isStreaming,
    getActiveConversation,
    clearCompletedTools,
  } = useChatStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<"tools" | "chunks">("tools");
  const activeConversation = getActiveConversation();
  const currentAgent = activeConversation?.agent;

  // Tick once a second while there is activity so durations update live and the
  // useMemos below are stable between ticks (instead of recomputing every render).
  const [now, setNow] = useState(() => Date.now());
  const hasActivity =
    activeAgents.length > 0 || activeTools.length > 0 || activeSkills.length > 0;
  useEffect(() => {
    if (!hasActivity) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActivity]);

  const currentAgentActivity = useMemo(() => {
    if (!currentAgent || !isStreaming) return null;
    const agentInfo = AGENTS[currentAgent];
    return {
      id: "main-agent",
      name: agentInfo.name,
      icon: AGENT_ICONS[currentAgent] || Bot,
      status: "running" as const,
      color: agentInfo.color,
      type: "agent" as const,
      duration: 0,
    };
  }, [currentAgent, isStreaming]);

  const agentActivities = useMemo(() => {
    const activities = activeAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      icon: Bot,
      status: agent.status,
      color: agent.type === "sub" ? "#8b5cf6" : "#00d4ff",
      duration: now - agent.startTime,
      type: "agent" as const,
    }));

    if (currentAgentActivity && !activities.some((activity) => activity.id === `agent-${currentAgent}`)) {
      activities.unshift(currentAgentActivity);
    }

    return activities;
  }, [activeAgents, currentAgent, currentAgentActivity, now]);

  const toolActivities = useMemo(() => {
    return activeTools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      icon: TOOL_ICONS[tool.name] || Wrench,
      status: tool.status,
      color: "#f59e0b",
      duration: now - tool.startTime,
      type: "tool" as const,
    }));
  }, [activeTools, now]);

  const skillActivities = useMemo(() => {
    return activeSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      icon: Zap,
      status: "running" as const,
      color: "#ec4899",
      type: "skill" as const,
    }));
  }, [activeSkills]);

  const completedCount = useMemo(() => {
    return toolActivities.filter((t) => t.status === "completed").length;
  }, [toolActivities]);

  const hasAnyActivity =
    agentActivities.length > 0 ||
    toolActivities.length > 0 ||
    skillActivities.length > 0;
  const hasChunkActivity = streamChunks.length > 0;

  useEffect(() => {
    if (scrollRef.current && (hasAnyActivity || hasChunkActivity)) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [hasAnyActivity, hasChunkActivity, toolActivities.length, streamChunks.length, viewMode]);

  const header = (
    <div className="flex items-center justify-between gap-2 px-1 mb-1.5">
      <p
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--muted-foreground, #505878)" }}
      >
        AI Activity
      </p>
      <div className="flex rounded-md overflow-hidden border border-white/10">
        <button
          type="button"
          onClick={() => setViewMode("tools")}
          className="px-1.5 py-0.5 text-[9px] inline-flex items-center gap-1 cursor-pointer"
          style={{
            color: viewMode === "tools" ? "var(--primary, #00d4ff)" : "var(--muted-foreground, #505878)",
            background: viewMode === "tools" ? "rgba(0,212,255,0.12)" : "transparent",
          }}
          title="Show tool activity"
        >
          <Wrench className="size-2.5" />
          Tools
        </button>
        <button
          type="button"
          onClick={() => setViewMode("chunks")}
          className="px-1.5 py-0.5 text-[9px] inline-flex items-center gap-1 cursor-pointer border-l border-white/10"
          style={{
            color: viewMode === "chunks" ? "var(--primary, #00d4ff)" : "var(--muted-foreground, #505878)",
            background: viewMode === "chunks" ? "rgba(0,212,255,0.12)" : "transparent",
          }}
          title="Show raw streaming chunks"
        >
          <Terminal className="size-2.5" />
          Chunks
        </button>
      </div>
    </div>
  );

  if (viewMode === "chunks") {
    return (
      <div className="p-2">
        {header}
        <div
          ref={scrollRef}
          className="max-h-64 overflow-y-auto pr-1"
          style={{
            scrollbarWidth: "thin",
            scrollbarColor: "var(--muted-foreground, #505878) transparent",
          }}
        >
          {streamChunks.length === 0 ? (
            <div
              className="rounded-md px-2 py-3 text-center"
              style={{ background: "rgba(255, 255, 255, 0.02)" }}
            >
              <span
                className="text-[10px]"
                style={{ color: "var(--muted-foreground, #505878)" }}
              >
                Waiting for chunks...
              </span>
            </div>
          ) : (
            <div className="space-y-1">
              <AnimatePresence initial={false}>
                {streamChunks.map((chunk) => {
                  const color = chunkColor(chunk.type);
                  return (
                    <motion.div
                      key={chunk.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="grid grid-cols-[3px_1fr] gap-1.5 rounded-sm bg-white/[0.025] pr-1 py-0.5"
                    >
                      <span className="rounded-full" style={{ backgroundColor: color }} />
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[8px] uppercase tracking-wide" style={{ color }}>
                            {chunk.type}
                          </span>
                          <span className="text-[8px] tabular-nums" style={{ color: "var(--muted-foreground, #505878)" }}>
                            {formatChunkTime(chunk.timestamp)}
                          </span>
                        </div>
                        <p className="font-mono text-[9px] leading-tight truncate" style={{ color: "var(--sidebar-foreground, #e0e4f0)" }}>
                          {chunk.preview || "(empty)"}
                        </p>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!hasAnyActivity) {
    return (
      <div className="p-2">
        {header}
        <div
          className="rounded-md px-2 py-3 text-center"
          style={{ background: "rgba(255, 255, 255, 0.02)" }}
        >
          <span
            className="text-[10px]"
            style={{ color: "var(--muted-foreground, #505878)" }}
          >
            Waiting for input...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2">
      {header}

      <div
        ref={scrollRef}
        className="max-h-64 overflow-y-auto space-y-2 pr-1"
        style={{
          scrollbarWidth: "thin",
          scrollbarColor: "var(--muted-foreground, #505878) transparent",
        }}
      >
        <AnimatePresence>
          {agentActivities.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <p
                className="text-[9px] uppercase tracking-wider mb-1"
                style={{ color: "var(--muted-foreground, #505878)" }}
              >
                Agents
              </p>
              {agentActivities.map((activity) => (
                <ActivityBar key={activity.id} {...activity} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {toolActivities.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <p
                className="text-[9px] uppercase tracking-wider mb-1"
                style={{ color: "var(--muted-foreground, #505878)" }}
              >
                Tools
              </p>
              {toolActivities.map((activity) => (
                <ActivityBar key={activity.id} {...activity} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {skillActivities.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <p
                className="text-[9px] uppercase tracking-wider mb-1"
                style={{ color: "var(--muted-foreground, #505878)" }}
              >
                Skills
              </p>
              {skillActivities.map((activity) => (
                <ActivityBar key={activity.id} {...activity} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {completedCount > 0 && (
        <motion.button
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          onClick={clearCompletedTools}
          className="w-full mt-2 flex items-center justify-center gap-1 px-2 py-1 rounded text-[9px] transition-colors cursor-pointer"
          style={{
            color: "var(--muted-foreground, #505878)",
            background: "rgba(255, 255, 255, 0.03)",
          }}
        >
          <X className="size-2.5" />
          Clear Completed ({completedCount})
        </motion.button>
      )}
    </div>
  );
}
