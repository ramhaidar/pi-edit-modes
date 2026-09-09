# Gemini mode

Gemini mode exposes the current `replace` and `write_file` surface. Strict `replace` suppresses native Pi mutation tools and stale Gemini aliases; `additive` is intentionally hybrid.

## `replace`

Parameters: `file_path`, `instruction`, `old_string`, `new_string`, optional `allow_multiple`.

Recovery order is exact -> flexible whitespace/indentation -> token-whitespace regex -> bounded fuzzy. For a missing relative `replace` path, the tool first checks the direct path and then performs a bounded workspace search (up to 50 directories) for a unique matching suffix/basename. Ambiguous matches are rejected instead of selecting one arbitrarily. Empty `old_string` creates a missing file but is rejected for an existing file. Existing line endings are preserved; new files use host OS line endings.

Omission placeholders are rejected unless the same normalized placeholder already exists in `old_string`. Fuzzy recovery reports 1-based match line ranges to the model.

When `gemini.disableLLMCorrection=false`, an eligible failed edit may use a utility-model correction against freshly re-read content. `noChangesRequired` becomes `EDIT_NO_CHANGE_LLM_JUDGEMENT`. If the corrected retry fails, the original initial edit error is returned. JSON-family files bypass LLM correction. The default is `disableLLMCorrection=true`.

## `write_file`

Parameters: `file_path`, `content`. Missing files are created and existing files overwritten without a hidden overwrite flag. Complete-content omission placeholders are rejected. The same line-ending and eligible correction policy applies.

## Approval and commit

`gemini.approval` defaults to `ask_user`. The mutation is prepared and diffed before confirmation. If the user edits the proposal, the editor receives the whole proposed file. A modified `replace` becomes whole-current-file -> whole-user-modified-file, matching current Gemini CLI behavior.

Prepared mutations are scoped by session ID + workspace + tool-call ID, cleared on lifecycle boundaries, and committed only if the current preimage still matches the approved proposal's preimage.

Successful results include bounded updated-code context. User-modified proposals report the actual final `new_string` / `content` written.

## Workspace access

Both `replace` and `write_file` are confined to Pi's current workspace. Path preprocessing follows Gemini CLI's defensive conventions: null bytes are stripped, accidental leading `@` references are normalized when no literal `@` path exists, `file://` and URI-encoded paths are decoded, and existing symlink ancestors are canonicalized. Safe symlinks that resolve inside the workspace therefore operate on their canonical target; paths that resolve outside remain rejected with `PATH_NOT_IN_WORKSPACE`.

The workspace policy also mirrors Gemini CLI's blocked sensitive path segments. `.git`, `.env`, `node_modules`, and `gha-creds-*.json` are denied case-insensitively, including current NTFS 8.3 short-name forms and the trailing-dot/space or alternate-data-stream spellings handled upstream. Blocking happens before file reads or optional LLM correction, so those sensitive contents are not exposed to the correction-model prompt.

Resolved model-generated paths additionally pass Gemini CLI's generic path preflight: control characters, common log/error fragments such as `AssertionError:`, suspicious long quoted/ellipsis paths, total paths over 4096 characters, and individual components over 255 characters are rejected before filesystem operations.

Validation runs before proposal calculation, again when execution starts, and immediately before mutation. On descriptor/openat-backed secure filesystem implementations this prevents a validated path from being redirected through a symlink race between validation and commit. The portable Node filesystem fallback performs best-effort symlink checks but still has a path-based TOCTOU window; set `PI_APPLY_PATCH_REQUIRE_SECURE_FS=1` to fail closed on hosts where the descriptor/openat backend is unavailable.

## Model conditioning and host divergence

Provider dispatch rewrites tool and parameter descriptions to the active Gemini model-family contract. Deprecated aliases are stripped.

Gemini CLI's trusted JIT subdirectory context discovery is not reproduced because Pi does not expose an equivalent extension-facing trusted context service; Pi's host resource loader remains authoritative.

For complete details see [Tool flows and parity](TOOL-FLOWS.md), [Configuration](CONFIGURATION.md), and [Development](DEVELOPMENT.md).
