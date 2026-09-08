# Tool flows and parity

Detailed surface semantics and upstream-aligned behavior for Codex, Gemini CLI, and DeepSeek Harness modes.

Focused per-model references: [Gemini](GEMINI.md), [Codex](CODEX.md), and [DeepSeek](DEEPSEEK.md). This document covers the shared surface, provider-guard, and cross-mode runtime behavior.

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

If `old_string` is empty and the target does not exist, `replace` creates the file from `new_string`, matching current Gemini CLI create semantics. If the file already exists, an empty `old_string` is rejected.

If all normal matching strategies fail on an eligible non-JSON-family file and `gemini.disableLLMCorrection=false`, the extension performs a bounded utility-model correction pass using `instruction`, the original failure, and the latest on-disk file content, then retries against that fresh content. If the secondary correction says no edit is required, the call fails as an upstream-style `EDIT_NO_CHANGE_LLM_JUDGEMENT` error rather than succeeding as a no-op; the error includes the correction explanation and original edit failure. If the corrected retry itself fails, the original initial edit error is returned instead of the correction-generated retry error, matching Gemini CLI feedback ownership.

### `write_file`

Model-facing parameters are exactly `file_path` and `content`.

- missing target: create
- existing target: overwrite
- no hidden overwrite flag is required
- omission placeholders use Gemini CLI's line-based detector: forms such as `(rest of methods ...)`, `(unchanged code ...)`, and `// rest of methods ...` are rejected; the ellipsis is required. `replace.new_string` may preserve a normalized placeholder only when the same placeholder already exists in `old_string`
- eligible non-JSON-family content follows Gemini CLI's correction policy: with LLM correction enabled it can use the utility escaping corrector; with correction disabled, current Gemini 2/3 and custom models keep the original content while older Gemini families may use deterministic aggressive unescape

Both Gemini mutation tools use the shared secure filesystem facade and file mutation queue.

### Approval and result context

`gemini.approval` defaults to `ask_user`.

- `ask_user`: the extension calculates the proposed mutation first, including recovery/correction, generates the diff, and shows it for approval. For both tools the editor receives the whole proposed file content. For a user-modified `replace`, execution is converted to the current whole file as `old_string` and the user-modified whole proposal as `new_string`, matching Gemini CLI's current modify lifecycle. The modified content is revalidated before commit. A non-interactive session fails closed because approval cannot be obtained.
- `auto_edit`: the same proposal/recovery pipeline still runs, including correction only when enabled, but the extension skips the interactive approval UI.

The executor commits only the prepared proposal for that tool call and verifies that the on-disk preimage has not changed since proposal calculation, so an edit approved against stale content is rejected instead of silently clobbering external changes. Prepared proposals are keyed by Pi session ID plus workspace path plus tool-call ID and are cleared on session start/shutdown, preventing approval state from leaking across sessions.

Successful `replace` and `write_file` results sent back to the model include a bounded updated-code context snippet. If confirmation changed a proposal, the result also reports the exact final `new_string` or `content` that was approved and written; for a manually modified `replace`, that `new_string` is the whole user-modified proposed file. Fuzzy recovery reports the 1-based matched line range(s), for example `Applied fuzzy match at line 12.` or `Applied fuzzy match at lines 12-14, 30-32.`

### JIT subdirectory context

Gemini CLI also appends newly discovered subdirectory project context after successful high-intent file operations. Pi loads its own trusted project context files (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`) through the host resource loader, but `ExtensionContext` does not expose Gemini CLI's memory-context manager or an equivalent trusted JIT subdirectory discovery service.

`pi-edit-modes` therefore does not independently scan or read extra context files after a mutation, because doing so would bypass Pi's resource/trust policy. This remains an explicit host-context lifecycle divergence.

## DeepSeek semantics

### `standard` preset

`standard` is the default preset. It installs DeepSeek Harness-shaped `read`, `write`, and `edit` definitions under those tool names.

- `read(file_path, offset?, limit?)` returns Harness-style line windows and records the observation used by later guarded writes/edits.
- `write(file_path, content)` creates or fully replaces UTF-8 text. Existing-file overwrite requires a current observation and uses stale-version/no-clobber checks.
- `edit(file_path, old_string, new_string, replace_all?)` performs literal replacement with unique-match-by-default semantics and uses the same observation/version state.
- `read_image(file_path)` is added only when the current model supports image input. It resolves the real target, refuses files outside the current workspace, validates the actual image bytes, and normalizes/resizes supported images through Pi's image pipeline before returning a native image block.

Observation/version state is scoped by both Pi session ID and workspace path. Two sessions in the same directory therefore do not share filesystem observations.

`read` remains parallel. `write` and `edit` are sequential/exclusive scheduler operations. Text reads switch to a bounded streaming path at 10 MiB, preserving line-window/output limits without loading the entire large file into memory.

Pi's extension API does not currently expose DeepSeek Harness's durable attachment-store service, so `read_image` returns the normalized native image block directly rather than persisting an attachment reference. This is an explicit host-capability divergence, not a model-facing name/schema divergence.

On `replace`, `str_replace_editor` is not exposed by the standard preset. On `additive`, it may coexist when available; that is explicitly hybrid behavior.

### `minimal` preset

`minimal` exposes only `str_replace_editor` from the managed filesystem family on the strict surface, with `view`, `create`, `str_replace`, and `insert`. It requires an absolute `path`.

`str_replace_editor` is registered as sequential/exclusive because `create`, `str_replace`, and `insert` mutate files. Its prompt guidance references only `str_replace_editor`; it does not instruct the model to call unavailable `write` or `edit` tools.

Directory `view` uses `lstat` and does not recurse through symlinked directories. Model-facing directory markers follow upstream: `d` for directory, `f` for file, and `?` for symlinks/other entries. The `?` marker does not change the no-follow traversal behavior.

### Shell guidance

Provider-facing shell descriptions are conditioned on the mutation tools that are actually active:

- strict `standard`: `write` / `edit`
- strict `minimal`: `str_replace_editor`
- additive/hybrid: all active mutation editors may be named

The guidance tells the model not to mutate files through shell redirection, PowerShell write commands, `sed -i`, scripts, and similar mechanisms. This is guidance, not a security boundary; containment and mutation checks come from the actual filesystem/runtime controls.

### Sandbox escalation fields

DeepSeek `write`/`edit` wire schemas intentionally omit sandbox escalation fields when the active host filesystem backend does not expose the corresponding escalation capability. The extension does not advertise unsupported schema capabilities merely to mimic a wider upstream union.

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
