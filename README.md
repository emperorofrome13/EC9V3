# EC9v3 C2 Claude

EC9v3 is a local-first AI coding assistant built with Next.js. It wraps OpenAI-compatible local or cloud models in an agentic tool loop with project file tools, shell execution, planning, AutoPrompt review stages, subagents, and durable project-local state.

## Features

- Tool loop for project work: file read/edit/create, search, shell, web, TODO planning, and project inspection.
- Local and cloud model providers, including LM Studio, OpenAI-compatible APIs, OpenCode-compatible APIs, and Anthropic-compatible APIs.
- Model discovery from provider `/models` endpoints where supported.
- Cloud Mode controls for external state files, codebase search, and trimmed tool outputs.
- Project-local conversation storage under `.ec9v3/` using SQLite metadata plus filesystem payload blobs for large outputs.
- Persistent task tracking through `tasks.db`, `tasks.jsonl`, `session.json`, and `worklog.jsonl` in the selected project directory.
- AutoPrompt follow-up pipeline for review, placeholder cleanup, run/fix verification, senior review, and final completeness checks.
- CLI commands for health checks, chat, model listing, and long-running task execution.

## Requirements

- Node.js 18+
- npm
- A model provider:
  - LM Studio at `http://localhost:1234` for local OpenAI-compatible inference, or
  - an OpenAI-compatible, OpenCode-compatible, or Anthropic-compatible cloud API.

## Setup

```powershell
npm install
copy .env.example .env
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

Configure providers from the Settings page. Keep real API keys in `.env` or browser settings only; do not commit them.

## Desktop App

EC9v3 can also run as an Electron desktop app.

Development desktop shell:

```powershell
npm run desktop:dev
```

Production preview:

```powershell
npm run desktop:preview
```

Build a portable Windows desktop app:

```powershell
npm run desktop:dist
```

Desktop artifacts are written to `desktop-dist/`. The packaged app uses the Next standalone server internally and does not bundle `.env`, `.ec9v3`, logs, task databases, JSONL work logs, or other local runtime state.

The desktop build rebuilds native modules for Electron while packaging, then restores `better-sqlite3` for the local Node runtime afterward. If a Windows process has the native module locked, stop running EC9v3/Next processes and run:

```powershell
npm rebuild better-sqlite3
```

## CLI

```powershell
node cli.mjs health
node cli.mjs models
node cli.mjs chat "list the files in src/lib"
node cli.mjs run --max-tasks 50 --on-fail retry
```

## Local State

EC9v3 intentionally keeps run state out of Git:

- `.ec9v3/` conversation databases and payload blobs
- `tasks.db`, `tasks.jsonl`, `session.json`, and `worklog.jsonl`
- log files and generated test artifacts
- local build outputs such as `.next/`

These files are ignored because they can contain large tool outputs, local paths, API responses, and project-specific working memory.

## Validation

Useful checks before shipping changes:

```powershell
npx.cmd tsc --noEmit
node --check cli.mjs
node cli.mjs health
npm run build
npm run desktop:dist
```
