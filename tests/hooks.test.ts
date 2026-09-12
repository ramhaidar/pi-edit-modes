import test from "node:test";
import assert from "node:assert/strict";
import {
  createEditModesHookHost,
  EDIT_MODES_HOOKS_QUERY,
  EDIT_MODES_HOOKS_STATE,
  type EditModesHookService,
} from "../src/hooks.ts";

function fakePi() {
  const tools = new Map<string, any>();
  const listeners = new Map<string, Array<(value?: unknown) => void>>();
  return {
    tools,
    api: {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      events: {
        on(name: string, handler: (value?: unknown) => void) {
          const list = listeners.get(name) ?? [];
          list.push(handler);
          listeners.set(name, list);
        },
        emit(name: string, value?: unknown) {
          for (const handler of listeners.get(name) ?? []) handler(value);
        },
      },
    } as any,
  };
}

const metadata = {
  name: "write_file",
  provider: "gemini" as const,
  capabilities: ["filesystem:write" as const],
  tags: ["mutation"],
};

function fakeManagedTool(execute: (...args: any[]) => Promise<any>, description = "test tool") {
  return {
    name: "write_file",
    label: "write_file",
    description,
    parameters: {} as any,
    execute,
  };
}

test("standalone hook host preserves normal tool execution", async () => {
  const { api, tools } = fakePi();
  const host = createEditModesHookHost(api);
  host.registerTool(
    metadata,
    fakeManagedTool(async (_id: string, params: any) => `raw:${params.value}`),
  );

  assert.equal(await tools.get("write_file").execute("1", { value: "ok" }), "raw:ok");
  assert.deepEqual(host.service.list(), []);
});

test("aroundToolExecute composes by priority and sees managed metadata", async () => {
  const { api, tools } = fakePi();
  const host = createEditModesHookHost(api);
  const calls: string[] = [];

  host.service.use({
    id: "low",
    priority: 10,
    async aroundToolExecute(context, next) {
      calls.push(`low-before:${context.metadata.provider}:${context.metadata.name}`);
      const result = await next();
      calls.push("low-after");
      return `${result}:low`;
    },
  });
  host.service.use({
    id: "high",
    priority: 100,
    async aroundToolExecute(_context, next) {
      calls.push("high-before");
      const result = await next();
      calls.push("high-after");
      return `${result}:high`;
    },
  });

  host.registerTool(
    metadata,
    fakeManagedTool(async () => {
      calls.push("tool");
      return "result";
    }),
  );

  assert.equal(
    await tools.get("write_file").execute("1", {}, undefined, undefined, { cwd: "." }),
    "result:low:high",
  );
  assert.deepEqual(calls, [
    "high-before",
    "low-before:gemini:write_file",
    "tool",
    "low-after",
    "high-after",
  ]);
});

test("late tool decorators rebuild managed definitions and disposer restores them", () => {
  const { api, tools } = fakePi();
  const host = createEditModesHookHost(api);
  host.registerTool(
    metadata,
    fakeManagedTool(async () => "ok", "base"),
  );
  assert.equal(tools.get("write_file").description, "base");

  const dispose = host.service.use({
    id: "decorate",
    decorateTool({ definition }) {
      return { ...definition, description: `${definition.description}:decorated` };
    },
  });
  assert.equal(tools.get("write_file").description, "base:decorated");

  dispose();
  assert.equal(tools.get("write_file").description, "base");
});

test("mode hooks can override resolution inputs/results and receive lifecycle notifications", async () => {
  const { api } = fakePi();
  const host = createEditModesHookHost(api);
  const seen: string[] = [];
  host.service.use({
    id: "mode-policy",
    beforeModeResolve() {
      return { sessionMode: "codex", sessionSurface: "additive" };
    },
    afterModeResolve(context) {
      return { resolution: { ...context.resolution, mode: "gemini" }, surface: "replace" };
    },
    onModeChanged(context) {
      seen.push(`${context.previousResolution.mode}->${context.resolution.mode}`);
    },
    onToolsChanged(context) {
      seen.push(`${context.previous.join(",")}=>${context.current.join(",")}`);
    },
  });

  const before = await host.beforeModeResolve({
    model: { provider: "x", id: "y" },
    settings: {
      version: 1,
      defaultMode: "pi",
      surface: "replace",
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
    },
    sessionMode: "auto",
    sessionSurface: "auto",
  });
  assert.equal(before.sessionMode, "codex");
  assert.equal(before.sessionSurface, "additive");

  const after = await host.afterModeResolve({
    model: { provider: "x", id: "y" },
    settings: before.settings,
    resolution: { mode: "codex", source: "session" },
    surface: "additive",
  });
  assert.equal(after.resolution.mode, "gemini");
  assert.equal(after.surface, "replace");

  await host.notifyModeChanged({
    previousResolution: { mode: "pi", source: "default" },
    resolution: { mode: "gemini", source: "session" },
    previousSurface: "pi",
    surface: "gemini-replace",
  });
  await host.notifyToolsChanged({ previous: ["read", "edit"], current: ["read", "replace"] });
  assert.deepEqual(seen, ["pi->gemini", "read,edit=>read,replace"]);
});

test("hook service discovery is load-order safe from the consumer side", () => {
  const { api } = fakePi();
  let discovered: EditModesHookService | undefined;
  api.events.on(EDIT_MODES_HOOKS_STATE, (value: unknown) => {
    discovered = value as EditModesHookService;
  });
  createEditModesHookHost(api);
  assert.equal(discovered?.protocol, "pi.edit-modes.hooks");

  discovered = undefined;
  api.events.emit(EDIT_MODES_HOOKS_QUERY, { requester: "late-consumer" });
  const rediscovered = discovered as EditModesHookService | undefined;
  assert.equal(rediscovered?.version, 1);
});

test("hook hosts are extension-instance scoped", async () => {
  const a = fakePi();
  const b = fakePi();
  const hostA = createEditModesHookHost(a.api);
  const hostB = createEditModesHookHost(b.api);
  hostA.service.use({
    id: "only-a",
    async aroundToolExecute(_context, next) {
      return `A:${await next()}`;
    },
  });
  hostA.registerTool(
    metadata,
    fakeManagedTool(async () => "ok"),
  );
  hostB.registerTool(
    metadata,
    fakeManagedTool(async () => "ok"),
  );
  assert.equal(await a.tools.get("write_file").execute("1", {}, undefined, undefined, {}), "A:ok");
  assert.equal(await b.tools.get("write_file").execute("1", {}, undefined, undefined, {}), "ok");
});
