export type ToolMode = "pi" | "codex" | "gemini" | "deepseek" | "all";
export type SessionToolMode = ToolMode | "auto";
export type ToolSurface = "replace" | "additive";
export type SessionToolSurface = ToolSurface | "auto";
/** Session-scoped bash-only override. `"auto"` defers to the persisted setting. */
export type SessionBashOnly = boolean | "auto";
export type GeminiApprovalMode = "ask_user" | "auto_edit";
export type DeepSeekPreset = "standard" | "minimal";
// Backward-compatible source alias for integrations that imported the old type name.
export type CodexSurface = ToolSurface;

export interface EditModesSettings {
  version: 1;
  defaultMode: ToolMode;
  surface: ToolSurface;
  /**
   * Bash-only override. When true it is authoritative over mode and surface:
   * every mutating file tool (native edit/write and all managed custom tools)
   * is removed so the shell is the only mutation path. Read-only tools stay.
   */
  bashOnly: boolean;
  autoDiscovery: {
    enabled: boolean;
    gemini: boolean;
    codex: boolean;
    deepseek: boolean;
  };
  gemini: {
    approval: GeminiApprovalMode;
    disableLLMCorrection: boolean;
    fileFiltering: {
      respectGitIgnore: boolean;
      respectGeminiIgnore: boolean;
      customIgnoreFilePaths: string[];
    };
  };
  deepseek: {
    preset: DeepSeekPreset;
  };
}

export interface ModelIdentity {
  provider?: string;
  id?: string;
  name?: string;
}

export type ResolutionSource =
  "session" | "models.json" | "auto-gemini" | "auto-codex" | "auto-deepseek" | "default";

export interface ModeResolution {
  mode: ToolMode;
  source: ResolutionSource;
  matchedBy?: string;
}

export interface ModelOverrideMap {
  get(provider: string | undefined, modelId: string | undefined): ToolMode | undefined;
}
