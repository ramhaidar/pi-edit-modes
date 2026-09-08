import test from "node:test";
import assert from "node:assert/strict";
import {
  codexProviderToolAvailable,
  guardProviderPayload,
  type ProviderGuardResult,
} from "../src/modes/provider-guard.ts";
import { getGeminiToolContract } from "../src/tools/gemini/upstream-parity.ts";

const compatibilitySupport = { supported: true, transport: "compatibility" as const };
const unavailableSupport = { supported: false };
const passthroughCodexGuard = (payload: unknown): ProviderGuardResult => ({
  payload,
  changed: false,
});

function declaration(name: string, description = `${name} description`) {
  const properties =
    name === "apply_patch"
      ? { input: { type: "string" } }
      : name === "replace"
        ? {
            file_path: { type: "string", description: "stale" },
            instruction: { type: "string", description: "stale" },
            old_string: { type: "string", description: "stale" },
            new_string: { type: "string", description: "stale" },
            allow_multiple: { type: "boolean", description: "stale" },
          }
        : name === "write_file"
          ? {
              file_path: { type: "string", description: "stale" },
              content: { type: "string", description: "stale" },
            }
          : {};
  const required =
    name === "apply_patch"
      ? ["input"]
      : name === "replace"
        ? ["file_path", "instruction", "old_string", "new_string"]
        : name === "write_file"
          ? ["file_path", "content"]
          : [];
  return {
    name,
    description,
    parametersJsonSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

test("Codex provider availability follows effective active surface, not registered-tool availability", () => {
  assert.equal(codexProviderToolAvailable("codex-replace", ["apply_patch"]), true);
  assert.equal(
    codexProviderToolAvailable("codex-additive", ["edit", "write", "apply_patch"]),
    true,
  );
  assert.equal(codexProviderToolAvailable("codex-unavailable", ["apply_patch"]), false);
  assert.equal(codexProviderToolAvailable("codex-replace", ["edit", "write"]), false);
  assert.equal(codexProviderToolAvailable("gemini-replace", ["apply_patch"]), false);
});

test("Gemini mode removes stale apply_patch from native Google functionDeclarations", () => {
  const payload = {
    model: "gemini-x",
    config: {
      tools: [{ functionDeclarations: [declaration("replace"), declaration("apply_patch")] }],
    },
  };
  const result = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
    activeTools: ["replace"],
  });
  assert.equal(result.changed, true);
  const names = (result.payload as any).config.tools[0].functionDeclarations.map(
    (x: any) => x.name,
  );
  assert.deepEqual(names, ["replace"]);
});

test("Gemini provider descriptions follow the active model family", () => {
  const payload = {
    config: {
      tools: [
        {
          functionDeclarations: [
            declaration("replace", "stale"),
            declaration("write_file", "stale"),
          ],
        },
      ],
    },
  };
  const gemini3 = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
    activeTools: ["replace", "write_file"],
    modelId: "gemini-3-pro",
  });
  const gemini3Declarations = (gemini3.payload as any).config.tools[0].functionDeclarations;
  const gemini3Contract = getGeminiToolContract("gemini-3-pro");
  assert.equal(gemini3Declarations[0].description, gemini3Contract.replace.description);
  assert.equal(gemini3Declarations[1].description, gemini3Contract.write_file.description);
  assert.equal(
    gemini3Declarations[0].parametersJsonSchema.properties.new_string.description,
    gemini3Contract.replace.parameters.new_string,
  );
  assert.equal(
    gemini3Declarations[1].parametersJsonSchema.properties.content.description,
    gemini3Contract.write_file.parameters.content,
  );

  const legacy = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
    activeTools: ["replace", "write_file"],
    modelId: "gemini-2.5-pro",
  });
  const legacyDeclarations = (legacy.payload as any).config.tools[0].functionDeclarations;
  const legacyContract = getGeminiToolContract("gemini-2.5-pro");
  assert.equal(legacyDeclarations[0].description, legacyContract.replace.description);
  assert.equal(legacyDeclarations[1].description, legacyContract.write_file.description);
  assert.equal(
    legacyDeclarations[0].parametersJsonSchema.properties.old_string.description,
    legacyContract.replace.parameters.old_string,
  );
  assert.notEqual(legacyDeclarations[0].description, gemini3Declarations[0].description);
});

test("Codex mode rewrites Google apply_patch compatibility description", () => {
  const payload = {
    model: "gemini-x",
    config: {
      tools: [{ functionDeclarations: [declaration("apply_patch", "freeform description")] }],
    },
  };
  const result = guardProviderPayload({
    payload,
    mode: "codex",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
  });
  assert.equal(result.changed, true);
  const description = (result.payload as any).config.tools[0].functionDeclarations[0].description;
  assert.match(description, /raw `\*\*\* Begin Patch`/);
  assert.match(description, /`input` string/);
});

test("Codex unavailable removes apply_patch from Google wire payload", () => {
  const payload = {
    config: {
      tools: [{ functionDeclarations: [declaration("apply_patch"), declaration("other")] }],
    },
  };
  const result = guardProviderPayload({
    payload,
    mode: "codex",
    codexSupport: unavailableSupport,
    codexGuard: passthroughCodexGuard,
  });
  assert.equal(result.changed, true);
  assert.deepEqual(
    (result.payload as any).config.tools[0].functionDeclarations.map((x: any) => x.name),
    ["other"],
  );
});

test("Google allowedFunctionNames is pruned with forbidden tools", () => {
  const payload = {
    config: {
      tools: [{ functionDeclarations: [declaration("replace"), declaration("apply_patch")] }],
      toolConfig: {
        functionCallingConfig: { mode: "AUTO", allowedFunctionNames: ["replace", "apply_patch"] },
      },
    },
  };
  const result = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
    activeTools: ["replace"],
  });
  assert.deepEqual(
    (result.payload as any).config.toolConfig.functionCallingConfig.allowedFunctionNames,
    ["replace"],
  );
});

test("Google ANY with only forbidden allowed functions fails closed", () => {
  const payload = {
    config: {
      tools: [{ functionDeclarations: [declaration("apply_patch")] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["apply_patch"] } },
    },
  };
  const result = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
    activeTools: [],
  });
  assert.equal(result.fatal, true);
});

test("Google ANY without allowedFunctionNames fails closed when filtering removes every declaration", () => {
  const payload = {
    config: {
      tools: [{ functionDeclarations: [declaration("apply_patch")] }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    },
  };
  const result = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
    activeTools: [],
  });
  assert.equal(result.fatal, true);
  assert.deepEqual((result.payload as any).config.tools, []);
});

test("Google ANY remains valid when another callable declaration survives filtering", () => {
  const payload = {
    config: {
      tools: [{ functionDeclarations: [declaration("apply_patch"), declaration("other")] }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    },
  };
  const result = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
    activeTools: [],
  });
  assert.equal(result.fatal, undefined);
  assert.deepEqual(
    (result.payload as any).config.tools[0].functionDeclarations.map((x: any) => x.name),
    ["other"],
  );
});

test("top-level required tool choice fails closed when filtering removes every tool", () => {
  const payload = {
    tools: [{ type: "function", function: { name: "apply_patch" } }],
    tool_choice: "required",
  };
  const result = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
    activeTools: [],
  });
  assert.equal(result.fatal, true);
  assert.deepEqual((result.payload as any).tools, []);
});

test("top-level required tool choice remains valid when another tool survives filtering", () => {
  const payload = {
    tools: [
      { type: "function", function: { name: "apply_patch" } },
      { type: "function", function: { name: "other" } },
    ],
    tool_choice: "required",
  };
  const result = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: compatibilitySupport,
    codexGuard: passthroughCodexGuard,
    activeTools: [],
  });
  assert.equal(result.fatal, undefined);
  assert.deepEqual(
    (result.payload as any).tools.map((tool: any) => tool.function.name),
    ["other"],
  );
});

test("top-level OpenAI/Anthropic-style stale tools are still removed", () => {
  const payload = {
    tools: [{ name: "apply_patch" }, { name: "replace" }, { name: "replace_file_content" }],
  };
  const result = guardProviderPayload({
    payload,
    mode: "pi",
    codexSupport: unavailableSupport,
    codexGuard: passthroughCodexGuard,
  });
  assert.deepEqual((result.payload as any).tools, []);
});

test("DeepSeek standard strict surface removes Codex/Gemini/minimal editor tools", () => {
  const payload = {
    tools: [
      { type: "function", function: { name: "apply_patch" } },
      { type: "function", function: { name: "replace" } },
      { type: "function", function: { name: "str_replace_editor" } },
      { type: "function", function: { name: "read" } },
      { type: "function", function: { name: "edit" } },
      { type: "function", function: { name: "write" } },
    ],
  };
  const result = guardProviderPayload({
    payload,
    mode: "deepseek",
    codexSupport: { supported: false },
    codexGuard: (value) => ({ payload: value, changed: false }),
    activeTools: ["read", "edit", "write"],
    surface: "deepseek-replace",
    deepseekPreset: "standard",
  });
  const names = (result.payload as any).tools.map((tool: any) => tool.function.name);
  assert.deepEqual(names, ["read", "edit", "write"]);
});

test("Gemini strict surface is final wire authority over externally reactivated edit/write", () => {
  const payload = {
    tools: [
      { type: "function", function: { name: "edit" } },
      { type: "function", function: { name: "write" } },
      { type: "function", function: { name: "replace" } },
      { type: "function", function: { name: "write_file" } },
    ],
  };
  const result = guardProviderPayload({
    payload,
    mode: "gemini",
    codexSupport: unavailableSupport,
    codexGuard: passthroughCodexGuard,
    activeTools: ["edit", "write", "replace", "write_file"],
    surface: "gemini-replace",
  });
  assert.deepEqual(
    (result.payload as any).tools.map((tool: any) => tool.function.name),
    ["replace", "write_file"],
  );
});

test("DeepSeek minimal strict surface exposes only str_replace_editor from filesystem families", () => {
  const payload = {
    tools: [
      { type: "function", function: { name: "read" } },
      { type: "function", function: { name: "read_image" } },
      { type: "function", function: { name: "edit" } },
      { type: "function", function: { name: "write" } },
      { type: "function", function: { name: "str_replace_editor" } },
    ],
  };
  const result = guardProviderPayload({
    payload,
    mode: "deepseek",
    codexSupport: unavailableSupport,
    codexGuard: passthroughCodexGuard,
    activeTools: ["str_replace_editor"],
    surface: "deepseek-replace",
    deepseekPreset: "minimal",
  });
  assert.deepEqual(
    (result.payload as any).tools.map((tool: any) => tool.function.name),
    ["str_replace_editor"],
  );
});

test("Codex mode removes stale DeepSeek editor", () => {
  const payload = {
    tools: [
      { type: "function", function: { name: "str_replace_editor" } },
      { type: "function", function: { name: "read" } },
    ],
  };
  const result = guardProviderPayload({
    payload,
    mode: "codex",
    codexSupport: { supported: false },
    codexGuard: (value) => ({ payload: value, changed: false }),
    activeTools: ["read"],
  });
  const names = (result.payload as any).tools.map((tool: any) => tool.function.name);
  assert.deepEqual(names, ["read"]);
});

test("DeepSeek minimal shell guidance mentions only str_replace_editor", () => {
  const payload = {
    tools: [
      { type: "function", function: { name: "bash", description: "Run a shell command" } },
      { type: "function", function: { name: "str_replace_editor", description: "Edit files" } },
    ],
  };
  const result = guardProviderPayload({
    payload,
    mode: "deepseek",
    codexSupport: { supported: false },
    codexGuard: passthroughCodexGuard,
    activeTools: ["bash", "str_replace_editor"],
  });
  assert.equal(result.changed, true);
  const bash = (result.payload as any).tools.find((tool: any) => tool.function.name === "bash");
  assert.match(bash.function.description, /Use str_replace_editor for file mutations/);
  assert.doesNotMatch(bash.function.description, /Use write|Use edit/);
  assert.match(bash.function.description, /WriteAllLines/);
});

test("DeepSeek shell guard is not applied when no DeepSeek mutation tool is active", () => {
  const payload = {
    tools: [{ type: "function", function: { name: "bash", description: "Run a shell command" } }],
  };
  const result = guardProviderPayload({
    payload,
    mode: "deepseek",
    codexSupport: { supported: false },
    codexGuard: passthroughCodexGuard,
    activeTools: ["bash"],
  });
  assert.equal(result.changed, false);
  assert.equal((result.payload as any).tools[0].function.description, "Run a shell command");
});

test("DeepSeek standard shell guidance mentions only write/edit", () => {
  const payload = {
    tools: [
      { type: "function", function: { name: "bash", description: "Run a shell command" } },
      { type: "function", function: { name: "write", description: "Write files" } },
      { type: "function", function: { name: "edit", description: "Edit files" } },
    ],
  };
  const result = guardProviderPayload({
    payload,
    mode: "deepseek",
    codexSupport: { supported: false },
    codexGuard: passthroughCodexGuard,
    activeTools: ["bash", "write", "edit"],
  });
  const bash = (result.payload as any).tools.find((tool: any) => tool.function.name === "bash");
  assert.match(bash.function.description, /Use write or edit for file mutations/);
  assert.doesNotMatch(bash.function.description, /str_replace_editor/);
});

test("DeepSeek additive shell guidance mentions every active mutation tool", () => {
  const payload = {
    tools: [
      { type: "function", function: { name: "bash", description: "Run a shell command" } },
      { type: "function", function: { name: "write", description: "Write files" } },
      { type: "function", function: { name: "edit", description: "Edit files" } },
      { type: "function", function: { name: "str_replace_editor", description: "Edit files" } },
    ],
  };
  const result = guardProviderPayload({
    payload,
    mode: "deepseek",
    codexSupport: { supported: false },
    codexGuard: passthroughCodexGuard,
    activeTools: ["bash", "write", "edit", "str_replace_editor"],
  });
  const bash = (result.payload as any).tools.find((tool: any) => tool.function.name === "bash");
  assert.match(
    bash.function.description,
    /Use write, edit, or str_replace_editor for file mutations/,
  );
});

test("DeepSeek OpenAI wire write/edit schemas hide Pi compatibility aliases", () => {
  const payload = {
    tools: [
      {
        type: "function",
        function: {
          name: "write",
          parameters: {
            type: "object",
            properties: { file_path: {}, content: {}, path: {} },
            required: ["file_path", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "edit",
          parameters: {
            type: "object",
            properties: { file_path: {}, old_string: {}, new_string: {}, path: {}, edits: {} },
            required: ["file_path", "old_string", "new_string"],
          },
        },
      },
    ],
  };
  const result = guardProviderPayload({
    payload,
    mode: "deepseek",
    codexSupport: unavailableSupport,
    codexGuard: passthroughCodexGuard,
    activeTools: ["write", "edit"],
  });
  const [write, edit] = (result.payload as any).tools.map((x: any) => x.function.parameters);
  assert.deepEqual(Object.keys(write.properties), ["file_path", "content"]);
  assert.deepEqual(write.required, ["file_path", "content"]);
  assert.equal(write.additionalProperties, false);
  assert.deepEqual(Object.keys(edit.properties), [
    "file_path",
    "old_string",
    "new_string",
    "replace_all",
  ]);
  assert.deepEqual(edit.required, ["file_path", "old_string", "new_string"]);
  assert.equal(edit.additionalProperties, false);
});

test("DeepSeek Google wire write/edit schemas hide Pi compatibility aliases", () => {
  const payload = {
    config: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "write",
              parametersJsonSchema: { type: "object", properties: { path: {}, content: {} } },
            },
            {
              name: "edit",
              parametersJsonSchema: { type: "object", properties: { path: {}, edits: {} } },
            },
          ],
        },
      ],
    },
  };
  const result = guardProviderPayload({
    payload,
    mode: "deepseek",
    codexSupport: unavailableSupport,
    codexGuard: passthroughCodexGuard,
    activeTools: ["write", "edit"],
  });
  const [write, edit] = (result.payload as any).config.tools[0].functionDeclarations.map(
    (x: any) => x.parametersJsonSchema,
  );
  assert.deepEqual(Object.keys(write.properties), ["file_path", "content"]);
  assert.deepEqual(Object.keys(edit.properties), [
    "file_path",
    "old_string",
    "new_string",
    "replace_all",
  ]);
});

test("DeepSeek Anthropic wire write/edit schemas hide Pi compatibility aliases", () => {
  const payload = {
    tools: [
      { name: "write", input_schema: { type: "object", properties: { path: {}, content: {} } } },
      { name: "edit", input_schema: { type: "object", properties: { path: {}, edits: {} } } },
    ],
  };
  const result = guardProviderPayload({
    payload,
    mode: "deepseek",
    codexSupport: unavailableSupport,
    codexGuard: passthroughCodexGuard,
    activeTools: ["write", "edit"],
  });
  const [write, edit] = (result.payload as any).tools.map((x: any) => x.input_schema);
  assert.deepEqual(Object.keys(write.properties), ["file_path", "content"]);
  assert.deepEqual(Object.keys(edit.properties), [
    "file_path",
    "old_string",
    "new_string",
    "replace_all",
  ]);
});
