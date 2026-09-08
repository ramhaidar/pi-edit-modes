import type { DeepSeekPreset, ToolMode, ToolSurface } from "../config/types.ts";

export const GEMINI_TOOL_NAMES = ["replace", "write_file"] as const;
export const DEEPSEEK_TOOL_NAMES = ["str_replace_editor", "read_image"] as const;
export const DEPRECATED_GEMINI_TOOL_NAMES = [
  "replace_file_content",
  "multi_replace_file_content",
  "write_to_file",
] as const;
export const MANAGED_CUSTOM_TOOLS = [
  "apply_patch",
  ...GEMINI_TOOL_NAMES,
  ...DEEPSEEK_TOOL_NAMES,
  ...DEPRECATED_GEMINI_TOOL_NAMES,
] as const;

export type ManagedSurface =
  | "pi"
  | "codex-replace"
  | "codex-additive"
  | "gemini-replace"
  | "gemini-additive"
  | "deepseek-replace"
  | "deepseek-additive"
  | "codex-unavailable"
  | "gemini-unavailable"
  | "deepseek-unavailable";

export interface ToolOwnership {
  surface: ManagedSurface;
  suppressesNative: boolean;
  readRemovedByUs: boolean;
  editRemovedByUs: boolean;
  writeRemovedByUs: boolean;
  readRestoreIndex?: number;
  editRestoreIndex?: number;
  writeRestoreIndex?: number;
}

export function initialToolOwnership(): ToolOwnership {
  return {
    surface: "pi",
    suppressesNative: false,
    readRemovedByUs: false,
    editRemovedByUs: false,
    writeRemovedByUs: false,
  };
}

function insertAt(tools: string[], name: string, index?: number): void {
  if (tools.includes(name)) return;
  const target = index === undefined ? tools.length : Math.max(0, Math.min(index, tools.length));
  tools.splice(target, 0, name);
}

function restoreNative(
  tools: string[],
  ownership: ToolOwnership,
  available: ReadonlySet<string>,
): void {
  const candidates = [
    { name: "read", owned: ownership.readRemovedByUs, index: ownership.readRestoreIndex },
    { name: "edit", owned: ownership.editRemovedByUs, index: ownership.editRestoreIndex },
    { name: "write", owned: ownership.writeRemovedByUs, index: ownership.writeRestoreIndex },
  ].filter((item) => item.owned && !tools.includes(item.name) && available.has(item.name));
  candidates.sort(
    (a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER),
  );
  for (const item of candidates) insertAt(tools, item.name, item.index);
  ownership.readRemovedByUs = false;
  ownership.editRemovedByUs = false;
  ownership.writeRemovedByUs = false;
  ownership.readRestoreIndex = undefined;
  ownership.editRestoreIndex = undefined;
  ownership.writeRestoreIndex = undefined;
  ownership.suppressesNative = false;
}

function removeManagedCustomTools(tools: string[]): string[] {
  const managed = new Set<string>(MANAGED_CUSTOM_TOOLS);
  return tools.filter((name) => !managed.has(name));
}

export interface TransitionInput {
  activeTools: string[];
  availableTools: ReadonlySet<string>;
  desiredMode: ToolMode;
  surface: ToolSurface;
  codexSupported: boolean;
  deepseekPreset?: DeepSeekPreset;
  deepseekImageSupported?: boolean;
  ownership: ToolOwnership;
}

export interface TransitionResult {
  nextTools: string[];
  nextOwnership: ToolOwnership;
  surface: ManagedSurface;
}

export function computeToolTransition(input: TransitionInput): TransitionResult {
  let tools = [...input.activeTools];
  const ownership: ToolOwnership = { ...input.ownership };

  tools = removeManagedCustomTools(tools);

  const availableGemini = GEMINI_TOOL_NAMES.filter((name) => input.availableTools.has(name));
  const codexActive =
    input.desiredMode === "codex" &&
    input.codexSupported &&
    input.availableTools.has("apply_patch");
  const geminiActive = input.desiredMode === "gemini" && availableGemini.length > 0;
  const deepseekPreset = input.deepseekPreset ?? "standard";
  const deepseekStandardAvailable = ["read", "write", "edit"].every((name) =>
    input.availableTools.has(name),
  );
  const deepseekMinimalAvailable = input.availableTools.has("str_replace_editor");
  const deepseekActive =
    input.desiredMode === "deepseek" &&
    (deepseekPreset === "minimal" ? deepseekMinimalAvailable : deepseekStandardAvailable);
  const suppressEditWrite = (codexActive || geminiActive) && input.surface === "replace";
  const suppressDeepSeekMinimal =
    deepseekActive && deepseekPreset === "minimal" && input.surface === "replace";
  const suppressNative = suppressEditWrite || suppressDeepSeekMinimal;

  if (!suppressNative) {
    restoreNative(tools, ownership, input.availableTools);
  } else {
    // Strict/replace surfaces are authoritative. If another extension reactivates
    // a forbidden native file tool, the next synchronization removes it again;
    // before_provider_request independently enforces the same invariant on wire.
    const readIndex = tools.indexOf("read");
    const editIndex = tools.indexOf("edit");
    const writeIndex = tools.indexOf("write");
    if (suppressDeepSeekMinimal && readIndex !== -1 && !ownership.readRemovedByUs) {
      ownership.readRemovedByUs = true;
      ownership.readRestoreIndex = readIndex;
    }
    if (editIndex !== -1 && !ownership.editRemovedByUs) {
      ownership.editRemovedByUs = true;
      ownership.editRestoreIndex = editIndex;
    }
    if (writeIndex !== -1 && !ownership.writeRemovedByUs) {
      ownership.writeRemovedByUs = true;
      ownership.writeRestoreIndex = writeIndex;
    }
    tools = tools.filter((name) => {
      if (name === "edit" || name === "write") return false;
      if (suppressDeepSeekMinimal && name === "read") return false;
      return true;
    });
    ownership.suppressesNative = true;
  }

  let surface: ManagedSurface;
  if (input.desiredMode === "pi") {
    surface = "pi";
  } else if (input.desiredMode === "codex") {
    if (!codexActive) {
      surface = "codex-unavailable";
    } else {
      if (!tools.includes("apply_patch")) tools.push("apply_patch");
      surface = input.surface === "additive" ? "codex-additive" : "codex-replace";
    }
  } else if (input.desiredMode === "gemini") {
    if (!geminiActive) {
      surface = "gemini-unavailable";
    } else {
      for (const name of availableGemini) if (!tools.includes(name)) tools.push(name);
      surface = input.surface === "additive" ? "gemini-additive" : "gemini-replace";
    }
  } else if (!deepseekActive) {
    surface = "deepseek-unavailable";
  } else {
    if (deepseekPreset === "minimal") {
      if (!tools.includes("str_replace_editor")) tools.push("str_replace_editor");
    } else {
      for (const name of ["read", "write", "edit"] as const)
        if (!tools.includes(name)) tools.push(name);
      if (
        input.deepseekImageSupported &&
        input.availableTools.has("read_image") &&
        !tools.includes("read_image")
      )
        tools.push("read_image");
      if (
        input.surface === "additive" &&
        input.availableTools.has("str_replace_editor") &&
        !tools.includes("str_replace_editor")
      )
        tools.push("str_replace_editor");
    }
    surface = input.surface === "additive" ? "deepseek-additive" : "deepseek-replace";
  }

  ownership.surface = surface;
  return { nextTools: tools, nextOwnership: ownership, surface };
}

export function sameToolList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

export function managedFileToolSurface(activeTools: readonly string[]): string {
  const relevant = ["read", "edit", "write", ...MANAGED_CUSTOM_TOOLS].filter((name) =>
    activeTools.includes(name),
  );
  return relevant.length ? relevant.join(", ") : "(none)";
}
