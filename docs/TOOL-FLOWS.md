# Tool flows and parity

Detailed surface semantics and upstream-aligned behavior for Codex, Gemini CLI, and DeepSeek Harness modes.

Focused per-model references: [Gemini](GEMINI.md), [Codex](CODEX.md), and [DeepSeek](DEEPSEEK.md). This document covers the shared surface, provider-guard, and cross-mode runtime behavior.

## All-tools mode

Select `all` with `/tool-mode all`, `--tool-mode all`, `defaultMode: "all"`, or the `/tool-mode` popup. It activates every available file-editing tool from this package at once: custom DeepSeek `read`/`edit`/`write` owns those duplicate names, alongside Codex `apply_patch`, Gemini `replace`/`write_file`, DeepSeek `str_replace_editor`, and `read_image` for image-capable models. Excluded or unavailable tools are not resurrected. `bash-only` remains authoritative and removes every mutating file tool.

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

### `bash-only`

`bash-only` is an independent master switch (`bashOnly`), not a third surface value. It is authoritative over both mode and surface: when it is on, every write/edit/delete-capable file tool is removed regardless of the resolved mode, including on the `additive` surface.

Removed: native `edit`/`write` and every managed custom tool - Codex `apply_patch`, Gemini `replace`/`write_file`, DeepSeek `standard` `write`/`edit`, DeepSeek minimal `str_replace_editor` (its `create`/`str_replace`/`insert` commands mutate files), and the read-only DeepSeek `read_image`. Managed custom tools are mode-owned, and bash-only disables the modes wholesale, so even the read-only one goes.

Preserved: the Pi-native read-only tools (`read`, `grep`, `find`, `ls`), the shell (`bash`, or `powershell` on Windows), and any unrelated tool owned by another extension. The shell is therefore the only mutation path.

Like the strict `replace` surfaces, bash-only re-removes a forbidden tool if another extension reactivates it, and `before_provider_request` applies the same restriction directly to OpenAI/Anthropic top-level `tools`, Google `functionDeclarations`, and Google `allowedFunctionNames`. A provider that forces one of the stripped tools is treated as a fatal invariant violation, matching existing strict-surface behavior.

Native `edit`/`write` removals are tracked in the same ownership record as strict surfaces, so turning bash-only off restores them at their original positions. Pi exposes no native delete/`rm` tool, so "delete" is covered by the mutation commands of the disabled custom tools rather than by a dedicated tool.

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

Before proposal calculation, Gemini also applies Gemini-style defensive path normalization: null bytes are stripped, accidental `@` reference prefixes are normalized when appropriate, URI/file-URL input is decoded, and existing symlink ancestors are canonicalized. Relative parent escapes, absolute paths outside the workspace, canonical targets outside the workspace, and blocked sensitive segments (`.git`, `.env`, `node_modules`, `gha-creds-*.json`, including upstream case/NTFS alias handling) are rejected as `PATH_NOT_IN_WORKSPACE`; safe in-workspace symlinks resolve to their canonical in-workspace target. Blocking happens before file reads and optional correction-model calls. Execution repeats validation before the mutation and again immediately before commit.

Resolved model-generated paths also use Gemini CLI's generic preflight checks for control characters, common log/error fragments, suspicious long quote/ellipsis forms, the 4096-character path limit, and the 255-character component limit. Relative `replace` targets additionally use a bounded 50-directory suffix/basename search when the direct path is missing. That fallback discovery respects `.gitignore` (including nested ignore files in Git workspaces) and root `.geminiignore` by default; `gemini.fileFiltering` can disable either ignore family and add project-root-relative `customIgnoreFilePaths`. A unique visible match is corrected and ambiguous visible matches are rejected.

Pi currently exposes a single workspace root (`ctx.cwd`) to this extension, so fallback correction searches that root only. Gemini CLI can search every configured `WorkspaceContext` directory in multi-root sessions; this remains a host-architecture divergence until Pi exposes an equivalent multi-root workspace API.

The race guarantee depends on the shared filesystem backend. Descriptor/openat-backed secure implementations prevent symlink redirection between validation and commit. The portable Node fallback is intentionally best-effort and retains a path-based TOCTOU window between its checks and write; `PI_APPLY_PATCH_REQUIRE_SECURE_FS=1` makes the host fail closed when that secure backend is unavailable.

### Approval and result context

`gemini.approval` defaults to `ask_user`.

- `ask_user`: the extension calculates the proposed mutation first, including recovery/correction, generates the diff, and shows it for approval. For both tools the editor receives the whole proposed file content. For a user-modified `replace`, execution is converted to the current whole file as `old_string` and the user-modified whole proposal as `new_string`, matching Gemini CLI's current modify lifecycle. The modified content is revalidated before commit. A non-interactive session fails closed because approval cannot be obtained.
- `auto_edit`: the same proposal/recovery pipeline still runs, including correction only when enabled, but the extension skips the interactive approval UI.

The executor commits only the prepared proposal for that tool call and verifies that the on-disk preimage has not changed since proposal calculation, so an edit approved against stale content is rejected instead of silently clobbering external changes. Prepared proposals are keyed by Pi session ID plus workspace path plus tool-call ID and are cleared on session start/shutdown, preventing approval state from leaking across sessions.

Successful `replace` and `write_file` results sent back to the model include a bounded updated-code context snippet. If confirmation changed a proposal, the result also reports the exact final `new_string` or `content` that was approved and written; for a manually modified `replace`, that `new_string` is the whole user-modified proposed file. Fuzzy recovery reports the 1-based matched line range(s), for example `Applied fuzzy match at line 12.` or `Applied fuzzy match at lines 12-14, 30-32.`

### JIT subdirectory context

Gemini CLI also appends newly discovered subdirectory project context after successful high-intent file operations. Pi loads its own trusted project context files (`AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`) through the host resource loader, but `ExtensionContext` does not expose Gemini CLI's memory-context manager or an equivalent trusted JIT subdirectory discovery service.

`pi-edit-modes` therefore does not independently scan or read extra context files after a mutation, because doing so would bypass Pi's resource/trust policy. This remains an explicit host-context lifecycle divergence.

The Gemini tool registrations also avoid Pi-only `promptSnippet` / `promptGuidelines`; tool-specific model conditioning comes from the upstream-shaped tool declaration description and parameter schema.

## DeepSeek semantics

### `standard` preset

`standard` is the default preset. It installs DeepSeek Harness-shaped `read`, `write`, and `edit` definitions under those tool names.

- `read(file_path, offset?, limit?)` returns Harness-style line windows and records the observation used by later guarded writes/edits.
- `write(file_path, content)` creates or fully replaces UTF-8 text. Existing-file overwrite requires a current observation and uses stale-version/no-clobber checks.
- `edit(file_path, old_string, new_string, replace_all?)` performs literal replacement with unique-match-by-default semantics and uses the same observation/version state.
- `read`, `write`, and `edit` project their current Harness system-prompt section once through Pi's `promptSnippet` field; the extension does not add a second paraphrased guideline copy.
- `read_image(file_path)` is added only when the current model supports image input. Its declaration text and `file_path` description mirror current Harness, including extension-less/content-detected PNG/JPEG/WebP/GIF handling and normalization/concurrency guidance, and it adds no standalone prompt snippet/guidelines. Runtime rejects blank paths, unsupported extensions such as BMP, declared-extension/content mismatches, source reads over the current Harness local-store default of 5 MiB, sides over 2000 px, and intrinsic images over 40M pixels; supported extension-less images are accepted by content signature. The secure read snapshot supplies both bytes and the version recorded after successful normalization/admission, so image reads participate in the same observation lifecycle as text reads. Missing targets record an absent observation. The tool returns the Harness `<path>/<type>/<content>` text envelope beside the native normalized image block. Pi cannot inherit deployment-specific Harness attachment-store limit overrides because that store is not exposed to extensions.

Observation/version state is scoped by both Pi session ID and workspace path. Two sessions in the same directory therefore do not share filesystem observations.

`read` remains parallel. `write` and `edit` are sequential/exclusive scheduler operations. Text reads switch to a bounded streaming path at 10 MiB, preserving line-window/output limits without loading the entire large file into memory.

DeepSeek filesystem operations use the shared Codex/Gemini secure-filesystem facade. On the descriptor/openat backend, file snapshots, directory traversal, and CAS writes are anchored to opened descriptors; mutation versions are checked on the opened target immediately before writing, so a concurrently substituted path cannot redirect the operation outside the checked workspace. The portable Node fallback retains best-effort symlink checks and a path-based TOCTOU window; `PI_APPLY_PATCH_REQUIRE_SECURE_FS=1` makes the host fail closed when the descriptor/openat backend is unavailable.

Pi's extension API does not currently expose DeepSeek Harness's durable attachment-store service, so `read_image` returns the normalized native image block directly rather than persisting an attachment reference. This is an explicit host-capability divergence, not a model-facing name/schema divergence.

On `replace`, `str_replace_editor` is not exposed by the standard preset. On `additive`, it may coexist when available; that is explicitly hybrid behavior.

### `minimal` preset

`minimal` exposes only `str_replace_editor` from the managed filesystem family on the strict surface, with `view`, `create`, `str_replace`, and `insert`. It requires an absolute `path`.

`str_replace_editor` is registered as sequential/exclusive because `create`, `str_replace`, and `insert` mutate files. Matching the shipped Harness minimal composition, the tool contributes no standalone prompt snippet/guidelines and `str_replace`/`insert` do not require a prior `view`; each operation derives its CAS version from the current file. Standard `read`/`write`/`edit` continue to use mandatory observation policy, and the underlying editor methods retain observation-aware behavior when composed directly with that policy.

Directory `view` uses `lstat` and does not recurse through symlinked directories. Model-facing directory markers follow upstream: `d` for directory, `f` for file, and `?` for symlinks/other entries. The `?` marker does not change the no-follow traversal behavior.

Unlike the current shipped Harness minimal preset's bare `fs-local`, Pi retains workspace confinement for all minimal editor paths. This is a deliberate safer host divergence. On the secure descriptor/openat backend the fence is race-resistant; on the portable fallback it has the best-effort limitation described above.

### Shell guidance

Strict DeepSeek parity surfaces do not rewrite provider shell descriptions. This keeps `standard` and `minimal` model-facing shell conditioning upstream-shaped instead of appending Pi-specific filesystem-mutation prohibitions.

The explicit `deepseek-additive` hybrid surface may append Pi guidance that names all active mutation editors and discourages shell-based file mutation. This additive-only conditioning is not part of strict Harness parity and is not a security boundary; containment and mutation checks come from the actual filesystem/runtime controls.

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
- Gemini family selection operates on Pi's concrete `ctx.model.id`; Gemini CLI alias resolution (`auto`/`pro`/`flash`) and dynamic family metadata remain host-routing differences unless Pi has already resolved the model to a concrete ID.
- DeepSeek `standard` strict mode removes Codex, Gemini, and `str_replace_editor`; it keeps the standard Harness filesystem family.
- DeepSeek `minimal` strict mode removes Codex, Gemini, and native `read`/`edit`/`write`; it keeps `str_replace_editor`.
- OpenAI/Anthropic-style top-level tool arrays and native Google `config.tools[].functionDeclarations[]` are handled.
- Google `allowedFunctionNames` is pruned consistently.
- A provider request that forces a now-forbidden tool fails closed.
- Internal Pi compatibility aliases for DeepSeek `write`/`edit` are removed from the model-facing schemas.

Deprecated Gemini names `replace_file_content`, `multi_replace_file_content`, and `write_to_file` are treated only as stale managed aliases and are removed from active/model-facing surfaces.

## Diff rendering

Codex, Gemini, and DeepSeek mutation tools expose generated diffs through the shared call-body renderer. Headers use compact action + target forms such as `apply_patch A /index.php`, `replace M /index.php`, and `str_replace_editor M /index.php`.
