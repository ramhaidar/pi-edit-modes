# Gemini mode

Gemini mode exposes the current `replace` and `write_file` surface. Strict `replace` suppresses native Pi mutation tools and stale Gemini aliases; `additive` is intentionally hybrid.

## `replace`

Parameters: `file_path`, `instruction`, `old_string`, `new_string`, optional `allow_multiple`.

Recovery order is exact -> flexible whitespace/indentation -> token-whitespace regex -> bounded fuzzy. Empty `old_string` creates a missing file but is rejected for an existing file. Existing line endings are preserved; new files use host OS line endings.

Omission placeholders are rejected unless the same normalized placeholder already exists in `old_string`. Fuzzy recovery reports 1-based match line ranges to the model.

When `gemini.disableLLMCorrection=false`, an eligible failed edit may use a utility-model correction against freshly re-read content. `noChangesRequired` becomes `EDIT_NO_CHANGE_LLM_JUDGEMENT`. If the corrected retry fails, the original initial edit error is returned. JSON-family files bypass LLM correction. The default is `disableLLMCorrection=true`.

## `write_file`

Parameters: `file_path`, `content`. Missing files are created and existing files overwritten without a hidden overwrite flag. Complete-content omission placeholders are rejected. The same line-ending and eligible correction policy applies.

## Approval and commit

`gemini.approval` defaults to `ask_user`. The mutation is prepared and diffed before confirmation. If the user edits the proposal, the editor receives the whole proposed file. A modified `replace` becomes whole-current-file -> whole-user-modified-file, matching current Gemini CLI behavior.

Prepared mutations are scoped by session ID + workspace + tool-call ID, cleared on lifecycle boundaries, and committed only if the current preimage still matches the approved proposal's preimage.

Successful results include bounded updated-code context. User-modified proposals report the actual final `new_string` / `content` written.

## Model conditioning and host divergence

Provider dispatch rewrites tool and parameter descriptions to the active Gemini model-family contract. Deprecated aliases are stripped.

Gemini CLI's trusted JIT subdirectory context discovery is not reproduced because Pi does not expose an equivalent extension-facing trusted context service; Pi's host resource loader remains authoritative.

For complete details see [Tool flows and parity](TOOL-FLOWS.md), [Configuration](CONFIGURATION.md), and [Development](DEVELOPMENT.md).
