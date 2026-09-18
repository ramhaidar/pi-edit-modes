import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
export type EditModesHookToolMode = "pi" | "codex" | "gemini" | "deepseek";
export type EditModesHookSessionToolMode = EditModesHookToolMode | "auto";
export type EditModesHookToolSurface = "replace" | "additive";
export type EditModesHookSessionToolSurface = EditModesHookToolSurface | "auto";
export interface EditModesHookModelIdentity {
  provider?: string;
  id?: string;
  name?: string;
}
export interface EditModesHookSettings {
  version: 1;
  defaultMode: EditModesHookToolMode;
  surface: EditModesHookToolSurface;
  bashOnly: boolean;
  autoDiscovery: { enabled: boolean; gemini: boolean; codex: boolean; deepseek: boolean };
  gemini: {
    approval: "ask_user" | "auto_edit";
    disableLLMCorrection: boolean;
    fileFiltering: {
      respectGitIgnore: boolean;
      respectGeminiIgnore: boolean;
      customIgnoreFilePaths: string[];
    };
  };
  deepseek: { preset: "standard" | "minimal" };
}
export interface EditModesHookModeResolution {
  mode: EditModesHookToolMode;
  source: "session" | "models.json" | "auto-gemini" | "auto-codex" | "auto-deepseek" | "default";
  matchedBy?: string;
}

export const EDIT_MODES_HOOKS_QUERY = "pi.edit-modes.hooks.query.v1";
export const EDIT_MODES_HOOKS_STATE = "pi.edit-modes.hooks.state.v1";

export type EditModesProvider = "pi" | "codex" | "gemini" | "deepseek";
export type EditModesToolCapability =
  "filesystem:read" | "filesystem:write" | "filesystem:image-read";

export interface EditModesManagedToolMetadata {
  name: string;
  provider: EditModesProvider;
  capabilities: readonly EditModesToolCapability[];
  tags?: readonly string[];
}

export interface EditModesToolExecutionContext {
  metadata: EditModesManagedToolMetadata;
  toolCallId: string;
  params: unknown;
  signal: AbortSignal | undefined;
  onUpdate: unknown;
  ctx: any;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface EditModesToolDecorationContext {
  metadata: EditModesManagedToolMetadata;
  definition: AnyToolDefinition;
}

export interface EditModesBeforeModeResolveContext {
  model: EditModesHookModelIdentity;
  settings: EditModesHookSettings;
  sessionMode: EditModesHookSessionToolMode;
  sessionSurface: EditModesHookSessionToolSurface;
  sessionBashOnly: boolean | "auto";
}

export interface EditModesBeforeModeResolveResult {
  sessionMode?: EditModesHookSessionToolMode;
  sessionSurface?: EditModesHookSessionToolSurface;
  sessionBashOnly?: boolean | "auto";
}

export interface EditModesAfterModeResolveContext {
  model: EditModesHookModelIdentity;
  settings: EditModesHookSettings;
  resolution: EditModesHookModeResolution;
  surface: EditModesHookToolSurface;
  bashOnly: boolean;
}

export interface EditModesAfterModeResolveResult {
  resolution?: EditModesHookModeResolution;
  surface?: EditModesHookToolSurface;
  bashOnly?: boolean;
}

export interface EditModesModeChangedContext {
  previousResolution: EditModesHookModeResolution;
  resolution: EditModesHookModeResolution;
  previousSurface: string;
  surface: string;
}

export interface EditModesToolsChangedContext {
  previous: readonly string[];
  current: readonly string[];
}

export interface EditModesPlugin {
  id: string;
  priority?: number;
  /**
   * Synchronous tool-definition decorator. It may change schema, descriptions,
   * rendering, executionMode, or execute, but it must preserve the tool name.
   */
  decorateTool?(context: EditModesToolDecorationContext): AnyToolDefinition | void;
  /** Koa-style async middleware around every pi-edit-modes managed tool execution. */
  aroundToolExecute?(
    context: EditModesToolExecutionContext,
    next: () => Promise<any>,
  ): Promise<any>;
  beforeModeResolve?(
    context: EditModesBeforeModeResolveContext,
  ): Promise<EditModesBeforeModeResolveResult | void> | EditModesBeforeModeResolveResult | void;
  afterModeResolve?(
    context: EditModesAfterModeResolveContext,
  ): Promise<EditModesAfterModeResolveResult | void> | EditModesAfterModeResolveResult | void;
  onModeChanged?(context: EditModesModeChangedContext): Promise<void> | void;
  onToolsChanged?(context: EditModesToolsChangedContext): Promise<void> | void;
}

export interface EditModesHookService {
  protocol: "pi.edit-modes.hooks";
  version: 1;
  /** Register or replace a plugin by id. Returns a disposer for that registration. */
  use(plugin: EditModesPlugin): () => void;
  list(): ReadonlyArray<{ id: string; priority: number }>;
}

export interface EditModesHookHost {
  service: EditModesHookService;
  registerTool<TParams extends TSchema, TDetails = unknown, TState = any>(
    metadata: EditModesManagedToolMetadata,
    definition: ToolDefinition<TParams, TDetails, TState>,
  ): void;
  beforeModeResolve(
    context: EditModesBeforeModeResolveContext,
  ): Promise<EditModesBeforeModeResolveContext>;
  afterModeResolve(
    context: EditModesAfterModeResolveContext,
  ): Promise<EditModesAfterModeResolveContext>;
  notifyModeChanged(context: EditModesModeChangedContext): Promise<void>;
  notifyToolsChanged(context: EditModesToolsChangedContext): Promise<void>;
}

interface PluginRecord {
  plugin: EditModesPlugin;
  sequence: number;
}

interface ManagedToolRecord {
  metadata: EditModesManagedToolMetadata;
  definition: AnyToolDefinition;
}

function priorityOf(plugin: EditModesPlugin): number {
  return Number.isFinite(plugin.priority) ? Number(plugin.priority) : 0;
}

function cloneMetadata(metadata: EditModesManagedToolMetadata): EditModesManagedToolMetadata {
  return {
    ...metadata,
    capabilities: [...metadata.capabilities],
    tags: metadata.tags ? [...metadata.tags] : undefined,
  };
}

export function createEditModesHookHost(pi: ExtensionAPI): EditModesHookHost {
  const plugins = new Map<string, PluginRecord>();
  const managedTools = new Map<string, ManagedToolRecord>();
  let sequence = 0;

  const orderedPlugins = (): PluginRecord[] =>
    [...plugins.values()].sort((a, b) => {
      const priority = priorityOf(b.plugin) - priorityOf(a.plugin);
      return priority !== 0 ? priority : a.sequence - b.sequence;
    });

  const rebuildTool = (name: string): void => {
    const record = managedTools.get(name);
    if (!record) return;
    let definition = { ...record.definition };
    const originalName = definition.name;

    for (const { plugin } of orderedPlugins()) {
      if (!plugin.decorateTool) continue;
      const decorated = plugin.decorateTool({
        metadata: cloneMetadata(record.metadata),
        definition,
      });
      if (decorated !== undefined) definition = decorated;
      if (!definition || typeof definition !== "object") {
        throw new Error(
          `pi-edit-modes hook '${plugin.id}' returned an invalid tool definition for '${name}'`,
        );
      }
      if (definition.name !== originalName) {
        throw new Error(
          `pi-edit-modes hook '${plugin.id}' attempted to rename managed tool '${originalName}' to '${String(definition.name)}'`,
        );
      }
    }

    const decoratedExecute = definition.execute?.bind(definition) as
      | ((
          ...args: Parameters<AnyToolDefinition["execute"]>
        ) => ReturnType<AnyToolDefinition["execute"]>)
      | undefined;
    if (typeof decoratedExecute !== "function") {
      throw new Error(`Managed tool '${name}' has no execute() after hook decoration`);
    }

    definition = {
      ...definition,
      async execute(...args: Parameters<AnyToolDefinition["execute"]>) {
        const executionContext: EditModesToolExecutionContext = {
          metadata: cloneMetadata(record.metadata),
          toolCallId: String(args[0] ?? ""),
          params: args[1],
          signal: args[2] as AbortSignal | undefined,
          onUpdate: args[3],
          ctx: args[4],
        };
        const middleware = orderedPlugins().filter(({ plugin }) => plugin.aroundToolExecute);

        const dispatch = async (index: number): Promise<any> => {
          if (index >= middleware.length) return await decoratedExecute(...args);
          const { plugin } = middleware[index]!;
          let called = false;
          return await plugin.aroundToolExecute!(executionContext, async () => {
            if (called) {
              throw new Error(`pi-edit-modes hook '${plugin.id}' called next() more than once`);
            }
            called = true;
            return await dispatch(index + 1);
          });
        };

        return await dispatch(0);
      },
    };

    pi.registerTool(definition);
  };

  const rebuildAllTools = (): void => {
    for (const name of managedTools.keys()) rebuildTool(name);
  };

  const service: EditModesHookService = {
    protocol: "pi.edit-modes.hooks",
    version: 1,
    use(plugin) {
      if (
        !plugin ||
        typeof plugin !== "object" ||
        typeof plugin.id !== "string" ||
        !plugin.id.trim()
      ) {
        throw new Error("pi-edit-modes hook plugins require a non-empty id");
      }
      const record: PluginRecord = { plugin, sequence: sequence++ };
      plugins.set(plugin.id, record);
      rebuildAllTools();
      return () => {
        if (plugins.get(plugin.id) !== record) return;
        plugins.delete(plugin.id);
        rebuildAllTools();
      };
    },
    list() {
      return orderedPlugins().map(({ plugin }) => ({
        id: plugin.id,
        priority: priorityOf(plugin),
      }));
    },
  };

  const events = (pi as any).events;
  if (events && typeof events.on === "function" && typeof events.emit === "function") {
    const announce = (): void => events.emit(EDIT_MODES_HOOKS_STATE, service);
    events.on(EDIT_MODES_HOOKS_QUERY, announce);
    announce();
  }

  return {
    service,
    registerTool(metadata, definition) {
      if (!definition || typeof definition !== "object" || typeof definition.name !== "string") {
        throw new Error("pi-edit-modes managed tool definitions require a string name");
      }
      if (metadata.name !== definition.name) {
        throw new Error(
          `Managed tool metadata name '${metadata.name}' does not match definition name '${definition.name}'`,
        );
      }
      managedTools.set(definition.name, {
        metadata: cloneMetadata(metadata),
        definition,
      });
      rebuildTool(definition.name);
    },
    async beforeModeResolve(context) {
      let current = { ...context };
      for (const { plugin } of orderedPlugins()) {
        if (!plugin.beforeModeResolve) continue;
        const result = await plugin.beforeModeResolve(current);
        if (!result) continue;
        current = {
          ...current,
          sessionMode: result.sessionMode ?? current.sessionMode,
          sessionSurface: result.sessionSurface ?? current.sessionSurface,
          sessionBashOnly: result.sessionBashOnly ?? current.sessionBashOnly,
        };
      }
      return current;
    },
    async afterModeResolve(context) {
      let current = { ...context };
      for (const { plugin } of orderedPlugins()) {
        if (!plugin.afterModeResolve) continue;
        const result = await plugin.afterModeResolve(current);
        if (!result) continue;
        current = {
          ...current,
          resolution: result.resolution ?? current.resolution,
          surface: result.surface ?? current.surface,
          bashOnly: result.bashOnly ?? current.bashOnly,
        };
      }
      return current;
    },
    async notifyModeChanged(context) {
      for (const { plugin } of orderedPlugins()) await plugin.onModeChanged?.(context);
    },
    async notifyToolsChanged(context) {
      for (const { plugin } of orderedPlugins()) await plugin.onToolsChanged?.(context);
    },
  };
}

/** Register through the hook host when present, otherwise preserve legacy direct registration. */
export function registerManagedTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  pi: ExtensionAPI,
  hooks: EditModesHookHost | undefined,
  metadata: EditModesManagedToolMetadata,
  definition: ToolDefinition<TParams, TDetails, TState>,
): void {
  if (hooks) hooks.registerTool(metadata, definition);
  else pi.registerTool(definition);
}
