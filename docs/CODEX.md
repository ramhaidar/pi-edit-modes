# Codex mode

Codex mode exposes the Codex-compatible `apply_patch` surface.

On strict `replace`, native Pi mutations and Gemini/DeepSeek managed mutations are removed. `additive` is intentionally hybrid.

## `apply_patch`

The engine supports Add, Delete, Update, and Move hunks under the secure filesystem policy.

The grammar accepts the optional protocol header:

```text
*** Environment ID: <id>
```

Pi exposes a single workspace environment and no environment catalog, so supplying an Environment ID fails closed at execution. It is never silently ignored or mapped to the current workspace.

For Google/Gemini providers explicitly overridden to Codex mode, `apply_patch` is represented as a compatibility function carrying the raw patch string.

Strict provider guarding removes other managed mutation families and rejects forced forbidden tools.

Full Codex harness features such as multi-environment execution, sandbox routing, streaming patch argument events, and wider hooks are host-level capabilities outside standalone edit-engine parity.

See [Tool flows and parity](TOOL-FLOWS.md), [Configuration](CONFIGURATION.md), and [Development](DEVELOPMENT.md).
