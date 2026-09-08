import { isAbsolute, resolve } from "node:path";
import { generateDiffString, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { withSharedSecureFilesystem } from "../codex/engine.ts";
import { planReplacementChunks, planSingleReplacement, preserveReplacementLineEndings, type ReplacementChunk } from "./replacement-engine.ts";
import {
  DiffCallRenderComponent,
  displayToolPath,
  firstText,
  type CompactFileAction,
  type DiffCallRendererState,
} from "../diff-call-renderer.ts";

const REPLACEMENT_CHUNK_SCHEMA = Type.Object({
  TargetContent: Type.String({ description: "Exact text to replace." }),
  ReplacementContent: Type.String({ description: "Replacement text. May be empty to delete the target." }),
  AllowMultiple: Type.Optional(Type.Boolean({ description: "Replace every exact match in the selected range." })),
  StartLine: Type.Optional(Type.Integer({ minimum: 1 })),
  EndLine: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

function absoluteTarget(cwd: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

function resultDetails(toolName: string, action: CompactFileAction, target: string, original: string, updated: string, chunks: number) {
  const diff = generateDiffString(original, updated);
  return { toolName, action, target, chunks, diff: diff.diff };
}

function updateGeminiHeader(component: DiffCallRenderComponent, theme: any, toolName: string, action: CompactFileAction, target: string, suffix = ""): void {
  component.updateHeader(
    theme.fg("toolTitle", theme.bold(`${toolName} ${action} `))
      + theme.fg("accent", displayToolPath(target))
      + (suffix ? theme.fg("dim", suffix) : ""),
  );
}

type GeminiEditDetails = ReturnType<typeof resultDetails>;

function renderGeminiResult(result: any, options: any, theme: any, context?: any) {
  const details = result.details as GeminiEditDetails | undefined;
  const text = firstText(result);
  const isError = context?.isError === true || options?.isError === true;

  if (!isError && details && Object.hasOwn(details, "diff")) {
    const state = context?.state as DiffCallRendererState | undefined;
    if (state?.callComponent) {
      const suffix = details.toolName === "multi_replace_file_content" ? ` (${details.chunks} chunks)` : "";
      updateGeminiHeader(state.callComponent, theme, details.toolName, details.action, details.target, suffix);
      state.callComponent.updateResult(text, details.diff);
    }
    const component = context?.lastComponent instanceof Container ? context.lastComponent : new Container();
    component.clear();
    return component;
  }

  return new Text(theme.fg(isError ? "error" : "success", text ?? (isError ? "Error" : "Done")), 0, 0);
}

export interface GeminiToolRegistrationOptions {
  strictExactMatch: () => boolean;
}

export function registerGeminiTools(pi: ExtensionAPI, options: GeminiToolRegistrationOptions): void {
  pi.registerTool({
    name: "replace_file_content",
    label: "replace_file_content",
    description: "Edit one contiguous block in a file by exact TargetContent match.",
    promptSnippet: "Use replace_file_content for one contiguous exact-match edit.",
    promptGuidelines: [
      "TargetContent must match the file content exactly, including whitespace.",
      "Use StartLine/EndLine to restrict the candidate range when useful.",
      "If the target occurs more than once, narrow it or set AllowMultiple=true intentionally.",
    ],
    parameters: Type.Object({
      TargetFile: Type.String(),
      TargetContent: Type.String(),
      ReplacementContent: Type.String(),
      AllowMultiple: Type.Optional(Type.Boolean()),
      StartLine: Type.Optional(Type.Integer({ minimum: 1 })),
      EndLine: Type.Optional(Type.Integer({ minimum: 1 })),
      Instruction: Type.Optional(Type.String()),
      Description: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    renderCall(args, theme, context) {
      const state = context.state as DiffCallRendererState;
      const component =
        context.lastComponent instanceof DiffCallRenderComponent
          ? context.lastComponent
          : state.callComponent ?? new DiffCallRenderComponent();
      state.callComponent = component;
      updateGeminiHeader(component, theme, "replace_file_content", "M", args.TargetFile);
      return component;
    },
    renderResult: renderGeminiResult,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const target = absoluteTarget(ctx.cwd, params.TargetFile);
      return withFileMutationQueue(target, () => withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
        const original = await fs.readFile(target, signal);
        const plan = planSingleReplacement(original, {
          TargetContent: params.TargetContent,
          ReplacementContent: params.ReplacementContent,
          AllowMultiple: params.AllowMultiple,
          StartLine: params.StartLine,
          EndLine: params.EndLine,
        }, { strictExactMatch: options.strictExactMatch() });
        if (plan.content === original) {
          return { content: [{ type: "text", text: `No content change required for ${params.TargetFile}.` }], details: resultDetails("replace_file_content", "M", params.TargetFile, original, plan.content, 1) };
        }
        await fs.writeFile(target, plan.content, false, signal);
        return {
          content: [{ type: "text", text: `Edited ${params.TargetFile}: ${plan.replacements.length} replacement${plan.replacements.length === 1 ? "" : "s"}.` }],
          details: resultDetails("replace_file_content", "M", params.TargetFile, original, plan.content, 1),
        };
      }));
    },
  });

  pi.registerTool({
    name: "multi_replace_file_content",
    label: "multi_replace_file_content",
    description: "Make multiple non-overlapping exact-match edits to one file atomically from one original snapshot.",
    promptSnippet: "Use multi_replace_file_content for multiple non-contiguous edits in one file.",
    promptGuidelines: [
      "All ReplacementChunks are validated against the same original file snapshot.",
      "Any missing, ambiguous, or overlapping chunk aborts the operation before the file is written.",
    ],
    parameters: Type.Object({
      TargetFile: Type.String(),
      Instruction: Type.Optional(Type.String()),
      Description: Type.Optional(Type.String()),
      ReplacementChunks: Type.Array(REPLACEMENT_CHUNK_SCHEMA, { minItems: 1 }),
    }, { additionalProperties: false }),
    renderCall(args, theme, context) {
      const count = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks.length : 0;
      const state = context.state as DiffCallRendererState;
      const component =
        context.lastComponent instanceof DiffCallRenderComponent
          ? context.lastComponent
          : state.callComponent ?? new DiffCallRenderComponent();
      state.callComponent = component;
      updateGeminiHeader(component, theme, "multi_replace_file_content", "M", args.TargetFile, ` (${count} chunks)`);
      return component;
    },
    renderResult: renderGeminiResult,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const target = absoluteTarget(ctx.cwd, params.TargetFile);
      return withFileMutationQueue(target, () => withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
        const original = await fs.readFile(target, signal);
        const plan = planReplacementChunks(original, params.ReplacementChunks as ReplacementChunk[], { strictExactMatch: options.strictExactMatch() });
        if (plan.content !== original) await fs.writeFile(target, plan.content, false, signal);
        return {
          content: [{ type: "text", text: `Edited ${params.TargetFile}: ${params.ReplacementChunks.length} chunk${params.ReplacementChunks.length === 1 ? "" : "s"}, ${plan.replacements.length} replacement${plan.replacements.length === 1 ? "" : "s"}.` }],
          details: resultDetails("multi_replace_file_content", "M", params.TargetFile, original, plan.content, params.ReplacementChunks.length),
        };
      }));
    },
  });

  pi.registerTool({
    name: "write_to_file",
    label: "write_to_file",
    description: "Create a file, or replace an existing file only when Overwrite=true.",
    promptSnippet: "Use write_to_file to create a new file.",
    promptGuidelines: ["Do not set Overwrite=true unless replacing an existing file is intended."],
    parameters: Type.Object({
      TargetFile: Type.String(),
      CodeContent: Type.String(),
      Overwrite: Type.Optional(Type.Boolean()),
      Description: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    renderCall(args, theme, context) {
      const state = context.state as DiffCallRendererState;
      const component =
        context.lastComponent instanceof DiffCallRenderComponent
          ? context.lastComponent
          : state.callComponent ?? new DiffCallRenderComponent();
      state.callComponent = component;
      updateGeminiHeader(component, theme, "write_to_file", args.Overwrite === true ? "M" : "A", args.TargetFile);
      return component;
    },
    renderResult: renderGeminiResult,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const target = absoluteTarget(ctx.cwd, params.TargetFile);
      return withFileMutationQueue(target, () => withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
        const existing = await fs.readFileOptional(target, signal);
        if (existing !== undefined && params.Overwrite !== true) {
          throw new Error(`Refusing to overwrite existing file '${params.TargetFile}' without Overwrite=true`);
        }
        const content = existing === undefined ? params.CodeContent : preserveReplacementLineEndings(params.CodeContent, existing);
        if (existing === undefined) await fs.createFile(target, content, signal);
        else await fs.writeFile(target, content, false, signal);
        return {
          content: [{ type: "text", text: `${existing === undefined ? "Created" : "Overwrote"} ${params.TargetFile}.` }],
          details: resultDetails("write_to_file", existing === undefined ? "A" : "M", params.TargetFile, existing ?? "", content, 1),
        };
      }));
    },
  });
}
