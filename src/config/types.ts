export type ToolMode = "pi" | "codex" | "gemini" | "deepseek";
export type SessionToolMode = ToolMode | "auto";
export type ToolSurface = "replace" | "additive";
export type SessionToolSurface = ToolSurface | "auto";
// Backward-compatible source alias for integrations that imported the old type name.
export type CodexSurface = ToolSurface;

export interface EditModesSettings {
  version: 1;
  defaultMode: ToolMode;
  surface: ToolSurface;
  autoDiscovery: {
    enabled: boolean;
    gemini: boolean;
    codex: boolean;
    deepseek: boolean;
  };
  gemini: {
    strictExactMatch: boolean;
  };
}

export interface ModelIdentity {
  provider?: string;
  id?: string;
  name?: string;
}

export type ResolutionSource = "session" | "models.json" | "auto-gemini" | "auto-codex" | "auto-deepseek" | "default";

export interface ModeResolution {
  mode: ToolMode;
  source: ResolutionSource;
  matchedBy?: string;
}

export interface ModelOverrideMap {
  get(provider: string | undefined, modelId: string | undefined): ToolMode | undefined;
}
