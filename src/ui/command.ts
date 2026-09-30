import type {
  EditModesSettings,
  ModeResolution,
  SessionBashOnly,
  SessionDisableReadImage,
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
  sessionBashOnly: SessionBashOnly;
  sessionDisableReadImage: SessionDisableReadImage;
  settings: EditModesSettings;
}): Promise<DialogResult | undefined> {
  return input.ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (result: DialogResult) => void) =>
      new SettingsDialog(
        {
          sessionMode: input.sessionMode,
          sessionSurface: input.sessionSurface,
          sessionBashOnly: input.sessionBashOnly,
          sessionDisableReadImage: input.sessionDisableReadImage,
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
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: 64,
        // The dialog renders 28-30 lines (17 rows plus header/footer and the
        // wrapped description of the selected row); the old maxHeight of 26
        // clipped its bottom. 45 leaves headroom for 3-line descriptions.
        maxHeight: 45,
      },
    },
  );
}
