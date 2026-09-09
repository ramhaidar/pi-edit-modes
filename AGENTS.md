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
- `gemini`: Gemini CLI-shaped `replace` and `write_file`
- `deepseek`: Harness-compatible `standard` preset (`read`/`write`/`edit`, conditional `read_image`) or `minimal` preset (`str_replace_editor`)

Entry point: `src/index.ts`, registered via `package.json` → `pi.extensions`. The package ships `src/`, `docs/`, `scripts/fetch-vendors.mjs`, `README.md`, and `LICENSE` directly — there is no build step.

Runtime Pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) are peer dependencies. Direct dependencies are `ignore` (Gemini discovery filtering) and `koffi` (Win32 APIs used by the secure filesystem backend).

## Commands

| Task                  | Command                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Install deps          | `pnpm install`                                                                                       |
| Run all quality gates | `pnpm check`                                                                                         |
| Typecheck             | `pnpm typecheck`                                                                                     |
| Lint                  | `pnpm lint`                                                                                          |
| Format code           | `pnpm format`                                                                                        |
| Check formatting      | `pnpm format:check`                                                                                  |
| Run all tests         | `pnpm test`                                                                                          |
| Run one test file     | `pnpm test -- tests/router.test.ts` or `node --experimental-strip-types --test tests/router.test.ts` |
| Fetch vendor repos    | `pnpm fetch-vendors` (add `--force` to re-download)                                                  |

- There is no build step; the package ships TypeScript source directly. `pnpm typecheck`, `pnpm lint`, and CI are quality gates rather than build outputs.
- `pnpm check` runs format check, typecheck, lint, and tests in that order.
- GitHub Actions runs frozen install, format check, typecheck, lint, and tests on Node 22 and Node 24.
- Tests run on Node's built-in runner with `--experimental-strip-types` (see `package.json` `scripts.test`).
- `tsconfig.json` includes both `src/` and `tests/`; test files must typecheck too (`@types/node` is a devDependency for `node:test`/`node:assert`).
- Prettier (`.prettierrc.json` + `.prettierignore`) is the formatter. `src/tools/codex/engine.ts`, `vendor/`, and `pnpm-lock.yaml` are excluded from formatting (see Code Style / Safety).
- `vendor/` is gitignored; `pnpm fetch-vendors` downloads upstream repos as GitHub archive zips and records SHAs in `vendor/.state.json` (skips unchanged repos).

## Code Style

- TypeScript with explicit `.ts` extensions on relative imports (required by `node --experimental-strip-types`).
- Double quotes and semicolons throughout.
- Prettier enforces formatting: 2-space indent, double quotes, semicolons, `printWidth: 100`, LF endings, trailing commas (`"all"`). Run `pnpm format` after edits, or `pnpm format:check` to verify.
- `src/tools/codex/engine.ts` and nearby files use tabs; the rest of the repo uses spaces — preserve each file's existing indentation. The Codex engine is deliberately preserved from an upstream single-file baseline (commit `6525b95dae2082ac9fee672b14c2cffdef172bb8`); refactor it only when the task truly requires it.
- `src/tools/codex/engine.ts` is in `.prettierignore` and must never be reformatted.
- Tests in `tests/deepseek-fs-tools.test.ts` assert against source-file text with regexes; keep those regexes whitespace-tolerant (`\s*` around call boundaries) so they survive Prettier reformatting.
- Tests use `node:test` + `node:assert/strict` and import from `../src/...` with `.ts` extensions.

## Architecture Notes

- `src/config/` — settings schema/defaults (`schema.ts`), persistence with temp-file + fsync + rename (`settings-store.ts`), mode resolver (`resolver.ts`), `models.json` parsing that tolerates BOM and comments (`models-config.ts`).
  - Mode precedence: `--tool-mode` CLI → `/tool-mode` session → `x-pi-tool-mode` in `models.json` → auto-detection → `defaultMode` from `~/.pi/agent/edit-modes.json`.
- `src/modes/router.ts` — universal tool-surface router (`replace`/`additive`) and native-tool ownership. Strict `replace` surfaces are authoritative and remove forbidden native tools again if another extension reactivates them; tools excluded from Pi's registry are never resurrected.
- `src/modes/provider-guard.ts` — `before_provider_request` payload filtering per mode, including OpenAI/Anthropic top-level tool arrays and native Google `functionDeclarations`.
- `src/tools/codex|gemini|deepseek/` — per-model tool engines. Gemini uses current `replace`/`write_file` vocabulary, upstream omission/line-ending/result-context semantics, model-family contracts, session-scoped proposal state, whole-proposed-file manual modification, correction no-change errors, fuzzy line-range feedback, and a Gemini-specific workspace fence that rejects lexical/symlink escapes before proposal and commit. Gemini CLI JIT subdirectory context remains a host-context divergence because Pi does not expose Gemini's trusted memory-context discovery service. DeepSeek `standard` replaces Pi's `read`/`write`/`edit` definitions and conditionally adds `read_image`; `minimal` exposes sequential `str_replace_editor` without a prior-view observation requirement or standalone prompt contribution, while deliberately retaining Pi workspace confinement. Leaving DeepSeek restores Pi's definitions.
- `src/tools/deepseek/fs-parity.ts`, `arg-compat.ts`, `win32.ts` — Harness parity, Pi-host argument aliases, and Windows-specific behavior (koffi/advapi32/kernel32).
- `src/ui/` — `/tool-mode` and `/tool-surface` command + settings overlay.
- `vendor/` — fetched upstream sources (openai/codex, google-gemini/gemini-cli, deepseek-ai/deepseek-harness) used as parity reference material; not part of the published package.

## Safety / Do Not Touch

- `vendor/` is generated: never hand-edit; regenerate with `pnpm fetch-vendors` (`--force` to refresh even when the recorded SHA matches).
- `vendor/.state.json` records fetched SHAs; it is managed by the fetch script.
- Treat the Codex engine as a preserved upstream baseline (see Code Style) — behavior-parity changes there need explicit justification and test coverage.
- Behavior changes to tool schemas/semantics (Gemini exact/flexible/regex/fuzzy, correction errors, approval modification flow, result feedback; DeepSeek observation/version guards and scheduling; provider-guard stripping/conditioning) must be reflected in `tests/` and in the relevant file under `docs/`; keep `README.md` concise and accurate instead of duplicating full behavior detail there.

## Agent Workflow

- Make minimal, behavior-preserving changes; this repo favors upstream model-facing and runtime-flow parity over convenience, while documenting host capabilities that cannot be reproduced exactly.
- Before finishing, run `pnpm check` and keep format, typecheck, lint, and tests green. Any new tool behavior gets a matching test file under `tests/`.
- Settings persistence changes must preserve the migration path from the legacy `codex.surface` shape (see `tests/settings.test.ts`).
