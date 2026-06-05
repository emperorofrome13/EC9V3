"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import {
  Brain,
  Cpu,
  TrendingUp,
  LineChart,
  SearchCheck,
  ListChecks,
  Wrench,
  GraduationCap,
  CheckCircle2,
  Plus,
  Trash2,
  Settings,
  MessageSquare,
  Wifi,
  WifiOff,
  Palette,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AGENTS,
  detectAgent,
  useSettingsStore,
} from "@/stores/settings-store";
import { useChatStore } from "@/stores/chat-store";
import { AIActivityDashboard } from "./ai-activity-dashboard";
import type { ChatMessage } from "@/types/ec9v3";

const ICON_MAP: Record<string, LucideIcon> = {
  Brain,
  Cpu,
  TrendingUp,
  LineChart,
  SearchCheck,
  ListChecks,
  Wrench,
  GraduationCap,
  CheckCircle2,
  Palette,
};

function resolveIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Brain;
}

function formatRelativeTime(date: string): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

function truncateTitle(title: string, maxLen = 50): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen) + "...";
}

interface SidebarProps {
  connected: boolean;
  modelName: string;
  isOpen?: boolean;
  onClose?: () => void;
}

export default function Sidebar({
  connected,
  modelName,
  isOpen = true,
  onClose,
}: SidebarProps) {
  const {
    conversations,
    activeConversationId,
    setActiveConversation,
    setConversationMessages,
    createConversation,
    deleteConversation,
  } = useChatStore();
  const { workingDirectory } = useSettingsStore();

  const sortedConversations = useMemo(
    () =>
      [...conversations].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      ),
    [conversations]
  );

  const handleNewChat = () => {
    // Auto-detect agent based on the last conversation's context, or default to general
    const detectedAgent = detectAgent('');
    createConversation(detectedAgent);
    onClose?.();
  };

  const handleSelectConversation = async (id: string) => {
    setActiveConversation(id);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages?limit=80&workingDirectory=${encodeURIComponent(workingDirectory)}`);
      if (response.ok) {
        const data = await response.json() as { messages?: ChatMessage[] };
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          setConversationMessages(id, data.messages);
        }
      }
    } catch {
      // Keep local preview state if the server history window is unavailable.
    }
    onClose?.();
  };

  const handleDeleteConversation = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteConversation(id);
  };

  const sidebarContent = (
    <div
      className="h-full flex flex-col w-64"
      style={{ background: "var(--sidebar, #080810)", borderRight: "1px solid var(--sidebar-border, #1e1e2e)" }}
    >
      <div
        className="shrink-0 px-3 pt-4 pb-3"
        style={{
          background: "linear-gradient(180deg, rgba(0,212,255,0.08) 0%, transparent 100%)",
          borderBottom: "1px solid var(--sidebar-border, #1e1e2e)",
        }}
      >
        <div className="flex items-center gap-2.5 mb-1">
          <div
            className="flex items-center justify-center size-8 rounded-lg"
            style={{
              background: "linear-gradient(135deg, rgba(0,212,255,0.2) 0%, rgba(0,212,255,0.05) 100%)",
              border: "1px solid rgba(0,212,255,0.3)",
              boxShadow: "0 0 12px rgba(0,212,255,0.15)",
            }}
          >
            <Brain className="size-4" style={{ color: "var(--primary, #00d4ff)" }} />
          </div>
          <div>
            <span
              className="text-sm font-bold tracking-wide"
              style={{ color: "var(--primary, #00d4ff)", textShadow: "0 0 10px rgba(0,212,255,0.3)" }}
            >
              EC9v3
            </span>
            <div className="text-[9px] font-mono" style={{ color: "var(--muted-foreground, #505878)" }}>
              Local AI Coding Assistant
            </div>
          </div>
        </div>
      </div>

      <div className="px-2 py-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={handleNewChat}
          style={{
            borderColor: "rgba(0,212,255,0.2)",
            color: "var(--sidebar-foreground, #e0e4f0)",
          }}
        >
          <Plus className="size-4" />
          New Chat
        </Button>
      </div>

      <Separator style={{ borderColor: "var(--sidebar-border, #1e1e2e)" }} />

      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="p-2 space-y-0.5">
            {sortedConversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-3 text-center">
                <MessageSquare className="size-8 mb-2" style={{ color: "var(--muted-foreground, #505878)", opacity: 0.4 }} />
                <p className="text-xs" style={{ color: "var(--muted-foreground, #505878)" }}>
                  No conversations yet
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: "var(--muted-foreground, #505878)", opacity: 0.6 }}>
                  Start a new chat to begin
                </p>
              </div>
            ) : (
              sortedConversations.map((conv) => {
                const isActive = conv.id === activeConversationId;
                const agentInfo = AGENTS[conv.agent];
                const Icon = resolveIcon(agentInfo.icon);

                return (
                  <ContextMenu key={conv.id}>
                    <ContextMenuTrigger asChild>
                      <div
                        className="group relative w-full cursor-pointer"
                      >
                        <button
                          onClick={() => handleSelectConversation(conv.id)}
                          style={
                            isActive
                              ? {
                                  background: `${agentInfo.color}15`,
                                  borderLeft: `2px solid ${agentInfo.color}`,
                                }
                              : {
                                  background: "transparent",
                                  borderLeft: "2px solid transparent",
                                }
                          }
                          className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors overflow-hidden"
                          onMouseEnter={(e) => {
                            if (!isActive) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)";
                          }}
                          onMouseLeave={(e) => {
                            if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
                          }}
                        >
                          <MessageSquare
                            className="size-3.5 shrink-0"
                            style={{
                              color: isActive ? agentInfo.color : "var(--muted-foreground, #505878)",
                              opacity: isActive ? 1 : 0.5,
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <p
                              className="text-xs font-medium truncate leading-tight max-w-[180px]"
                              style={{ color: isActive ? "var(--foreground, #e0e4f0)" : "var(--muted-foreground, #505878)" }}
                            >
                              {truncateTitle(conv.title)}
                            </p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span
                                className="inline-flex items-center gap-0.5 text-[10px] leading-none"
                                style={{ color: agentInfo.color }}
                              >
                                <Icon className="size-2.5" />
                                <span className="max-w-[60px] truncate">{agentInfo.name}</span>
                              </span>
                              <span className="text-[10px]" style={{ color: "var(--muted-foreground, #505878)", opacity: 0.5 }}>
                                {formatRelativeTime(conv.updatedAt)}
                              </span>
                            </div>
                          </div>
                        </button>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => handleSelectConversation(conv.id)}>
                        Open Chat
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem 
                        onClick={() => deleteConversation(conv.id)}
                        className="text-destructive focus:text-destructive focus:bg-destructive/10"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete Chat
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>

      <Separator style={{ borderColor: "var(--sidebar-border, #1e1e2e)" }} />

      <AIActivityDashboard />

      <Separator style={{ borderColor: "var(--sidebar-border, #1e1e2e)" }} />

      <div className="p-2">
        <div className="flex items-center gap-2 px-1 py-1.5">
          {connected ? (
            <Wifi className="size-3.5 text-emerald-500 shrink-0" />
          ) : (
            <WifiOff className="size-3.5 text-destructive shrink-0" />
          )}
          <span
            className="text-[11px]"
            style={{
              color: connected ? "#34d399" : "var(--destructive, #ff4060)",
            }}
          >
            {connected ? "LM Studio Connected" : "LM Studio Offline"}
          </span>
          {connected && modelName && (
            <Badge
              variant="secondary"
              className="text-[9px] px-1.5 py-0 h-4 ml-auto truncate max-w-[110px]"
            >
              {modelName}
            </Badge>
          )}
        </div>
      </div>

      <div className="p-2 pt-0">
        <Link href="/settings" className="block">
          <button
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left transition-colors cursor-pointer"
            style={{ color: "var(--muted-foreground, #505878)" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--foreground, #e0e4f0)";
              (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--muted-foreground, #505878)";
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <Settings className="size-3.5" />
            <span className="text-xs">Settings</span>
          </button>
        </Link>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden md:flex h-full shrink-0">{sidebarContent}</aside>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={onClose}
          />
          <aside className="fixed inset-y-0 left-0 z-50 md:hidden animate-in slide-in-from-left duration-200">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
