import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  DeepSeekPreset,
  ModelIdentity,
  ModeResolution,
  SessionToolMode,
  SessionToolSurface,
  ToolMode,
  ToolSurface,
} from "./config/types.ts";
import { EditModesConfigStore } from "./config/settings-store.ts";
import { isToolMode, isToolSurface } from "./config/schema.ts";
import { resolveMode } from "./config/resolver.ts";
import { registerCodexApplyPatchTool, getCodexApplyPatchSupport, guardCodexProviderPayload } from "./tools/codex/engine.ts";
import { registerGeminiTools } from "./tools/gemini/index.ts";
import { registerDeepSeekTool } from "./tools/deepseek/index.ts";
import {
  clearDeepSeekFsRuntimes,
  registerDeepSeekFilesystemTools,
  registerDeepSeekReadImageTool,
  registerDeepSeekMutationCompatibilityHook,
  registerPiFilesystemTools,
  type FilesystemToolFlavor,
} from "./tools/deepseek/fs-tools.ts";
import {
  computeToolTransition,
  initialToolOwnership,
  managedFileToolSurface,
  sameToolList,
  GEMINI_TOOL_NAMES,
  DEEPSEEK_TOOL_NAMES,
  type ManagedSurface,
} from "./modes/router.ts";
import { codexProviderToolAvailable, guardProviderPayload } from "./modes/provider-guard.ts";
import { openSettingsDialog } from "./ui/command.ts";

function modelIdentity(model: unknown): ModelIdentity {
  if (!model || typeof model !== "object") return {};
  const value = model as Record<string, unknown>;
  return {
    provider: typeof value.provider === "string" ? value.provider : undefined,
    id: typeof value.id === "string" ? value.id : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
  };
}

function modelLabel(model: unknown): string {
  const identity = modelIdentity(model);
  if (identity.provider && identity.id) return `${identity.provider}/${identity.id}`;
  return identity.id ?? identity.name ?? "(unknown model)";
}

function modelSupportsImages(model: unknown): boolean {
  if (!model || typeof model !== "object") return false;
  const input = (model as { input?: unknown }).input;
  return Array.isArray(input) && input.includes("image");
}

function parseToolModeFlag(value: unknown): { mode: SessionToolMode; warning?: string } {
  if (value === undefined || value === null || String(value).trim() === "") return { mode: "auto" };
  const text = String(value).trim().toLowerCase();
  if (text === "auto" || isToolMode(text)) return { mode: text as SessionToolMode };
  return { mode: "auto", warning: `Invalid --tool-mode '${text}'. Expected auto, gemini, codex, deepseek, or pi. Using auto.` };
}

function parseToolSurfaceFlag(value: unknown): { surface: SessionToolSurface; warning?: string } {
  if (value === undefined || value === null || String(value).trim() === "") return { surface: "auto" };
  const text = String(value).trim().toLowerCase();
  if (text === "auto" || isToolSurface(text)) return { surface: text as SessionToolSurface };
  return { surface: "auto", warning: `Invalid --tool-surface '${text}'. Expected auto, replace, or additive. Using auto.` };
}

function parseLegacyApplyPatchMode(value: unknown): { mode?: ToolMode; surface?: ToolSurface; warning?: string } {
  if (value === undefined || value === null || String(value).trim() === "") return {};
  const text = String(value).trim().toLowerCase();
  if (text === "replace") return { mode: "codex", surface: "replace" };
  if (text === "additive") return { mode: "codex", surface: "additive" };
  if (text === "off") return { mode: "pi" };
  return { warning: `Invalid legacy apply_patch mode '${text}'. Expected replace, additive, or off; ignoring it.` };
}

function configuredToolNames(pi: ExtensionAPI): Set<string> {
  const names = new Set<string>();
  for (const tool of pi.getAllTools()) {
    if (tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string") {
      names.add((tool as { name: string }).name);
    }
  }
  return names;
}

function effectiveSessionOverride(cliMode: SessionToolMode, runtimeMode: SessionToolMode): SessionToolMode {
  return cliMode !== "auto" ? cliMode : runtimeMode;
}

function effectiveSurface(cliSurface: SessionToolSurface, runtimeSurface: SessionToolSurface, configured: ToolSurface): ToolSurface {
  if (cliSurface !== "auto") return cliSurface;
  if (runtimeSurface !== "auto") return runtimeSurface;
  return configured;
}

function surfaceLabel(surface: ManagedSurface): string {
  switch (surface) {
    case "pi": return "pi (edit/write)";
    case "codex-replace": return "codex / replace";
    case "codex-additive": return "codex / additive";
    case "gemini-replace": return "gemini / replace";
    case "gemini-additive": return "gemini / additive";
    case "deepseek-replace": return "deepseek / replace";
    case "deepseek-additive": return "deepseek / additive";
    case "codex-unavailable": return "pi fallback (codex unavailable)";
    case "gemini-unavailable": return "pi fallback (gemini unavailable)";
    case "deepseek-unavailable": return "pi fallback (deepseek unavailable)";
  }
}

export default function editModesExtension(pi: ExtensionAPI): void {
  pi.registerFlag("tool-mode", {
    description: "File tool mode: auto, gemini, codex, deepseek, or pi",
    type: "string",
  });
  pi.registerFlag("tool-surface", {
    description: "Custom file-tool surface: auto, replace, or additive",
    type: "string",
  });
  pi.registerFlag("apply-patch-mode", {
    description: "Deprecated: apply_patch surface replace, additive, or off",
    type: "string",
  });

  const toolModeFlag = pi.getFlag("tool-mode");
  const toolSurfaceFlag = pi.getFlag("tool-surface");
  const parsedCli = parseToolModeFlag(toolModeFlag);
  const parsedSurfaceCli = parseToolSurfaceFlag(toolSurfaceFlag);
  const newCliModeWasSpecified = toolModeFlag !== undefined && toolModeFlag !== null && String(toolModeFlag).trim() !== "";
  const newCliSurfaceWasSpecified = toolSurfaceFlag !== undefined && toolSurfaceFlag !== null && String(toolSurfaceFlag).trim() !== "";
  const legacyRaw = pi.getFlag("apply-patch-mode") ?? process.env.PI_APPLY_PATCH_TOOL_MODE;
  const legacy = !newCliModeWasSpecified && !newCliSurfaceWasSpecified ? parseLegacyApplyPatchMode(legacyRaw) : {};
  const cliSessionMode: SessionToolMode = parsedCli.mode !== "auto" ? parsedCli.mode : legacy.mode ?? "auto";
  const cliSessionSurface: SessionToolSurface = parsedSurfaceCli.surface !== "auto" ? parsedSurfaceCli.surface : legacy.surface ?? "auto";
  let runtimeSessionMode: SessionToolMode = "auto";
  let runtimeSessionSurface: SessionToolSurface = "auto";

  const store = new EditModesConfigStore(getAgentDir());
  let ownership = initialToolOwnership();
  let currentResolution: ModeResolution = { mode: "pi", source: "default", matchedBy: "startup" };
  let currentSurface: ManagedSurface = "pi";
  let currentSurfaceReason: string | undefined;
  const shownWarnings = new Set<string>();
  let filesystemToolFlavor: FilesystemToolFlavor = "pi";

  // Pi treats tool_call input as mutable and other extensions commonly special-case
  // the built-in names write/edit using Pi-native argument fields. Keep the DeepSeek
  // wire schema intact while publishing compatibility aliases to that hook chain.
  registerDeepSeekMutationCompatibilityHook(
    pi,
    () => currentResolution.mode === "deepseek" && filesystemToolFlavor === "deepseek",
  );

  const warn = (ctx: any, message: string): void => {
    if (!message || shownWarnings.has(message)) return;
    shownWarnings.add(message);
    if (ctx?.hasUI) ctx.ui.notify(message, "warning");
  };

  const setActiveToolsIfChanged = (next: string[]): void => {
    const current = pi.getActiveTools();
    if (!sameToolList(current, next)) pi.setActiveTools(next);
  };

  const setFilesystemToolFlavor = (next: FilesystemToolFlavor, cwd: string): boolean => {
    if (filesystemToolFlavor === next) return false;
    if (next === "deepseek") registerDeepSeekFilesystemTools(pi);
    else registerPiFilesystemTools(pi, cwd);
    filesystemToolFlavor = next;
    return true;
  };

  const syncTools = async (model: unknown, ctx?: any, forceRefresh = false): Promise<boolean> => {
    const snapshot = await store.refresh(forceRefresh);
    for (const message of snapshot.warnings) warn(ctx, message);
    const resolution = resolveMode({
      model: modelIdentity(model),
      settings: snapshot.settings,
      overrides: snapshot.overrides,
      sessionOverride: effectiveSessionOverride(cliSessionMode, runtimeSessionMode),
    });
    currentResolution = resolution;
    const deepseekPreset: DeepSeekPreset = snapshot.settings.deepseek.preset;
    const definitionsChanged = setFilesystemToolFlavor(
      resolution.mode === "deepseek" && deepseekPreset === "standard" ? "deepseek" : "pi",
      ctx?.cwd ?? process.cwd(),
    );
    const surface = effectiveSurface(cliSessionSurface, runtimeSessionSurface, snapshot.settings.surface);
    const available = configuredToolNames(pi);
    const codexSupport = getCodexApplyPatchSupport(model, available.has("apply_patch"));
    let transition = computeToolTransition({
      activeTools: pi.getActiveTools(),
      availableTools: available,
      desiredMode: resolution.mode,
      surface,
      codexSupported: codexSupport.supported,
      deepseekPreset,
      deepseekImageSupported: modelSupportsImages(model),
      ownership,
    });
    setActiveToolsIfChanged(transition.nextTools);

    // Defensive postcondition: if Pi rejected a configured custom tool name, recompute without it
    // rather than retaining ownership of edit/write based on an activation that did not stick.
    const active = pi.getActiveTools();
    if (resolution.mode === "codex" && codexSupport.supported && available.has("apply_patch") && !active.includes("apply_patch")) {
      transition = computeToolTransition({
        activeTools: active,
        availableTools: new Set([...available].filter((name) => name !== "apply_patch")),
        desiredMode: resolution.mode,
        surface,
        codexSupported: false,
        deepseekPreset,
        deepseekImageSupported: modelSupportsImages(model),
        ownership: transition.nextOwnership,
      });
      setActiveToolsIfChanged(transition.nextTools);
    } else if (resolution.mode === "gemini") {
      const configuredGemini = GEMINI_TOOL_NAMES.filter((name) => available.has(name));
      if (configuredGemini.length > 0 && !configuredGemini.some((name) => active.includes(name))) {
        const reduced = new Set([...available].filter((name) => !GEMINI_TOOL_NAMES.includes(name as any)));
        transition = computeToolTransition({
          activeTools: active,
          availableTools: reduced,
          desiredMode: resolution.mode,
          surface,
          codexSupported: codexSupport.supported,
          deepseekPreset,
          deepseekImageSupported: modelSupportsImages(model),
          ownership: transition.nextOwnership,
        });
        setActiveToolsIfChanged(transition.nextTools);
      }
    } else if (resolution.mode === "deepseek" && deepseekPreset === "minimal" && available.has("str_replace_editor") && !active.includes("str_replace_editor")) {
      const reduced = new Set([...available].filter((name) => !DEEPSEEK_TOOL_NAMES.includes(name as any)));
      transition = computeToolTransition({
        activeTools: active,
        availableTools: reduced,
        desiredMode: resolution.mode,
        surface,
        codexSupported: codexSupport.supported,
        deepseekPreset,
        deepseekImageSupported: modelSupportsImages(model),
        ownership: transition.nextOwnership,
      });
      setActiveToolsIfChanged(transition.nextTools);
    }

    ownership = transition.nextOwnership;
    currentSurface = transition.surface;
    if (transition.surface === "codex-unavailable") {
      currentSurfaceReason = codexSupport.reason ?? "apply_patch is unavailable under the current Pi/provider configuration";
    } else if (transition.surface === "gemini-unavailable") {
      currentSurfaceReason = "all Gemini file-edit tools are unavailable or excluded by Pi tool configuration";
    } else if (transition.surface === "deepseek-unavailable") {
      currentSurfaceReason = deepseekPreset === "minimal"
        ? "DeepSeek minimal preset requires str_replace_editor, but it is unavailable or excluded"
        : "DeepSeek standard preset requires read/write/edit, but one or more tools are unavailable";
    } else {
      currentSurfaceReason = undefined;
    }

    // If DeepSeek's requested surface could not be activated, restore Pi's own
    // read/write/edit definitions so the reported fallback is semantically true.
    if (currentSurface === "deepseek-unavailable" && filesystemToolFlavor === "deepseek") {
      setFilesystemToolFlavor("pi", ctx?.cwd ?? process.cwd());
      return true;
    }
    return definitionsChanged;
  };

  registerCodexApplyPatchTool(pi);
  registerDeepSeekTool(pi);
  registerDeepSeekReadImageTool(pi);
  registerGeminiTools(pi);

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (currentResolution.mode !== "gemini") return;
    if (event?.toolName !== "replace" && event?.toolName !== "write_file") return;
    if (store.snapshot().settings.gemini.approval === "auto_edit") return;
    const path = event?.input && typeof event.input === "object" && typeof event.input.file_path === "string"
      ? event.input.file_path
      : "(unknown path)";
    if (!ctx.hasUI) {
      return { block: true, reason: `Gemini ${event.toolName} requires user approval, but this session has no interactive UI.` };
    }
    const approved = await ctx.ui.confirm("Approve Gemini file edit", `${event.toolName} ${path}`);
    if (!approved) return { block: true, reason: `User rejected Gemini ${event.toolName} for ${path}.` };
  });

  pi.registerCommand("tool-mode", {
    description: "Show or change file tool mode",
    getArgumentCompletions: (prefix) => {
      const text = prefix.trim().toLowerCase();
      const values: SessionToolMode[] = ["auto", "gemini", "codex", "deepseek", "pi"];
      const matches = values.filter((value) => value.startsWith(text));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested) {
        if (requested !== "auto" && !isToolMode(requested)) {
          ctx.ui.notify(`Invalid tool mode '${requested}'. Expected auto, gemini, codex, deepseek, or pi.`, "error");
          return;
        }
        runtimeSessionMode = requested as SessionToolMode;
        await syncTools(ctx.model, ctx, true);
        const cliNote = cliSessionMode !== "auto" ? `; CLI override '${cliSessionMode}' still has precedence` : "";
        ctx.ui.notify(`Session tool mode: ${runtimeSessionMode}${cliNote}. Resolved: ${currentResolution.mode}; effective surface: ${surfaceLabel(currentSurface)}.`, "info");
        return;
      }

      await syncTools(ctx.model, ctx, true);
      const snapshot = store.snapshot();
      const result = await openSettingsDialog({
        ctx,
        modelLabel: modelLabel(ctx.model),
        resolution: currentResolution,
        effectiveSurface: surfaceLabel(currentSurface),
        effectiveReason: currentSurfaceReason,
        sessionMode: runtimeSessionMode,
        sessionSurface: runtimeSessionSurface,
        settings: snapshot.settings,
      });
      if (!result || result.action === "cancel") return;
      runtimeSessionMode = result.draft.sessionMode;
      runtimeSessionSurface = result.draft.sessionSurface;
      await store.save(result.draft.settings);
      await syncTools(ctx.model, ctx, true);
      const notes = [
        cliSessionMode !== "auto" ? `CLI mode '${cliSessionMode}' remains authoritative.` : "",
        cliSessionSurface !== "auto" ? `CLI surface '${cliSessionSurface}' remains authoritative.` : "",
      ].filter(Boolean).join(" ");
      ctx.ui.notify(`Saved edit-modes.json. Resolved mode: ${currentResolution.mode}; effective surface: ${surfaceLabel(currentSurface)}.${notes ? ` ${notes}` : ""}`, "info");
    },
  });

  pi.registerCommand("tool-surface", {
    description: "Show or change universal custom file-tool surface",
    getArgumentCompletions: (prefix) => {
      const text = prefix.trim().toLowerCase();
      const values: SessionToolSurface[] = ["auto", "replace", "additive"];
      const matches = values.filter((value) => value.startsWith(text));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!requested) {
        await syncTools(ctx.model, ctx, true);
        ctx.ui.notify(`Session tool surface: ${runtimeSessionSurface}. Effective surface: ${surfaceLabel(currentSurface)}.`, "info");
        return;
      }
      if (requested !== "auto" && !isToolSurface(requested)) {
        ctx.ui.notify(`Invalid tool surface '${requested}'. Expected auto, replace, or additive.`, "error");
        return;
      }
      runtimeSessionSurface = requested as SessionToolSurface;
      await syncTools(ctx.model, ctx, true);
      const cliNote = cliSessionSurface !== "auto" ? `; CLI override '${cliSessionSurface}' still has precedence` : "";
      ctx.ui.notify(`Session tool surface: ${runtimeSessionSurface}${cliNote}. Effective surface: ${surfaceLabel(currentSurface)}.`, "info");
    },
  });

  pi.registerCommand("apply-patch-mode", {
    description: "Deprecated alias for Codex mode plus universal tool surface",
    getArgumentCompletions: (prefix) => {
      const text = prefix.trim().toLowerCase();
      const values = ["replace", "additive", "off"] as const;
      const matches = values.filter((value) => value.startsWith(text));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!requested) {
        ctx.ui.notify(`Deprecated command. Resolved mode: ${currentResolution.mode}; effective surface: ${surfaceLabel(currentSurface)}; file tools: ${managedFileToolSurface(pi.getActiveTools())}. Use /tool-mode and /tool-surface.`, "info");
        return;
      }
      const parsed = parseLegacyApplyPatchMode(requested);
      if (!parsed.mode) {
        ctx.ui.notify(parsed.warning ?? `Invalid apply_patch mode '${requested}'.`, "error");
        return;
      }
      runtimeSessionMode = parsed.mode;
      runtimeSessionSurface = parsed.surface ?? "auto";
      await syncTools(ctx.model, ctx, true);
      ctx.ui.notify(`Deprecated apply_patch mode '${requested}' mapped to ${parsed.mode}${parsed.surface ? `/${parsed.surface}` : ""}.`, "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (parsedCli.warning) warn(ctx, parsedCli.warning);
    if (parsedSurfaceCli.warning) warn(ctx, parsedSurfaceCli.warning);
    if (legacy.warning) warn(ctx, legacy.warning);
    if (legacy.mode) warn(ctx, "--apply-patch-mode / PI_APPLY_PATCH_TOOL_MODE is deprecated; use --tool-mode, --tool-surface, and edit-modes.json.");
    await syncTools(ctx.model, ctx, true);
  });

  pi.on("model_select", async (event, ctx) => {
    await syncTools(event.model, ctx, false);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await syncTools(ctx.model, ctx, false);
    // Tool definitions can change while names stay identical (Pi read/write/edit
    // -> DeepSeek Harness-compatible read/write/edit). Always compare the rebuilt
    // prompt, not just the active tool-name list.
    const rebuilt = ctx.getSystemPrompt();
    if (rebuilt !== event.systemPrompt) return { systemPrompt: rebuilt };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const activeTools = pi.getActiveTools();
    const support = getCodexApplyPatchSupport(ctx.model, codexProviderToolAvailable(currentSurface, activeTools));
    const guarded = guardProviderPayload({
      payload: event.payload,
      mode: currentResolution.mode,
      codexSupport: support,
      codexGuard: guardCodexProviderPayload,
      activeTools,
      surface: currentSurface,
      deepseekPreset: store.snapshot().settings.deepseek.preset,
    });
    if (guarded.violation && ctx.hasUI) ctx.ui.notify(guarded.violation, guarded.fatal ? "error" : "warning");
    if (guarded.fatal) throw new Error(guarded.violation ?? "File-tool provider serialization invariant violated");
    if (guarded.changed) return guarded.payload;
  });

  pi.on("session_shutdown", () => {
    if (filesystemToolFlavor === "deepseek") {
      registerPiFilesystemTools(pi, process.cwd());
      filesystemToolFlavor = "pi";
    } else {
      clearDeepSeekFsRuntimes();
    }
    const available = configuredToolNames(pi);
    const transition = computeToolTransition({
      activeTools: pi.getActiveTools(),
      availableTools: available,
      desiredMode: "pi",
      surface: "replace",
      codexSupported: false,
      deepseekPreset: store.snapshot().settings.deepseek.preset,
      ownership,
    });
    setActiveToolsIfChanged(transition.nextTools);
    ownership = transition.nextOwnership;
  });
}
