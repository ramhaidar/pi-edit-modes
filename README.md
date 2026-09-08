# pi-edit-modes

A Pi extension package that routes file editing tools by model:

- `pi`: Pi's native `edit` and `write`
- `codex`: Codex-compatible `apply_patch`
- `gemini`: Antigravity-style `replace_file_content`, `multi_replace_file_content`, and `write_to_file`
- `deepseek`: DeepSeek Harness-compatible `read`, `write`, `edit`, and `str_replace_editor` (`view`, `create`, `str_replace`, `insert`)

Codex and Gemini use the universal custom-tool surface normally:

- `replace`: custom mode tools replace Pi native `edit`/`write`
- `additive`: custom mode tools are added alongside Pi native `edit`/`write`

DeepSeek is intentionally different: both `replace` and `additive` keep the `write`/`edit` tool names active, but DeepSeek mode overrides Pi's definitions with DeepSeek Harness-compatible `read`/`write`/`edit` schemas and execution semantics, then adds `str_replace_editor`. Leaving DeepSeek mode restores Pi's native definitions.

The Codex parser/runtime/security implementation is preserved from the supplied single-file extension baseline `6525b95dae2082ac9fee672b14c2cffdef172bb8`. The package adds a shared mode resolver, universal surface router, and Gemini exact-match engine around it.

## Install

Install the folder/package with Pi's package installation mechanism, or place it where Pi loads package resources. The manifest is in `package.json` under `pi.extensions`.

Runtime Pi packages are peer dependencies because Pi provides them to extensions.

## Resolution order

Mode resolution:

1. `--tool-mode` CLI override
2. runtime `/tool-mode` session override
3. `x-pi-tool-mode` in `models.json`
4. automatic Gemini/DeepSeek/Codex detection
5. `defaultMode` from `edit-modes.json`

Surface resolution:

1. `--tool-surface` CLI override
2. runtime `/tool-surface` or TUI session override
3. `surface` from `edit-modes.json`

`--apply-patch-mode` and `PI_APPLY_PATCH_TOOL_MODE` remain supported as deprecated migration inputs when no new mode/surface CLI override is set.

## Settings

`~/.pi/agent/edit-modes.json`:

```json
{
  "version": 1,
  "defaultMode": "pi",
  "surface": "replace",
  "autoDiscovery": {
    "enabled": true,
    "gemini": true,
    "codex": true,
    "deepseek": true
  },
  "gemini": {
    "strictExactMatch": true
  }
}
```

The old v0.1.0 shape `codex.surface` is accepted and migrated in memory to the universal top-level `surface` setting. Settings writes from the TUI use a temp file, fsync, and rename.

## Model override

Custom model:

```jsonc
{
  // Comments and UTF-8 BOM are accepted like Pi's current models.json loader.
  "providers": {
    "my-proxy": {
      "models": [
        {
          "id": "gemini-3-pro",
          "x-pi-tool-mode": "codex"
        }
      ]
    }
  }
}
```

Built-in override:

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.4": {
          "x-pi-tool-mode": "pi"
        }
      }
    }
  }
}
```

The package reads raw `models.json`, strips BOM/comments using Pi-compatible lexical behavior, and does not depend on extension metadata being propagated onto `ctx.model`.

## Commands

- `/tool-mode` opens a centered settings overlay.
- `/tool-mode auto|gemini|codex|deepseek|pi` changes the runtime session mode override.
- `/tool-surface auto|replace|additive` changes the runtime session surface override for Codex, Gemini, and DeepSeek.
- `/apply-patch-mode replace|additive|off` is a deprecated compatibility alias.

The overlay reports both the resolved mode and effective tool surface. If a requested custom mode is unavailable, it reports the Pi fallback and reason instead of labeling the unavailable mode as effective. The overlay can also configure Gemini strict exact matching.

## Gemini semantics

### replace_file_content

- `TargetContent` is exact by default.
- `StartLine`/`EndLine` restrict the candidate range for LF, CRLF, and CR-only files.
- zero matches fail.
- multiple matches fail unless `AllowMultiple=true`.
- replacement line endings follow the existing file.

### multi_replace_file_content

All chunks are validated against one original snapshot. Overlapping chunks, ambiguous chunks, or any invalid chunk fail before a write occurs. Valid replacements are applied in memory from highest offset to lowest offset, followed by one file write.

### write_to_file

- missing target: create
- existing target + `Overwrite` not true: reject
- existing target + `Overwrite=true`: replace

All Gemini mutations use the same secure filesystem facade and mutation queue as the Codex implementation.


## DeepSeek semantics

### Diff rendering

Codex, Gemini, and DeepSeek mutation tools expose their generated diff as call-body rows. This keeps edit previews compatible with tool-output display wrappers: collapsed views can cap the diff while expanded views can reveal the complete diff. DeepSeek `view` remains normal result output rather than a diff. Tool call headers also use a compact action + target form (for example `apply_patch A /index.php`, `replace_file_content M /index.php`, and `str_replace_editor M /index.php`), so the target remains visible when the outer UI appends `(ctrl + o to toggle)`.

The `deepseek` mode does not use Pi's native `read`, `write`, or `edit` definitions. It overrides those names with a compatibility layer matching the current DeepSeek Harness filesystem contracts, while also exposing the standalone `str_replace_editor` surface:

- `read(file_path, offset?, limit?)` uses Harness-style line windows and records file observations.
- `write(file_path, content)` creates or fully replaces UTF-8 text, requires a prior observation before overwriting an existing file, uses version/no-clobber guards, and publishes atomically.
- `edit(file_path, old_string, new_string, replace_all?)` requires a prior observation, performs literal replacement with unique-match-by-default semantics, detects stale versions before generic edit matching, preserves existing line endings, and publishes atomically.
- `str_replace_editor` requires an absolute `path`; `view`, `create`, `str_replace`, and `insert` share the same observation/version state as `read`/`write`/`edit`.
- `str_replace_editor view` uses the Harness line-number format, 16,000-character clipping behavior, and directory traversal rules.
- `str_replace` requires `old_str` to match exactly once and reports all duplicate-match line numbers; omit `new_str` to delete the match.
- `insert` inserts `new_str` after the boundary represented by `insert_line` (`0` inserts before the first line).
- Mode switches restore Pi's own `read`/`write`/`edit` definitions outside DeepSeek mode.
- Pi-host compatibility is handled before `tool_call` guards: `prepareArguments` adds internal Pi aliases (`path`, plus `oldText`/`newText` and `edits[]` for edit) so guards written for Pi native mutation tools can inspect DeepSeek calls safely. The provider guard removes those aliases from the advertised schema, so the model still sees the exact DeepSeek Harness `write(file_path, content)` and `edit(file_path, old_string, new_string, replace_all?)` contracts.

## Tool ownership

The router owns only native `edit`/`write` instances it actually removed. If another extension or manual action reactivates a native tool, ownership is relinquished and repeated sync does not fight that activation.

Explicit Pi tool filtering is respected. The package never resurrects a custom tool excluded from Pi's configured tool registry.

## Provider guard

At `before_provider_request`:

- Codex mode strips Gemini/DeepSeek edit tools and validates/re-writes `apply_patch` compatibility transport.
- Gemini mode strips `apply_patch`, DeepSeek tools, and stale excluded Gemini tools.
- DeepSeek mode strips `apply_patch`, Gemini tools, and stale excluded DeepSeek tools, keeps the `write`/`edit` names active, and swaps `read`/`write`/`edit` to the Harness-compatible definitions on both replace and additive surfaces.
- When `str_replace_editor` is active, DeepSeek mode also marks shell tools as non-mutating for file edits, preventing PowerShell/backtick and shell-redirection corruption; file mutations are directed through `write`, `edit`, or `str_replace_editor`.
- Pi mode strips all managed custom edit tools.
- OpenAI/Anthropic-style top-level tool arrays are handled.
- Native Google `config.tools[].functionDeclarations[]` and `toolConfig.functionCallingConfig.allowedFunctionNames` are handled.
- a forced forbidden tool choice fails closed.

For native Google/Gemini models explicitly overridden to Codex mode, `apply_patch` is validated as an ordinary function declaration and its description is rewritten to the compatibility guidance that tells the model to put raw patch text in the `input` string.

## Tests

```bash
npm test
```

The included tests cover resolver precedence/detection, Pi-compatible `models.json` BOM/comment parsing, universal replace/additive mode transitions and ownership, Google provider wire guarding, DeepSeek Harness read/write/edit observation and stale-version behavior, shared `str_replace_editor` observation state, exact replacement/insert/view behavior, atomic/no-clobber concurrency, LF/CRLF handling, Gemini exact replacement behavior, model overrides, and settings migration/persistence.
