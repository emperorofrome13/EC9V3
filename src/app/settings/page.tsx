'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  RefreshCw,
  Check,
  Link2,
  Cpu,
  Thermometer,
  Hash,
  Palette,
  FolderOpen,
  ToggleLeft,
  ToggleRight,
  Cloud,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  useSettingsStore,
  DEFAULT_AUTOPROMPT_CONFIG,
  LOCAL_PROVIDER_ID,
  resolveActiveModelProvider,
} from '@/stores/settings-store';
import { applyTheme, THEMES } from '@/lib/themes';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export default function SettingsPage() {
  const {
    theme,
    lmstudioUrl,
    activeProviderId,
    modelProviders,
    selectedModel,
    temperature,
    maxTokens,
    maxContextTokens,
    topP,
    repeatPenalty,
    workingDirectory,
    autoPromptConfig,
    subAgentEnabled,
    skillAutoLoad,
    autoCompactionEnabled,
    autoCompactionLimitType,
    autoCompactionPercent,
    autoCompactionTokens,
    contextOverloadProtectionEnabled,
    cloudModeEnabled,
    setTheme,
    setLmstudioUrl,
    setActiveProviderId,
    updateModelProvider,
    addModelProvider,
    removeModelProvider,
    setSelectedModel,
    setTemperature,
    setMaxTokens,
    setMaxContextTokens,
    setTopP,
    setRepeatPenalty,
    setWorkingDirectory,
    setAutoPromptConfig,
    setSubAgentEnabled,
    setSkillAutoLoad,
    setAutoCompactionEnabled,
    setAutoCompactionLimitType,
    setAutoCompactionPercent,
    setAutoCompactionTokens,
    setContextOverloadProtectionEnabled,
    setCloudModeEnabled,
    matchMaxTokensToContext,
  } = useSettingsStore();

  const activeProvider = useMemo(
    () => resolveActiveModelProvider(modelProviders, activeProviderId, lmstudioUrl, selectedModel),
    [modelProviders, activeProviderId, lmstudioUrl, selectedModel],
  );
  const activeBaseUrl = activeProvider.baseUrl || lmstudioUrl || 'http://localhost:1234';
  const activeModel = activeProvider.model || (activeProvider.type === 'local' ? selectedModel || 'local-model' : '');

  const [models, setModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'connected' | 'error'>('unknown');
  const [activeTab, setActiveTab] = useState<'general' | 'provider' | 'model' | 'autoprompt' | 'panels' | 'theme'>('provider');

  const fetchModels = useCallback(async () => {
    try {
      setConnectionStatus('unknown');
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: activeBaseUrl,
          apiKey: activeProvider.apiKey || undefined,
          apiProtocol: activeProvider.apiProtocol,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setModels(data.models?.map((m: { id: string }) => m.id) || []);
        setConnectionStatus('connected');
      } else {
        setConnectionStatus('error');
      }
    } catch {
      setConnectionStatus('error');
    }
  }, [activeBaseUrl, activeProvider.apiKey, activeProvider.apiProtocol]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const tabs = [
    { id: 'provider' as const, label: 'Provider', icon: Cloud },
    { id: 'general' as const, label: 'General', icon: FolderOpen },
    { id: 'model' as const, label: 'Model', icon: Cpu },
    { id: 'autoprompt' as const, label: 'AutoPrompt', icon: Thermometer },
    { id: 'panels' as const, label: 'Panels', icon: ToggleLeft },
    { id: 'theme' as const, label: 'Theme', icon: Palette },
  ];

  const themeCategories = THEMES.reduce<Record<string, typeof THEMES>>((acc, t) => {
    if (!acc[t.category]) acc[t.category] = [];
    acc[t.category].push(t);
    return acc;
  }, {});

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => model.toLowerCase().includes(query));
  }, [models, modelSearch]);

  const renderModelPicker = (compact = false) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-muted-foreground">
          API Models {models.length > 0 ? `(${models.length})` : ''}
        </label>
        <Button variant="outline" size="sm" onClick={fetchModels}>
          <RefreshCw className="size-3.5 mr-1" />
          Refresh
        </Button>
      </div>
      <input
        type="text"
        value={modelSearch}
        onChange={(e) => setModelSearch(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
        placeholder="Search returned models..."
      />
      <div className={cn(
        'rounded-lg border border-border overflow-y-auto',
        compact ? 'max-h-56' : 'max-h-72'
      )}>
        {filteredModels.length > 0 ? (
          filteredModels.map((model) => (
            <button
              key={model}
              type="button"
              onClick={() => setSelectedModel(model)}
              className={cn(
                'flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs last:border-b-0 hover:bg-muted',
                activeModel === model && 'bg-primary/10 text-primary'
              )}
            >
              {activeModel === model ? <Check className="size-3.5 shrink-0" /> : <span className="size-3.5 shrink-0" />}
              <span className="truncate font-mono">{model}</span>
            </button>
          ))
        ) : (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {models.length === 0 ? 'No models returned by this provider yet.' : 'No models match your search.'}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 px-4 py-4 border-b border-border">
          <Link href="/">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <h1 className="text-lg font-semibold">Settings</h1>
        </div>

        <div className="flex">
          <div className="w-44 border-r border-border p-3 space-y-1 shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-lg text-sm w-full transition-colors cursor-pointer',
                  activeTab === tab.id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <tab.icon className="size-4" />
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex-1 p-6 space-y-6">
            {activeTab === 'provider' && (
              <div className="space-y-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold">Model Provider</h2>
                      <p className="text-xs text-muted-foreground">Switch between local LM Studio, OpenAI-compatible APIs, and Anthropic-compatible APIs.</p>
                    </div>
                    <Button variant="outline" size="sm" onClick={addModelProvider}>
                      <Plus className="size-3.5 mr-1" />
                      Add API
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-2">
                    {modelProviders.map((provider) => (
                      <button
                        key={provider.id}
                        type="button"
                        onClick={() => setActiveProviderId(provider.id)}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                          provider.id === activeProviderId
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border hover:bg-muted'
                        )}
                      >
                        {provider.id === activeProviderId ? <Check className="size-4" /> : <Cloud className="size-4 text-muted-foreground" />}
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{provider.name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {provider.type === 'local' ? 'Local' : 'Cloud'} · {provider.apiProtocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} · {provider.baseUrl || 'No URL'}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-4 rounded-lg border border-border p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">Name</label>
                      <input
                        type="text"
                        value={activeProvider.name}
                        onChange={(e) => updateModelProvider(activeProvider.id, { name: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">Type</label>
                      <select
                        value={activeProvider.type}
                        onChange={(e) => updateModelProvider(activeProvider.id, { type: e.target.value === 'cloud' ? 'cloud' : 'local' })}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                      >
                        <option value="local">Local</option>
                        <option value="cloud">Cloud</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">API Protocol</label>
                      <select
                        value={activeProvider.apiProtocol}
                        onChange={(e) => updateModelProvider(activeProvider.id, { apiProtocol: e.target.value === 'anthropic' ? 'anthropic' : 'openai' })}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                      >
                        <option value="openai">OpenAI-compatible</option>
                        <option value="anthropic">Anthropic-compatible</option>
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        OpenCode Go uses OpenAI-compatible for DeepSeek/GLM/Kimi/MiMo and Anthropic-compatible for MiniMax/Qwen.
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Provider Base URL</label>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-background">
                      <Link2 className="size-4 text-muted-foreground shrink-0" />
                      <input
                        type="text"
                        value={activeBaseUrl}
                        onChange={(e) => {
                          updateModelProvider(activeProvider.id, { baseUrl: e.target.value });
                          if (activeProvider.id === LOCAL_PROVIDER_ID) setLmstudioUrl(e.target.value);
                        }}
                        className="flex-1 bg-transparent text-sm outline-none"
                        placeholder={activeProvider.type === 'local' ? 'http://localhost:1234' : 'https://openrouter.ai/api'}
                      />
                      <Button variant="outline" size="icon" onClick={fetchModels} title="Test provider">
                        <RefreshCw className="size-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">API Key</label>
                    <input
                      type="password"
                      value={activeProvider.apiKey}
                      onChange={(e) => updateModelProvider(activeProvider.id, { apiKey: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                      placeholder={activeProvider.type === 'local' ? 'Usually blank for LM Studio' : 'Stored locally in browser settings'}
                    />
                    <p className="text-[11px] text-muted-foreground">Keys are saved in this browser's local settings. They are sent only to EC9v3 for the active request.</p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Model</label>
                    <input
                      type="text"
                      value={activeModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                      placeholder={activeProvider.type === 'local' ? 'local-model' : 'provider/model-name'}
                    />
                  </div>

                  {renderModelPicker(true)}

                  <div className="flex items-center justify-between gap-3">
                    <div className={cn(
                      'text-xs px-2 py-1 rounded inline-flex items-center gap-1.5',
                      connectionStatus === 'connected' && 'text-green-400 bg-green-400/10',
                      connectionStatus === 'error' && 'text-red-400 bg-red-400/10',
                      connectionStatus === 'unknown' && 'text-muted-foreground bg-muted'
                    )}>
                      <div className={cn(
                        'size-2 rounded-full',
                        connectionStatus === 'connected' && 'bg-green-400',
                        connectionStatus === 'error' && 'bg-red-400',
                        connectionStatus === 'unknown' && 'bg-muted-foreground'
                      )} />
                      {connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'error' ? 'Connection failed' : 'Not tested'}
                    </div>
                    {activeProvider.id !== LOCAL_PROVIDER_ID && (
                      <Button variant="outline" size="sm" onClick={() => removeModelProvider(activeProvider.id)}>
                        <Trash2 className="size-3.5 mr-1" />
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'general' && (
              <>
                <div className="space-y-3">
                  <label className="text-sm font-medium text-muted-foreground">Working Directory</label>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-background">
                    <FolderOpen className="size-4 text-muted-foreground shrink-0" />
                    <input
                      type="text"
                      value={workingDirectory}
                      onChange={(e) => setWorkingDirectory(e.target.value)}
                      className="flex-1 bg-transparent text-sm outline-none"
                      placeholder="/path/to/project"
                    />
                  </div>
                </div>
              </>
            )}

            {activeTab === 'model' && (
              <>
                <div className="space-y-3">
                  <label className="text-sm font-medium text-muted-foreground">Model Selection</label>

                  {activeProvider.type === 'local' ? (
                    <button
                      onClick={() => setSelectedModel('local-model')}
                      className={cn(
                        'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm w-full transition-colors cursor-pointer mb-2',
                        activeModel === 'local-model'
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-muted'
                      )}
                    >
                      {activeModel === 'local-model' && <Check className="size-4" />}
                      <span>Use provider default/current model</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => setSelectedModel('')}
                      className={cn(
                        'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm w-full transition-colors cursor-pointer mb-2',
                        !activeModel
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-muted'
                      )}
                    >
                      {!activeModel && <Check className="size-4" />}
                      <span>Clear cloud model selection</span>
                    </button>
                  )}

                  {renderModelPicker()}
                </div>

                <div className="space-y-3">
                  <label className="text-sm font-medium text-muted-foreground">Temperature ({temperature})</label>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.05"
                    value={temperature}
                    onChange={(e) => setTemperature(parseFloat(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Precise (0)</span>
                    <span>Creative (2)</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-muted-foreground">
                      <Hash className="size-3 inline mr-1" />Max Tokens ({maxTokens})
                    </label>
                    <button
                      onClick={matchMaxTokensToContext}
                      className="text-xs text-primary hover:underline cursor-pointer px-2 py-1 rounded bg-primary/10"
                    >
                      Match Context
                    </button>
                  </div>
                  <input
                    type="number"
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(parseInt(e.target.value) || 30000)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  />
                </div>

                <div className="space-y-3">
                  <label className="text-sm font-medium text-muted-foreground">
                    <Hash className="size-3 inline mr-1" />Max Context Tokens ({maxContextTokens})
                  </label>
                  <input
                    type="number"
                    value={maxContextTokens}
                    onChange={(e) => setMaxContextTokens(parseInt(e.target.value) || 30000)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  />
                </div>

                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label className="text-sm font-medium">Auto-Compaction</label>
                      <p className="text-xs text-muted-foreground">Compact older chat history before it reaches the active context window.</p>
                    </div>
                    <button onClick={() => setAutoCompactionEnabled(!autoCompactionEnabled)} className="cursor-pointer hover:opacity-80 transition-opacity">
                      {autoCompactionEnabled ? <ToggleRight className="size-8 text-primary" /> : <ToggleLeft className="size-8 text-muted-foreground" />}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setAutoCompactionLimitType('percent')}
                      disabled={!autoCompactionEnabled}
                      className={cn(
                        'px-3 py-2 rounded-lg border text-xs transition-colors disabled:opacity-50',
                        autoCompactionLimitType === 'percent' ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted'
                      )}
                    >
                      Percentage
                    </button>
                    <button
                      type="button"
                      onClick={() => setAutoCompactionLimitType('tokens')}
                      disabled={!autoCompactionEnabled}
                      className={cn(
                        'px-3 py-2 rounded-lg border text-xs transition-colors disabled:opacity-50',
                        autoCompactionLimitType === 'tokens' ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted'
                      )}
                    >
                      Token Count
                    </button>
                  </div>

                  {autoCompactionLimitType === 'percent' ? (
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Compact at {autoCompactionPercent}% of loaded context</label>
                      <input
                        type="range"
                        min="50"
                        max="98"
                        step="1"
                        value={autoCompactionPercent}
                        onChange={(e) => setAutoCompactionPercent(parseInt(e.target.value) || 90)}
                        disabled={!autoCompactionEnabled}
                        className="w-full"
                      />
                      <input
                        type="number"
                        min="50"
                        max="98"
                        value={autoCompactionPercent}
                        onChange={(e) => setAutoCompactionPercent(parseInt(e.target.value) || 90)}
                        disabled={!autoCompactionEnabled}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm disabled:opacity-50"
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Compact at estimated token count</label>
                      <input
                        type="number"
                        min="1000"
                        step="1000"
                        value={autoCompactionTokens}
                        onChange={(e) => setAutoCompactionTokens(parseInt(e.target.value) || 27000)}
                        disabled={!autoCompactionEnabled}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm disabled:opacity-50"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label className="text-sm font-medium">Cloud Mode</label>
                      <p className="text-xs text-muted-foreground">Use external project state, search-first code discovery, and tighter tool-result replay limits for remote models.</p>
                    </div>
                    <button
                      onClick={() => setCloudModeEnabled(!cloudModeEnabled)}
                      className="cursor-pointer hover:opacity-80 transition-opacity"
                      title="Toggle Cloud Mode"
                    >
                      {cloudModeEnabled ? <ToggleRight className="size-8 text-primary" /> : <ToggleLeft className="size-8 text-muted-foreground" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Durable handoff state is written to <code className="font-mono text-[11px]">.ec9v3/cloud-state.json</code>. Large payload bodies remain under <code className="font-mono text-[11px]">.ec9v3/payloads</code>.
                  </p>
                </div>

                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label className="text-sm font-medium">Context Overload Protection</label>
                      <p className="text-xs text-muted-foreground">Split large file reads into non-destructive chunk copies before sending content to the model.</p>
                    </div>
                    <button
                      onClick={() => setContextOverloadProtectionEnabled(!contextOverloadProtectionEnabled)}
                      className="cursor-pointer hover:opacity-80 transition-opacity"
                    >
                      {contextOverloadProtectionEnabled ? <ToggleRight className="size-8 text-primary" /> : <ToggleLeft className="size-8 text-muted-foreground" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Large files are copied into <code className="font-mono text-[11px]">.ec9v3-context-chunks</code> as readable slices. Edits still target the original file.
                  </p>
                </div>

                <div className="space-y-3">
                  <label className="text-sm font-medium text-muted-foreground">Top P ({topP})</label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={topP}
                    onChange={(e) => setTopP(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>

                <div className="space-y-3">
                  <label className="text-sm font-medium text-muted-foreground">Repeat Penalty ({repeatPenalty})</label>
                  <input
                    type="range"
                    min="1"
                    max="2"
                    step="0.05"
                    value={repeatPenalty}
                    onChange={(e) => setRepeatPenalty(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>
              </>
            )}

            {activeTab === 'autoprompt' && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  AutoPrompt runs multi-stage code review automatically after each response.
                </p>
                {(Object.entries(autoPromptConfig) as [keyof typeof autoPromptConfig, boolean][])
                  .filter(([key]) => key !== 'task_verify')
                  .map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                    <label className="text-sm capitalize">{key.replace('_', ' ')}</label>
                    <button
                      onClick={() => setAutoPromptConfig({ [key]: !value })}
                      className="cursor-pointer hover:opacity-80 transition-opacity"
                    >
                      {value ? (
                        <ToggleRight className="size-8 text-primary" />
                      ) : (
                        <ToggleLeft className="size-8 text-muted-foreground" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'panels' && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Enable or disable AI assistance features.
                </p>
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <div>
                    <label className="text-sm">Sub-Agent System</label>
                    <p className="text-xs text-muted-foreground">Allow AI to spawn specialized sub-agents for complex tasks</p>
                  </div>
                  <button onClick={() => setSubAgentEnabled(!subAgentEnabled)} className="cursor-pointer hover:opacity-80 transition-opacity">
                    {subAgentEnabled ? <ToggleRight className="size-8 text-primary" /> : <ToggleLeft className="size-8 text-muted-foreground" />}
                  </button>
                </div>
                <div className="flex items-center justify-between py-2">
                  <div>
                    <label className="text-sm">Skill Auto-Load</label>
                    <p className="text-xs text-muted-foreground">Automatically detect and load relevant skills for each task</p>
                  </div>
                  <button onClick={() => setSkillAutoLoad(!skillAutoLoad)} className="cursor-pointer hover:opacity-80 transition-opacity">
                    {skillAutoLoad ? <ToggleRight className="size-8 text-primary" /> : <ToggleLeft className="size-8 text-muted-foreground" />}
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'theme' && (
              <div className="space-y-6">
                {Object.entries(themeCategories).map(([category, themes]) => (
                  <div key={category}>
                    <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 block">
                      {category}
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      {themes.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setTheme(t.id)}
                          className={cn(
                            'flex items-center gap-3 px-3 py-3 rounded-lg border text-left transition-colors cursor-pointer',
                            theme === t.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
                          )}
                        >
                          <div className="flex gap-1">
                            <div className="w-4 h-4 rounded border border-border" style={{ backgroundColor: t.colors.background }} />
                            <div className="w-4 h-4 rounded border border-border" style={{ backgroundColor: t.colors.primary }} />
                            <div className="w-4 h-4 rounded border border-border" style={{ backgroundColor: t.colors.accent }} />
                          </div>
                          <span className="text-sm">{t.name}</span>
                          {theme === t.id && <Check className="size-4 text-primary shrink-0 ml-auto" />}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
