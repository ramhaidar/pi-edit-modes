# Development and quality gates

Contributor-facing commands, test expectations, and packaging notes for `pi-edit-modes`.

## Commands

```bash
pnpm install
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm check
```

The repository is pnpm-native. `pnpm-lock.yaml` and `pnpm-workspace.yaml` are authoritative; do not substitute npm, npx, yarn, or bun commands.

`pnpm check` runs Prettier format checking, TypeScript typechecking, Oxlint with warnings denied across `src` and `tests`, and the full Node test suite. GitHub Actions runs the same gates after a frozen install on Node 22 and Node 24.

There is no build step. The package ships TypeScript source directly.

## Test coverage

Coverage includes:

- mode resolution, settings migration/persistence, strict/additive routing, and provider wire filtering
- Gemini create/recovery/correction/approval behavior, secondary no-change error semantics, corrected-retry original-error fallback, whole-proposed-file manual modification, fuzzy match line feedback, omission validation, session-scoped prepared proposals, post-tool updated-code context, model-family descriptions, and host-OS new-file line endings
- DeepSeek observation and stale-version semantics, session isolation, standard and minimal exclusive mutation scheduling, active-tool-specific shell guidance, large-file streaming, image validation/normalization, `str_replace_editor`, and no-follow directory listing/marker semantics
- Codex Environment ID grammar/execution rejection on a single-environment host
- shared diff rendering

Two filesystem parity tests are skipped on platforms where the required POSIX mode/symlink behavior cannot be exercised by the current test environment.

Tests use Node's built-in runner with `--experimental-strip-types` and `node:assert/strict`. `tsconfig.json` includes both `src/` and `tests/`, so tests must typecheck too.

## Vendor snapshots

`vendor/` is generated and must not be hand-edited. Refresh it with:

```bash
pnpm fetch-vendors
```

Use `--force` to re-download even when the recorded SHA matches. `vendor/.state.json` records fetched SHAs and is managed by the fetch script.

## Packaging

Before publishing or handing off a change, run `pnpm check`, `pnpm pack --dry-run`, and `git diff --check`.

The published package includes `src/`, `docs/`, `README.md`, and `LICENSE`.

## Documentation ownership

- `README.md`: concise overview, install, common commands, and links.
- `docs/CONFIGURATION.md`: complete mode/surface resolution, settings, model overrides, and runtime commands.
- `docs/GEMINI.md`: focused Gemini `replace` / `write_file` contract, lifecycle, correction, approval, result context, and host divergence.
- `docs/CODEX.md`: focused Codex `apply_patch` contract and single-environment host behavior.
- `docs/DEEPSEEK.md`: focused DeepSeek standard/minimal contracts, scheduling, observations, image handling, shell guidance, and host divergence.
- `docs/TOOL-FLOWS.md`: shared model-facing surfaces, provider guards, cross-mode behavior, host divergences, and diff rendering.
- `docs/DEVELOPMENT.md`: contributor workflow, quality gates, tests, vendor snapshots, and packaging.

User-visible behavior changes should update the relevant file under `docs/` and keep README's summary accurate rather than duplicating the full detail back into README.
