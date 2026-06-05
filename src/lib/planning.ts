import type { PlanState, PlanStep } from '@/types/ec9v3';

export interface PlanTask {
  id: string;
  title: string;
  description?: string;
  depends_on: string[];
  files_to_read: string[];
  files_to_create: string[];
  files_to_modify: string[];
  success_criteria: string;
}

export interface ExecutionPlan {
  task_summary: string;
  complexity: 'low' | 'medium' | 'high';
  tasks: PlanTask[];
  subagent_strategy: 'none' | 'single' | 'sequential' | 'parallel';
  file_scoping: Record<string, { allowed_read?: string[]; allowed_write?: string[] }>;
}

export const TODO_DISCIPLINE_PROTOCOL = `STRUCTURED PLANNING / TODO DISCIPLINE PROTOCOL (ENFORCED):

When structured planning is enabled, you must create a TODO plan before answering with results or using any non-todo tool. For normal conversation, the user should turn Structured Planning off.

WHEN TO CREATE A PLAN:
- Task has 3+ distinct steps or involves multiple files
- User explicitly asks for a plan
- Task is complex enough you might lose track

WHEN NOT TO CREATE A PLAN (ONLY IF STRUCTURED PLANNING IS OFF):
- Answering a question
- Single tool call
- Explaining something
- Casual conversation
- Trivial task (one change, one fix)

FREEFORM MODE:
- Used only before the first plan exists or after all plan steps are completed/removed.
- While Structured Planning is enabled, non-todo tools are blocked until todo.write creates a plan and sets a step to in_progress.
- NEVER call todo.write and another tool in the same response.

PROTOCOL MODE:
Prefer not to mix todo.write and other tools in the same response. After the first plan exists, the server treats phase mistakes as reminders instead of blocking useful tool work.

Use this strict three-phase loop:

1. DECLARE phase:
   - Prefer todo.write calls only.
   - Set exactly one step to in_progress.
   - Avoid read/write/shell/search tools in this response unless the work would otherwise stall.

2. EXECUTE phase:
   - Prefer non-todo tool calls only.
   - Run the tools needed for the current in_progress step.
   - Avoid todo.write in this response unless you need to repair stale plan state.
   - The server collects tool evidence: tool name, success/failure, and result summary.

3. RESOLVE phase:
   - Prefer todo.write calls only.
   - Mark the current step completed only if tool evidence supports it.
   - After marking a step completed, leave remaining work pending; the next response declares the next in_progress step.
   - If work is not complete, keep the current step in_progress or adjust the plan.
   - If you mark a step completed without tool evidence, the server rejects it with:
     "Cannot mark step completed — no tool evidence collected"

Example:
Response 1: todo.write([{ id: "1", content: "Inspect files", status: "in_progress", priority: "high" }, ...])
Response 2: read_file(...), grep(...), shell_command(...)
Response 3: todo.write([{ id: "1", content: "Inspect files", status: "completed", priority: "high" }, { id: "2", content: "Apply fix", status: "pending", priority: "high" }, ...])
Response 4: todo.write([{ id: "1", content: "Inspect files", status: "completed", priority: "high" }, { id: "2", content: "Apply fix", status: "in_progress", priority: "high" }, ...])
Response 5: edit_file(...), shell_command(...)
Response 6: todo.write([...completed steps...])

When all plan steps are completed or removed, the server exits PROTOCOL mode and returns to FREEFORM mode.`;

export const QUALITY_GATES = `QUALITY GATES (ALWAYS ACTIVE):

You have three quality gates that apply to EVERY task. A failed gate means you STOP and fix the problem before proceeding to the user.

--- GATE 1: PLAN COMPLETENESS ---
Before you start executing, verify your plan covers the full request:
□ Every user requirement maps to at least one planned step
□ Every step is specific enough for another developer to execute without ambiguity
□ The plan defines what "done" looks like (what files exist, what they contain, where they're saved)
□ Steps are ordered so no step depends on output from a later step

If any check fails: expand your plan before executing. Do NOT start coding with an incomplete plan.

--- GATE 2: OUTPUT VALIDATION ---
After generating each deliverable, verify the output before telling the user it's done:
□ The file you claim to have created actually exists at the path you specified
□ The file is not empty (0 bytes = hard failure)
□ The file is in the correct output directory, not a temp or wrong location
□ The file contains real content, not just templates/scaffolding with no actual logic
□ If it's runnable code: dependencies installed, no import errors, no syntax errors, build succeeds

If any check fails: fix the specific issue and re-validate. Do NOT report completion for a broken deliverable.

--- GATE 3: TASK COMPLETION INTEGRITY ---
At the very end, after all deliverables are generated and validated:
□ Every requirement from the original request has a corresponding output that addresses it
□ Every output maps back to an actual user requirement (no scope creep)
□ Every planned step is either completed with a verified deliverable, or explicitly removed with a stated reason - no step may silently disappear
□ If you implemented part of a feature (e.g., 3 of 5 endpoints, UI without backend), you MUST explicitly report what was completed and what was NOT. Do NOT claim full completion for partial work.

If any check fails: complete the missing deliverables, remove scope creep, or explicitly acknowledge partial delivery.

GATE EXECUTION ORDER: Gate 1 (before execution) -> Gate 2 (after each deliverable) -> Gate 3 (after all deliverables). Never skip a gate. Never run them out of order.`;

function normalizeStatusLine(line: string): string {
  return line
    .replace(/âœ…/g, '✅')
    .replace(/ðŸ”„/g, '🔄')
    .replace(/âŒ/g, '❌')
    .replace(/ðŸ“‹/g, '📋');
}

function upsertStep(steps: PlanStep[], next: PlanStep): PlanStep[] {
  const index = steps.findIndex((step) => step.id === next.id);
  if (index === -1) return [...steps, next];
  return steps.map((step, i) => (i === index ? { ...step, ...next } : step));
}

export function parsePlanState(text: string, previous?: PlanState | null, enabled = true): PlanState | null {
  if (!enabled) {
    return { mode: 'off', steps: [], updatedAt: new Date().toISOString() };
  }

  const normalizedLines = text.split(/\r?\n/).map(normalizeStatusLine);
  const sawPlanningMarker = normalizedLines.some((line) => /📋\s*Plan:|^Plan:/i.test(line) || /✅|🔄|❌|Done:|Working on:|Removed:/i.test(line));
  if (!sawPlanningMarker && !previous) return null;

  let steps: PlanStep[] = previous?.steps ? [...previous.steps] : [];
  let currentStep = previous?.currentStep;
  let inPlan = false;

  for (const rawLine of normalizedLines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/📋\s*Plan:|^Plan:/i.test(line)) {
      inPlan = true;
      continue;
    }

    const planMatch = inPlan
      ? line.match(/^(?:[-*]\s*)?([0-9]+(?:-[a-z])?)\.\s+(.+)$/i)
      : null;
    if (planMatch) {
      steps = upsertStep(steps, {
        id: planMatch[1],
        description: planMatch[2].trim(),
        status: steps.find((step) => step.id === planMatch[1])?.status || 'pending',
      });
      continue;
    }

    if (inPlan && /^(?:✅|🔄|❌|Done:|Working on:|Removed:)/i.test(line)) {
      inPlan = false;
    }

    const doneMatch = line.match(/^(?:✅\s*)?Done:\s*Step\s+([0-9]+(?:-[a-z])?)\s*(?:[-—:]\s*)?(.+)?$/i);
    if (doneMatch) {
      steps = upsertStep(steps, {
        id: doneMatch[1],
        description: doneMatch[2]?.trim() || steps.find((step) => step.id === doneMatch[1])?.description || '',
        status: 'completed',
      });
      if (currentStep === doneMatch[1]) currentStep = undefined;
      continue;
    }

    const workingMatch = line.match(/^(?:🔄\s*)?Working on:\s*Step\s+([0-9]+(?:-[a-z])?)\s*(?:[-—:]\s*)?(.+)?$/i);
    if (workingMatch) {
      currentStep = workingMatch[1];
      steps = steps.map((step) => step.status === 'in_progress' ? { ...step, status: 'pending' } : step);
      steps = upsertStep(steps, {
        id: workingMatch[1],
        description: workingMatch[2]?.trim() || steps.find((step) => step.id === workingMatch[1])?.description || '',
        status: 'in_progress',
      });
      continue;
    }

    const removedMatch = line.match(/^(?:❌\s*)?Removed:\s*Step\s+([0-9]+(?:-[a-z])?)\s*(?:[-—:]\s*)?(.+?)?(?:\s*(?:->|→)\s*Reason:\s*(.+))?$/i);
    if (removedMatch) {
      steps = upsertStep(steps, {
        id: removedMatch[1],
        description: removedMatch[2]?.trim() || steps.find((step) => step.id === removedMatch[1])?.description || '',
        status: 'removed',
        reason: removedMatch[3]?.trim(),
      });
      if (currentStep === removedMatch[1]) currentStep = undefined;
    }
  }

  if (steps.length === 0 && !previous) return null;

  return {
    mode: 'on',
    steps,
    currentStep,
    updatedAt: new Date().toISOString(),
  };
}
