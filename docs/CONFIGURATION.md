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

Bash-only resolution:

1. `--bash-only` / `--no-bash-only` CLI override
2. runtime `/bash-only on|off|auto|toggle` session override
3. `bashOnly` from `edit-modes.json`

`--apply-patch-mode` and `PI_APPLY_PATCH_TOOL_MODE` remain supported as deprecated migration inputs when no new mode/surface CLI override is set.

## Settings file

Settings are stored in `~/.pi/agent/edit-modes.json`: Set `defaultMode` to `"all"` to expose every available file-editing tool.

```json
{
  "version": 1,
  "defaultMode": "pi",
  "surface": "replace",
  "bashOnly": false,
  "autoDiscovery": {
    "enabled": true,
    "gemini": true,
    "codex": true,
    "deepseek": true
  },
  "gemini": {
    "approval": "ask_user",
    "disableLLMCorrection": true,
    "fileFiltering": {
      "respectGitIgnore": true,
      "respectGeminiIgnore": true,
      "customIgnoreFilePaths": []
    }
  },
  "deepseek": {
    "preset": "standard"
  }
}
```

- `surface`: `replace` or `additive`.
- `bashOnly`: boolean, default `false`. See [Bash-only override](#bash-only-override).
- `gemini.approval`: `ask_user` or `auto_edit`.
- `gemini.disableLLMCorrection`: boolean, default `true`, matching current Gemini CLI's correction default.
- `gemini.fileFiltering.respectGitIgnore`: boolean, default `true`. Controls whether Gemini `replace` fallback path discovery respects `.gitignore` and `.git/info/exclude`.
- `gemini.fileFiltering.respectGeminiIgnore`: boolean, default `true`. Controls whether fallback discovery respects `.geminiignore`.
- `gemini.fileFiltering.customIgnoreFilePaths`: array of project-root-relative ignore-file paths, default `[]`. These files participate in fallback discovery filtering. This arbitrary path list is configured in JSON rather than the settings overlay.
- `deepseek.preset`: `standard` or `minimal`.

The legacy `codex.surface` setting is accepted as a migration fallback. The legacy `gemini.strictExactMatch` boolean is also accepted so older settings files still load, but it is no longer projected into current Gemini behavior.

Settings writes from the TUI use a temp file, fsync, and rename.

## Bash-only override

`bashOnly` is an independent master switch that is authoritative over both mode and surface. When it is on, every mutating file tool is removed from the active roster and from provider payloads:

- native `edit` and `write`
- `apply_patch` (Codex)
- `replace` and `write_file` (Gemini)
- `str_replace_editor` (DeepSeek minimal; its `create`/`str_replace`/`insert` commands mutate files)
- DeepSeek `standard` `write`/`edit`
- `read_image` (DeepSeek; read-only, but mode-owned, and bash-only disables the whole DeepSeek surface)

The surviving roster is the Pi-native read-only tools (`read`, `grep`, `find`, `ls`) plus the shell (`bash`, or `powershell` on Windows), so the shell becomes the only remaining mutation path. Every managed custom tool is mode-owned and is removed, including the read-only DeepSeek `read_image`, because bash-only is mode-independent. This is a strict surface: if another extension reactivates a forbidden tool, the next synchronization removes it again and `before_provider_request` independently enforces the same roster on the wire.

Pi ships no native delete/`rm` tool, so the disabled set is exactly the write/edit/delete-capable tools listed above rather than a separate "delete tool".

Mode and surface still resolve normally and are still reported, but they no longer determine the active tools while bash-only is on. Because bash-only overrides surface, it also applies to the otherwise-hybrid `additive` surface.

If `bashOnly` is on but no shell tool is available (for example `bash` excluded through Pi tool configuration), the switch still removes every mutating tool and warns that no file-mutation path remains. It never silently restores `edit`/`write`; the resolved surface is reported as `bash-only (no file tools)` with the reason attached.

Set it through any of:

- `edit-modes.json`: `"bashOnly": true`
- CLI: `--bash-only` (force on) or `--no-bash-only` (force off) for a single run
- Session: `/bash-only on|off|auto|toggle`
- Overlay: the `/tool-mode` dialog's `Session bash-only` and `Default bash-only` rows

Pi's generic CLI parser consumes the argument after an extension flag when that argument does not start with `-`, which is shared behavior for every extension boolean flag. Prefer `--bash-only=true` or place the flag after the prompt (for example `pi "fix the bug" --bash-only`), or separate it with `--`, so `--bash-only "fix the bug"` does not swallow the prompt.

Leaving bash-only restores the native `edit`/`write` tools at their original positions, matching strict `replace` surface behavior.

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
- `/tool-mode auto|gemini|codex|deepseek|all|pi` changes the runtime session mode override.
- `/tool-surface auto|replace|additive` changes the runtime session surface override.
- `/bash-only on|off|auto|toggle` changes the runtime session bash-only override.
- `/apply-patch-mode replace|additive|off` is a deprecated compatibility alias.

The overlay reports resolved mode, effective surface, bash-only state, Gemini approval mode, Gemini `.gitignore`/`.geminiignore` discovery toggles, and DeepSeek preset. If a requested custom mode is unavailable, it reports the Pi fallback and the reason.
