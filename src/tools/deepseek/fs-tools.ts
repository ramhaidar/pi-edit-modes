import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  generateDiffString,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  DEEPSEEK_READ_LIMIT,
  formatDeepSeekEditOutput,
  formatDeepSeekReadOutput,
  formatDeepSeekWriteOutput,
} from "./fs-parity.ts";
import { clearDeepSeekFsRuntimes, getDeepSeekFsRuntime } from "./runtime.ts";
import {
  addPiMutationAliases,
  normalizeDeepSeekEditArgs,
  normalizeDeepSeekWriteArgs,
  prepareDeepSeekEditArgsForPi,
  prepareDeepSeekWriteArgsForPi,
} from "./arg-compat.ts";
import { DiffCallRenderComponent, displayToolPath, firstText, type CompactFileAction, type DiffCallRendererState } from "../diff-call-renderer.ts";

export type FilesystemToolFlavor = "pi" | "deepseek";

interface FileToolDetails {
  target?: string;
  diff?: string;
  action?: "A" | "M" | "V";
}

function resultText(text: string, details?: FileToolDetails) {
  return { content: [{ type: "text" as const, text }], ...(details ? { details } : {}) };
}


function renderPath(args: any): string {
  const value = args?.file_path ?? args?.path;
  return typeof value === "string" && value.length > 0 ? value : "...";
}

function renderCallTitle(name: string, path: string, theme: any) {
  return new Text(theme.fg("toolTitle", theme.bold(`${name} ${path}`)), 0, 0);
}

function renderTextResult(result: any, options: any, theme: any, context?: any) {
  const first = Array.isArray(result?.content) ? result.content.find((part: any) => part?.type === "text") : undefined;
  const text = typeof first?.text === "string" ? first.text : (options?.isError || context?.isError ? "Error" : "Done");
  return new Text(theme.fg(options?.isError || context?.isError ? "error" : "success", text), 0, 0);
}

function updateMutationHeader(
  component: DiffCallRenderComponent,
  theme: any,
  name: "write" | "edit",
  action: CompactFileAction,
  target: string,
): void {
  component.updateHeader(
    theme.fg("toolTitle", theme.bold(`${name} ${action} `))
      + theme.fg("accent", displayToolPath(target)),
  );
}

function renderMutationCall(name: "write" | "edit", action: CompactFileAction, args: any, theme: any, context: any) {
  const state = context.state as DiffCallRendererState;
  const component = context.lastComponent instanceof DiffCallRenderComponent
    ? context.lastComponent
    : state.callComponent ?? new DiffCallRenderComponent();
  state.callComponent = component;
  updateMutationHeader(component, theme, name, action, renderPath(args));
  return component;
}

function renderMutationResult(
  name: "write" | "edit",
  result: any,
  options: any,
  theme: any,
  context?: any,
) {
  const isError = context?.isError === true || options?.isError === true;
  const text = firstText(result) ?? (isError ? "Error" : "Done");
  const details = result?.details as FileToolDetails | undefined;
  const state = context?.state as DiffCallRendererState | undefined;
  const callComponent = state?.callComponent;

  if (callComponent) {
    const action = details?.action ?? "M";
    const target = details?.target ?? renderPath(context?.args);
    updateMutationHeader(callComponent, theme, name, action, target);
    callComponent.updateResult(text, isError ? undefined : details?.diff);

    const component = context?.lastComponent instanceof Container ? context.lastComponent : new Container();
    component.clear();
    return component;
  }

  return new Text(theme.fg(isError ? "error" : "success", text), 0, 0);
}

function registerDeepSeekRead(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read a UTF-8 text file and return line-numbered content.",
    promptSnippet: "Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.",
    promptGuidelines: [
      "Use read instead of shell commands like cat to inspect text files; use offset and limit to continue reading large files.",
    ],
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to read, resolved by the filesystem backend." }),
      offset: Type.Optional(Type.Number({ description: "1-based first line to return. Defaults to 1." })),
      limit: Type.Optional(Type.Number({ description: `Maximum number of lines to return. Defaults to ${DEEPSEEK_READ_LIMIT}.` })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    renderCall: (args, theme) => renderCallTitle("read", renderPath(args), theme),
    renderResult: renderTextResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await getDeepSeekFsRuntime(ctx).read(params.file_path, params.offset, params.limit, signal);
      return resultText(formatDeepSeekReadOutput(outcome), { target: outcome.path, action: "V" });
    },
  });
}

function detectImageMime(bytes: Uint8Array, path: string): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a") return "image/gif";
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return undefined;
}

async function fencedImagePath(cwd: string, filePath: string): Promise<string> {
  const workspace = await realpath(cwd);
  const requested = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  const target = await realpath(requested);
  const rel = relative(workspace, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`Path '${filePath}' resolves outside the workspace`);
  }
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`Path '${filePath}' is not a file`);
  return target;
}

export function registerDeepSeekReadImageTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_image",
    label: "read_image",
    description: "Read an image file and return it as a model image attachment.",
    promptSnippet: "Use read_image to inspect image files when image input is available.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to the image file." }),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    renderCall: (args, theme) => renderCallTitle("read_image", renderPath(args), theme),
    renderResult: renderTextResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("read_image aborted");
      const input = (ctx.model as { input?: string[] } | undefined)?.input;
      if (!Array.isArray(input) || !input.includes("image")) throw new Error("Current model does not support image input");
      const target = await fencedImagePath(ctx.cwd, params.file_path);
      const bytes = await readFile(target, signal ? { signal } : undefined);
      const mimeType = detectImageMime(bytes, target);
      if (!mimeType) throw new Error(`Unsupported image format for '${params.file_path}'`);
      return {
        content: [
          { type: "text" as const, text: `Image loaded from ${params.file_path}` },
          { type: "image" as const, data: bytes.toString("base64"), mimeType },
        ],
        details: undefined,
      };
    },
  });
}

function registerDeepSeekWrite(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "write",
    label: "write",
    description: "Create or fully replace a UTF-8 text file.",
    promptSnippet: "Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.",
    promptGuidelines: [
      "Use write to create files or completely replace file contents; read an existing file first before overwriting it, and prefer edit for targeted changes.",
    ],
    // Internal validation schema is a strict superset of the DeepSeek Harness
    // wire schema. prepareArguments adds Pi-native aliases before *any* tool_call
    // extension runs. before_provider_request strips these aliases from the schema
    // advertised to the model, so model-facing parameters stay Harness-exact.
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to write, resolved by the filesystem backend." }),
      content: Type.String({ description: "Full UTF-8 text content to write." }),
      path: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    prepareArguments: prepareDeepSeekWriteArgsForPi,
    executionMode: "parallel",
    // Explicitly override Pi built-in renderer inheritance. Because the tool name
    // is `write`, Pi may inherit built-in presentation defaults unless this is set.
    // DeepSeek file mutations should use the same boxed shell as str_replace_editor.
    renderShell: "default",
    renderCall: (args, theme, context) => renderMutationCall("write", "M", args, theme, context),
    renderResult: (result, options, theme, context) => renderMutationResult("write", result, options, theme, context),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const normalized = normalizeDeepSeekWriteArgs(params as any);
      const outcome = await getDeepSeekFsRuntime(ctx).write(normalized.filePath, normalized.content, signal);
      const diff = outcome.before === null ? generateDiffString("", outcome.after).diff : generateDiffString(outcome.before, outcome.after).diff;
      return resultText(formatDeepSeekWriteOutput(outcome.path, outcome.operation), {
        target: outcome.path,
        action: outcome.operation === "create" ? "A" : "M",
        diff,
      });
    },
  });
}

function registerDeepSeekEdit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit an existing UTF-8 text file by replacing literal text.",
    promptSnippet: "Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.",
    promptGuidelines: [
      "Use edit for targeted literal replacements; by default old_string must appear exactly once, and read the file first unless it was just created or edited in this session.",
    ],
    parameters: Type.Object({
      file_path: Type.String({ description: "Path to edit, resolved by the filesystem backend." }),
      old_string: Type.String({ description: "Literal text to replace. Must match exactly." }),
      new_string: Type.String({ description: "Literal replacement text. Use an empty string to delete the match." }),
      replace_all: Type.Optional(Type.Boolean({ description: "Replace all matches. Defaults to false; when false, old_string must appear exactly once." })),
      // Compatibility aliases are internal-only; the provider guard removes them
      // from the schema sent to DeepSeek.
      path: Type.Optional(Type.String()),
      oldText: Type.Optional(Type.String()),
      newText: Type.Optional(Type.String()),
      edits: Type.Optional(Type.Array(Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
        replaceAll: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }))),
    }, { additionalProperties: false }),
    prepareArguments: prepareDeepSeekEditArgsForPi,
    executionMode: "parallel",
    // Pi special-cases built-in `edit` with renderShell: "self". ToolExecutionComponent
    // inherits that shell when a replacement definition omits renderShell, which is why
    // DeepSeek edit was rendered as an unboxed native-style diff. Force the default
    // boxed shell so its presentation matches str_replace_editor.
    renderShell: "default",
    renderCall: (args, theme, context) => renderMutationCall("edit", "M", args, theme, context),
    renderResult: (result, options, theme, context) => renderMutationResult("edit", result, options, theme, context),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const normalized = normalizeDeepSeekEditArgs(params as any);
      const replaceAll = normalized.replaceAll;
      const outcome = await getDeepSeekFsRuntime(ctx).edit(normalized.filePath, normalized.oldString, normalized.newString, replaceAll, signal);
      return resultText(formatDeepSeekEditOutput(outcome.path, replaceAll), {
        target: outcome.path,
        action: "M",
        diff: generateDiffString(outcome.before, outcome.after).diff,
      });
    },
  });
}

export function registerDeepSeekFilesystemTools(pi: ExtensionAPI): void {
  registerDeepSeekRead(pi);
  registerDeepSeekWrite(pi);
  registerDeepSeekEdit(pi);
}

export function registerDeepSeekMutationCompatibilityHook(pi: ExtensionAPI, isDeepSeekActive: () => boolean): void {
  pi.on("tool_call", (event: any) => {
    if (!isDeepSeekActive()) return;
    if (event?.toolName !== "write" && event?.toolName !== "edit") return;
    if (!event.input || typeof event.input !== "object") return;
    addPiMutationAliases(event.toolName, event.input as Record<string, unknown>);
  });
}

export function registerPiFilesystemTools(pi: ExtensionAPI, cwd: string): void {
  // Re-register Pi's own definitions over our DeepSeek overrides. This preserves
  // Pi's native schemas/semantics outside DeepSeek mode after a mode switch.
  pi.registerTool(createReadToolDefinition(cwd) as any);
  pi.registerTool(createWriteToolDefinition(cwd) as any);
  pi.registerTool(createEditToolDefinition(cwd) as any);
  clearDeepSeekFsRuntimes();
}

export { clearDeepSeekFsRuntimes };
