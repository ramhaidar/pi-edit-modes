import type { DeepSeekPreset, ToolMode } from "../config/types.ts";
import { DEEPSEEK_TOOL_NAMES, DEPRECATED_GEMINI_TOOL_NAMES, GEMINI_TOOL_NAMES, type ManagedSurface } from "./router.ts";

export interface ProviderGuardResult { payload: unknown; changed: boolean; violation?: string; fatal?: boolean }

export interface CodexProviderSupport {
  supported: boolean;
  transport?: "native" | "compatibility";
}

export type CodexProviderGuard = (payload: unknown, support: any) => ProviderGuardResult;

export function codexProviderToolAvailable(surface: ManagedSurface, activeTools: readonly string[]): boolean {
  return (surface === "codex-replace" || surface === "codex-additive") && activeTools.includes("apply_patch");
}

const APPLY_PATCH_COMPAT_DESCRIPTION =
  "Apply a Codex-style patch. Pass the raw `*** Begin Patch` / `*** End Patch` patch text verbatim in the `input` string.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wireName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  if (typeof tool.name === "string") return tool.name;
  if (isRecord(tool.function) && typeof tool.function.name === "string") return tool.function.name;
  if (isRecord(tool.custom) && typeof tool.custom.name === "string") return tool.custom.name;
  return undefined;
}

function choiceForces(choice: unknown, name: string): boolean {
  if (choice === name) return true;
  if (!isRecord(choice)) return false;
  if (choice.type === name || choice.name === name) return true;
  if (isRecord(choice.function) && choice.function.name === name) return true;
  if (isRecord(choice.custom) && choice.custom.name === name) return true;
  return false;
}

function forcedName(payload: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    if (choiceForces(payload.tool_choice, name) || choiceForces(payload.toolChoice, name)) return name;
  }
  return undefined;
}

function choiceRequiresSomeTool(choice: unknown): boolean {
  if (typeof choice === "string") {
    const normalized = choice.toLowerCase();
    return normalized === "required" || normalized === "any";
  }
  if (!isRecord(choice) || typeof choice.type !== "string") return false;
  const normalized = choice.type.toLowerCase();
  return normalized === "required" || normalized === "any";
}

function topLevelChoiceRequiresSomeTool(payload: Record<string, unknown>): boolean {
  return choiceRequiresSomeTool(payload.tool_choice) || choiceRequiresSomeTool(payload.toolChoice);
}

function stripTopLevelTools(
  payload: Record<string, unknown>,
  forbidden: ReadonlySet<string>,
): { payload: Record<string, unknown>; changed: boolean; fatal?: string } {
  if (!Array.isArray(payload.tools)) return { payload, changed: false };
  const nextTools = payload.tools.filter((tool) => !forbidden.has(wireName(tool) ?? ""));
  if (nextTools.length === payload.tools.length) return { payload, changed: false };
  if (nextTools.length === 0 && topLevelChoiceRequiresSomeTool(payload)) {
    return {
      payload: { ...payload, tools: nextTools },
      changed: true,
      fatal: "Provider request requires a tool call but filtering removed every callable tool.",
    };
  }
  return { payload: { ...payload, tools: nextTools }, changed: true };
}

function stripGoogleToolConfig(config: Record<string, unknown>, forbidden: ReadonlySet<string>): { config: Record<string, unknown>; changed: boolean; fatal?: string } {
  if (!isRecord(config.toolConfig) || !isRecord(config.toolConfig.functionCallingConfig)) return { config, changed: false };
  const functionCallingConfig = config.toolConfig.functionCallingConfig;
  if (!Array.isArray(functionCallingConfig.allowedFunctionNames)) return { config, changed: false };

  const names = functionCallingConfig.allowedFunctionNames.filter((name): name is string => typeof name === "string");
  const nextNames = names.filter((name) => !forbidden.has(name));
  if (nextNames.length === names.length) return { config, changed: false };

  const mode = typeof functionCallingConfig.mode === "string" ? functionCallingConfig.mode.toUpperCase() : undefined;
  if (mode === "ANY" && names.length > 0 && nextNames.length === 0) {
    return { config, changed: false, fatal: "Google provider request forces a function call but only forbidden file-edit tools are allowed." };
  }

  return {
    config: {
      ...config,
      toolConfig: {
        ...config.toolConfig,
        functionCallingConfig: { ...functionCallingConfig, allowedFunctionNames: nextNames },
      },
    },
    changed: true,
  };
}

function googleFunctionCallingMode(config: Record<string, unknown>): string | undefined {
  if (!isRecord(config.toolConfig) || !isRecord(config.toolConfig.functionCallingConfig)) return undefined;
  const mode = config.toolConfig.functionCallingConfig.mode;
  return typeof mode === "string" ? mode.toUpperCase() : undefined;
}

function googleCallableFunctionCount(config: Record<string, unknown>): number {
  if (!Array.isArray(config.tools)) return 0;
  let count = 0;
  for (const toolGroup of config.tools) {
    if (!isRecord(toolGroup) || !Array.isArray(toolGroup.functionDeclarations)) continue;
    count += toolGroup.functionDeclarations.length;
  }
  return count;
}

function stripGoogleTools(payload: Record<string, unknown>, forbidden: ReadonlySet<string>): { payload: Record<string, unknown>; changed: boolean; fatal?: string } {
  if (!isRecord(payload.config)) return { payload, changed: false };
  let config = payload.config;
  let changed = false;

  if (Array.isArray(config.tools)) {
    let toolsChanged = false;
    const nextTools: unknown[] = [];
    for (const toolGroup of config.tools) {
      if (!isRecord(toolGroup) || !Array.isArray(toolGroup.functionDeclarations)) {
        nextTools.push(toolGroup);
        continue;
      }
      const nextDeclarations = toolGroup.functionDeclarations.filter((declaration) => !forbidden.has(wireName(declaration) ?? ""));
      if (nextDeclarations.length === toolGroup.functionDeclarations.length) {
        nextTools.push(toolGroup);
        continue;
      }
      toolsChanged = true;
      const remainingKeys = Object.keys(toolGroup).filter((key) => key !== "functionDeclarations");
      if (nextDeclarations.length > 0 || remainingKeys.length > 0) {
        nextTools.push({ ...toolGroup, functionDeclarations: nextDeclarations });
      }
    }
    if (toolsChanged) {
      config = { ...config, tools: nextTools };
      changed = true;
    }
  }

  const toolConfigResult = stripGoogleToolConfig(config, forbidden);
  if (toolConfigResult.fatal) return { payload, changed, fatal: toolConfigResult.fatal };
  if (toolConfigResult.changed) {
    config = toolConfigResult.config;
    changed = true;
  }

  if (changed && googleFunctionCallingMode(config) === "ANY" && googleCallableFunctionCount(config) === 0) {
    return {
      payload: { ...payload, config },
      changed: true,
      fatal: "Google provider request requires a function call but filtering removed every function declaration.",
    };
  }
  return changed ? { payload: { ...payload, config }, changed: true } : { payload, changed: false };
}

function stripTools(payload: unknown, forbidden: ReadonlySet<string>): ProviderGuardResult {
  if (!isRecord(payload)) return { payload, changed: false };
  const forced = forcedName(payload, [...forbidden]);
  if (forced) return { payload, changed: false, fatal: true, violation: `Provider request forces forbidden tool '${forced}'.` };

  const top = stripTopLevelTools(payload, forbidden);
  if (top.fatal) return { payload: top.payload, changed: top.changed, fatal: true, violation: top.fatal };
  const google = stripGoogleTools(top.payload, forbidden);
  if (google.fatal) return { payload: google.payload, changed: top.changed || google.changed, fatal: true, violation: google.fatal };
  const changed = top.changed || google.changed;
  return {
    payload: google.payload,
    changed,
    violation: changed ? "Removed stale file-edit tools from provider payload." : undefined,
  };
}

function googleApplyPatchDeclarations(payload: unknown): Array<Record<string, unknown>> {
  if (!isRecord(payload) || !isRecord(payload.config) || !Array.isArray(payload.config.tools)) return [];
  const entries: Array<Record<string, unknown>> = [];
  for (const toolGroup of payload.config.tools) {
    if (!isRecord(toolGroup) || !Array.isArray(toolGroup.functionDeclarations)) continue;
    for (const declaration of toolGroup.functionDeclarations) {
      if (isRecord(declaration) && wireName(declaration) === "apply_patch") entries.push(declaration);
    }
  }
  return entries;
}

function googleFunctionParameters(declaration: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(declaration.parametersJsonSchema)) return declaration.parametersJsonSchema;
  if (isRecord(declaration.parameters)) return declaration.parameters;
  if (isRecord(declaration.inputSchema)) return declaration.inputSchema;
  if (isRecord(declaration.input_schema)) return declaration.input_schema;
  return undefined;
}


/**
 * Base model-facing schemas from DeepSeek Harness dsh-tool-fs.
 *
 * The registered Pi tools use an internal strict superset so prepareArguments can
 * publish Pi-native aliases before third-party tool_call guards run. These wire
 * schemas are restored immediately before serialization to the provider.
 * sandbox_permissions/justification are intentionally absent: upstream only adds
 * those fields when the active filesystem sandbox exposes an escalation API, and
 * this Pi backend currently exposes no such capability.
 */
export const DEEPSEEK_WRITE_WIRE_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path to write, resolved by the filesystem backend." },
    content: { type: "string", description: "Full UTF-8 text content to write." },
  },
  required: ["file_path", "content"],
  additionalProperties: false,
} as const;

export const DEEPSEEK_EDIT_WIRE_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path to edit, resolved by the filesystem backend." },
    old_string: { type: "string", description: "Literal text to replace. Must match exactly." },
    new_string: { type: "string", description: "Literal replacement text. Use an empty string to delete the match." },
    replace_all: { type: "boolean", description: "Replace all matches. Defaults to false; when false, old_string must appear exactly once." },
  },
  required: ["file_path", "old_string", "new_string"],
  additionalProperties: false,
} as const;

function deepCloneSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(schema);
}

function replaceSchemaField(
  owner: Record<string, unknown>,
  schema: Record<string, unknown>,
  fields: readonly string[],
): { owner: Record<string, unknown>; changed: boolean } {
  for (const field of fields) {
    if (Object.hasOwn(owner, field)) {
      return { owner: { ...owner, [field]: deepCloneSchema(schema) }, changed: true };
    }
  }
  return { owner, changed: false };
}

function rewriteDeepSeekToolSchema(tool: unknown): { tool: unknown; changed: boolean } {
  if (!isRecord(tool)) return { tool, changed: false };
  const name = wireName(tool);
  const schema = name === "write"
    ? DEEPSEEK_WRITE_WIRE_SCHEMA as unknown as Record<string, unknown>
    : name === "edit"
      ? DEEPSEEK_EDIT_WIRE_SCHEMA as unknown as Record<string, unknown>
      : undefined;
  if (!schema) return { tool, changed: false };

  // OpenAI-compatible function tool.
  if (isRecord(tool.function)) {
    const replaced = replaceSchemaField(tool.function, schema, ["parameters", "parametersJsonSchema", "inputSchema", "input_schema"]);
    // Current OpenAI-compatible serializers use `parameters`; if a minimal test or
    // provider shim omitted the field, install it rather than leaking internal aliases.
    const fn = replaced.changed ? replaced.owner : { ...tool.function, parameters: deepCloneSchema(schema) };
    return { tool: { ...tool, function: fn }, changed: true };
  }

  // Anthropic, Google declarations and generic Pi serializer shapes.
  const replaced = replaceSchemaField(tool, schema, ["input_schema", "parametersJsonSchema", "parameters", "inputSchema"]);
  if (replaced.changed) return { tool: replaced.owner, changed: true };

  // A named function declaration with no schema should still get the Harness
  // schema; this also keeps test doubles representative of the real wire payload.
  return { tool: { ...tool, parameters: deepCloneSchema(schema) }, changed: true };
}

function rewriteDeepSeekFileToolSchemas(payload: unknown): ProviderGuardResult {
  if (!isRecord(payload)) return { payload, changed: false };
  let changed = false;
  let nextPayload = payload;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.map((tool) => {
      const rewritten = rewriteDeepSeekToolSchema(tool);
      changed ||= rewritten.changed;
      return rewritten.tool;
    });
    if (changed) nextPayload = { ...nextPayload, tools };
  }

  if (isRecord(nextPayload.config) && Array.isArray(nextPayload.config.tools)) {
    let googleChanged = false;
    const groups = nextPayload.config.tools.map((group) => {
      if (!isRecord(group) || !Array.isArray(group.functionDeclarations)) return group;
      const declarations = group.functionDeclarations.map((tool) => {
        const rewritten = rewriteDeepSeekToolSchema(tool);
        googleChanged ||= rewritten.changed;
        return rewritten.tool;
      });
      return googleChanged ? { ...group, functionDeclarations: declarations } : group;
    });
    if (googleChanged) {
      changed = true;
      nextPayload = { ...nextPayload, config: { ...nextPayload.config, tools: groups } };
    }
  }

  return { payload: nextPayload, changed };
}

function googleApplyPatchIsCompatibilityFunction(declaration: Record<string, unknown>): boolean {
  const parameters = googleFunctionParameters(declaration);
  if (!parameters || parameters.type !== "object") return false;
  if (!isRecord(parameters.properties) || !isRecord(parameters.properties.input)) return false;
  if (parameters.properties.input.type !== "string") return false;
  if (!Array.isArray(parameters.required) || !parameters.required.includes("input")) return false;
  if (parameters.additionalProperties === true) return false;
  return true;
}

function rewriteGoogleCompatibilityApplyPatch(payload: unknown, support: CodexProviderSupport): ProviderGuardResult {
  if (!isRecord(payload)) return { payload, changed: false };
  const entries = googleApplyPatchDeclarations(payload);
  if (entries.length === 0) return { payload, changed: false };

  if (!support.supported) return stripTools(payload, new Set(["apply_patch"]));
  if (support.transport !== "compatibility") {
    return {
      payload,
      changed: false,
      fatal: true,
      violation: "apply_patch native serialization invariant violated: Google functionDeclarations cannot carry the native Codex grammar tool",
    };
  }
  if (entries.some((entry) => !googleApplyPatchIsCompatibilityFunction(entry))) {
    return {
      payload,
      changed: false,
      fatal: true,
      violation: "apply_patch compatibility serialization invariant violated: expected a Google functionDeclaration with one required string `input` parameter",
    };
  }

  const config = payload.config as Record<string, unknown>;
  const nextTools = (config.tools as unknown[]).map((toolGroup) => {
    if (!isRecord(toolGroup) || !Array.isArray(toolGroup.functionDeclarations)) return toolGroup;
    const declarations = toolGroup.functionDeclarations.map((declaration) => {
      if (!isRecord(declaration) || wireName(declaration) !== "apply_patch") return declaration;
      if (declaration.description === APPLY_PATCH_COMPAT_DESCRIPTION) return declaration;
      return { ...declaration, description: APPLY_PATCH_COMPAT_DESCRIPTION };
    });
    return { ...toolGroup, functionDeclarations: declarations };
  });
  return { payload: { ...payload, config: { ...config, tools: nextTools } }, changed: true };
}


const DEEPSEEK_SHELL_EDIT_GUIDANCE =
  " In DeepSeek file-edit mode, do not create, overwrite, append, patch, or rewrite files with this shell tool (including redirection, PowerShell Set-Content/WriteAllLines, sed -i, perl -pi, or scripts that write files). Use the write, edit, or str_replace_editor file tools for file mutations. Shell use is limited to inspection and command execution that does not modify files.";
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "powershell", "pwsh"]);

function appendDeepSeekShellGuidance(tool: unknown): { tool: unknown; changed: boolean } {
  if (!isRecord(tool)) return { tool, changed: false };
  const name = wireName(tool);
  if (!name || !SHELL_TOOL_NAMES.has(name)) return { tool, changed: false };

  if (isRecord(tool.function)) {
    const description = typeof tool.function.description === "string" ? tool.function.description : "";
    if (description.includes(DEEPSEEK_SHELL_EDIT_GUIDANCE.trim())) return { tool, changed: false };
    return {
      tool: { ...tool, function: { ...tool.function, description: `${description}${DEEPSEEK_SHELL_EDIT_GUIDANCE}`.trim() } },
      changed: true,
    };
  }

  const description = typeof tool.description === "string" ? tool.description : "";
  if (description.includes(DEEPSEEK_SHELL_EDIT_GUIDANCE.trim())) return { tool, changed: false };
  return { tool: { ...tool, description: `${description}${DEEPSEEK_SHELL_EDIT_GUIDANCE}`.trim() }, changed: true };
}

function guardDeepSeekShellDescriptions(payload: unknown): ProviderGuardResult {
  if (!isRecord(payload)) return { payload, changed: false };
  let changed = false;
  let nextPayload = payload;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.map((tool) => {
      const guarded = appendDeepSeekShellGuidance(tool);
      changed ||= guarded.changed;
      return guarded.tool;
    });
    if (changed) nextPayload = { ...nextPayload, tools };
  }

  if (isRecord(nextPayload.config) && Array.isArray(nextPayload.config.tools)) {
    let googleChanged = false;
    const groups = nextPayload.config.tools.map((group) => {
      if (!isRecord(group) || !Array.isArray(group.functionDeclarations)) return group;
      const declarations = group.functionDeclarations.map((tool) => {
        const guarded = appendDeepSeekShellGuidance(tool);
        googleChanged ||= guarded.changed;
        return guarded.tool;
      });
      return googleChanged ? { ...group, functionDeclarations: declarations } : group;
    });
    if (googleChanged) {
      changed = true;
      nextPayload = { ...nextPayload, config: { ...nextPayload.config, tools: groups } };
    }
  }

  return { payload: nextPayload, changed };
}

function mergeGuardResults(first: ProviderGuardResult, second: ProviderGuardResult): ProviderGuardResult {
  return {
    payload: second.payload,
    changed: first.changed || second.changed,
    violation: second.violation ?? first.violation,
    fatal: second.fatal ?? first.fatal,
  };
}

export function guardProviderPayload(input: {
  payload: unknown;
  mode: ToolMode;
  codexSupport: CodexProviderSupport;
  codexGuard: CodexProviderGuard;
  activeTools?: readonly string[];
  surface?: ManagedSurface;
  deepseekPreset?: DeepSeekPreset;
}): ProviderGuardResult {
  const strictSurface = input.surface?.endsWith("-replace") === true;
  const deprecatedGemini = new Set<string>(DEPRECATED_GEMINI_TOOL_NAMES);
  if (input.mode === "codex") {
    const otherCustomTools = new Set<string>([...GEMINI_TOOL_NAMES, ...DEEPSEEK_TOOL_NAMES, ...DEPRECATED_GEMINI_TOOL_NAMES]);
    if (strictSurface) {
      otherCustomTools.add("edit");
      otherCustomTools.add("write");
    }
    const stripped = stripTools(input.payload, otherCustomTools);
    if (stripped.fatal) return stripped;

    // Keep the original Codex guard authoritative for OpenAI/Anthropic top-level wire shapes.
    const codex = input.codexGuard(stripped.payload, input.codexSupport);
    const combined = mergeGuardResults(stripped, codex);
    if (combined.fatal) return combined;

    // Pi's native Google serializer nests function declarations under config.tools[].
    const google = rewriteGoogleCompatibilityApplyPatch(combined.payload, input.codexSupport);
    return mergeGuardResults(combined, google);
  }

  const forbidden = new Set<string>(["apply_patch", ...deprecatedGemini]);
  if (input.mode === "pi") {
    for (const name of GEMINI_TOOL_NAMES) forbidden.add(name);
    for (const name of DEEPSEEK_TOOL_NAMES) forbidden.add(name);
  } else if (input.mode === "gemini") {
    for (const name of DEEPSEEK_TOOL_NAMES) forbidden.add(name);
    if (strictSurface) {
      forbidden.add("edit");
      forbidden.add("write");
    }
    if (input.activeTools) for (const name of GEMINI_TOOL_NAMES) if (!input.activeTools.includes(name)) forbidden.add(name);
  } else if (input.mode === "deepseek") {
    for (const name of GEMINI_TOOL_NAMES) forbidden.add(name);
    const preset = input.deepseekPreset ?? "standard";
    if (strictSurface && preset === "standard") forbidden.add("str_replace_editor");
    if (strictSurface && preset === "minimal") {
      forbidden.add("read");
      forbidden.add("write");
      forbidden.add("edit");
      forbidden.add("read_image");
    }
    if (input.activeTools) for (const name of DEEPSEEK_TOOL_NAMES) if (!input.activeTools.includes(name)) forbidden.add(name);
  }
  const stripped = stripTools(input.payload, forbidden);
  if (stripped.fatal || input.mode !== "deepseek") return stripped;

  // Internal Pi validation accepts compatibility aliases for write/edit so
  // mutation guards written for Pi's native tools cannot crash on DeepSeek args.
  // Never expose those aliases to the model: restore the exact Harness schemas on
  // every provider request.
  const schemas = rewriteDeepSeekFileToolSchemas(stripped.payload);
  let combined = mergeGuardResults(stripped, schemas);
  if (!input.activeTools?.includes("str_replace_editor")) return combined;
  return mergeGuardResults(combined, guardDeepSeekShellDescriptions(combined.payload));
}
