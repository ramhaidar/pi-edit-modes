export type ToolMode = "pi" | "codex" | "gemini" | "deepseek" | "all";
export type SessionToolMode = ToolMode | "auto";
export type ToolSurface = "replace" | "additive";
export type SessionToolSurface = ToolSurface | "auto";
/** Session-scoped bash-only override. `"auto"` defers to the persisted setting. */
export type SessionBashOnly = boolean | "auto";
/**
 * Session-scoped `read_image` override. `"auto"` keeps default behavior
 * (`read_image` appears on DeepSeek surfaces when the model supports images);
 * `true` removes `read_image` so image files go through the native `read` tool;
 * `false` forces `read_image` on even when the model advertises native image input.
 */
export type SessionDisableReadImage = boolean | "auto";
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
    /**
     * Persisted DeepSeek read override. When false (default), DeepSeek mode
     * replaces Pi's native `read` with the DeepSeek parity read and adds
     * `read_image`. When true, Pi's native `read` is kept and `read_image` is
     * not activated, so image files go through the native `read` tool.
     */
    nativeRead: boolean;
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
