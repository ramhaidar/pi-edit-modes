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
const SAVE_ROW = 9;

function cycle<T>(values: readonly T[], current: T, direction: -1 | 1): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + direction + values.length) % values.length]!;
}

function cloneDraft(draft: SettingsDialogDraft): SettingsDialogDraft {
  return { sessionMode: draft.sessionMode, sessionSurface: draft.sessionSurface, settings: structuredClone(draft.settings) };
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
      { label: "Auto detect Gemini", value: this.draft.settings.autoDiscovery.gemini ? "On" : "Off" },
      { label: "Auto detect Codex", value: this.draft.settings.autoDiscovery.codex ? "On" : "Off" },
      { label: "Auto detect DeepSeek", value: this.draft.settings.autoDiscovery.deepseek ? "On" : "Off" },
      { label: "Gemini strict exact match", value: this.draft.settings.gemini.strictExactMatch ? "On" : "Off" },
      { label: "Save settings", value: "" },
    ];
  }

  private change(direction: -1 | 1): void {
    switch (this.selected) {
      case 0: this.draft.sessionMode = cycle(SESSION_MODES, this.draft.sessionMode, direction); break;
      case 1: this.draft.sessionSurface = cycle(SESSION_SURFACES, this.draft.sessionSurface, direction); break;
      case 2: this.draft.settings.defaultMode = cycle(DEFAULT_MODES, this.draft.settings.defaultMode, direction); break;
      case 3: this.draft.settings.surface = cycle(TOOL_SURFACES, this.draft.settings.surface, direction); break;
      case 4: this.draft.settings.autoDiscovery.enabled = !this.draft.settings.autoDiscovery.enabled; break;
      case 5: this.draft.settings.autoDiscovery.gemini = !this.draft.settings.autoDiscovery.gemini; break;
      case 6: this.draft.settings.autoDiscovery.codex = !this.draft.settings.autoDiscovery.codex; break;
      case 7: this.draft.settings.autoDiscovery.deepseek = !this.draft.settings.autoDiscovery.deepseek; break;
      case 8: this.draft.settings.gemini.strictExactMatch = !this.draft.settings.gemini.strictExactMatch; break;
      case SAVE_ROW: this.done({ action: "save", draft: cloneDraft(this.draft) }); return;
    }
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done({ action: "cancel" });
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
      if (this.selected === SAVE_ROW) return this.done({ action: "save", draft: cloneDraft(this.draft) });
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
    lines.push(this.theme.fg("border", `╭${"─".repeat(left)}`) + this.theme.fg("accent", title) + this.theme.fg("border", `${"─".repeat(right)}╮`));
    const add = (text = "") => lines.push(this.theme.fg("border", "│") + truncateToWidth(` ${text}`, inner, "...", true).padEnd(inner) + this.theme.fg("border", "│"));
    add(`Model: ${this.modelLabel}`);
    add(`Resolved mode: ${this.resolvedMode}`);
    add(`Effective surface: ${this.effectiveSurface}`);
    add(`Source: ${this.sourceLabel}`);
    if (this.effectiveReason) add(`Reason: ${this.effectiveReason}`);
    add();
    rows.forEach((row, index) => {
      const prefix = index === this.selected ? ">" : " ";
      const value = row.value ? ` ${row.value}` : "";
      const labelWidth = Math.max(10, inner - visibleWidth(value) - 4);
      const label = truncateToWidth(row.label, labelWidth, "...", true).padEnd(labelWidth);
      add(`${prefix} ${label}${value}`);
    });
    add();
    add("↑/↓ Navigate   ←/→ Change   Enter Select   Esc Close");
    lines.push(this.theme.fg("border", `╰${"─".repeat(inner)}╯`));
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}
