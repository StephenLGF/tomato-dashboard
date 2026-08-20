# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

番茄工作台 (Tomato Dashboard) — a local workboard that syncs Tomato (番茄 Team) issues into a Kanban UI and embeds into the Codex desktop app. Cards link to dev repos and Codex conversations; conversation events sync back to the issue. macOS-focused. Node.js ≥ 22.5, plain Node ESM (`.mjs`) on the backend, React 19 + Vite + TypeScript on the frontend. No external DB/HTTP frameworks: the server uses `node:http` and `node:sqlite` (`DatabaseSync`).

## Commands

- `npm run dev` — API + Vite dev servers (Vite on 5173 proxies `/api` to the server on 47823)
- `npm run codex:dev` — Codex-embedded dev mode with hot reload (use for React/TS/CSS work)
- `npm run taskboard` — browser-only mode (no Codex injection), serves built app at `http://127.0.0.1:47823/`
- `npm run codex` — full integration: starts server, launches ChatGPT.app with a loopback-only CDP port, injects the userscript
- `npm run build` — Vite build to `dist/web` + refresh any running injected page
- `npm run typecheck` — `tsc -p web/tsconfig.json --noEmit` (only covers `web/`; server is plain JS)
- `npm test` — `node --test` over `test/*.test.mjs`
- `node --test test/server.test.mjs` — run a single test file
- `npm run check` — typecheck + build + test
- `npm run doctor` — read-only diagnostics (Node, deps, Codex CLI, MCP config, `gitee` CLI login)

## Development workflow rules (from AGENTS.md)

These rules govern feature work and supersede any older test-first instructions:

1. Before implementing, prove the real operation path: entry point → action → data change/side effect → observable result, citing actual components/APIs/files. This proof is not a test.
2. Implement the main path with the smallest direct change.
3. After implementing, demonstrate only that direct path and give results to the user for confirmation.
4. Before user confirmation, do NOT proactively add guardrails, regression tests, legacy compatibility, defensive extensions, or speculative fallbacks.
5. User confirmation does not authorize follow-up hardening; add protection/tests only when explicitly asked or when a concrete failure is reported.

Keep validation at real external boundaries (user input, external APIs), but don't expand it beyond the requested path.

## Architecture

Three runtime pieces, with `shared/` holding models used by both ends:

- **`server/` — local Node backend (plain ESM, no framework).** `index.mjs` is the entry; `app.mjs` has all HTTP routing/validation and serves the built frontend; `database.mjs` owns SQLite access and migrations (DB at `.data/taskboard.sqlite`). Tomato data comes only from the local `gitee` CLI (`tomato-cli.mjs` adapter → `tomato-sync.mjs` sync/transition service) — there is no direct Tomato API or MCP dependency in the sync path. Codex conversations run through the local Codex CLI: `ai-chat-process.mjs` spawns `codex app-server --stdio` for a thread's first turn (`thread/start` then `turn/start`) and `codex exec resume --json <threadId>` for subsequent turns, normalizing raw Codex output into workboard events; `ai-chat.mjs` (`AiChatService`) persists runs/events to SQLite and pushes them over SSE. `codexThreadId` in SQLite is only an index — Codex itself owns native thread persistence.
- **`web/` — React frontend.** `App.tsx` is page-level state and detects `?host=codex` for embedded mode. The frontend never touches SQLite, the Tomato CLI, or Codex directly: everything goes through `web/src/api.ts` → local HTTP API → SSE events merged in `aiChatState.ts` → rendered by `components/AiChat.tsx`.
- **`inject/codex-taskboard.user.js` + `scripts/codex-injector.mjs` — Codex desktop integration.** Not an official plugin API: the injector launches Codex with CDP and uses `Runtime.evaluate` to inject the userscript, which adds a sidebar entry and mounts the workboard as an iframe. The iframe and the Codex page are separate contexts and communicate ONLY via `window.postMessage` through a fixed message set in the userscript (`taskboard:ready`, `taskboard:host-context`, `taskboard:open-thread`, `taskboard:open-review`, `taskboard:create-thread`, `taskboard:expand-sidebar`). Never put Tomato credentials into the page or iframe. After editing `inject/` or `scripts/codex-injector*`, restart the injector — hot reload doesn't cover it.
- **`shared/` — framework-free domain models** (task/status/priority in `domain.mjs`, Tomato ID/status/URL transforms in `tomato-*.mjs`, workflow graph logic in `workflow-*.mjs`). Tomato URLs are built only in `shared/tomato-url.mjs`; never string-format them elsewhere. No React or Node service logic belongs here.
- **`skills/` and `plugins/`** — a project-level Codex Skill (`skills/tomato-workboard/SKILL.md`) served to Codex via `/api/meta`, and an optional Codex plugin wrapper. Guidance/metadata only, not runtime code.

## Boundaries and constraints

- Tests (`test/*.test.mjs`, `node:test` + `node:assert/strict`) use temp dirs via `mkdtemp` and fake CLI executables — they must not depend on real tokens, `~/.codex`, or production data. Server tests start the app with `createTaskboardServer({ dataDirectory: <tmpdir> })` on port 0.
- `.env` holds no tokens (Tomato PAT lives in the `gitee` CLI's own config). Config vars are prefixed `CODEX_TASKBOARD_*` / `TOMATO_*`; see `.env.example`.
- The server binds loopback only by default; keep it that way.
- Codex injection mode depends on macOS `open`/`pgrep`/`lsof` and never modifies `ChatGPT.app`/`app.asar`. Windows/Linux: browser mode only.
- `.data/`, `dist/`, `.env`, `output/`, `*.log` are git-ignored runtime artifacts — don't commit them.
