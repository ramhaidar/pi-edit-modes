# DeepSeek mode

DeepSeek mode provides Harness-shaped filesystem tools with `standard` and `minimal` presets.

## Standard

Strict standard mode exposes `read`, `write`, and `edit`, plus conditional `read_image`. `read` is parallel; `write` and `edit` are sequential/exclusive. Observation/version state is scoped by session + workspace, and guarded mutations reject stale/missing observations. Reads stream at 10 MiB and above.

`read_image` validates bytes, enforces the realpath workspace fence, and uses Pi image normalization. Pi has no extension-facing durable attachment store, so it returns the normalized native image block directly.

## Minimal

Strict minimal mode exposes only sequential/exclusive `str_replace_editor` with `view`, `create`, `str_replace`, and `insert` from the managed filesystem family. The editor contributes no standalone `promptSnippet` or `promptGuidelines`; model conditioning comes from its tool description/schema and the surrounding Pi/provider tool surface.

Like the current shipped Harness minimal preset, `str_replace` and `insert` do not require a prior `view`. They stat/read the current file during the call and use that current version as the compare-and-swap basis. Mandatory observation remains enabled for the standard filesystem composition and for direct `str_replace_editor` + observation-policy composition.

Directory view never follows directory symlinks. Entry markers match Harness: `d` directory, `f` file, `?` symlink/other.

Pi deliberately retains workspace confinement for minimal editor paths. Current upstream minimal uses bare `fs-local` and can address paths outside its configured cwd; `pi-edit-modes` does not copy that unsafe behavior. Tool/schema/edit semantics follow the minimal preset while path access remains fenced to the Pi workspace.

## Shell guidance

Shell descriptions name only active mutation tools: standard -> `write`/`edit`, minimal -> `str_replace_editor`, additive -> all active editors. This Pi-specific shell-description conditioning is model guidance, not a standalone `str_replace_editor` prompt contribution and not a security boundary.

DeepSeek runtimes are cleared on shutdown. Pi-only aliases and unsupported sandbox-escalation fields are stripped from model-facing schemas.

See [Tool flows and parity](TOOL-FLOWS.md), [Configuration](CONFIGURATION.md), and [Development](DEVELOPMENT.md).
