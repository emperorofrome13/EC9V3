# EC9v3 System Architecture

## Overview

EC9v3 is a local AI coding assistant optimized for LM Studio deployment. It provides autonomous code generation, multi-stage review, sub-agent dispatch, and self-healing capabilities — all running locally.

---

## Core Flow

### 1. User Input → Agent Detection
When a user sends a message, `detectAgent()` analyzes the content and auto-selects the best agent:

| Agent | Trigger Keywords |
|-------|-----------------|
| **general** | Default fallback |
| **cpp_expert** | cpp, c++, class, template, std::, cmake, smart pointer, rvalue, etc. |
| **python_ml** | pytorch, tensorflow, sklearn, pandas, neural network, training, model, etc. |
| **full-stack-developer** | next.js, react, component, api route, prisma, tailwind, fullstack, etc. |
| **frontend-styling-expert** | css, styling, responsive, animation, flexbox, grid, tailwind, theme, etc. |

### 2. Internal Planning Phase
Before the tool loop begins, if `planningPassEnabled` is true and subagents are enabled:
- `runPlanningPass()` analyzes the user request with the detected agent and loaded skills
- Generates an `ExecutionPlan` with:
  - Task summary and complexity assessment
  - Files to read/create/modify
  - Subagent strategy (none/single/sequential/parallel)
  - File scoping for parallel agents (allowed_write/allowed_read per agent)
  - Success criteria for task verification
- Writes planning results to worklog for subagent context
- If planning fails or times out (15s default), falls back to default plan (empty, no subagents)

### 3. Skill Auto-Loading
If `skillAutoLoad` is enabled, `buildSkillPrompt()` scans the user message against 12 skill trigger patterns. Matching skills inject their instructions into the system prompt.

### 4. Tool Loop Execution
The selected agent enters a tool loop (up to 20 iterations):
1. LLM generates response + tool calls
2. Tools execute (create_file, read_file, edit_file, grep, glob, shell_command, web_search, etc.)
3. Results fed back to LLM
4. Loop continues until no more tool calls

### 5. Sub-Agent Dispatch
If `subAgentEnabled` is true and planning produced a non-empty strategy:
- **Plan-driven dispatch**: `dispatchSubAgents()` consumes the `ExecutionPlan` from the planning phase
- **Mode: `none`** → No subagents dispatched
- **Mode: `single`** → One agent dispatched with task spec from plan
- **Mode: `sequential`** → Agents sorted by `depends_on`, run one at a time with worklog context passing between agents
- **Mode: `parallel`** → All agents run concurrently with file scope restrictions:
  - Each agent gets `allowed_write` and `allowed_read` file lists
  - After completion, conflict detection checks if agents wrote outside their scope
  - Conflicts logged to console but don't block execution
- **Structured task specs**: Each sub-agent receives:
  - Task ID (unique identifier)
  - Objective (what needs to be accomplished)
  - Input files (files to read/reference)
  - Output files (files to create/modify)
  - Success criteria (how to verify completion)
  - Constraints (any limitations or requirements)
  - File scope (allowed_write/allowed_read for parallel mode)
- **Worklog integration**: All sub-agents read the shared `worklog.md` before starting and append their results after completing

### 6. Worklog System
A shared `worklog.md` file in the working directory serves as the single source of truth:
- **Read before execution**: Each sub-agent reads the worklog to understand what has already been done
- **Append after completion**: Each sub-agent appends its results with timestamp, task ID, and outcome
- **Planning context**: Planning pass writes its execution plan to worklog for subagent visibility
- **Prevents duplication**: Agents know what previous agents accomplished
- **Shared context**: Enables coordination between sequential and parallel agents

### 7. AutoPrompt Review Pipeline
After the main response is generated, enabled AutoPrompt stages run sequentially:

| Stage | Purpose |
|-------|---------|
| **review** | Code quality, correctness, security, performance |
| **completeness** | Checks if all user requirements were met |
| **run_fix** | Generates fixes for identified issues |
| **senior_review** | Architectural review (off by default) |
| **task_verify** | Final verification against success criteria (off by default) |

---

## Verification Gates

After the tool loop completes and before AutoPrompt runs, the system performs automatic verification:

### TypeScript Compilation Check
```
Code Generated → Check for tsconfig.json → Run `npx tsc --noEmit`
                                          ↓
                              Pass: "TypeScript compilation passed ✓"
                              Fail: Full error output captured
```

- Only triggers if `tsconfig.json` exists in the working directory
- 60-second timeout
- Results streamed to client as `verification_start` / `verification_result` events
- Failures are captured and included in the AutoPrompt context for automatic fixing

---

## Self-Correction Loop

The AutoPrompt system includes a built-in self-correction mechanism that **never escalates to the user**:

```
┌─────────────────────────────────────────┐
│  AutoPrompt Self-Correction Loop        │
├─────────────────────────────────────────┤
│                                         │
│  1. Run all enabled stages              │
│     (review → completeness → etc.)      │
│              ↓                          │
│  2. Any stage FAIL?                     │
│     ├── NO → Done, return results       │
│     └── YES → Continue                  │
│              ↓                          │
│  3. Is `run_fix` stage enabled?         │
│     ├── NO → Done (issues noted)        │
│     └── YES → Continue                  │
│              ↓                          │
│  4. Fix round < 3?                      │
│     ├── NO → Done (max retries hit)     │
│     └── YES → Run `run_fix` stage       │
│              ↓                          │
│  5. Append fix output to context        │
│     Go back to step 1                   │
│                                         │
└─────────────────────────────────────────┘
```

### Key Behaviors:
- **Max 3 fix rounds** — prevents infinite loops
- **Context accumulation** — each fix round's output is appended to the context for the next round
- **Full tool access** — `run_fix` has all 12 tools available, can actually modify files
- **No user escalation** — the loop handles everything internally. If it can't fix after 3 rounds, it simply reports the remaining issues
- **Auto-detection** — if `run_fix` is in the enabled stages, the loop activates automatically

### Example Flow:
```
User: "Create a login page with form validation"

1. Main agent creates the login page files
2. Verification: tsc --noEmit → FAILS (type errors)
3. AutoPrompt review: FAILS (missing error handling)
4. AutoPrompt completeness: FAILS (no password strength check)
5. Self-correction loop round 1:
   - run_fix analyzes all failures
   - Fixes type errors, adds error handling, adds password validation
6. Re-run stages:
   - review: PASS ✓
   - completeness: PASS ✓
7. Done — all stages passed
```

---

## Architecture Diagram

```
User Message
    ↓
detectAgent() → Selects best agent (general, cpp_expert, python_ml, full-stack, frontend)
    ↓
buildSkillPrompt() → Injects matching skill instructions (if skillAutoLoad enabled)
    ↓
runPlanningPass() → Generates ExecutionPlan (files, strategy, scoping)
    ↓
┌──────────────────────────────────────────────┐
│  Main Tool Loop (up to 20 iterations)        │
│  - LLM generates response + tool calls       │
│  - Tools execute (12 available tools)        │
│  - Results fed back to LLM                   │
└──────────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────────┐
│  Sub-Agent Dispatch (if subAgentEnabled)     │
│  - Consumes ExecutionPlan from planning      │
│  - Modes: none | single | sequential | para  │
│  - Sequential: dependency-based ordering     │
│  - Parallel: file scope enforcement          │
│  - Conflict detection on scope violations    │
└──────────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────────┐
│  Verification Gates                          │
│  - TypeScript: npx tsc --noEmit              │
│  - Results streamed to client                │
└──────────────────────────────────────────────┘
    ↓
┌──────────────────────────────────────────────┐
│  AutoPrompt Pipeline + Self-Correction       │
│  - review → completeness → run_fix loop      │
│  - senior_review → task_verify (optional)    │
│  - Up to 3 auto-fix rounds                   │
│  - No user escalation                        │
└──────────────────────────────────────────────┘
    ↓
Final Response Streamed to User
```

---

## Configuration

All settings are stored in Zustand with localStorage persistence:

| Setting | Default | Purpose |
|---------|---------|---------|
| `selectedModel` | `local-model` | Use currently loaded LM Studio model |
| `maxTokens` | `30000` | Max tokens for LLM responses |
| `temperature` | `0.7` | LLM creativity |
| `subAgentEnabled` | `true` | Enable sub-agent dispatch |
| `skillAutoLoad` | `true` | Auto-detect and inject skills |
| `planningPassEnabled` | `true` | Run planning pass before tool loop |
| `planningPassTimeout` | `15000` | Planning phase timeout in ms (15s) |
| `subagentFileScopeEnforcement` | `true` | Warn on file scope violations in parallel mode |
| `autoPromptConfig` | `review:true, completeness:true, run_fix:true` | Which AutoPrompt stages run |
| `workingDirectory` | `process.cwd()` | Base directory for file operations |

### Planning Pass Configuration

The planning pass is a lightweight LLM call that produces structured execution plans:

```typescript
interface ExecutionPlan {
  task_summary: string;          // One-sentence task description
  complexity: 'low' | 'medium' | 'high';
  files_to_read: string[];       // Files needed for context
  files_to_create: string[];     // Expected new files
  files_to_modify: string[];     // Existing files to change
  subagent_strategy: {
    mode: 'none' | 'single' | 'sequential' | 'parallel';
    agents: Array<{
      type: string;
      objective: string;
      depends_on: string | null;  // Task ID of dependency
    }>;
  };
  file_scoping: Array<{
    agent_index: number;
    allowed_write: string[];     // Files this agent may modify
    allowed_read: string[];      // Files this agent may read
  }>;
  success_criteria: string[];    // Testable completion conditions
}
```

- **Graceful fallback**: If planning fails or times out, system uses default plan (empty, mode: 'none')
- **Non-blocking**: Planning pass never blocks execution; it's advisory, not mandatory
- **Subagent coordination**: Plan consumed by `dispatchSubAgents()` to determine execution strategy
