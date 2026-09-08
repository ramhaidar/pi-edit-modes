import type {
  EditModesSettings,
  ModeResolution,
  SessionToolMode,
  SessionToolSurface,
} from "../config/types.ts";
import { SettingsDialog, type DialogResult } from "./settings-dialog.ts";

export async function openSettingsDialog(input: {
  ctx: any;
  modelLabel: string;
  resolution: ModeResolution;
  effectiveSurface: string;
  effectiveReason?: string;
  sessionMode: SessionToolMode;
  sessionSurface: SessionToolSurface;
  settings: EditModesSettings;
}): Promise<DialogResult | undefined> {
  return input.ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (result: DialogResult) => void) =>
      new SettingsDialog(
        {
          sessionMode: input.sessionMode,
          sessionSurface: input.sessionSurface,
          settings: input.settings,
        },
        input.modelLabel,
        input.resolution.mode,
        input.effectiveSurface,
        input.effectiveReason,
        `${input.resolution.source}${input.resolution.matchedBy ? ` (${input.resolution.matchedBy})` : ""}`,
        theme,
        done,
        () => tui.requestRender(),
      ),
    { overlay: true, overlayOptions: { anchor: "center", width: 64, maxHeight: 24 } },
  );
}
