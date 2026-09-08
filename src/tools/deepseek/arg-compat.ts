export interface DeepSeekWriteArgs {
  file_path?: unknown;
  path?: unknown;
  content?: unknown;
}

export interface DeepSeekEditArgs {
  file_path?: unknown;
  path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
  oldText?: unknown;
  newText?: unknown;
  edits?: unknown;
}

export interface NormalizedDeepSeekWriteArgs {
  filePath: string;
  content: string;
}

export interface NormalizedDeepSeekEditArgs {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export interface PreparedDeepSeekEditArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  path: string;
  oldText: string;
  newText: string;
  edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

/**
 * Normalize write arguments after Pi's host hook chain.
 *
 * DeepSeek Harness sends { file_path, content }. Pi-native mutation guards often
 * recognize the built-in tool name "write" and expect { path, content } instead.
 * The executor accepts either shape so a downstream guard may normalize the call
 * without breaking the DeepSeek implementation.
 */
export function normalizeDeepSeekWriteArgs(input: DeepSeekWriteArgs): NormalizedDeepSeekWriteArgs {
  const filePath = typeof input.file_path === "string" ? input.file_path : input.path;
  return {
    filePath: requireString(filePath, "file_path"),
    content: requireString(input.content, "content"),
  };
}

/**
 * Normalize edit arguments after Pi's host hook chain.
 *
 * Primary DeepSeek Harness shape:
 *   { file_path, old_string, new_string, replace_all? }
 *
 * Pi compatibility shapes accepted after hook processing:
 *   { path, edits: [{ oldText, newText, replaceAll? }] }
 *   { path, oldText, newText }
 */
export function normalizeDeepSeekEditArgs(input: DeepSeekEditArgs): NormalizedDeepSeekEditArgs {
  const filePath = typeof input.file_path === "string" ? input.file_path : input.path;
  let oldString = typeof input.old_string === "string" ? input.old_string : undefined;
  let newString = typeof input.new_string === "string" ? input.new_string : undefined;
  let replaceAll = optionalBoolean(input.replace_all, "replace_all") ?? false;

  if (oldString === undefined && typeof input.oldText === "string") oldString = input.oldText;
  if (newString === undefined && typeof input.newText === "string") newString = input.newText;

  if ((oldString === undefined || newString === undefined) && Array.isArray(input.edits)) {
    if (input.edits.length !== 1) {
      throw new Error("DeepSeek edit compatibility expects exactly one Pi-native edits[] entry");
    }
    const edit = input.edits[0];
    if (edit && typeof edit === "object") {
      const record = edit as Record<string, unknown>;
      if (oldString === undefined && typeof record.oldText === "string") oldString = record.oldText;
      if (newString === undefined && typeof record.newText === "string") newString = record.newText;
      const nestedReplaceAll = optionalBoolean(record.replaceAll, "edits[0].replaceAll");
      if (nestedReplaceAll !== undefined && input.replace_all === undefined)
        replaceAll = nestedReplaceAll;
    }
  }

  return {
    filePath: requireString(filePath, "file_path"),
    oldString: requireString(oldString, "old_string"),
    newString: requireString(newString, "new_string"),
    replaceAll,
  };
}

/**
 * Pi runs prepareArguments before schema validation and before extension
 * tool_call handlers. Return a dual-shape object so every downstream guard sees
 * the Pi-native aliases even when this extension is loaded after that guard.
 *
 * The registered *internal* schema accepts these aliases. before_provider_request
 * rewrites the advertised write schema back to the exact DeepSeek Harness wire
 * shape, so the model never sees the compatibility fields.
 */
export function prepareDeepSeekWriteArgsForPi(raw: unknown): {
  file_path: string;
  content: string;
  path: string;
} {
  const input = asRecord(raw);
  const normalized = normalizeDeepSeekWriteArgs(input);
  return {
    file_path: normalized.filePath,
    content: normalized.content,
    path: normalized.filePath,
  };
}

/** See prepareDeepSeekWriteArgsForPi. */
export function prepareDeepSeekEditArgsForPi(raw: unknown): PreparedDeepSeekEditArgs {
  const input = asRecord(raw);
  const normalized = normalizeDeepSeekEditArgs(input);
  const edit: PreparedDeepSeekEditArgs["edits"][number] = {
    oldText: normalized.oldString,
    newText: normalized.newString,
  };
  if (normalized.replaceAll) edit.replaceAll = true;

  const prepared: PreparedDeepSeekEditArgs = {
    file_path: normalized.filePath,
    old_string: normalized.oldString,
    new_string: normalized.newString,
    path: normalized.filePath,
    oldText: normalized.oldString,
    newText: normalized.newString,
    edits: [edit],
  };
  if (input.replace_all !== undefined || normalized.replaceAll)
    prepared.replace_all = normalized.replaceAll;
  return prepared;
}

/**
 * Last-resort in-place bridge for Pi builds that do not route prepareArguments
 * through the extension runner. It is intentionally idempotent. On current Pi,
 * prepareArguments already makes these aliases available before tool_call hooks.
 */
export function addPiMutationAliases(toolName: string, input: Record<string, unknown>): void {
  if (toolName === "write") {
    if (typeof input.file_path === "string" && typeof input.path !== "string")
      input.path = input.file_path;
    if (typeof input.path === "string" && typeof input.file_path !== "string")
      input.file_path = input.path;
    return;
  }

  if (toolName !== "edit") return;
  if (typeof input.file_path === "string" && typeof input.path !== "string")
    input.path = input.file_path;
  if (typeof input.path === "string" && typeof input.file_path !== "string")
    input.file_path = input.path;

  if (typeof input.old_string === "string" && typeof input.oldText !== "string")
    input.oldText = input.old_string;
  if (typeof input.new_string === "string" && typeof input.newText !== "string")
    input.newText = input.new_string;
  if (typeof input.oldText === "string" && typeof input.old_string !== "string")
    input.old_string = input.oldText;
  if (typeof input.newText === "string" && typeof input.new_string !== "string")
    input.new_string = input.newText;

  if (
    !Array.isArray(input.edits) &&
    typeof input.old_string === "string" &&
    typeof input.new_string === "string"
  ) {
    const edit: PreparedDeepSeekEditArgs["edits"][number] = {
      oldText: input.old_string,
      newText: input.new_string,
    };
    if (typeof input.replace_all === "boolean") edit.replaceAll = input.replace_all;
    input.edits = [edit];
  }
}
