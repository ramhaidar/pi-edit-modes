# AGENTS.md

## Package Manager Rule (hard requirement)

Use **pnpm exclusively** in this repository. Never use `npm`, `npx`, `yarn`, or `bun`, for any purpose (install, run, execute, exec, dlx, or equivalent).

- Install: `pnpm install` (frozen lockfile when appropriate: `pnpm install --frozen-lockfile`)
- Run scripts: `pnpm <script-name>` or `pnpm run <script-name>`
- The repo is pnpm-native: `pnpm-lock.yaml` and `pnpm-workspace.yaml` are authoritative. `pnpm-workspace.yaml` also declares `allowBuilds` for `koffi`, `protobufjs`, and `@google/genai` postinstall scripts.
- README examples that show `npm test` are stale; the equivalent is `pnpm test`.

## Project Overview

`pi-edit-modes` is a Pi coding-agent extension (TypeScript, ESM, Node >= 22.6.0) that routes file-editing tools by model:

- `pi`: Pi native `edit`/`write`
- `codex`: Codex-compatible `apply_patch`
- `gemini`: `replace_file_content`, `multi_replace_file_content`, `write_to_file`
- `deepseek`: Harness-compatible `read`/`write`/`edit` (overriding Pi's native tool *names*) plus `str_replace_editor`

Entry point: `src/index.ts`, registered via `package.json` → `pi.extensions`. The package ships source directly (`files: ["src"]`) — there is no build step.

Runtime Pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) are peer dependencies; `koffi` is the only direct dependency (used in `src/tools/deepseek/win32.ts` for Win32 APIs).

## Commands

| Task | Command |
|---|---|
| Install deps | `pnpm install` |
| Run all tests | `pnpm test` |
| Run one test file | `pnpm test -- tests/router.test.ts` or `node --experimental-strip-types --test tests/router.test.ts` |
| Fetch vendor repos | `pnpm fetch-vendors` (add `--force` to re-download) |

- No build, lint, format, or typecheck command is defined. There is no CI configuration in this repo.
- Tests run on Node's built-in runner with `--experimental-strip-types` (see `package.json` `scripts.test`).
- `vendor/` is gitignored; `pnpm fetch-vendors` downloads upstream repos as GitHub archive zips and records SHAs in `vendor/.state.json` (skips unchanged repos).

## Code Style

- TypeScript with explicit `.ts` extensions on relative imports (required by `node --experimental-strip-types`).
- Double quotes and semicolons throughout.
- `src/tools/codex/engine.ts` and nearby files use tabs; the rest of the repo uses spaces — preserve each file's existing indentation. The Codex engine is deliberately preserved from an upstream single-file baseline (commit `6525b95dae2082ac9fee672b14c2cffdef172bb8`); refactor it only when the task truly requires it.
- Tests use `node:test` + `node:assert/strict` and import from `../src/...` with `.ts` extensions.

## Architecture Notes

- `src/config/` — settings schema/defaults (`schema.ts`), persistence with temp-file + fsync + rename (`settings-store.ts`), mode resolver (`resolver.ts`), `models.json` parsing that tolerates BOM and comments (`models-config.ts`).
  - Mode precedence: `--tool-mode` CLI → `/tool-mode` session → `x-pi-tool-mode` in `models.json` → auto-detection → `defaultMode` from `~/.pi/agent/edit-modes.json`.
- `src/modes/router.ts` — universal tool-surface router (`replace`/`additive`) and native-tool ownership. It only owns native tools it actually removed and never resurrects tools excluded from Pi's registry.
- `src/modes/provider-guard.ts` — `before_provider_request` payload filtering per mode, including OpenAI/Anthropic top-level tool arrays and native Google `functionDeclarations`.
- `src/tools/codex|gemini|deepseek/` — per-model tool engines. DeepSeek mode *replaces the definitions of* Pi's native `read`/`write`/`edit` (the names stay active) and adds `str_replace_editor`; leaving DeepSeek mode restores Pi's definitions.
- `src/tools/deepseek/fs-parity.ts`, `arg-compat.ts`, `win32.ts` — Harness parity, Pi-host argument aliases, and Windows-specific behavior (koffi/advapi32/kernel32).
- `src/ui/` — `/tool-mode` and `/tool-surface` command + settings overlay.
- `vendor/` — fetched upstream sources (openai/codex, google-gemini/gemini-cli, deepseek-ai/deepseek-harness) used as parity reference material; not part of the published package.

## Safety / Do Not Touch

- `vendor/` is generated: never hand-edit; regenerate with `pnpm fetch-vendors` (`--force` to refresh even when the recorded SHA matches).
- `vendor/.state.json` records fetched SHAs; it is managed by the fetch script.
- Treat the Codex engine as a preserved upstream baseline (see Code Style) — behavior-parity changes there need explicit justification and test coverage.
- Behavior changes to tool schemas/semantics (Gemini exact-match rules, DeepSeek observation/version guards, provider-guard stripping) must be reflected in `tests/` and, where user-visible, in `README.md`.

## Agent Workflow

- Make minimal, behavior-preserving changes; this repo favors exact-match/Harness-parity semantics over convenience.
- Before finishing, run `pnpm test` and keep it green. Any new tool behavior gets a matching test file under `tests/`.
- Settings persistence changes must preserve the migration path from the legacy `codex.surface` shape (see `tests/settings.test.ts`).
