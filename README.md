# pi-edit-modes

A Pi extension package that selects model-facing file tools by model family while keeping provider payloads aligned with the selected tool surface.

Supported modes:

- `pi`: Pi native file tools.
- `codex`: Codex-compatible `apply_patch`.
- `gemini`: Gemini CLI-shaped `replace` and `write_file`.
- `deepseek`: DeepSeek Harness-shaped filesystem tools with `standard` and `minimal` presets.

The package targets model-facing contract and editing-flow alignment. Host capabilities that Pi cannot reproduce are documented explicitly rather than hidden.

## Install

Install the folder/package through Pi's package mechanism, or place it where Pi loads package resources. The extension entry point is declared in `package.json` under `pi.extensions`.

Pi runtime packages are peer dependencies and also dev dependencies so a clean checkout can run the local test suite.

## Configuration

Defaults are `defaultMode: "pi"`, strict `surface: "replace"`, Gemini `approval: "ask_user"`, Gemini `disableLLMCorrection: true`, and DeepSeek `preset: "standard"`. Settings live at `~/.pi/agent/edit-modes.json`.

Runtime controls are `/tool-mode` and `/tool-surface`; the deprecated `/apply-patch-mode` alias remains for migration. See [Configuration](docs/CONFIGURATION.md) for precedence, CLI/session overrides, the complete settings schema, `models.json` overrides, migration behavior, and command syntax.

## Tool-flow summary

`replace` is the strict model-facing surface; `additive` is intentionally hybrid. Provider guards independently enforce the selected roster so stale or externally reactivated forbidden tools do not leak to the model.

### Gemini

`replace` supports create-via-empty-`old_string`, exact/flexible/regex/fuzzy recovery, optional bounded LLM correction, omission protection, whole-proposal approval modification, session/workspace-scoped prepared mutations, stale-preimage checks, and updated-code result context. `write_file` creates or overwrites complete content through the same secure mutation path.

See [Gemini mode](docs/GEMINI.md) for the focused contract and [Tool flows and parity](docs/TOOL-FLOWS.md) for shared runtime/provider behavior.

### DeepSeek

`standard` exposes Harness-shaped `read`, `write`, and `edit`, plus conditional `read_image`. Reads are concurrent; mutations are sequential/exclusive; reads at 10 MiB and above stream; observation/version state is session + workspace scoped.

`minimal` exposes sequential/exclusive `str_replace_editor` with `view`, `create`, `str_replace`, and `insert`. Its prompt names only that available editor. Directory views do not follow symlinked directories and use upstream `d` / `f` / `?` markers. Shell guidance names only active mutation tools.

Pi does not expose Harness's durable attachment store, so `read_image` returns a normalized native image block directly. See [DeepSeek mode](docs/DEEPSEEK.md) for the focused contract.

### Codex

`apply_patch` supports Add/Delete/Update/Move hunks. The optional Environment ID grammar is accepted for protocol compatibility, but Pi fails closed when an ID is supplied because this host exposes one workspace environment and no environment catalog.

See [Codex mode](docs/CODEX.md) for the focused contract.

## Development

```bash
pnpm install
pnpm check
```

`pnpm check` runs formatting checks, TypeScript typechecking, Oxlint with warnings denied, and the full Node test suite. CI runs the same gates on Node 22 and Node 24.

See [Development and quality gates](docs/DEVELOPMENT.md) for complete test coverage, platform skips, vendor snapshots, packaging checks, and contributor rules.

## Documentation

- [Configuration](docs/CONFIGURATION.md) - resolution, settings, model overrides, commands.
- [Gemini mode](docs/GEMINI.md) - `replace` / `write_file`, correction, approval, result context, host divergence.
- [Codex mode](docs/CODEX.md) - `apply_patch`, Environment ID behavior, host-scope boundaries.
- [DeepSeek mode](docs/DEEPSEEK.md) - standard/minimal tools, scheduling, observations, image and shell behavior.
- [Tool flows and parity](docs/TOOL-FLOWS.md) - shared surfaces, provider guards, host divergences, diff rendering.
- [Development and quality gates](docs/DEVELOPMENT.md) - tests, CI, vendor snapshots, packaging, contributor workflow.
