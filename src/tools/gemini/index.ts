import { isAbsolute, resolve } from "node:path";
import { generateDiffString, type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { withSharedSecureFilesystem } from "../codex/engine.ts";
import { planSingleReplacement, preserveReplacementLineEndings } from "./replacement-engine.ts";
import {
  DiffCallRenderComponent,
  displayToolPath,
  firstText,
  type CompactFileAction,
  type DiffCallRendererState,
} from "../diff-call-renderer.ts";

function absoluteTarget(cwd: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

function resultDetails(toolName: string, action: CompactFileAction, target: string, original: string, updated: string) {
  const diff = generateDiffString(original, updated);
  return { toolName, action, target, diff: diff.diff };
}

function updateGeminiHeader(component: DiffCallRenderComponent, theme: any, toolName: string, action: CompactFileAction, target: string): void {
  component.updateHeader(
    theme.fg("toolTitle", theme.bold(`${toolName} ${action} `))
      + theme.fg("accent", displayToolPath(target)),
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
      updateGeminiHeader(state.callComponent, theme, details.toolName, details.action, details.target);
      state.callComponent.updateResult(text, details.diff);
    }
    const component = context?.lastComponent instanceof Container ? context.lastComponent : new Container();
    component.clear();
    return component;
  }

  return new Text(theme.fg(isError ? "error" : "success", text ?? (isError ? "Error" : "Done")), 0, 0);
}

function containsOmissionPlaceholder(content: string): boolean {
  return /\(\s*(?:rest|remaining|unchanged)\s+(?:of\s+)?(?:the\s+)?(?:code|file|content|methods?|implementation)[^)]*\)/iu.test(content);
}

export function registerGeminiTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "replace",
    label: "replace",
    description: "Replaces text within a file. By default exactly one occurrence of old_string must match. Set allow_multiple=true to replace all matching occurrences of the same old_string.",
    promptSnippet: "Use replace for surgical edits to existing files.",
    promptGuidelines: [
      "old_string and new_string are literal, unescaped text.",
      "Provide enough surrounding context for old_string to identify the intended location uniquely.",
      "Use allow_multiple=true only when every occurrence of the same old_string should change.",
    ],
    parameters: Type.Object({
      file_path: Type.String({ description: "The path to the file to modify." }),
      instruction: Type.String({ description: "A clear, self-contained semantic instruction for the code change." }),
      old_string: Type.String({ description: "The exact literal text to replace, unescaped." }),
      new_string: Type.String({ description: "The exact literal replacement text, unescaped." }),
      allow_multiple: Type.Optional(Type.Boolean({ description: "Replace all occurrences of old_string. Defaults to false." })),
    }, { additionalProperties: false }),
    renderCall(args, theme, context) {
      const state = context.state as DiffCallRendererState;
      const component = context.lastComponent instanceof DiffCallRenderComponent
        ? context.lastComponent
        : state.callComponent ?? new DiffCallRenderComponent();
      state.callComponent = component;
      updateGeminiHeader(component, theme, "replace", "M", args.file_path);
      return component;
    },
    renderResult: renderGeminiResult,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const target = absoluteTarget(ctx.cwd, params.file_path);
      return withFileMutationQueue(target, () => withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
        const original = await fs.readFile(target, signal);
        const plan = planSingleReplacement(original, params);
        if (plan.content !== original) await fs.writeFile(target, plan.content, false, signal);
        const strategy = plan.strategy === "exact" ? "" : ` using ${plan.strategy} recovery`;
        return {
          content: [{ type: "text", text: `Edited ${params.file_path}: ${plan.occurrences} replacement${plan.occurrences === 1 ? "" : "s"}${strategy}.` }],
          details: resultDetails("replace", "M", params.file_path, original, plan.content),
        };
      }));
    },
  });

  pi.registerTool({
    name: "write_file",
    label: "write_file",
    description: "Writes content to a file. Creates the file when absent and overwrites it when it already exists.",
    promptSnippet: "Use write_file to create or fully rewrite a file.",
    promptGuidelines: ["Provide the complete file content. Do not use omission placeholders for unchanged sections."],
    parameters: Type.Object({
      file_path: Type.String({ description: "The path to the file to write." }),
      content: Type.String({ description: "The complete content to write to the file." }),
    }, { additionalProperties: false }),
    renderCall(args, theme, context) {
      const state = context.state as DiffCallRendererState;
      const component = context.lastComponent instanceof DiffCallRenderComponent
        ? context.lastComponent
        : state.callComponent ?? new DiffCallRenderComponent();
      state.callComponent = component;
      updateGeminiHeader(component, theme, "write_file", "M", args.file_path);
      return component;
    },
    renderResult: renderGeminiResult,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (containsOmissionPlaceholder(params.content)) {
        throw new Error("write_file content contains an omission placeholder; provide the complete literal file content");
      }
      const target = absoluteTarget(ctx.cwd, params.file_path);
      return withFileMutationQueue(target, () => withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
        const existing = await fs.readFileOptional(target, signal);
        const content = existing === undefined ? params.content : preserveReplacementLineEndings(params.content, existing);
        if (existing === undefined) await fs.createFile(target, content, signal);
        else await fs.writeFile(target, content, false, signal);
        return {
          content: [{ type: "text", text: `${existing === undefined ? "Created" : "Overwrote"} ${params.file_path}.` }],
          details: resultDetails("write_file", existing === undefined ? "A" : "M", params.file_path, existing ?? "", content),
        };
      }));
    },
  });
}
