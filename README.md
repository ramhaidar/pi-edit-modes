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
    "approval": "ask_user",
    "disableLLMCorrection": true
  },
  "deepseek": {
    "preset": "standard"
  }
}
```

Settings:

- `surface`: `replace` or `additive`.
- `gemini.approval`: `ask_user` or `auto_edit`.
- `gemini.disableLLMCorrection`: boolean, default `true`, matching current Gemini CLI's correction default.
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
          "x-pi-tool-mode": "codex",
        },
      ],
    },
  },
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

By default a replacement must resolve to one intended match. `allow_multiple=true` permits replacing all accepted matches. Existing file line endings are preserved; newly created files use the host OS line ending, matching Gemini CLI (`CRLF` on Windows, `LF` elsewhere).

If `old_string` is empty and the target does not exist, `replace` creates the file from `new_string`, matching current Gemini CLI create semantics. If the file already exists, an empty `old_string` is rejected. If all normal matching strategies fail on an eligible non-JSON-family file and `gemini.disableLLMCorrection=false`, the extension performs a bounded utility-model correction pass using `instruction`, the failure, and the latest on-disk file content, then retries the replacement against that fresh content. If that secondary correction judges that no edit is required, the call fails as an upstream-style edit error rather than succeeding as a no-op; the error includes the correction explanation and the original edit failure.

### `write_file`

Model-facing parameters are exactly `file_path` and `content`.

- missing target: create
- existing target: overwrite
- no hidden overwrite flag is required
- omission placeholders use Gemini CLI's line-based detector: forms such as `(rest of methods ...)`, `(unchanged code ...)`, and `// rest of methods ...` are rejected; the ellipsis is required. `replace.new_string` may preserve a normalized placeholder only when the same placeholder already exists in `old_string`
- eligible non-JSON-family content follows Gemini CLI's correction policy: with LLM correction enabled it can use the utility escaping corrector; with correction disabled, current Gemini 2/3 and custom models keep the original content while older Gemini families may use deterministic aggressive unescape

Both Gemini mutation tools use the shared secure filesystem facade and file mutation queue.

### Approval

`gemini.approval` defaults to `ask_user`.

- `ask_user`: the extension calculates the proposed mutation first, including recovery/correction, generates the diff, and shows it for approval. For both tools the editor receives the whole proposed file content. For a user-modified `replace`, execution is converted to the current whole file as `old_string` and the user-modified whole proposal as `new_string`, matching Gemini CLI's current modify lifecycle. The modified content is revalidated before commit. A non-interactive session fails closed because approval cannot be obtained.
- `auto_edit`: the same proposal/recovery pipeline still runs, including correction only when enabled, but the extension skips the interactive approval UI.

The executor commits only the prepared proposal for that tool call and verifies that the on-disk preimage has not changed since proposal calculation, so an edit approved against stale content is rejected instead of silently clobbering external changes. Prepared proposals are keyed by Pi session ID plus workspace path plus tool-call ID and are cleared on session start/shutdown, preventing approval state from leaking across sessions.

Successful `replace` and `write_file` results sent back to the model include a bounded updated-code context snippet. If confirmation changed a proposal, the result also reports the exact final `new_string` or `content` that was approved and written; for a manually modified `replace`, that `new_string` is the whole user-modified proposed file, matching upstream. Fuzzy recovery also reports the 1-based matched line range(s), for example `Applied fuzzy match at line 12.` or `Applied fuzzy match at lines 12-14, 30-32.`

Gemini CLI also appends newly discovered subdirectory project context after successful high-intent file operations. Pi loads its own project context files (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`) through the host resource loader, but `ExtensionContext` does not expose Gemini CLI's memory-context manager or an equivalent trusted JIT subdirectory discovery service. `pi-edit-modes` therefore does not independently read extra context files after a mutation, because doing so would bypass Pi's resource/trust policy. This remains an explicit host-context lifecycle divergence.

## DeepSeek semantics

### `standard` preset

`standard` is the default preset. It installs DeepSeek Harness-shaped `read`, `write`, and `edit` definitions under those tool names.

- `read(file_path, offset?, limit?)` returns Harness-style line windows and records the observation used by later guarded writes/edits.
- `write(file_path, content)` creates or fully replaces UTF-8 text. Existing-file overwrite requires a current observation and uses stale-version/no-clobber checks.
- `edit(file_path, old_string, new_string, replace_all?)` performs literal replacement with unique-match-by-default semantics and uses the same observation/version state.
- `read_image(file_path)` is added only when the current model supports image input. It resolves the real target, refuses files outside the current workspace, validates the actual image bytes, and normalizes/resizes supported images through Pi's image pipeline before returning a native image block.

Observation/version state is scoped by both Pi session ID and workspace path. Two sessions in the same directory therefore do not share filesystem observations.

`read` remains parallel. `write` and `edit` are registered as sequential/exclusive scheduler operations to match current DeepSeek Harness mutation scheduling. Text reads switch to a bounded streaming path at 10 MiB, preserving the same line-window/output limits without loading the entire large file into memory.

Pi's extension API does not currently expose DeepSeek Harness's durable attachment-store service, so `read_image` returns the normalized native image block directly rather than persisting an attachment reference. This is an explicit host-capability divergence, not a model-facing name/schema divergence.

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

Pi currently exposes one workspace environment per invocation. The header remains part of the accepted grammar for protocol compatibility, but execution fails closed when an Environment ID is supplied because this host has no environment catalog from which to resolve that ID. The ID is never silently ignored or mapped to the current workspace.

For Google/Gemini providers explicitly overridden to Codex mode, `apply_patch` is represented as a compatibility function whose `input` string contains the raw `*** Begin Patch` ... `*** End Patch` payload.

## Provider guard

Before each provider request, the extension treats the selected strict roster as final authority.

- Pi mode removes managed custom file-edit tools.
- Codex mode removes Gemini and DeepSeek custom tools and validates `apply_patch` transport.
- Gemini mode removes Codex, DeepSeek, deprecated Gemini aliases, and native `edit`/`write` on the strict surface. It also rewrites `replace`/`write_file` descriptions and parameter descriptions to the active upstream Gemini model-family contract before each provider request.
- DeepSeek `standard` strict mode removes Codex, Gemini, and `str_replace_editor`; it keeps the standard Harness filesystem family.
- DeepSeek `minimal` strict mode removes Codex, Gemini, and native `read`/`edit`/`write`; it keeps `str_replace_editor`.
- OpenAI/Anthropic-style top-level tool arrays and native Google `config.tools[].functionDeclarations[]` are handled.
- Google `allowedFunctionNames` is pruned consistently.
- A provider request that forces a now-forbidden tool fails closed.
- Internal Pi compatibility aliases for DeepSeek `write`/`edit` are removed from the model-facing schemas.

Deprecated Gemini names `replace_file_content`, `multi_replace_file_content`, and `write_to_file` are treated only as stale managed aliases and are removed from active/model-facing surfaces.

## Diff rendering

Codex, Gemini, and DeepSeek mutation tools expose generated diffs through the shared call-body renderer. Headers use compact action + target forms such as `apply_patch A /index.php`, `replace M /index.php`, and `str_replace_editor M /index.php`.

## Quality gates

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm check
```

`pnpm check` runs Prettier format checking, TypeScript typechecking, Oxlint with warnings denied across `src` and `tests`, and the full Node test suite. GitHub Actions runs the same gates after a frozen install on Node 22 and Node 24.

Coverage includes mode resolution, settings migration/persistence, strict/additive routing, provider wire filtering, Gemini create/recovery/correction/approval behavior, secondary no-change error semantics, whole-proposed-file manual modification, fuzzy match line feedback, omission validation, session-scoped prepared proposals, post-tool updated-code context, model-family descriptions, and host-OS new-file line endings; DeepSeek observation and stale-version semantics, session isolation, exclusive mutation scheduling, large-file streaming, image validation/normalization, `str_replace_editor`; Codex Environment ID grammar/execution rejection on a single-environment host; and diff rendering.

Two filesystem parity tests are skipped on platforms where the required POSIX mode/symlink behavior cannot be exercised by the current test environment.
