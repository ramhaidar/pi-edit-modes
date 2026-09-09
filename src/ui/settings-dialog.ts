import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditModesSettings, SessionToolMode, SessionToolSurface } from "../config/types.ts";

export interface SettingsDialogDraft {
  sessionMode: SessionToolMode;
  sessionSurface: SessionToolSurface;
  settings: EditModesSettings;
}

export type DialogResult = { action: "save"; draft: SettingsDialogDraft } | { action: "cancel" };

const SESSION_MODES: SessionToolMode[] = ["auto", "gemini", "codex", "deepseek", "pi"];
const SESSION_SURFACES: SessionToolSurface[] = ["auto", "replace", "additive"];
const DEFAULT_MODES: EditModesSettings["defaultMode"][] = ["pi", "gemini", "codex", "deepseek"];
const TOOL_SURFACES: EditModesSettings["surface"][] = ["replace", "additive"];
const GEMINI_APPROVALS: EditModesSettings["gemini"]["approval"][] = ["ask_user", "auto_edit"];
const DEEPSEEK_PRESETS: EditModesSettings["deepseek"]["preset"][] = ["standard", "minimal"];
const SAVE_ROW = 13;

const ROW_DESCRIPTIONS: readonly string[] = [
  "Tool mode for this session only ('auto' follows the active model). Session-only: it does not change saved settings.",
  "Session-only tool surface: 'replace' swaps Pi's built-in edit tools for the mode's tools, 'additive' keeps both.",
  "Mode used for new sessions when no model-specific rule matches. Written to edit-modes.json on save.",
  "Default surface for new sessions. A session surface override still wins while a session is running.",
  "Master switch for model auto-detection. When Off, none of the individual auto-detect rules below apply.",
  "Automatically use Gemini tools whenever the active model is a Gemini model.",
  "Automatically use Codex tools whenever the active model is a Codex/GPT model.",
  "Automatically use DeepSeek tools whenever the active model is a DeepSeek model.",
  "'ask_user' asks for confirmation before Gemini edits or writes files; 'auto_edit' lets Gemini apply changes without asking.",
  "When On, Gemini can retry failed file edits on its own. Turn Off to fail fast instead of auto-correcting.",
  "When On, Gemini relative-path fallback discovery respects .gitignore and .git/info/exclude rules.",
  "When On, Gemini relative-path fallback discovery respects .geminiignore. Custom ignore files remain configurable in edit-modes.json.",
  "DeepSeek tool/prompt profile: 'standard' is the full setup, 'minimal' is a lighter, lower-token setup.",
  "Write all changed values to edit-modes.json and close this dialog. Esc closes without saving.",
];

function cycle<T>(values: readonly T[], current: T, direction: -1 | 1): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + direction + values.length) % values.length]!;
}

function cloneDraft(draft: SettingsDialogDraft): SettingsDialogDraft {
  return {
    sessionMode: draft.sessionMode,
    sessionSurface: draft.sessionSurface,
    settings: structuredClone(draft.settings),
  };
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export class SettingsDialog {
  private selected = 0;
  private readonly draft: SettingsDialogDraft;
  private readonly modelLabel: string;
  private readonly resolvedMode: string;
  private readonly effectiveSurface: string;
  private readonly effectiveReason?: string;
  private readonly sourceLabel: string;
  private readonly theme: any;
  private readonly done: (result: DialogResult) => void;
  private readonly requestRender: () => void;

  constructor(
    draft: SettingsDialogDraft,
    modelLabel: string,
    resolvedMode: string,
    effectiveSurface: string,
    effectiveReason: string | undefined,
    sourceLabel: string,
    theme: any,
    done: (result: DialogResult) => void,
    requestRender: () => void,
  ) {
    this.draft = cloneDraft(draft);
    this.modelLabel = modelLabel;
    this.resolvedMode = resolvedMode;
    this.effectiveSurface = effectiveSurface;
    this.effectiveReason = effectiveReason;
    this.sourceLabel = sourceLabel;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
  }

  private rows(): Array<{ label: string; value: string }> {
    return [
      { label: "Current session mode", value: this.draft.sessionMode },
      { label: "Current session surface", value: this.draft.sessionSurface },
      { label: "Default mode", value: this.draft.settings.defaultMode },
      { label: "Default surface", value: this.draft.settings.surface },
      { label: "Auto discovery", value: this.draft.settings.autoDiscovery.enabled ? "On" : "Off" },
      {
        label: "Auto detect Gemini",
        value: this.draft.settings.autoDiscovery.gemini ? "On" : "Off",
      },
      { label: "Auto detect Codex", value: this.draft.settings.autoDiscovery.codex ? "On" : "Off" },
      {
        label: "Auto detect DeepSeek",
        value: this.draft.settings.autoDiscovery.deepseek ? "On" : "Off",
      },
      { label: "Gemini mutation approval", value: this.draft.settings.gemini.approval },
      {
        label: "Gemini LLM correction",
        value: this.draft.settings.gemini.disableLLMCorrection ? "Off" : "On",
      },
      {
        label: "Gemini respect .gitignore",
        value: this.draft.settings.gemini.fileFiltering.respectGitIgnore ? "On" : "Off",
      },
      {
        label: "Gemini respect .geminiignore",
        value: this.draft.settings.gemini.fileFiltering.respectGeminiIgnore ? "On" : "Off",
      },
      { label: "DeepSeek preset", value: this.draft.settings.deepseek.preset },
      { label: "Save settings", value: "" },
    ];
  }

  private describe(row: number): string {
    return ROW_DESCRIPTIONS[row] ?? "↑/↓ select a row to see what it does.";
  }

  private change(direction: -1 | 1): void {
    switch (this.selected) {
      case 0:
        this.draft.sessionMode = cycle(SESSION_MODES, this.draft.sessionMode, direction);
        break;
      case 1:
        this.draft.sessionSurface = cycle(SESSION_SURFACES, this.draft.sessionSurface, direction);
        break;
      case 2:
        this.draft.settings.defaultMode = cycle(
          DEFAULT_MODES,
          this.draft.settings.defaultMode,
          direction,
        );
        break;
      case 3:
        this.draft.settings.surface = cycle(TOOL_SURFACES, this.draft.settings.surface, direction);
        break;
      case 4:
        this.draft.settings.autoDiscovery.enabled = !this.draft.settings.autoDiscovery.enabled;
        break;
      case 5:
        this.draft.settings.autoDiscovery.gemini = !this.draft.settings.autoDiscovery.gemini;
        break;
      case 6:
        this.draft.settings.autoDiscovery.codex = !this.draft.settings.autoDiscovery.codex;
        break;
      case 7:
        this.draft.settings.autoDiscovery.deepseek = !this.draft.settings.autoDiscovery.deepseek;
        break;
      case 8:
        this.draft.settings.gemini.approval = cycle(
          GEMINI_APPROVALS,
          this.draft.settings.gemini.approval,
          direction,
        );
        break;
      case 9:
        this.draft.settings.gemini.disableLLMCorrection =
          !this.draft.settings.gemini.disableLLMCorrection;
        break;
      case 10:
        this.draft.settings.gemini.fileFiltering.respectGitIgnore =
          !this.draft.settings.gemini.fileFiltering.respectGitIgnore;
        break;
      case 11:
        this.draft.settings.gemini.fileFiltering.respectGeminiIgnore =
          !this.draft.settings.gemini.fileFiltering.respectGeminiIgnore;
        break;
      case 12:
        this.draft.settings.deepseek.preset = cycle(
          DEEPSEEK_PRESETS,
          this.draft.settings.deepseek.preset,
          direction,
        );
        break;
      case SAVE_ROW:
        this.done({ action: "save", draft: cloneDraft(this.draft) });
        return;
    }
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))
      return this.done({ action: "cancel" });
    if (matchesKey(data, "up")) {
      this.selected = (this.selected - 1 + this.rows().length) % this.rows().length;
      return this.requestRender();
    }
    if (matchesKey(data, "down")) {
      this.selected = (this.selected + 1) % this.rows().length;
      return this.requestRender();
    }
    if (matchesKey(data, "left")) return this.change(-1);
    if (matchesKey(data, "right") || matchesKey(data, "space")) return this.change(1);
    if (matchesKey(data, "return")) {
      if (this.selected === SAVE_ROW)
        return this.done({ action: "save", draft: cloneDraft(this.draft) });
      return this.change(1);
    }
  }

  render(width: number): string[] {
    const inner = Math.max(30, width - 2);
    const rows = this.rows();
    const lines: string[] = [];
    const title = " File Tool Mode ";
    const left = Math.max(0, Math.floor((inner - visibleWidth(title)) / 2));
    const right = Math.max(0, inner - left - visibleWidth(title));
    lines.push(
      this.theme.fg("border", `╭${"─".repeat(left)}`) +
        this.theme.fg("accent", title) +
        this.theme.fg("border", `${"─".repeat(right)}╮`),
    );
    const add = (text = "") =>
      lines.push(
        this.theme.fg("border", "│") +
          truncateToWidth(` ${text}`, inner, "...", true).padEnd(inner) +
          this.theme.fg("border", "│"),
      );
    add(`Model: ${this.modelLabel}`);
    add(`Resolved mode: ${this.resolvedMode}`);
    add(`Effective surface: ${this.effectiveSurface}`);
    add(`Source: ${this.sourceLabel}`);
    if (this.effectiveReason) add(`Reason: ${this.effectiveReason}`);
    add();
    rows.forEach((row, index) => {
      const selected = index === this.selected;
      const prefix = selected ? ">" : " ";
      const value = row.value ? ` ${row.value}` : "";
      const labelWidth = Math.max(10, inner - visibleWidth(value) - 4);
      const label = truncateToWidth(row.label, labelWidth, "...", true).padEnd(labelWidth);
      add(`${prefix} ${selected ? this.theme.fg("accent", label) : label}${value}`);
    });
    add();
    for (const line of wrapText(this.describe(this.selected), inner - 2))
      add(this.theme.fg("dim", line));
    add("↑/↓ Navigate   ←/→ Change   Enter Select   Esc Close");
    lines.push(this.theme.fg("border", `╰${"─".repeat(inner)}╯`));
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}
