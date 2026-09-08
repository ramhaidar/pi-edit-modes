# Configuration

Complete mode resolution, settings, model overrides, and runtime commands for `pi-edit-modes`.

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

## Settings file

Settings are stored in `~/.pi/agent/edit-modes.json`:

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

- `surface`: `replace` or `additive`.
- `gemini.approval`: `ask_user` or `auto_edit`.
- `gemini.disableLLMCorrection`: boolean, default `true`, matching current Gemini CLI's correction default.
- `deepseek.preset`: `standard` or `minimal`.

The legacy `codex.surface` setting is accepted as a migration fallback. The legacy `gemini.strictExactMatch` boolean is also accepted so older settings files still load, but it is no longer projected into current Gemini behavior.

Settings writes from the TUI use a temp file, fsync, and rename.

## Model overrides

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
