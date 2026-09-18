import type {
  DeepSeekPreset,
  EditModesSettings,
  GeminiApprovalMode,
  ToolMode,
  ToolSurface,
} from "./types.ts";

export const DEFAULT_SETTINGS: EditModesSettings = {
  version: 1,
  defaultMode: "pi",
  surface: "replace",
  bashOnly: false,
  autoDiscovery: { enabled: true, gemini: true, codex: true, deepseek: true },
  gemini: {
    approval: "ask_user",
    disableLLMCorrection: true,
    fileFiltering: {
      respectGitIgnore: true,
      respectGeminiIgnore: true,
      customIgnoreFilePaths: [],
    },
  },
  deepseek: { preset: "standard" },
};

export function isToolMode(value: unknown): value is ToolMode {
  return (
    value === "pi" ||
    value === "codex" ||
    value === "gemini" ||
    value === "deepseek" ||
    value === "all"
  );
}

export function isToolSurface(value: unknown): value is ToolSurface {
  return value === "replace" || value === "additive";
}

export function isGeminiApprovalMode(value: unknown): value is GeminiApprovalMode {
  return value === "ask_user" || value === "auto_edit";
}

export function isDeepSeekPreset(value: unknown): value is DeepSeekPreset {
  return value === "standard" || value === "minimal";
}

// Backward-compatible alias.
export const isCodexSurface = isToolSurface;

export function parseSettings(value: unknown): { settings: EditModesSettings; warning?: string } {
  const fallback = (message: string) => ({
    settings: structuredClone(DEFAULT_SETTINGS),
    warning: `${message} Using defaults.`,
  });
  if (value === undefined || value === null) return { settings: structuredClone(DEFAULT_SETTINGS) };
  if (typeof value !== "object" || Array.isArray(value))
    return fallback("edit-modes.json must contain a JSON object.");
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1)
    return fallback(`Unsupported edit-modes.json version '${String(record.version)}'.`);
  if (record.defaultMode !== undefined && !isToolMode(record.defaultMode))
    return fallback(`Invalid defaultMode '${String(record.defaultMode)}'.`);

  const section = (name: string): Record<string, unknown> | undefined => {
    const raw = record[name];
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`${name} must be an object.`);
    return raw as Record<string, unknown>;
  };

  try {
    const auto = section("autoDiscovery") ?? {};
    const legacyCodex = section("codex") ?? {};
    const gemini = section("gemini") ?? {};
    const geminiFileFiltering =
      gemini.fileFiltering === undefined
        ? {}
        : gemini.fileFiltering &&
            typeof gemini.fileFiltering === "object" &&
            !Array.isArray(gemini.fileFiltering)
          ? (gemini.fileFiltering as Record<string, unknown>)
          : null;
    if (geminiFileFiltering === null) return fallback("gemini.fileFiltering must be an object.");
    const deepseek = section("deepseek") ?? {};
    for (const key of ["enabled", "gemini", "codex", "deepseek"] as const) {
      if (auto[key] !== undefined && typeof auto[key] !== "boolean")
        return fallback(`autoDiscovery.${key} must be boolean.`);
    }
    if (record.surface !== undefined && !isToolSurface(record.surface))
      return fallback(`Invalid surface '${String(record.surface)}'.`);
    if (record.bashOnly !== undefined && typeof record.bashOnly !== "boolean")
      return fallback("bashOnly must be boolean.");
    if (legacyCodex.surface !== undefined && !isToolSurface(legacyCodex.surface))
      return fallback(`Invalid legacy codex.surface '${String(legacyCodex.surface)}'.`);
    if (gemini.approval !== undefined && !isGeminiApprovalMode(gemini.approval))
      return fallback(`Invalid gemini.approval '${String(gemini.approval)}'.`);
    if (
      gemini.disableLLMCorrection !== undefined &&
      typeof gemini.disableLLMCorrection !== "boolean"
    )
      return fallback("gemini.disableLLMCorrection must be boolean.");
    for (const key of ["respectGitIgnore", "respectGeminiIgnore"] as const) {
      if (geminiFileFiltering[key] !== undefined && typeof geminiFileFiltering[key] !== "boolean")
        return fallback(`gemini.fileFiltering.${key} must be boolean.`);
    }
    if (
      geminiFileFiltering.customIgnoreFilePaths !== undefined &&
      (!Array.isArray(geminiFileFiltering.customIgnoreFilePaths) ||
        !geminiFileFiltering.customIgnoreFilePaths.every((value) => typeof value === "string"))
    )
      return fallback("gemini.fileFiltering.customIgnoreFilePaths must be an array of strings.");
    // v0.1.x exposed strictExactMatch. Accept the legacy boolean so old settings
    // files continue loading, but intentionally do not project it into the current
    // Gemini CLI-compatible replacement behavior.
    if (gemini.strictExactMatch !== undefined && typeof gemini.strictExactMatch !== "boolean")
      return fallback("legacy gemini.strictExactMatch must be boolean.");
    if (deepseek.preset !== undefined && !isDeepSeekPreset(deepseek.preset))
      return fallback(`Invalid deepseek.preset '${String(deepseek.preset)}'.`);

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
        defaultMode: isToolMode(record.defaultMode)
          ? record.defaultMode
          : DEFAULT_SETTINGS.defaultMode,
        surface,
        bashOnly:
          typeof record.bashOnly === "boolean" ? record.bashOnly : DEFAULT_SETTINGS.bashOnly,
        autoDiscovery: {
          enabled:
            typeof auto.enabled === "boolean"
              ? auto.enabled
              : DEFAULT_SETTINGS.autoDiscovery.enabled,
          gemini:
            typeof auto.gemini === "boolean" ? auto.gemini : DEFAULT_SETTINGS.autoDiscovery.gemini,
          codex:
            typeof auto.codex === "boolean" ? auto.codex : DEFAULT_SETTINGS.autoDiscovery.codex,
          deepseek:
            typeof auto.deepseek === "boolean"
              ? auto.deepseek
              : DEFAULT_SETTINGS.autoDiscovery.deepseek,
        },
        gemini: {
          approval: isGeminiApprovalMode(gemini.approval)
            ? gemini.approval
            : DEFAULT_SETTINGS.gemini.approval,
          disableLLMCorrection:
            typeof gemini.disableLLMCorrection === "boolean"
              ? gemini.disableLLMCorrection
              : DEFAULT_SETTINGS.gemini.disableLLMCorrection,
          fileFiltering: {
            respectGitIgnore:
              typeof geminiFileFiltering.respectGitIgnore === "boolean"
                ? geminiFileFiltering.respectGitIgnore
                : DEFAULT_SETTINGS.gemini.fileFiltering.respectGitIgnore,
            respectGeminiIgnore:
              typeof geminiFileFiltering.respectGeminiIgnore === "boolean"
                ? geminiFileFiltering.respectGeminiIgnore
                : DEFAULT_SETTINGS.gemini.fileFiltering.respectGeminiIgnore,
            customIgnoreFilePaths: Array.isArray(geminiFileFiltering.customIgnoreFilePaths)
              ? [...geminiFileFiltering.customIgnoreFilePaths]
              : [...DEFAULT_SETTINGS.gemini.fileFiltering.customIgnoreFilePaths],
          },
        },
        deepseek: {
          preset: isDeepSeekPreset(deepseek.preset)
            ? deepseek.preset
            : DEFAULT_SETTINGS.deepseek.preset,
        },
      },
    };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}
