# pi-edit-modes

A Pi extension package that selects model-facing file tools by model family while keeping the provider payload aligned with the selected tool surface.

Supported modes:

- `pi`: Pi native file tools.
- `codex`: Codex-compatible `apply_patch`.
- `gemini`: Gemini CLI-shaped `replace` and `write_file`.
- `deepseek`: DeepSeek Harness-shaped filesystem tools, with `standard` and `minimal` presets.

The package aims for model-facing contract alignment, not a claim that every upstream runtime capability is reproduced. Host-specific behavior and known limitations are documented below.

## Install

Install the folder/package with Pi's package installation mechanism, or place it where Pi loads package resources. The manifest is in `package.json` under `pi.extensions`.

Pi runtime packages are peer dependencies. They are also dev dependencies so a clean checkout can run the local test suite without relying on an externally installed Pi runtime.

## Resolution order

Mode resolution:

1. `--tool-mode` CLI override
2. runtime `/tool-mode` session override
3. `x-pi-tool-mode` in `models.json`
4. automatic Gemini/DeepSeek/Codex detection
5. `defaultMode` from `edit-modes.json`

Surface resolution:

1. `--tool-surface` CLI override
2. runtime `/tool-surface` session override
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
    "approval": "ask_user"
  },
  "deepseek": {
    "preset": "standard"
  }
}
```

Settings:

- `surface`: `replace` or `additive`.
- `gemini.approval`: `ask_user` or `auto_edit`.
- `deepseek.preset`: `standard` or `minimal`.

The legacy `codex.surface` setting is accepted as a migration fallback. The legacy `gemini.strictExactMatch` boolean is also accepted so older settings files still load, but it is no longer projected into current Gemini behavior.

Settings writes from the TUI use a temp file, fsync, and rename.

## Model override

Custom model example:

```jsonc
{
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

Built-in override example:

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

The package reads raw `models.json`, strips UTF-8 BOM/comments using Pi-compatible lexical behavior, and does not depend on custom metadata being propagated onto `ctx.model`.

## Commands

- `/tool-mode` opens the settings overlay.
- `/tool-mode auto|gemini|codex|deepseek|pi` changes the runtime session mode override.
- `/tool-surface auto|replace|additive` changes the runtime session surface override.
- `/apply-patch-mode replace|additive|off` is a deprecated compatibility alias.

The overlay reports resolved mode, effective surface, Gemini approval mode, and DeepSeek preset. If a requested custom mode is unavailable, it reports the Pi fallback and the reason.

## Surface semantics

### `replace`

`replace` is the strict model-facing surface.

- Codex suppresses native `edit`/`write` and exposes `apply_patch`.
- Gemini suppresses native `edit`/`write` and exposes `replace`/`write_file`.
- DeepSeek `standard` exposes its Harness-shaped `read`/`write`/`edit` family, plus `read_image` only for image-capable models.
- DeepSeek `minimal` suppresses native `read`/`edit`/`write` and exposes only `str_replace_editor` from the managed filesystem families.

If another extension reactivates a forbidden native tool, synchronization removes it again. `before_provider_request` independently applies the same roster restriction so stale tool definitions do not leak to the model.

### `additive`

`additive` is intentionally a hybrid surface, not an exact-upstream parity claim. Native and custom tools may coexist.

## Gemini semantics

### `replace`

Model-facing parameters are:

- `file_path`
- `instruction`
- `old_string`
- `new_string`
- optional `allow_multiple`

Replacement recovery follows this order:

1. exact
2. flexible whitespace/indentation recovery
3. token-whitespace regex recovery
4. bounded fuzzy recovery

By default a replacement must resolve to one intended match. `allow_multiple=true` permits replacing all accepted matches. Existing file line endings are preserved.

### `write_file`

Model-facing parameters are exactly `file_path` and `content`.

- missing target: create
- existing target: overwrite
- no hidden overwrite flag is required
- omission placeholders such as `(rest of file unchanged)` are rejected because `content` must be complete

Both Gemini mutation tools use the shared secure filesystem facade and file mutation queue.

### Approval

`gemini.approval` defaults to `ask_user`.

- `ask_user`: every Gemini `replace`/`write_file` mutation requests interactive confirmation. A non-interactive session fails closed because approval cannot be obtained.
- `auto_edit`: Gemini mutations execute without the extension-level confirmation prompt.

## DeepSeek semantics

### `standard` preset

`standard` is the default preset. It installs DeepSeek Harness-shaped `read`, `write`, and `edit` definitions under those tool names.

- `read(file_path, offset?, limit?)` returns Harness-style line windows and records the observation used by later guarded writes/edits.
- `write(file_path, content)` creates or fully replaces UTF-8 text. Existing-file overwrite requires a current observation and uses stale-version/no-clobber checks.
- `edit(file_path, old_string, new_string, replace_all?)` performs literal replacement with unique-match-by-default semantics and uses the same observation/version state.
- `read_image(file_path)` is added only when the current model supports image input. It resolves the real target and refuses files outside the current workspace.

Observation/version state is scoped by both Pi session ID and workspace path. Two sessions in the same directory therefore do not share filesystem observations.

On `replace`, `str_replace_editor` is not exposed by the standard preset. On `additive`, it may coexist when available; that is explicitly hybrid behavior.

### `minimal` preset

`minimal` exposes `str_replace_editor` with `view`, `create`, `str_replace`, and `insert`.

On the strict `replace` surface it suppresses the native `read`/`edit`/`write` family. `str_replace_editor` requires an absolute `path`.

Directory `view` does not recurse through symlinked directories. This avoids traversal escaping through a symlink during recursive listing.

### Shell guidance

When `str_replace_editor` is active, provider-facing shell tool descriptions receive guidance telling the model not to mutate files through shell redirection, PowerShell write commands, `sed -i`, scripts, and similar mechanisms.

This is guidance, not a security boundary. The extension does not claim that prompt text prevents a shell tool from mutating files. Filesystem containment and mutation checks must come from the actual filesystem/runtime controls.

### Sandbox escalation fields

DeepSeek write/edit wire schemas intentionally omit sandbox escalation fields when the active host filesystem backend does not expose the corresponding escalation capability. The extension does not advertise unsupported schema capabilities merely to mimic a wider upstream union.

## Codex semantics

`apply_patch` supports Add/Delete/Update/Move hunks and the secure filesystem policy implemented by the Codex engine.

The constrained grammar also accepts an optional header immediately after `*** Begin Patch`:

```text
*** Environment ID: <id>
```

Pi currently exposes one workspace environment per invocation. The header is parsed for protocol compatibility and resolves to the current invocation environment; it is not a multi-environment selector in this host.

For Google/Gemini providers explicitly overridden to Codex mode, `apply_patch` is represented as a compatibility function whose `input` string contains the raw `*** Begin Patch` ... `*** End Patch` payload.

## Provider guard

Before each provider request, the extension treats the selected strict roster as final authority.

- Pi mode removes managed custom file-edit tools.
- Codex mode removes Gemini and DeepSeek custom tools and validates `apply_patch` transport.
- Gemini mode removes Codex, DeepSeek, deprecated Gemini aliases, and native `edit`/`write` on the strict surface.
- DeepSeek `standard` strict mode removes Codex, Gemini, and `str_replace_editor`; it keeps the standard Harness filesystem family.
- DeepSeek `minimal` strict mode removes Codex, Gemini, and native `read`/`edit`/`write`; it keeps `str_replace_editor`.
- OpenAI/Anthropic-style top-level tool arrays and native Google `config.tools[].functionDeclarations[]` are handled.
- Google `allowedFunctionNames` is pruned consistently.
- A provider request that forces a now-forbidden tool fails closed.
- Internal Pi compatibility aliases for DeepSeek `write`/`edit` are removed from the model-facing schemas.

Deprecated Gemini names `replace_file_content`, `multi_replace_file_content`, and `write_to_file` are treated only as stale managed aliases and are removed from active/model-facing surfaces.

## Diff rendering

Codex, Gemini, and DeepSeek mutation tools expose generated diffs through the shared call-body renderer. Headers use compact action + target forms such as `apply_patch A /index.php`, `replace M /index.php`, and `str_replace_editor M /index.php`.

## Tests

```bash
pnpm test
```

Coverage includes mode resolution, settings migration/persistence, strict/additive routing, provider wire filtering, Gemini schema/recovery/overwrite behavior, DeepSeek observation and stale-version semantics, session isolation, image containment, concurrency, `str_replace_editor`, Codex Environment ID grammar, and diff rendering.

Two filesystem parity tests are skipped on platforms where the required POSIX mode/symlink behavior cannot be exercised by the current test environment.
