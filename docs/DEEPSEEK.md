# DeepSeek mode

DeepSeek mode provides Harness-shaped filesystem tools with `standard` and `minimal` presets.

## Standard

Strict standard mode exposes `read`, `write`, and `edit`, plus conditional `read_image`. `read` is parallel; `write` and `edit` are sequential/exclusive. Observation/version state is scoped by session + workspace, and guarded mutations reject stale/missing observations. Reads stream at 10 MiB and above.

`read_image` validates bytes, enforces the realpath workspace fence, and uses Pi image normalization. Pi has no extension-facing durable attachment store, so it returns the normalized native image block directly.

## Minimal

Strict minimal mode exposes only sequential/exclusive `str_replace_editor` with `view`, `create`, `str_replace`, and `insert`. Its prompt mentions only that available editor.

Directory view never follows directory symlinks. Entry markers match Harness: `d` directory, `f` file, `?` symlink/other.

## Shell guidance

Shell descriptions name only active mutation tools: standard -> `write`/`edit`, minimal -> `str_replace_editor`, additive -> all active editors. This is model guidance, not a security boundary.

DeepSeek runtimes are cleared on shutdown. Pi-only aliases and unsupported sandbox-escalation fields are stripped from model-facing schemas.

See [Tool flows and parity](TOOL-FLOWS.md), [Configuration](CONFIGURATION.md), and [Development](DEVELOPMENT.md).
