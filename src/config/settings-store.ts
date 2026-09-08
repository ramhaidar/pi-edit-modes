import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS, parseSettings } from "./schema.ts";
import { fileMtimeMs, readModelOverrides, MutableModelOverrideMap } from "./models-config.ts";
import type { EditModesSettings } from "./types.ts";

export interface StoreSnapshot {
  settings: EditModesSettings;
  overrides: MutableModelOverrideMap;
  warnings: string[];
}

export class EditModesConfigStore {
  readonly settingsPath: string;
  readonly modelsPath: string;
  private settingsMtime = Number.NaN;
  private modelsMtime = Number.NaN;
  private snapshotValue: StoreSnapshot = {
    settings: structuredClone(DEFAULT_SETTINGS),
    overrides: new MutableModelOverrideMap(),
    warnings: [],
  };

  constructor(agentDir: string) {
    this.settingsPath = join(agentDir, "edit-modes.json");
    this.modelsPath = join(agentDir, "models.json");
  }

  snapshot(): StoreSnapshot { return this.snapshotValue; }

  async refresh(force = false): Promise<StoreSnapshot> {
    const [settingsMtime, modelsMtime] = await Promise.all([fileMtimeMs(this.settingsPath), fileMtimeMs(this.modelsPath)]);
    if (!force && settingsMtime === this.settingsMtime && modelsMtime === this.modelsMtime) return this.snapshotValue;
    this.settingsMtime = settingsMtime;
    this.modelsMtime = modelsMtime;
    const warnings: string[] = [];
    let settings = structuredClone(DEFAULT_SETTINGS);
    if (settingsMtime >= 0) {
      try {
        const parsed = parseSettings(JSON.parse(await readFile(this.settingsPath, "utf8")));
        settings = parsed.settings;
        if (parsed.warning) warnings.push(parsed.warning);
      } catch (error) {
        warnings.push(`Invalid edit-modes.json: ${error instanceof Error ? error.message : String(error)}. Using defaults.`);
      }
    }
    const modelResult = await readModelOverrides(this.modelsPath);
    warnings.push(...modelResult.warnings);
    this.snapshotValue = { settings, overrides: modelResult.overrides, warnings };
    return this.snapshotValue;
  }

  async save(settings: EditModesSettings): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temp = `${this.settingsPath}.tmp-${process.pid}-${Date.now()}`;
    const payload = `${JSON.stringify(settings, null, 2)}\n`;
    await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
    const handle = await open(temp, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temp, this.settingsPath);
    const dir = await open(dirname(this.settingsPath), "r").catch(() => undefined);
    try { await dir?.sync().catch(() => undefined); } finally { await dir?.close().catch(() => undefined); }
    await this.refresh(true);
  }
}
