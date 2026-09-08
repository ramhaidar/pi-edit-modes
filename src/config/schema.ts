import type { EditModesSettings, ToolMode, ToolSurface } from "./types.ts";

export const DEFAULT_SETTINGS: EditModesSettings = {
  version: 1,
  defaultMode: "pi",
  surface: "replace",
  autoDiscovery: { enabled: true, gemini: true, codex: true, deepseek: true },
  gemini: { strictExactMatch: true },
};

export function isToolMode(value: unknown): value is ToolMode {
  return value === "pi" || value === "codex" || value === "gemini" || value === "deepseek";
}

export function isToolSurface(value: unknown): value is ToolSurface {
  return value === "replace" || value === "additive";
}

// Backward-compatible alias.
export const isCodexSurface = isToolSurface;

export function parseSettings(value: unknown): { settings: EditModesSettings; warning?: string } {
  const fallback = (message: string) => ({ settings: structuredClone(DEFAULT_SETTINGS), warning: `${message} Using defaults.` });
  if (value === undefined || value === null) return { settings: structuredClone(DEFAULT_SETTINGS) };
  if (typeof value !== "object" || Array.isArray(value)) return fallback("edit-modes.json must contain a JSON object.");
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) return fallback(`Unsupported edit-modes.json version '${String(record.version)}'.`);
  if (record.defaultMode !== undefined && !isToolMode(record.defaultMode)) return fallback(`Invalid defaultMode '${String(record.defaultMode)}'.`);

  const section = (name: string): Record<string, unknown> | undefined => {
    const raw = record[name];
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${name} must be an object.`);
    return raw as Record<string, unknown>;
  };

  try {
    const auto = section("autoDiscovery") ?? {};
    const legacyCodex = section("codex") ?? {};
    const gemini = section("gemini") ?? {};
    for (const key of ["enabled", "gemini", "codex", "deepseek"] as const) {
      if (auto[key] !== undefined && typeof auto[key] !== "boolean") return fallback(`autoDiscovery.${key} must be boolean.`);
    }
    if (record.surface !== undefined && !isToolSurface(record.surface)) return fallback(`Invalid surface '${String(record.surface)}'.`);
    if (legacyCodex.surface !== undefined && !isToolSurface(legacyCodex.surface)) return fallback(`Invalid legacy codex.surface '${String(legacyCodex.surface)}'.`);
    if (gemini.strictExactMatch !== undefined && typeof gemini.strictExactMatch !== "boolean") return fallback("gemini.strictExactMatch must be boolean.");

    // v0.1.0 stored the custom-tool surface under codex.surface. Accept it as a migration
    // fallback, but normalize the setting to one universal surface shared by all custom modes.
    const surface = isToolSurface(record.surface)
      ? record.surface
      : isToolSurface(legacyCodex.surface)
        ? legacyCodex.surface
        : DEFAULT_SETTINGS.surface;

    return {
      settings: {
        version: 1,
        defaultMode: isToolMode(record.defaultMode) ? record.defaultMode : DEFAULT_SETTINGS.defaultMode,
        surface,
        autoDiscovery: {
          enabled: typeof auto.enabled === "boolean" ? auto.enabled : DEFAULT_SETTINGS.autoDiscovery.enabled,
          gemini: typeof auto.gemini === "boolean" ? auto.gemini : DEFAULT_SETTINGS.autoDiscovery.gemini,
          codex: typeof auto.codex === "boolean" ? auto.codex : DEFAULT_SETTINGS.autoDiscovery.codex,
          deepseek: typeof auto.deepseek === "boolean" ? auto.deepseek : DEFAULT_SETTINGS.autoDiscovery.deepseek,
        },
        gemini: {
          strictExactMatch: typeof gemini.strictExactMatch === "boolean"
            ? gemini.strictExactMatch
            : DEFAULT_SETTINGS.gemini.strictExactMatch,
        },
      },
    };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}
