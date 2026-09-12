# Hooks and extension API

`pi-edit-modes` exposes a small plugin host so other Pi extensions can customize its behavior without replacing its tools or patching Pi internals.

The hook host is optional. If nobody registers a plugin, `pi-edit-modes` behaves normally.

## Discovery

The hook service is shared through Pi's extension event bus:

- query: `pi.edit-modes.hooks.query.v1`
- state: `pi.edit-modes.hooks.state.v1`

The service shape is exported from `pi-edit-modes/hooks`:

```ts
interface EditModesHookService {
  protocol: "pi.edit-modes.hooks";
  version: 1;
  use(plugin: EditModesPlugin): () => void;
  list(): ReadonlyArray<{ id: string; priority: number }>;
}
```

Discovery is load-order safe when consumers listen for the state event first and then emit the query event. The host also announces itself when it loads, so consumers loaded earlier can receive it.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EditModesHookService } from "pi-edit-modes/hooks";

const QUERY = "pi.edit-modes.hooks.query.v1";
const STATE = "pi.edit-modes.hooks.state.v1";

export default function myExtension(pi: ExtensionAPI) {
  let dispose: (() => void) | undefined;

  pi.events.on(STATE, (value: unknown) => {
    const service = value as EditModesHookService;
    if (service?.protocol !== "pi.edit-modes.hooks" || service.version !== 1) return;

    dispose?.();
    dispose = service.use({
      id: "my-extension",
      priority: 100,
      async aroundToolExecute(context, next) {
        // Inspect context.metadata, params, cwd, signal, etc.
        return await next();
      },
    });
  });

  pi.events.emit(QUERY, { requester: "my-extension" });
}
```

## Plugin hooks

A plugin can implement any subset of these hooks.

### `aroundToolExecute(context, next)`

Koa-style async middleware around every tool definition managed by `pi-edit-modes`. Higher priority plugins are outermost and run first. `next()` may be called at most once.

The context contains:

```ts
{
  metadata: {
    name: string;
    provider: "pi" | "codex" | "gemini" | "deepseek";
    capabilities: ("filesystem:read" | "filesystem:write" | "filesystem:image-read")[];
    tags?: string[];
  };
  toolCallId: string;
  params: unknown;
  signal?: AbortSignal;
  onUpdate: unknown;
  ctx: PiToolContext;
}
```

Typical uses include locking, tracing, auditing, metrics, approval layers, transactional wrappers, policy checks, result transformation, or experimental tool behavior.

### `decorateTool(context)`

Synchronously decorate a managed tool definition before Pi receives it. This can change descriptions, parameter schemas, renderers, `executionMode`, `prepareArguments`, or `execute`.

The tool name must remain unchanged because mode routing depends on stable names.

Decorators are also applied when registered after tool initialization: the hook host rebuilds its currently managed definitions immediately. Removing the plugin via its disposer rebuilds them again without that decorator.

### `beforeModeResolve(context)`

Runs before the built-in resolver. It may override:

```ts
{
  sessionMode?: "auto" | "pi" | "codex" | "gemini" | "deepseek";
  sessionSurface?: "auto" | "replace" | "additive";
}
```

The hook receives model identity and the current parsed settings as read-only input by convention.

### `afterModeResolve(context)`

Runs after the built-in resolver and may override the final `ModeResolution` and `ToolSurface` before tool routing is applied.

### `onModeChanged(context)`

Notification after the effective mode/surface changes.

### `onToolsChanged(context)`

Notification after the active tool roster changes.

## Priorities and replacement

Plugins are identified by `id`. Registering another plugin with the same `id` replaces the previous registration. Higher numeric `priority` values run first; equal priorities preserve registration order.

`use()` returns a disposer. A stale disposer does not remove a newer plugin that reused the same id.

## Managed tool metadata

Current managed tool families expose capability metadata so policy extensions do not need to hard-code every provider tool name:

- Pi `read`: `filesystem:read`
- Pi `write`: `filesystem:write`
- Pi `edit`: `filesystem:read`, `filesystem:write`
- Codex `apply_patch`: `filesystem:read`, `filesystem:write`
- Gemini `replace` / `write_file`: mutation capabilities
- DeepSeek `read`: `filesystem:read`
- DeepSeek `read_image`: `filesystem:read`, `filesystem:image-read`
- DeepSeek `write` / `edit`: mutation capabilities
- DeepSeek `str_replace_editor`: both read and write because its command determines whether a particular invocation mutates

Consumers may inspect `params` when a mixed-capability tool needs per-command classification.

## Scope

These hooks cover tools owned or re-registered by `pi-edit-modes`. They do not intercept arbitrary tools owned by unrelated Pi extensions. Those extensions can use Pi's own events or expose their own hook/middleware APIs.
