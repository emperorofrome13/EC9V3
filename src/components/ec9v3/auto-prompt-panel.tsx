"use client";

import { useMemo } from "react";
import {
  SearchCheck,
  ListChecks,
  Eraser,
  Wrench,
  GraduationCap,
  CheckCircle2,
  Check,
  X,
  Loader2,
  Zap,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  useSettingsStore,
  AUTOPROMPT_STAGES,
  DEFAULT_AUTOPROMPT_CONFIG,
} from "@/stores/settings-store";
import { useChatStore } from "@/stores/chat-store";
import type { AutoPromptConfig, AutoPromptStageResult } from "@/types/ec9v3";

const ICON_MAP: Record<string, React.ElementType> = {
  SearchCheck,
  ListChecks,
  Eraser,
  Wrench,
  GraduationCap,
  CheckCircle2,
};

type StageKey = keyof AutoPromptConfig;

const PRESETS: Array<{
  name: string;
  label: string;
  icon: React.ReactNode;
  config: Partial<AutoPromptConfig>;
}> = [
  {
    name: "quick",
    label: "Quick",
    icon: <Zap className="h-3 w-3" />,
    config: { review: true, placeholder_cleanup: true, run_fix: false, senior_review: false, completeness: true, task_verify: false },
  },
  {
    name: "fullcode",
    label: "Full Code",
    icon: <CheckCircle2 className="h-3 w-3" />,
    config: { review: true, placeholder_cleanup: true, run_fix: true, senior_review: true, completeness: true, task_verify: false },
  },
  {
    name: "alloff",
    label: "All Off",
    icon: <X className="h-3 w-3" />,
    config: { review: false, placeholder_cleanup: false, run_fix: false, senior_review: false, completeness: false, task_verify: false },
  },
];

export function AutoPromptPanel() {
  const { autoPromptConfig, setAutoPromptConfig } = useSettingsStore();
  const activeConv = useChatStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId) || null
  );

  const results: AutoPromptStageResult[] = useMemo(() => {
    if (!activeConv) return [];
    return activeConv.messages
      .filter((m) => m.role === "autoprompt" && m.autopromptStage)
      .map((m) => ({
        stage: m.autopromptStage as AutoPromptStageResult['stage'],
        passed: m.autopromptPass ?? false,
        summary: m.content,
        details: m.autopromptDetails || m.content,
      }));
  }, [activeConv]);

  const latestResults = useMemo(() => {
    const byStage = new Map<string, AutoPromptStageResult>();
    for (const result of results) {
      byStage.set(result.stage, result);
    }
    return AUTOPROMPT_STAGES
      .map((stage) => byStage.get(stage.key))
      .filter((result): result is AutoPromptStageResult => Boolean(result));
  }, [results]);

  const isStreaming = useChatStore((s) => s.isStreaming);

  const isPipelineEnabled = useMemo(
    () => Object.values(autoPromptConfig).some(Boolean),
    [autoPromptConfig]
  );

  const toggleStage = (key: StageKey) => {
    setAutoPromptConfig({ [key]: !autoPromptConfig[key] });
  };

  const applyPreset = (config: Partial<AutoPromptConfig>) => {
    setAutoPromptConfig(config);
  };

  const getStageStatus = (key: string) => {
    const result = [...results].reverse().find((r) => r.stage === key);
    if (result) return result.passed ? "completed" as const : "failed" as const;

    if (isStreaming && autoPromptConfig[key as StageKey]) {
      const failedStageExists = results.some((r) => !r.passed);
      const executableStages = AUTOPROMPT_STAGES
        .map((stage) => stage.key)
        .filter((stageKey) => autoPromptConfig[stageKey])
        .filter((stageKey) => stageKey !== "run_fix" || failedStageExists);
      const completedStages = new Set(results.map((r) => r.stage));
      const currentStage = executableStages.find((stageKey) => !completedStages.has(stageKey));
      if (currentStage === key) {
        return "running" as const;
      }
    }

    if (autoPromptConfig[key as StageKey]) {
      return "enabled" as const;
    }
    return "disabled" as const;
  };

  return (
    <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-semibold">AutoPrompt Pipeline</CardTitle>
          </div>
          <Switch
            checked={isPipelineEnabled}
            onCheckedChange={(checked) => {
              if (!checked) {
                setAutoPromptConfig({
                  review: false,
                  placeholder_cleanup: false,
                  completeness: false,
                  run_fix: false,
                  senior_review: false,
                  task_verify: false,
                });
              } else {
                setAutoPromptConfig({ ...DEFAULT_AUTOPROMPT_CONFIG });
              }
            }}
            disabled={isStreaming}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="relative">
          <div className="space-y-0">
            {AUTOPROMPT_STAGES.map((stage, index) => {
              const stageKey = stage.key;
              const status = getStageStatus(stageKey);
              const isEnabled = autoPromptConfig[stageKey as StageKey];
              const isLast = index === AUTOPROMPT_STAGES.length - 1;
              const IconComponent = ICON_MAP[stage.icon] || CheckCircle2;

              return (
                <div key={stageKey} className="relative flex">
                  <div className="flex flex-col items-center">
                    <motion.div
                      className={`
                        relative z-10 flex h-9 w-9 items-center justify-center rounded-full border-2
                        transition-colors duration-300
                        ${status === "running" ? "border-primary bg-primary/20 text-primary" : ""}
                        ${status === "completed" ? "border-emerald-500 bg-emerald-500/20 text-emerald-500" : ""}
                        ${status === "failed" ? "border-destructive bg-destructive/20 text-destructive" : ""}
                        ${status === "enabled" ? "border-primary/60 bg-primary/10 text-primary" : ""}
                        ${status === "disabled" ? "border-muted-foreground/30 bg-muted/50 text-muted-foreground/50" : ""}
                      `}
                      animate={status === "running" ? { scale: [1, 1.1, 1] } : {}}
                      transition={status === "running" ? { duration: 1.5, repeat: Infinity, ease: "easeInOut" } : {}}
                    >
                      {status === "running" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : status === "completed" ? (
                        <Check className="h-4 w-4" />
                      ) : status === "failed" ? (
                        <X className="h-4 w-4" />
                      ) : (
                        <IconComponent className="h-4 w-4" />
                      )}
                    </motion.div>

                    {!isLast && (
                      <div className="relative h-8 w-0.5">
                        <div
                          className={`
                            absolute inset-0 w-full
                            ${status === "completed" ? "bg-emerald-500/50" : ""}
                            ${status === "running" ? "bg-primary/50" : ""}
                            ${status === "failed" ? "bg-destructive/30" : ""}
                            ${status === "enabled" ? "bg-primary/30" : ""}
                            ${status === "disabled" ? "bg-muted-foreground/15" : ""}
                          `}
                        />
                        {status === "running" && (
                          <motion.div
                            className="absolute left-0 top-0 h-full w-full bg-primary"
                            animate={{ scaleY: [0, 1] }}
                            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                            style={{ transformOrigin: "top" }}
                          />
                        )}
                      </div>
                    )}
                  </div>

                  <div className="ml-3 flex-1 pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-medium ${status === "disabled" ? "text-muted-foreground/60" : "text-foreground"}`}
                        >
                          {stage.name}
                        </span>
                        {status === "running" && (
                          <Badge variant="outline" className="border-primary/50 bg-primary/10 text-primary text-[10px] px-1.5 py-0">
                            Running
                          </Badge>
                        )}
                        {status === "completed" && (
                          <Badge variant="outline" className="border-emerald-500/50 bg-emerald-500/10 text-emerald-500 text-[10px] px-1.5 py-0">
                            Passed
                          </Badge>
                        )}
                        {status === "failed" && (
                          <Badge variant="outline" className="border-destructive/50 bg-destructive/10 text-destructive text-[10px] px-1.5 py-0">
                            Failed
                          </Badge>
                        )}
                      </div>
                      <Switch
                        checked={isEnabled}
                        onCheckedChange={() => toggleStage(stageKey as StageKey)}
                        disabled={isStreaming}
                        className="scale-75"
                      />
                    </div>
                    <p
                      className={`text-xs mt-0.5 ${status === "disabled" ? "text-muted-foreground/40" : "text-muted-foreground"}`}
                    >
                      {stage.description}
                    </p>
                    {(status === "completed" || status === "failed") && [...results].reverse().find((r) => r.stage === stageKey)?.summary && (
                      <p
                        className={`text-[11px] mt-1 line-clamp-2 font-mono ${status === "failed" ? "text-destructive/80" : "text-emerald-500/80"}`}
                      >
                        {[...results].reverse().find((r) => r.stage === stageKey)!.summary}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Separator className="my-2" />

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Quick presets</p>
          <div className="grid grid-cols-3 gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.name}
                variant="outline"
                size="sm"
                className="h-8 text-xs justify-center gap-1.5"
                onClick={() => applyPreset(preset.config)}
                disabled={isStreaming}
              >
                {preset.icon}
                {preset.label}
              </Button>
            ))}
          </div>
        </div>

        {latestResults.length > 0 && (
          <AnimatePresence>
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              transition={{ duration: 0.3 }}
            >
              <Separator className="my-2" />
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Latest Run ({latestResults.filter((r) => r.passed).length}/{latestResults.length} passed)
                </p>
                <div className="space-y-1">
                  {latestResults.map((result, index) => (
                    <div
                      key={`${result.stage}-${index}`}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50 transition-colors"
                    >
                      {result.passed ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                      ) : (
                        <X className="h-3.5 w-3.5 text-destructive shrink-0" />
                      )}
                      <span className="font-medium truncate capitalize">
                        {result.stage.replace("_", " ")}
                      </span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 ml-auto shrink-0 ${
                          result.passed ? "border-emerald-500/30 text-emerald-500" : "border-destructive/30 text-destructive"
                        }`}
                      >
                        {result.passed ? "Pass" : "Fail"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        )}
      </CardContent>
    </Card>
  );
}
