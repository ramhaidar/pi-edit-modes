# DeepSeek mode

DeepSeek mode provides Harness-shaped filesystem tools with `standard` and `minimal` presets.

## Standard

Strict standard mode exposes `read`, `write`, and `edit`, plus conditional `read_image`. `read` is parallel; `write` and `edit` are sequential/exclusive. Observation/version state is scoped by session + workspace, and guarded mutations reject stale/missing observations. Reads stream at 10 MiB and above.

`read`, `write`, and `edit` each contribute the current Harness system-prompt guidance exactly once through Pi's tool snippet channel; no duplicate paraphrased `promptGuidelines` are added.

`read_image` uses the current Harness declaration description and `file_path` description, including PNG/JPEG/WebP/GIF support, extension-less/content-detected images, normalization/downscaling guidance, small-batch concurrency guidance, and the image-capable-model requirement. It contributes no standalone `promptSnippet` or `promptGuidelines`. Runtime rejects blank `file_path`, unsupported extensions (including BMP), extension/content mismatches, source images larger than the current Harness local attachment-store default of 5 MiB before whole-file allocation, images above the 2000 px maximum-side default, and images above the 40M intrinsic-pixel default; supported extension-less images are accepted by content signature. A successful image read records the version captured from the same secure file descriptor that produced the bytes, so later observation-guarded mutations use the image that the model actually saw. Missing image targets record an absent observation. The result uses the Harness `<path>/<type>/<content>` envelope beside the normalized image block. Pi has no extension-facing durable attachment store, so deployment-specific attachment-limit overrides and persistence/reference semantics remain host-capability divergences.

DeepSeek text/image reads, writes, edits, and minimal-editor traversal share the Codex/Gemini secure-filesystem seam. On descriptor/openat-backed platforms, traversal and I/O remain anchored to opened descriptors and mutations compare the observed version on the opened target before writing, preventing a checked workspace path from being redirected through a symlink race. The portable Node fallback performs best-effort no-follow checks and retains a path-based TOCTOU window; set `PI_APPLY_PATCH_REQUIRE_SECURE_FS=1` to fail closed when the secure backend is unavailable.

## Minimal

Strict minimal mode exposes only sequential/exclusive `str_replace_editor` with `view`, `create`, `str_replace`, and `insert` from the managed filesystem family. The editor contributes no standalone `promptSnippet` or `promptGuidelines`; model conditioning comes from its tool description/schema and the surrounding Pi/provider tool surface.

Like the current shipped Harness minimal preset, `str_replace` and `insert` do not require a prior `view`. They stat/read the current file during the call and use that current version as the compare-and-swap basis. Mandatory observation remains enabled for the standard filesystem composition and for direct `str_replace_editor` + observation-policy composition.

Directory view never follows directory symlinks. Entry markers match Harness: `d` directory, `f` file, `?` symlink/other.

Pi deliberately retains workspace confinement for minimal editor paths. Current upstream minimal uses bare `fs-local` and can address paths outside its configured cwd; `pi-edit-modes` does not copy that unsafe behavior. Tool/schema/edit semantics follow the minimal preset while path access remains fenced through the same secure-filesystem policy described above.

## Shell guidance

Strict `standard` and `minimal` surfaces preserve the provider's upstream shell descriptions without appending Pi-specific filesystem-mutation prohibitions. The explicit `additive`/hybrid surface may append guidance naming all active mutation editors. That additive-only conditioning is a Pi enhancement, not part of strict Harness parity and not a security boundary.

DeepSeek runtimes are cleared on shutdown. Pi-only aliases and unsupported sandbox-escalation fields are stripped from model-facing schemas.

See [Tool flows and parity](TOOL-FLOWS.md), [Configuration](CONFIGURATION.md), and [Development](DEVELOPMENT.md).
