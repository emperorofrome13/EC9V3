'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { resolveActiveModelProvider, useSettingsStore } from '@/stores/settings-store';
import { useChatStore } from '@/stores/chat-store';
import { applyTheme } from '@/lib/themes';
import Sidebar from '@/components/ec9v3/sidebar';
import { ChatPanel } from '@/components/ec9v3/chat-panel';
import { AutoPromptPanel } from '@/components/ec9v3/auto-prompt-panel';
import { PlanStatePanel } from '@/components/ec9v3/plan-state-panel';
import { ContextTokenMeter } from '@/components/ec9v3/context-token-meter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Target, Zap, PanelRightClose, PanelRightOpen, Menu } from 'lucide-react';

function ThemeEffect() {
  const theme = useSettingsStore((s) => s.theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return null;
}

function HydrationGuard({ children }: { children: React.ReactNode }) {
  const chatHydrated = useChatStore((s) => s._hasHydrated);
  const settingsHydrated = useSettingsStore((s) => s._hasHydrated);

  if (!chatHydrated || !settingsHydrated) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">Loading...</span>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export default function HomePage() {
  const lmstudioUrl = useSettingsStore((s) => s.lmstudioUrl);
  const activeProviderId = useSettingsStore((s) => s.activeProviderId);
  const modelProviders = useSettingsStore((s) => s.modelProviders);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const structuredPlanningEnabled = useSettingsStore((s) => s.structuredPlanningEnabled);
  const setStructuredPlanningEnabled = useSettingsStore((s) => s.setStructuredPlanningEnabled);
  const goalModeEnabled = useSettingsStore((s) => s.goalModeEnabled);
  const setGoalModeEnabled = useSettingsStore((s) => s.setGoalModeEnabled);

  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const [connected, setConnected] = useState(false);
  const [modelName, setModelName] = useState('');
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  const testConnection = useCallback(async () => {
    try {
      const provider = resolveActiveModelProvider(modelProviders, activeProviderId, lmstudioUrl, selectedModel);
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: provider.baseUrl || lmstudioUrl || 'http://localhost:1234',
          apiKey: provider.apiKey || undefined,
          apiProtocol: provider.apiProtocol,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const data = await response.json();
        setConnected(true);
        setModelName(data.models?.[0]?.id || '');

        if (!selectedModel && data.models?.length > 0) {
          useSettingsStore.getState().setSelectedModel(data.models[0].id);
        }
      } else {
        setConnected(false);
        setModelName('');
      }
    } catch {
      setConnected(false);
      setModelName('');
    }
  }, [modelProviders, activeProviderId, lmstudioUrl, selectedModel]);

  useEffect(() => {
    const initialTimeout = setTimeout(testConnection, 0);
    const interval = setInterval(testConnection, 15000);
    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, [testConnection]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setStructuredPlanningEnabled(!useSettingsStore.getState().structuredPlanningEnabled);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setStructuredPlanningEnabled]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId),
    [conversations, activeConversationId]
  );

  return (
    <HydrationGuard>
      <div className="h-screen flex flex-col overflow-hidden bg-background">
        <ThemeEffect />

        <div className="flex flex-1 min-h-0">
          <Sidebar
            connected={connected}
            modelName={modelName}
            isOpen={showMobileMenu}
            onClose={() => setShowMobileMenu(false)}
          />

          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 bg-card/50 backdrop-blur-sm">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden h-8 w-8"
                  onClick={() => setShowMobileMenu(true)}
                >
                  <Menu className="size-4" />
                </Button>

                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: 'var(--primary, #00d4ff)' }}
                  />
                  <span className="text-sm font-medium">
                    EC9v3
                  </span>
                  {isStreaming && (
                    <span className="text-[9px] font-mono text-primary animate-pulse">
                      STREAMING
                    </span>
                  )}
                  {connected && !isStreaming && (
                    <span className="text-xs text-muted-foreground hidden sm:inline">
                      &middot; {modelName || 'Connected'}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1">
                <div className="flex items-center gap-2 mr-3 rounded-lg border border-border/50 px-2 py-1">
                  <div className="leading-tight">
                    <div className="text-[11px] font-medium hidden sm:block">Structured Planning</div>
                    <div className="text-[10px] text-muted-foreground">
                      <span className="hidden sm:inline">
                        {structuredPlanningEnabled ? 'AI plans before executing' : 'AI executes directly'}
                      </span>
                      <span className="sm:hidden">{structuredPlanningEnabled ? 'Plan' : 'Direct'}</span>
                    </div>
                  </div>
                  <Switch
                    checked={structuredPlanningEnabled}
                    onCheckedChange={setStructuredPlanningEnabled}
                    title="Toggle structured planning (Ctrl+Shift+P)"
                  />
                </div>
                <div className="flex items-center gap-2 mr-3 rounded-lg border border-border/50 px-2 py-1">
                  <Target className="size-3.5 text-muted-foreground hidden sm:block" />
                  <div className="leading-tight">
                    <div className="text-[11px] font-medium hidden sm:block">Goal Mode</div>
                    <div className="text-[10px] text-muted-foreground">
                      <span className="hidden sm:inline">
                        {goalModeEnabled ? 'Verify and fix until done' : 'Single pass'}
                      </span>
                      <span className="sm:hidden">{goalModeEnabled ? 'Goal' : 'Pass'}</span>
                    </div>
                  </div>
                  <Switch
                    checked={goalModeEnabled}
                    onCheckedChange={setGoalModeEnabled}
                    title="Toggle goal mode"
                  />
                </div>
                <div className="flex items-center gap-1.5 mr-2">
                  <div
                    className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}
                  />
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    {connected ? 'Connected' : 'Offline'}
                  </span>
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setShowRightPanel(!showRightPanel)}
                >
                  {showRightPanel ? (
                    <PanelRightClose className="size-4" />
                  ) : (
                    <PanelRightOpen className="size-4" />
                  )}
                </Button>
              </div>
            </div>

            <div className="flex-1 min-h-0">
              <ChatPanel />
            </div>
          </div>

          {showRightPanel && (
            <div className="hidden md:flex w-80 lg:w-96 border-l border-border/50 bg-card/30">
              <ScrollArea className="h-full w-full">
                <Tabs defaultValue="autoprompt" className="w-full">
                  <TabsList className="w-full justify-start rounded-none border-b border-border/50 bg-transparent p-0 h-auto">
                    <TabsTrigger
                      value="autoprompt"
                      className="flex-1 gap-1.5 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent py-2.5 text-xs"
                    >
                      <Zap className="size-3.5" />
                      AutoPrompt
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="autoprompt" className="mt-0 p-3">
                    <div className="space-y-3">
                      <PlanStatePanel />
                      <AutoPromptPanel />
                    </div>
                  </TabsContent>
                </Tabs>
              </ScrollArea>
            </div>
          )}
        </div>

        <footer
          className="border-t border-border/30 bg-card/30 backdrop-blur-sm px-4 py-1.5 flex items-center justify-between text-[10px] text-muted-foreground/60 shrink-0"
          suppressHydrationWarning
        >
          <span>EC9v3 v1.0 &middot; Optimized for LMStudio &amp; Local Models</span>
          <span suppressHydrationWarning>
            {conversations.length} chat{conversations.length !== 1 ? 's' : ''}
            {activeConversation?.messages ? ` · ${activeConversation.messages.length} messages` : ''}
          </span>
          <ContextTokenMeter />
        </footer>
      </div>
    </HydrationGuard>
  );
}
