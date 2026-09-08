import type {
  EditModesSettings,
  ModelIdentity,
  ModelOverrideMap,
  ModeResolution,
  SessionToolMode,
} from "./types.ts";

function corpus(model: ModelIdentity): string {
  return [model.provider, model.id, model.name].filter(Boolean).join(" ").toLowerCase();
}

function containsToken(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

export function resolveMode(input: {
  model: ModelIdentity;
  settings: EditModesSettings;
  overrides: ModelOverrideMap;
  sessionOverride?: SessionToolMode;
}): ModeResolution {
  const { model, settings, overrides } = input;
  if (input.sessionOverride && input.sessionOverride !== "auto") {
    return { mode: input.sessionOverride, source: "session", matchedBy: "session override" };
  }
  const explicit = overrides.get(model.provider, model.id);
  if (explicit) return { mode: explicit, source: "models.json", matchedBy: "x-pi-tool-mode" };

  const text = corpus(model);
  if (settings.autoDiscovery.enabled) {
    if (settings.autoDiscovery.gemini && containsToken(text, "gemini")) {
      return {
        mode: "gemini",
        source: "auto-gemini",
        matchedBy: "provider/id/name contains gemini token",
      };
    }
    if (settings.autoDiscovery.deepseek && containsToken(text, "deepseek")) {
      return {
        mode: "deepseek",
        source: "auto-deepseek",
        matchedBy: "provider/id/name contains deepseek token",
      };
    }
    const provider = model.provider?.trim().toLowerCase();
    if (settings.autoDiscovery.codex && provider === "openai-codex") {
      return { mode: "codex", source: "auto-codex", matchedBy: "provider is openai-codex" };
    }
    if (settings.autoDiscovery.codex && containsToken(text, "codex")) {
      return {
        mode: "codex",
        source: "auto-codex",
        matchedBy: "provider/id/name contains codex token",
      };
    }
  }
  return { mode: settings.defaultMode, source: "default", matchedBy: "defaultMode" };
}
