"use client";

import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useChatStore } from "@/stores/chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";

export function PlanStatePanel() {
  const structuredPlanningEnabled = useSettingsStore((s) => s.structuredPlanningEnabled);
  const activeConversation = useChatStore((s) => s.getActiveConversation());
  const planState = activeConversation?.planState;

  if (!structuredPlanningEnabled) {
    return (
      <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Structured Planning</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Planning disabled. AI executes directly.</p>
        </CardContent>
      </Card>
    );
  }

  const steps = planState?.steps || [];
  const currentStep = steps.find((step) => step.status === "in_progress");

  return (
    <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">
          Structured Planning
          {currentStep && (
            <span className="ml-2 align-middle text-[10px] font-normal text-primary">
              Step {currentStep.id} active
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {steps.length === 0 ? (
          <p className="text-xs text-muted-foreground">Waiting for the assistant to create a plan.</p>
        ) : (
          <div className="space-y-2">
            {steps.map((step) => {
              const isDone = step.status === "completed";
              const isWorking = step.status === "in_progress";
              const isRemoved = step.status === "removed";
              return (
                <div key={step.id} className="flex gap-2 text-xs">
                  <div className="mt-0.5 shrink-0">
                    {isDone ? (
                      <CheckCircle2 className="size-3.5 text-emerald-500" />
                    ) : isWorking ? (
                      <Loader2 className="size-3.5 animate-spin text-primary" />
                    ) : isRemoved ? (
                      <XCircle className="size-3.5 text-destructive" />
                    ) : (
                      <Circle className="size-3.5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "leading-snug",
                        isDone && "text-muted-foreground line-through",
                        isWorking && "font-semibold text-foreground",
                        isRemoved && "text-muted-foreground line-through opacity-70",
                        !isDone && !isWorking && !isRemoved && "text-muted-foreground"
                      )}
                    >
                      <span className="font-mono">{step.id}.</span> {step.description || "(no description yet)"}
                    </p>
                    {isRemoved && step.reason && (
                      <p className="mt-0.5 text-[10px] text-destructive/80">Reason: {step.reason}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
