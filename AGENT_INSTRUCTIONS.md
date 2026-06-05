# Agent Instructions — Controlling EC9v3 via CLI

You are an AI agent operating the EC9v3 coding assistant app. You **cannot** click the UI. You drive the app by invoking `cli.mjs`, which talks to the running Next.js server over HTTP and produces structured logs you can read back.

---

## Prerequisites — verify before doing anything

Run, in order:

```
node cli.mjs health
```

Expected output contains both `[ok]    server reachable` and `[ok]    lmstudio reachable`. If either fails:

| Failure | Cause | Action |
| --- | --- | --- |
| `server unreachable` | Next.js dev server not running | Start it: `npm run dev` in a separate terminal. Wait for `Ready in …`, then re-run `health`. |
| `lmstudio HTTP …` / `unreachable` | LM Studio not running or bound to a different port | Launch LM Studio, load a model, start the server (default `http://localhost:1234`). Or pass `--lmstudio <url>`. |

Do **not** proceed to `chat` or `test` until both are `[ok]`. Calling chat without LM Studio will hang or return 500.

If a model isn't loaded yet, call:

```
node cli.mjs models
```

You'll get one model id per line on stdout. Pass one with `--model <id>` (or rely on whatever LM Studio currently has loaded).

---

## How to send a prompt

```
node cli.mjs chat "your message here" [flags]
```

**Stdout** = the assistant's streaming text (token-by-token). **Stderr** = structured event log (`[info]`, `[ok]`, tool calls, autoprompt verdicts, errors). Capture both:

```
node cli.mjs chat "..." > out.txt 2> events.txt
```

### Flags you should know

- `--agent general|cpp_expert|python_ml|full-stack-developer|frontend-styling-expert` — pick a specialist system prompt. Default `general`.
- `--cwd <path>` — working directory for file/shell tools (defaults to the project root). **Always pass this** if your task targets a specific folder.
- `--model <id>` — only if multiple models exist. Otherwise omit.
- `--system "<prompt>"` — override the agent's system prompt entirely (use sparingly).
- `--planning` — enable the planning pass (recommended for non-trivial tasks: it produces a structured plan and may dispatch sub-agents).
- `--sub-agents` — allow the planner to dispatch specialist sub-agents (`general-purpose`, `explore`, `plan`, `frontend-styling-expert`, `full-stack-developer`).
- `--autoprompt` — runs `review` + `completeness` after the main answer. Use this when correctness matters.
- `--autoprompt full` — runs all five stages (`review`, `completeness`, `run_fix`, `senior_review`, `task_verify`) plus self-correction loop (up to 3 fix rounds). Slow but thorough.
- `--temperature <n>` — 0.2 for code/precision, 0.7 for ideation. Default 0.7.
- `--max-tokens <n>` — default 30000. Lower for short replies.
- `--timeout <sec>` — abort after N seconds. Default 300. Raise for long autoprompt runs.
- `--no-skills` — disable skill auto-load (you usually want it on).

### Recommended invocations

| Goal | Command |
| --- | --- |
| Quick question / explanation | `node cli.mjs chat "..." --temperature 0.3` |
| Edit a single file | `node cli.mjs chat "..." --cwd <dir> --temperature 0.2` |
| Multi-file change | `node cli.mjs chat "..." --cwd <dir> --planning --sub-agents` |
| Production-quality output | add `--autoprompt full --timeout 900` |
| Debug a bug | `node cli.mjs chat "..." --cwd <dir> --autoprompt --temperature 0.2` |

---

## Reading the logs

Every run writes two files into `logs/`, named `cli-<ISO-timestamp>.{jsonl,log}`. The CLI prints both paths to stderr — capture them.

### `cli-<ts>.jsonl` — structured events (machine-readable)

One JSON object per line. Each line has `t` (ISO timestamp) and `type`. Important types:

| `type` | Meaning | Key fields |
| --- | --- | --- |
| `cli.start` | Run begins | `command`, `flags`, `server`, `lmstudio`, `model`, `cwd` |
| `chat.start` | Request sent | `message`, `body` (config used) |
| `sse` | Raw SSE chunk from server | `chunk.type` is one of: `content`, `tool_call`, `tool_result`, `auto_prompt_stage_start`, `auto_prompt_stage`, `sub_agent_start`, `sub_agent_result`, `error`, `done` |
| `chat.done` | Final summary | `elapsed`, `assistantChars`, `toolCalls`, `stages`, `error` |
| `chat.error` | Network/HTTP failure | `error` |
| `chat.aborted` | Hit `--timeout` | `elapsed` |
| `cli.fatal` | CLI itself crashed | `error`, `stack` |
| `cli.end` | Run finished | `code` (process exit code) |
| `parse_error` | Server sent malformed SSE line | `line`, `error` |

### Parsing recipes

Get the assistant's full text:
```
node -e "for (const l of require('fs').readFileSync('logs/<file>.jsonl','utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l); if (e.type==='sse' && e.chunk?.type==='content') process.stdout.write(e.chunk.content||''); }"
```

List all tool calls and outcomes:
```
node -e "for (const l of require('fs').readFileSync('logs/<file>.jsonl','utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l); if (e.type==='sse' && e.chunk?.type==='tool_result') console.log(e.chunk.toolCall.name, e.chunk.toolCall.isError?'ERROR':'OK', (e.chunk.toolCall.result||'').slice(0,120)); }"
```

Find errors only:
```
findstr /C:"\"type\":\"error\"" /C:"\"isError\":true" /C:"chat.error" /C:"cli.fatal" logs\<file>.jsonl
```
(PowerShell: same but `Select-String` instead of `findstr`.)

### `cli-<ts>.log` — human-readable transcript

Includes the final `=== ASSISTANT FINAL ===` block. Read this when you need to answer a user about what the model said.

---

## Testing

```
node cli.mjs test           # quick: health + models + 1 chat probe (~30s)
node cli.mjs test --full    # adds tool-use probe + autoprompt probe (~3-5min)
```

Exit code is `0` if all probes pass. Each case logs `test.case` with `passed`, `ms`, and either an `outcome` or `error` field.

**Use the test command before and after making code changes** to detect regressions. The `--full` suite exercises:
- `chat_simple` — basic generation works
- `chat_tool_use` — model can call `list_directory` (validates tool loop)
- `chat_autoprompt_review` — autoprompt review stage runs and produces a verdict (validates the verdict-parsing fix)

---

## Error handling — what to do when something goes wrong

Always read the JSONL log before deciding.

| Symptom | Most likely cause | Fix |
| --- | --- | --- |
| Exit code 1, `cli.fatal` with `fetch failed` | Dev server died mid-request | Restart `npm run dev`, retry |
| Exit code 1, `sse` chunk with `type: "error"` and message containing `API error (4xx)` | LM Studio rejected the request (model not loaded, context too long, bad config) | Check `models`, lower `--max-tokens`, or load a different model |
| Exit code 124 (timeout) | Model is slow, or stuck in tool loop | Re-run with higher `--timeout`, or strip `--autoprompt full` if it's the autoprompt looping |
| Tool calls all fail with "ENOENT" or path errors | Wrong `--cwd` | Pass an absolute path to the right directory |
| `parse_error` events | Server emitted malformed SSE | Bug — capture `logs/cli-<ts>.jsonl` and the request and report it |
| `chat.done` with `error: "..."` set | Server-side stream error mid-response | Inspect the message; common: model output exceeded context |
| Health passes but chat hangs with no `content` events | LM Studio loaded but model not responsive | Restart LM Studio's server toggle |

When you can't resolve an error yourself, summarize the failure to the user with: the exit code, the relevant `chat.error` / `error` event, and the path to the JSONL log so they can inspect it.

---

## Workflow guidance for the AI

1. **Start of session:** run `health`. If it fails, fix the prerequisite before anything else.
2. **Before code changes:** run `node cli.mjs test` to baseline.
3. **Plan the work:** for non-trivial tasks, the first chat invocation should use `--planning --sub-agents`. The planner's output is logged as `Planning Pass` in `worklog.md` inside `--cwd`.
4. **Iterate:** run focused chats with `--temperature 0.2` and `--cwd <target-dir>` for editing tasks. Always read the JSONL log to confirm the tools that actually fired (don't trust the assistant's narrative — trust `tool_result` events).
5. **Verify:** rerun `node cli.mjs test`, then optionally `--full` if the change was substantial.
6. **Report to the user:** include exit codes, key events from the log, and paths to the log files. Quote the model's final answer from the `=== ASSISTANT FINAL ===` block, not from your own paraphrase.

## UI testing — `ui-test.mjs`

For things that live in the browser (button clicks, streamed messages rendering, sidebar, settings page, console errors), use the Playwright runner.

```
npm run ui:test               # headless, all tests
npm run ui:test:headed        # show the browser window (debugging)
node ui-test.mjs --only chat  # filter by test name
node ui-test.mjs --headed --slow 200    # slow-mo for visual debugging
```

**Requires:** `npm run dev` running, AND LM Studio reachable (the chat tests are live end-to-end — they type a real prompt, click send, and wait for the streamed response to render in the DOM).

### Tests included

| Test | What it verifies |
| --- | --- |
| `page_loads` | Home page renders, title set, empty state visible |
| `chat_input_present` | Textarea accepts input, send button enables |
| `new_chat_button` | Sidebar "New Chat" creates a fresh conversation |
| `suggestion_button_fills_input` | Empty-state suggestion buttons populate the textarea |
| `settings_page_loads` | `/settings` route renders inputs/forms |
| `chat_send_streams_response` | Live: types prompt, hits send, waits for assistant bubble to render, confirms `/api/chat` returned 200 |
| `stop_button_aborts_stream` | Live: starts a long generation, clicks stop, verifies stream halts |
| `console_errors_clean` | Navigates main routes and asserts no `console.error` or `pageerror` (favicon/resource noise filtered) |

### Logs and failure artifacts

- Same `logs/` directory as `cli.mjs`. Files: `ui-test-<ts>.jsonl` (events) and `ui-test-<ts>.log` (human transcript).
- Event types include `browser_console`, `browser_pageerror`, `browser_requestfailed`, `test.case`, `ui_test.done`.
- **On any test failure** the runner writes a full-page screenshot and the page HTML to `logs/screenshots/fail-<test>-<ts>.{png,html}` so you can inspect the broken state.
- Read `browser_pageerror` and `browser_requestfailed` events first when diagnosing — those are usually the root cause.

### Filter and timeout flags

- `--only <substring>` — run only tests whose name matches
- `--base <url>` — point at a non-default server
- `--timeout <sec>` — per-response timeout for streaming tests (default 180)
- `--no-color` — disable ANSI colors

## When to use which testing tool

| Goal | Use |
| --- | --- |
| Did the API behave correctly? | `node cli.mjs test [--full]` |
| Did the UI render the response? | `npm run ui:test --only chat_send` |
| Are there client-side console errors? | `npm run ui:test --only console_errors_clean` |
| Did my edit break the chat flow? | both, in this order: cli test → ui test |
| Reproduce a UI bug a user reported | `npm run ui:test:headed --slow 300` and watch |

## Limits that remain

- `cli.mjs chat` is single-turn (no persistent conversation across invocations) — to carry context, include prior turns inline. The UI keeps history in localStorage; the CLI does not.
- Theme switching and other localStorage-backed settings are best verified through `ui-test.mjs`, not `cli.mjs`.

If a task genuinely requires real-user interaction the runner can't simulate (file pickers, OS dialogs, drag-and-drop from the desktop), tell the user — don't fake it.

---

## Reference: file locations

- CLI: `cli.mjs`
- Logs: `logs/cli-*.jsonl` and `logs/cli-*.log`
- Server config consumed by CLI: `--server` flag → `EC9V3_SERVER` env → `http://localhost:3000`
- LM Studio URL: `--lmstudio` flag → `LMSTUDIO_URL` env → `http://localhost:1234`
- Working dir for tools: `--cwd` flag → `WORKING_DIRECTORY` env → `process.cwd()`
- Worklog (when planning/sub-agents are used): `<cwd>/worklog.md`
