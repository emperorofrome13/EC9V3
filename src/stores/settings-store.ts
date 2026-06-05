import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createQuotaSafeLocalStorage, pruneObsoleteBrowserStateStorage } from '@/stores/safe-browser-storage';
import type { Agent, AutoPromptConfig, ModelApiProtocol, SubAgentType } from '@/types/ec9v3';

export interface AgentInfo {
  id: Agent;
  name: string;
  description: string;
  icon: string;
  promptPath: string;
  color: string;
}

export const AGENTS: Record<Agent, AgentInfo> = {
  general: {
    id: 'general',
    name: 'EC9v3 General',
    description: 'Full-stack AI coding assistant with all tools and capabilities',
    icon: 'Brain',
    color: '#00d4ff',
    promptPath: 'agents/general.md',
  },
  cpp_expert: {
    id: 'cpp_expert',
    name: 'C++ Expert',
    description: 'Advanced C++ specialist with deep systems programming knowledge',
    icon: 'Cpu',
    color: '#00599C',
    promptPath: 'agents/cpp_expert.md',
  },
  python_ml: {
    id: 'python_ml',
    name: 'Python ML Expert',
    description: 'Machine learning specialist with deep Python data science expertise',
    icon: 'LineChart',
    color: '#FFD43B',
    promptPath: 'agents/python_ml.md',
  },
  'full-stack-developer': {
    id: 'full-stack-developer',
    name: 'Full-Stack Developer',
    description: 'Build complete web applications with Next.js, React, APIs, databases',
    icon: 'Wrench',
    color: '#10b981',
    promptPath: 'agents/full-stack-developer.md',
  },
  'frontend-styling-expert': {
    id: 'frontend-styling-expert',
    name: 'Frontend Styling Expert',
    description: 'CSS, responsive design, UI/UX, animations, layouts',
    icon: 'Palette',
    color: '#8b5cf6',
    promptPath: 'agents/frontend-styling-expert.md',
  },
};

/**
 * Auto-detect the best agent based on user message content.
 * Called before each conversation to select the appropriate agent.
 */
export function detectAgent(message: string): Agent {
  const lower = message.toLowerCase();

  // C++ detection
  const cppKeywords = ['cpp', 'c++', 'class ', 'template', 'std::', 'namespace', 'pointer', 'memory management', 'raii', 'smart pointer', 'unique_ptr', 'shared_ptr', 'make_shared', 'vector<', 'map<', 'unordered_map', 'cmake', 'makefile', 'header file', '.hpp', '.hxx', '.cpp', 'virtual function', 'inheritance', 'polymorphism', 'move semantics', 'rvalue', 'lvalue'];
  if (cppKeywords.some(kw => lower.includes(kw))) return 'cpp_expert';

  // Python ML detection — use substring matches only for unambiguous tokens.
  // Ambiguous English words ('model', 'training', 'inference', 'tensor',
  // 'transformer', 'dataset', 'gradient') need word-boundary matches so normal
  // chat about "your model" doesn't get routed to Python ML.
  const mlSubstrings = ['pytorch', 'tensorflow', 'keras', 'sklearn', 'scikit-learn', 'xgboost', 'lightgbm', 'pandas', 'numpy', 'polars', 'jupyter', 'machine learning', 'deep learning', 'neural network', 'dataframe', 'backpropagation', 'fine-tune', 'fine tune', 'ml model', 'ai model', 'llm fine-tune', 'reinforcement learning', 'computer vision', 'natural language processing'];
  const mlWordRegex = /\b(?:training\s+(?:data|set|loop)|model\s+(?:training|inference|weights|checkpoint)|tensor(?:flow|s)?|transformer\b|bert|gpt-[0-9]|cnn|rnn|nlp|inference\s+(?:engine|server|pipeline)|notebook\.ipynb|gradient\s+descent)\b/i;
  if (mlSubstrings.some(kw => lower.includes(kw)) || mlWordRegex.test(message)) return 'python_ml';

  // Full-stack web development detection
  const webKeywords = ['next.js', 'nextjs', 'react', 'component', 'api route', 'database schema', 'prisma', 'tailwind', 'shadcn', 'frontend', 'backend', 'full-stack', 'fullstack', 'web app', 'dashboard', 'auth', 'authentication', 'login', 'signup', 'crud', 'rest api', 'graphql', 'typescript', 'tsx', 'jsx', 'html', 'css', 'responsive', 'ui component', 'page.tsx', 'layout.tsx', 'app router'];
  if (webKeywords.some(kw => lower.includes(kw))) return 'full-stack-developer';

  // Frontend styling detection
  const styleKeywords = ['css', 'styling', 'style', 'responsive', 'animation', 'transition', 'flexbox', 'grid', 'layout', 'tailwind', 'theme', 'dark mode', 'color', 'font', 'typography', 'hover', 'button style', 'card style', 'modal', 'dialog', 'dropdown', 'navbar', 'sidebar', 'hero section', 'landing page', 'ui/ux', 'ux', 'user experience', 'design system'];
  if (styleKeywords.some(kw => lower.includes(kw))) return 'frontend-styling-expert';

  // Default to general
  return 'general';
}

export interface SubAgentConfig {
  id: SubAgentType;
  name: string;
  description: string;
  icon: string;
  tools: string[];
  promptPath: string;
}

export const SUB_AGENTS: Record<SubAgentType, SubAgentConfig> = {
  'general-purpose': {
    id: 'general-purpose',
    name: 'General Purpose',
    description: 'Research complex questions and execute multi-step tasks',
    icon: '🔍',
    tools: ['read_file', 'create_file', 'edit_file', 'delete_file', 'grep', 'glob', 'shell_command', 'web_search', 'read_webpage'],
    promptPath: 'subagents/general-purpose.md',
  },
  explore: {
    id: 'explore',
    name: 'Explorer',
    description: 'Fast codebase exploration and search',
    icon: '📁',
    tools: ['glob', 'grep', 'read_file', 'list_directory'],
    promptPath: 'subagents/explore.md',
  },
  plan: {
    id: 'plan',
    name: 'Planner',
    description: 'Software architecture and implementation planning',
    icon: '📋',
    tools: ['glob', 'grep', 'read_file', 'list_directory'],
    promptPath: 'subagents/plan.md',
  },
  'frontend-styling-expert': {
    id: 'frontend-styling-expert',
    name: 'Frontend Styling Expert',
    description: 'CSS, responsive design, UI/UX, animations, layouts',
    icon: '🎨',
    tools: ['read_file', 'create_file', 'edit_file', 'glob', 'grep', 'shell_command'],
    promptPath: 'subagents/frontend-styling-expert.md',
  },
  'full-stack-developer': {
    id: 'full-stack-developer',
    name: 'Full-Stack Developer',
    description: 'Build complete web applications with React, APIs, databases',
    icon: '🛠️',
    tools: ['read_file', 'create_file', 'edit_file', 'delete_file', 'glob', 'grep', 'shell_command', 'web_search', 'read_webpage', 'list_directory'],
    promptPath: 'subagents/full-stack-developer.md',
  },
};

export const DEFAULT_AUTOPROMPT_CONFIG: AutoPromptConfig = {
  review: true,
  placeholder_cleanup: true,
  run_fix: true,
  senior_review: false,
  completeness: true,
  task_verify: false,
};

export type ModelProviderType = 'local' | 'cloud';

export interface ModelProviderProfile {
  id: string;
  name: string;
  type: ModelProviderType;
  apiProtocol: ModelApiProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const LOCAL_PROVIDER_ID = 'local-lmstudio';

export const DEFAULT_MODEL_PROVIDERS: ModelProviderProfile[] = [
  {
    id: LOCAL_PROVIDER_ID,
    name: 'Local LM Studio',
    type: 'local',
    apiProtocol: 'openai',
    baseUrl: 'http://localhost:1234',
    apiKey: '',
    model: 'local-model',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'cloud',
    apiProtocol: 'openai',
    baseUrl: 'https://openrouter.ai/api',
    apiKey: '',
    model: '',
  },
  {
    id: 'opencode-go-openai',
    name: 'OpenCode Go (OpenAI)',
    type: 'cloud',
    apiProtocol: 'openai',
    baseUrl: 'https://opencode.ai/zen/go',
    apiKey: '',
    model: '',
  },
  {
    id: 'opencode-go-anthropic',
    name: 'OpenCode Go (Anthropic)',
    type: 'cloud',
    apiProtocol: 'anthropic',
    baseUrl: 'https://opencode.ai/zen/go',
    apiKey: '',
    model: '',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible',
    type: 'cloud',
    apiProtocol: 'openai',
    baseUrl: 'https://api.openai.com',
    apiKey: '',
    model: '',
  },
];

export function resolveActiveModelProvider(
  providers: ModelProviderProfile[] | undefined,
  activeProviderId: string | undefined,
  lmstudioUrl = 'http://localhost:1234',
  selectedModel = 'local-model',
): ModelProviderProfile {
  const normalized = normalizeModelProviders(providers, lmstudioUrl, selectedModel);
  return normalized.find((provider) => provider.id === activeProviderId) || normalized[0];
}

function normalizeModelProviders(
  providers: ModelProviderProfile[] | undefined,
  lmstudioUrl = 'http://localhost:1234',
  selectedModel = 'local-model',
): ModelProviderProfile[] {
  const normalizeProvider = (provider: ModelProviderProfile): ModelProviderProfile => {
    const isLocalProvider = provider.id === LOCAL_PROVIDER_ID;
    const type: ModelProviderType = isLocalProvider
      ? 'local'
      : provider.type === 'local'
      ? 'local'
      : 'cloud';
    return {
      ...provider,
      type,
      apiProtocol: type === 'local' ? 'openai' : provider.apiProtocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: String(provider.baseUrl || ''),
      apiKey: String(provider.apiKey || ''),
      model: String(provider.model || ''),
    };
  };

  const existing = Array.isArray(providers) ? providers : [];
  const defaults = DEFAULT_MODEL_PROVIDERS.map((provider) => ({ ...provider }));
  const merged = defaults.map((fallback) => {
    const saved = existing.find((provider) => provider.id === fallback.id);
    if (!saved) return normalizeProvider(fallback);
    return normalizeProvider({ ...fallback, ...saved });
  });
  for (const provider of existing) {
    if (!merged.some((item) => item.id === provider.id)) {
      merged.push(normalizeProvider({
        id: String(provider.id || `provider-${Date.now()}`),
        name: String(provider.name || 'Custom Provider'),
        type: provider.type === 'cloud' ? 'cloud' : 'local',
        apiProtocol: provider.apiProtocol === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: String(provider.baseUrl || ''),
        apiKey: String(provider.apiKey || ''),
        model: String(provider.model || ''),
      }));
    }
  }
  const local = merged.find((provider) => provider.id === LOCAL_PROVIDER_ID);
  if (local) {
    local.baseUrl = local.baseUrl || lmstudioUrl || 'http://localhost:1234';
    local.model = local.model || selectedModel || 'local-model';
    local.type = 'local';
    local.apiProtocol = 'openai';
  }
  return merged;
}

export interface SubAgentDispatch {
  task_id: string;
  agent_type: string;
  depends_on?: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  objective: string;
  explore_context?: string;
  files_to_read: string[];
  output_files: Array<{
    path: string;
    action: 'create' | 'modify';
    description: string;
  }>;
  requirements?: string[];
  constraints?: string[];
  success_criteria: string[];
}

export function buildDispatchMessage(dispatch: SubAgentDispatch): string {
  const sections: string[] = [];

  sections.push(`Task ID: ${dispatch.task_id}`);
  sections.push(`Agent: ${dispatch.agent_type}`);
  if (dispatch.depends_on) {
    sections.push(`Depends On: ${dispatch.depends_on}`);
  }

  sections.push(`\n## Objective\n${dispatch.objective}`);

  if (dispatch.explore_context) {
    sections.push(`\n## Explore Agent Results (Context)\n${dispatch.explore_context}`);
  }

  sections.push(`\n## Files to Read`);
  for (const file of dispatch.files_to_read) {
    sections.push(`- ${file}`);
  }

  sections.push(`\n## Output Files`);
  sections.push(`| File | Action | Description |`);
  sections.push(`|------|--------|-------------|`);
  for (const file of dispatch.output_files) {
    sections.push(`| ${file.path} | ${file.action} | ${file.description} |`);
  }

  if (dispatch.requirements?.length) {
    sections.push(`\n## Requirements`);
    for (const req of dispatch.requirements) {
      sections.push(`${dispatch.requirements.indexOf(req) + 1}. ${req}`);
    }
  }

  if (dispatch.constraints?.length) {
    sections.push(`\n## Constraints`);
    for (const c of dispatch.constraints) {
      sections.push(`- ${c}`);
    }
  }

  sections.push(`\n## Success Criteria`);
  for (const sc of dispatch.success_criteria) {
    sections.push(`- [ ] ${sc}`);
  }

  return sections.join('\n');
}

export const AUTOPROMPT_STAGES = [
  {
    key: 'review' as const,
    name: 'Review',
    description: 'Debugs bugs, bad logic, safety issues, and code-quality problems',
    defaultEnabled: true,
    icon: 'SearchCheck',
  },
  {
    key: 'placeholder_cleanup' as const,
    name: 'Placeholder Cleanup',
    description: 'Removes stubs, mocks, placeholders, TODOs, fake paths, and dead code',
    defaultEnabled: true,
    icon: 'Eraser',
  },
  {
    key: 'run_fix' as const,
    name: 'Run Fix',
    description: 'Runs the software or closest runtime check and fixes failures',
    defaultEnabled: true,
    icon: 'Wrench',
  },
  {
    key: 'senior_review' as const,
    name: 'Senior Review',
    description: 'Advanced architectural review for code quality',
    defaultEnabled: false,
    icon: 'GraduationCap',
  },
  {
    key: 'completeness' as const,
    name: 'Completeness',
    description: 'Final verification against the original request and success criteria',
    defaultEnabled: true,
    icon: 'CheckCircle2',
  },
];

interface SettingsState {
  theme: string;
  lmstudioUrl: string;
  activeProviderId: string;
  modelProviders: ModelProviderProfile[];
  selectedModel: string;
  temperature: number;
  maxTokens: number;
  maxContextTokens: number;
  topP: number;
  repeatPenalty: number;
  lmOpti: boolean;
  cloudModeEnabled: boolean;
  autoPromptConfig: AutoPromptConfig;
  workingDirectory: string;
  subAgentEnabled: boolean;
  skillAutoLoad: boolean;
  structuredPlanningEnabled: boolean;
  goalModeEnabled: boolean;
  planningPassEnabled: boolean;
  planningPassTimeout: number;
  subagentFileScopeEnforcement: boolean;
  autoCompactionEnabled: boolean;
  autoCompactionLimitType: 'percent' | 'tokens';
  autoCompactionPercent: number;
  autoCompactionTokens: number;
  contextOverloadProtectionEnabled: boolean;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  _hasHydrated: boolean;

  setTheme: (theme: string) => void;
  setLmstudioUrl: (url: string) => void;
  setActiveProviderId: (id: string) => void;
  updateModelProvider: (id: string, patch: Partial<Omit<ModelProviderProfile, 'id'>>) => void;
  addModelProvider: () => void;
  removeModelProvider: (id: string) => void;
  setSelectedModel: (model: string) => void;
  setTemperature: (temp: number) => void;
  setMaxTokens: (tokens: number) => void;
  setMaxContextTokens: (tokens: number) => void;
  setTopP: (p: number) => void;
  setRepeatPenalty: (p: number) => void;
  setLmOpti: (v: boolean) => void;
  setCloudModeEnabled: (v: boolean) => void;
  setAutoPromptConfig: (config: Partial<AutoPromptConfig>) => void;
  setWorkingDirectory: (dir: string) => void;
  setSubAgentEnabled: (v: boolean) => void;
  setSkillAutoLoad: (v: boolean) => void;
  setStructuredPlanningEnabled: (v: boolean) => void;
  setGoalModeEnabled: (v: boolean) => void;
  setPlanningPassEnabled: (v: boolean) => void;
  setPlanningPassTimeout: (v: number) => void;
  setSubagentFileScopeEnforcement: (v: boolean) => void;
  setAutoCompactionEnabled: (v: boolean) => void;
  setAutoCompactionLimitType: (v: 'percent' | 'tokens') => void;
  setAutoCompactionPercent: (v: number) => void;
  setAutoCompactionTokens: (v: number) => void;
  setContextOverloadProtectionEnabled: (v: boolean) => void;
  setSidebarOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  matchMaxTokensToContext: () => void;
  setHasHydrated: (state: boolean) => void;
}

const DEFAULT_MAX_TOKENS = 30000;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'cyberpunk-neon',
      lmstudioUrl: 'http://localhost:1234',
      activeProviderId: LOCAL_PROVIDER_ID,
      modelProviders: DEFAULT_MODEL_PROVIDERS.map((provider) => ({ ...provider })),
      selectedModel: 'local-model',
      temperature: 0.7,
      maxTokens: DEFAULT_MAX_TOKENS,
      maxContextTokens: DEFAULT_MAX_TOKENS,
      topP: 0.9,
      repeatPenalty: 1.1,
      lmOpti: false,
      cloudModeEnabled: false,
      autoPromptConfig: { ...DEFAULT_AUTOPROMPT_CONFIG },
      workingDirectory: process.env.WORKING_DIRECTORY || process.cwd(),
      subAgentEnabled: true,
      skillAutoLoad: true,
      structuredPlanningEnabled: true,
      goalModeEnabled: false,
      planningPassEnabled: true,
      planningPassTimeout: 15000,
      subagentFileScopeEnforcement: true,
      autoCompactionEnabled: true,
      autoCompactionLimitType: 'percent',
      autoCompactionPercent: 90,
      autoCompactionTokens: 27000,
      contextOverloadProtectionEnabled: true,
      sidebarOpen: true,
      settingsOpen: false,
      _hasHydrated: false,

      setTheme: (theme) => set({ theme }),
      setLmstudioUrl: (url) => set((state) => ({
        lmstudioUrl: url,
        modelProviders: state.modelProviders.map((provider) =>
          provider.id === LOCAL_PROVIDER_ID ? { ...provider, baseUrl: url } : provider
        ),
      })),
      setActiveProviderId: (activeProviderId) => set({ activeProviderId }),
      updateModelProvider: (id, patch) => set((state) => {
        const modelProviders = normalizeModelProviders(state.modelProviders, state.lmstudioUrl, state.selectedModel)
          .map((provider) => provider.id === id ? { ...provider, ...patch } : provider);
        const active = modelProviders.find((provider) => provider.id === state.activeProviderId);
        return {
          modelProviders,
          lmstudioUrl: id === LOCAL_PROVIDER_ID && patch.baseUrl !== undefined ? String(patch.baseUrl) : state.lmstudioUrl,
          selectedModel: active?.model || state.selectedModel,
        };
      }),
      addModelProvider: () => set((state) => {
        const id = `provider-${Date.now()}`;
        const nextProvider: ModelProviderProfile = {
          id,
          name: 'Custom Cloud API',
          type: 'cloud',
          apiProtocol: 'openai',
          baseUrl: 'https://',
          apiKey: '',
          model: '',
        };
        return {
          modelProviders: [...normalizeModelProviders(state.modelProviders, state.lmstudioUrl, state.selectedModel), nextProvider],
          activeProviderId: id,
        };
      }),
      removeModelProvider: (id) => set((state) => {
        if (id === LOCAL_PROVIDER_ID) return {};
        const modelProviders = normalizeModelProviders(state.modelProviders, state.lmstudioUrl, state.selectedModel)
          .filter((provider) => provider.id !== id);
        return {
          modelProviders,
          activeProviderId: state.activeProviderId === id ? LOCAL_PROVIDER_ID : state.activeProviderId,
        };
      }),
      setSelectedModel: (model) => set((state) => ({
        selectedModel: model,
        modelProviders: state.modelProviders.map((provider) =>
          provider.id === state.activeProviderId ? { ...provider, model } : provider
        ),
      })),
      setTemperature: (temperature) => set({ temperature }),
      setMaxTokens: (maxTokens) => set({ maxTokens }),
      setMaxContextTokens: (maxContextTokens) => set({ maxContextTokens }),
      setTopP: (topP) => set({ topP }),
      setRepeatPenalty: (repeatPenalty) => set({ repeatPenalty }),
      setLmOpti: (lmOpti) => set({ lmOpti }),
      setCloudModeEnabled: (cloudModeEnabled) => set({ cloudModeEnabled }),
      setAutoPromptConfig: (config) =>
        set((state) => {
          const next = { ...state.autoPromptConfig, ...config };
          if (config.task_verify === true) next.completeness = true;
          return { autoPromptConfig: next };
        }),
      setWorkingDirectory: (workingDirectory) => set({ workingDirectory }),
      setSubAgentEnabled: (subAgentEnabled) => set({ subAgentEnabled }),
      setSkillAutoLoad: (skillAutoLoad) => set({ skillAutoLoad }),
      setStructuredPlanningEnabled: (structuredPlanningEnabled) => set({ structuredPlanningEnabled }),
      setGoalModeEnabled: (goalModeEnabled) => set({ goalModeEnabled }),
      setPlanningPassEnabled: (planningPassEnabled) => set({ planningPassEnabled }),
      setPlanningPassTimeout: (planningPassTimeout) => set({ planningPassTimeout }),
      setSubagentFileScopeEnforcement: (subagentFileScopeEnforcement) => set({ subagentFileScopeEnforcement }),
      setAutoCompactionEnabled: (autoCompactionEnabled) => set({ autoCompactionEnabled }),
      setAutoCompactionLimitType: (autoCompactionLimitType) => set({ autoCompactionLimitType }),
      setAutoCompactionPercent: (autoCompactionPercent) => set({ autoCompactionPercent }),
      setAutoCompactionTokens: (autoCompactionTokens) => set({ autoCompactionTokens }),
      setContextOverloadProtectionEnabled: (contextOverloadProtectionEnabled) => set({ contextOverloadProtectionEnabled }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      matchMaxTokensToContext: () => set((state) => ({ maxTokens: state.maxContextTokens })),
      setHasHydrated: (state) => set({ _hasHydrated: state }),
    }),
    {
      name: 'ec9v3-settings',
      version: 1,
      storage: createJSONStorage(createQuotaSafeLocalStorage),
      partialize: (state) => ({
        theme: state.theme,
        lmstudioUrl: state.lmstudioUrl,
        activeProviderId: state.activeProviderId,
        modelProviders: state.modelProviders,
        selectedModel: state.selectedModel,
        temperature: state.temperature,
        maxTokens: state.maxTokens,
        maxContextTokens: state.maxContextTokens,
        topP: state.topP,
        repeatPenalty: state.repeatPenalty,
        lmOpti: state.lmOpti,
        cloudModeEnabled: state.cloudModeEnabled,
        autoPromptConfig: state.autoPromptConfig,
        workingDirectory: state.workingDirectory,
        subAgentEnabled: state.subAgentEnabled,
        skillAutoLoad: state.skillAutoLoad,
        structuredPlanningEnabled: state.structuredPlanningEnabled,
        goalModeEnabled: state.goalModeEnabled,
        planningPassEnabled: state.planningPassEnabled,
        planningPassTimeout: state.planningPassTimeout,
        subagentFileScopeEnforcement: state.subagentFileScopeEnforcement,
        autoCompactionEnabled: state.autoCompactionEnabled,
        autoCompactionLimitType: state.autoCompactionLimitType,
        autoCompactionPercent: state.autoCompactionPercent,
        autoCompactionTokens: state.autoCompactionTokens,
        contextOverloadProtectionEnabled: state.contextOverloadProtectionEnabled,
      }),
      onRehydrateStorage: () => (state) => {
        pruneObsoleteBrowserStateStorage('ec9v3-settings');
        if (state) {
          state.autoPromptConfig = {
            ...DEFAULT_AUTOPROMPT_CONFIG,
            ...state.autoPromptConfig,
            completeness: state.autoPromptConfig.completeness || state.autoPromptConfig.task_verify,
            task_verify: false,
          };
          state.modelProviders = normalizeModelProviders(
            state.modelProviders,
            state.lmstudioUrl,
            state.selectedModel,
          );
          state.activeProviderId = state.activeProviderId || LOCAL_PROVIDER_ID;
          state.setHasHydrated(true);
          state.setSettingsOpen(false);
        }
      },
    }
  )
);
