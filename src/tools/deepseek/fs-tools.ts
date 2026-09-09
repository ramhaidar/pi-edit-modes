import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  generateDiffString,
  resizeImage,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { extname } from "node:path";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { SharedSecureFileLimitError } from "../codex/engine.ts";
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
import {
  DiffCallRenderComponent,
  displayToolPath,
  firstText,
  type CompactFileAction,
  type DiffCallRendererState,
} from "../diff-call-renderer.ts";

export type FilesystemToolFlavor = "pi" | "deepseek";

interface FileToolDetails {
  target?: string;
  diff?: string;
  action?: "A" | "M" | "V";
}

function resultText(text: string, details?: FileToolDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

function renderPath(args: any): string {
  const value = args?.file_path ?? args?.path;
  return typeof value === "string" && value.length > 0 ? value : "...";
}

function renderCallTitle(name: string, path: string, theme: any) {
  return new Text(theme.fg("toolTitle", theme.bold(`${name} ${path}`)), 0, 0);
}

function renderTextResult(result: any, options: any, theme: any, context?: any) {
  const first = Array.isArray(result?.content)
    ? result.content.find((part: any) => part?.type === "text")
    : undefined;
  const text =
    typeof first?.text === "string"
      ? first.text
      : options?.isError || context?.isError
        ? "Error"
        : "Done";
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
    theme.fg("toolTitle", theme.bold(`${name} ${action} `)) +
      theme.fg("accent", displayToolPath(target)),
  );
}

function renderMutationCall(
  name: "write" | "edit",
  action: CompactFileAction,
  args: any,
  theme: any,
  context: any,
) {
  const state = context.state as DiffCallRendererState;
  const component =
    context.lastComponent instanceof DiffCallRenderComponent
      ? context.lastComponent
      : (state.callComponent ?? new DiffCallRenderComponent());
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

    const component =
      context?.lastComponent instanceof Container ? context.lastComponent : new Container();
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
    promptSnippet:
      "Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.",
    parameters: Type.Object(
      {
        file_path: Type.String({
          description: "Path to read, resolved by the filesystem backend.",
        }),
        offset: Type.Optional(
          Type.Number({ description: "1-based first line to return. Defaults to 1." }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: `Maximum number of lines to return. Defaults to ${DEEPSEEK_READ_LIMIT}.`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    renderCall: (args, theme) => renderCallTitle("read", renderPath(args), theme),
    renderResult: renderTextResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await getDeepSeekFsRuntime(ctx).read(
        params.file_path,
        params.offset,
        params.limit,
        signal,
      );
      return resultText(formatDeepSeekReadOutput(outcome), { target: outcome.path, action: "V" });
    },
  });
}

type DeepSeekImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export const DEEPSEEK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DEEPSEEK_IMAGE_MAX_DIMENSION = 2000;
export const DEEPSEEK_IMAGE_MAX_PIXELS = 40_000_000;

const DEEPSEEK_IMAGE_EXTENSIONS: Readonly<Record<string, DeepSeekImageMimeType>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function bytesMatch(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.byteLength < offset + expected.length) return false;
  return expected.every((byte, index) => data[offset + index] === byte);
}

function asciiMatches(data: Uint8Array, offset: number, expected: string): boolean {
  if (data.byteLength < offset + expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (data[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function sniffDeepSeekImageMimeType(data: Uint8Array): DeepSeekImageMimeType | undefined {
  if (bytesMatch(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytesMatch(data, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (asciiMatches(data, 0, "GIF87a") || asciiMatches(data, 0, "GIF89a")) return "image/gif";
  if (asciiMatches(data, 0, "RIFF") && asciiMatches(data, 8, "WEBP")) return "image/webp";
  return undefined;
}

function formatDeepSeekImageReadOutput(
  displayPath: string,
  image: {
    mimeType: string;
    bytes: number;
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
    wasResized: boolean;
  },
): string {
  let scaled = "";
  if (image.wasResized) {
    const x = (image.originalWidth / image.width).toFixed(2);
    const y = (image.originalHeight / image.height).toFixed(2);
    const advice =
      x === y
        ? `multiply coordinates by ${x}`
        : `multiply x coordinates by ${x} and y coordinates by ${y}`;
    scaled = ` (downscaled from ${image.originalWidth}x${image.originalHeight} px; ${advice} to locate features in the original file)`;
  }
  return `<path>${displayPath}</path>\n<type>image</type>\n<content>\n${image.mimeType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}\n</content>`;
}

export function assertDeepSeekImageDimensions(
  displayPath: string,
  width: number,
  height: number,
): void {
  if (width > DEEPSEEK_IMAGE_MAX_DIMENSION || height > DEEPSEEK_IMAGE_MAX_DIMENSION) {
    throw new Error(
      `cannot read "${displayPath}": at least one image side exceeds the ${DEEPSEEK_IMAGE_MAX_DIMENSION}px limit; downscale the image and read the smaller copy`,
    );
  }
  if (width * height > DEEPSEEK_IMAGE_MAX_PIXELS) {
    throw new Error(
      `cannot read "${displayPath}": the image exceeds the ${DEEPSEEK_IMAGE_MAX_PIXELS}-pixel decoded-size limit; downscale the image and read the smaller copy`,
    );
  }
}

export function registerDeepSeekReadImageTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_image",
    label: "read_image",
    description:
      "Read a PNG/JPEG/WebP/GIF file and return the image itself. " +
      "A path without a file extension is accepted; the format is detected from the file content, so normalized attachment paths can be passed directly without copying or renaming. " +
      "Harness validates and downscales large supported images before the next model request, so use this tool directly instead of installing image libraries or creating thumbnails merely to inspect an image. " +
      "Independent files may be read concurrently in small batches. Requires the current model to accept image input.",
    parameters: Type.Object(
      {
        file_path: Type.String({
          description: "Path to the image file, resolved by the filesystem backend.",
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    renderCall: (args, theme) => renderCallTitle("read_image", renderPath(args), theme),
    renderResult: renderTextResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("read_image aborted");
      if (params.file_path.trim().length === 0)
        throw new Error("file_path must be a non-empty string");
      const input = (ctx.model as { input?: string[] } | undefined)?.input;
      if (!Array.isArray(input) || !input.includes("image"))
        throw new Error("Current model does not support image input");
      const extension = extname(params.file_path).toLowerCase();
      const declaredMimeType = DEEPSEEK_IMAGE_EXTENSIONS[extension];
      if (declaredMimeType === undefined && extension !== "") {
        throw new Error(
          `cannot read "${params.file_path}": the ${extension} extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`,
        );
      }
      const runtime = getDeepSeekFsRuntime(ctx);
      let snapshot;
      try {
        snapshot = await runtime.readImageSnapshot(
          params.file_path,
          DEEPSEEK_IMAGE_MAX_BYTES,
          signal,
        );
      } catch (error) {
        if (error instanceof SharedSecureFileLimitError) {
          throw new Error(
            `cannot read "${params.file_path}": image exceeds the ${DEEPSEEK_IMAGE_MAX_BYTES}-byte source limit; downscale the image and read the smaller copy`,
            { cause: error },
          );
        }
        throw error;
      }
      const target = snapshot.target.displayPath;
      const bytes = snapshot.bytes;
      const detectedMimeType = sniffDeepSeekImageMimeType(bytes);
      if (!detectedMimeType) {
        throw new Error(
          `cannot read "${target}": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`,
        );
      }
      if (declaredMimeType !== undefined && declaredMimeType !== detectedMimeType) {
        throw new Error(
          `cannot read "${target}": the ${extension} extension declares ${declaredMimeType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`,
        );
      }
      const normalized = await resizeImage(bytes, detectedMimeType);
      if (!normalized) {
        throw new Error(
          `cannot read "${target}": the image could not be normalized for model input`,
        );
      }
      assertDeepSeekImageDimensions(target, normalized.originalWidth, normalized.originalHeight);
      const normalizedBytes = Buffer.from(normalized.data, "base64").byteLength;
      runtime.recordSuccessfulReadObservation(snapshot.target, snapshot.info);
      return {
        content: [
          {
            type: "text" as const,
            text: formatDeepSeekImageReadOutput(target, {
              mimeType: normalized.mimeType,
              bytes: normalizedBytes,
              width: normalized.width,
              height: normalized.height,
              originalWidth: normalized.originalWidth,
              originalHeight: normalized.originalHeight,
              wasResized: normalized.wasResized,
            }),
          },
          {
            type: "image" as const,
            data: normalized.data,
            mimeType: normalized.mimeType,
          },
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
    promptSnippet:
      "Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.",
    // Internal validation schema is a strict superset of the DeepSeek Harness
    // wire schema. prepareArguments adds Pi-native aliases before *any* tool_call
    // extension runs. before_provider_request strips these aliases from the schema
    // advertised to the model, so model-facing parameters stay Harness-exact.
    parameters: Type.Object(
      {
        file_path: Type.String({
          description: "Path to write, resolved by the filesystem backend.",
        }),
        content: Type.String({ description: "Full UTF-8 text content to write." }),
        path: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    prepareArguments: prepareDeepSeekWriteArgsForPi,
    executionMode: "sequential",
    // Explicitly override Pi built-in renderer inheritance. Because the tool name
    // is `write`, Pi may inherit built-in presentation defaults unless this is set.
    // DeepSeek file mutations should use the same boxed shell as str_replace_editor.
    renderShell: "default",
    renderCall: (args, theme, context) => renderMutationCall("write", "M", args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderMutationResult("write", result, options, theme, context),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const normalized = normalizeDeepSeekWriteArgs(params as any);
      const outcome = await getDeepSeekFsRuntime(ctx).write(
        normalized.filePath,
        normalized.content,
        signal,
      );
      const diff =
        outcome.before === null
          ? generateDiffString("", outcome.after).diff
          : generateDiffString(outcome.before, outcome.after).diff;
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
    promptSnippet:
      "Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.",
    parameters: Type.Object(
      {
        file_path: Type.String({
          description: "Path to edit, resolved by the filesystem backend.",
        }),
        old_string: Type.String({ description: "Literal text to replace. Must match exactly." }),
        new_string: Type.String({
          description: "Literal replacement text. Use an empty string to delete the match.",
        }),
        replace_all: Type.Optional(
          Type.Boolean({
            description:
              "Replace all matches. Defaults to false; when false, old_string must appear exactly once.",
          }),
        ),
        // Compatibility aliases are internal-only; the provider guard removes them
        // from the schema sent to DeepSeek.
        path: Type.Optional(Type.String()),
        oldText: Type.Optional(Type.String()),
        newText: Type.Optional(Type.String()),
        edits: Type.Optional(
          Type.Array(
            Type.Object(
              {
                oldText: Type.String(),
                newText: Type.String(),
                replaceAll: Type.Optional(Type.Boolean()),
              },
              { additionalProperties: false },
            ),
          ),
        ),
      },
      { additionalProperties: false },
    ),
    prepareArguments: prepareDeepSeekEditArgsForPi,
    executionMode: "sequential",
    // Pi special-cases built-in `edit` with renderShell: "self". ToolExecutionComponent
    // inherits that shell when a replacement definition omits renderShell, which is why
    // DeepSeek edit was rendered as an unboxed native-style diff. Force the default
    // boxed shell so its presentation matches str_replace_editor.
    renderShell: "default",
    renderCall: (args, theme, context) => renderMutationCall("edit", "M", args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderMutationResult("edit", result, options, theme, context),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const normalized = normalizeDeepSeekEditArgs(params as any);
      const replaceAll = normalized.replaceAll;
      const outcome = await getDeepSeekFsRuntime(ctx).edit(
        normalized.filePath,
        normalized.oldString,
        normalized.newString,
        replaceAll,
        signal,
      );
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

export function registerDeepSeekMutationCompatibilityHook(
  pi: ExtensionAPI,
  isDeepSeekActive: () => boolean,
): void {
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
