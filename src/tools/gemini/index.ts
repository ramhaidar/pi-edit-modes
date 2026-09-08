import {
  generateDiffString,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { withSharedSecureFilesystem } from "../codex/engine.ts";
import { calculateGeminiMutation, geminiDescriptions, takeGeminiMutation } from "./lifecycle.ts";
import {
  DiffCallRenderComponent,
  displayToolPath,
  firstText,
  type CompactFileAction,
  type DiffCallRendererState,
} from "../diff-call-renderer.ts";

function resultDetails(
  toolName: string,
  action: CompactFileAction,
  target: string,
  original: string,
  updated: string,
) {
  const diff = generateDiffString(original, updated);
  return { toolName, action, target, diff: diff.diff };
}

function updateGeminiHeader(
  component: DiffCallRenderComponent,
  theme: any,
  toolName: string,
  action: CompactFileAction,
  target: string,
): void {
  component.updateHeader(
    theme.fg("toolTitle", theme.bold(`${toolName} ${action} `)) +
      theme.fg("accent", displayToolPath(target)),
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
      updateGeminiHeader(
        state.callComponent,
        theme,
        details.toolName,
        details.action,
        details.target,
      );
      state.callComponent.updateResult(text, details.diff);
    }
    const component =
      context?.lastComponent instanceof Container ? context.lastComponent : new Container();
    component.clear();
    return component;
  }

  return new Text(
    theme.fg(isError ? "error" : "success", text ?? (isError ? "Error" : "Done")),
    0,
    0,
  );
}

function containsOmissionPlaceholder(content: string): boolean {
  return /\(\s*(?:rest|remaining|unchanged)\s+(?:of\s+)?(?:the\s+)?(?:code|file|content|methods?|implementation)[^)]*\)/iu.test(
    content,
  );
}

export function registerGeminiTools(pi: ExtensionAPI): void {
  const descriptions = geminiDescriptions();
  pi.registerTool({
    name: "replace",
    label: "replace",
    description: descriptions.replace,
    promptSnippet: "Use replace for surgical edits to existing files.",
    promptGuidelines: [
      "old_string and new_string are literal, unescaped text.",
      "Provide enough surrounding context for old_string to identify the intended location uniquely.",
      "Use allow_multiple=true only when every occurrence of the same old_string should change.",
    ],
    parameters: Type.Object(
      {
        file_path: Type.String({ description: "The path to the file to modify." }),
        instruction: Type.String({
          description: "A clear, self-contained semantic instruction for the code change.",
        }),
        old_string: Type.String({ description: "The exact literal text to replace, unescaped." }),
        new_string: Type.String({ description: "The exact literal replacement text, unescaped." }),
        allow_multiple: Type.Optional(
          Type.Boolean({
            description: "Replace all occurrences of old_string. Defaults to false.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme, context) {
      const state = context.state as DiffCallRendererState;
      const component =
        context.lastComponent instanceof DiffCallRenderComponent
          ? context.lastComponent
          : (state.callComponent ?? new DiffCallRenderComponent());
      state.callComponent = component;
      updateGeminiHeader(component, theme, "replace", "M", args.file_path);
      return component;
    },
    renderResult: renderGeminiResult,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const mutation =
        takeGeminiMutation(toolCallId) ??
        (await calculateGeminiMutation(toolCallId, "replace", params, ctx, signal));
      return withFileMutationQueue(mutation.absolutePath, () =>
        withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
          const current = await fs.readFileOptional(mutation.absolutePath, signal);
          if (current !== mutation.before)
            throw new Error(
              `replace target '${params.file_path}' changed after proposal calculation; re-read and retry`,
            );
          if (mutation.before === undefined)
            await fs.createFile(mutation.absolutePath, mutation.after, signal);
          else if (mutation.after !== mutation.before)
            await fs.writeFile(mutation.absolutePath, mutation.after, false, signal);
          const strategy =
            mutation.strategy && mutation.strategy !== "exact"
              ? ` using ${mutation.strategy} recovery`
              : "";
          const correction = mutation.corrected ? " after edit correction" : "";
          const userEdit = mutation.modifiedByUser ? " with user-modified proposed content" : "";
          const count = mutation.occurrences ?? 0;
          return {
            content: [
              {
                type: "text",
                text:
                  mutation.before === undefined
                    ? `Created ${params.file_path} via replace.${userEdit}`
                    : count === 0
                      ? `No changes required for ${params.file_path}.${correction}`
                      : `Edited ${params.file_path}: ${count} replacement${count === 1 ? "" : "s"}${strategy}${correction}${userEdit}.`,
              },
            ],
            details: resultDetails(
              "replace",
              mutation.action,
              params.file_path,
              mutation.before ?? "",
              mutation.after,
            ),
          };
        }),
      );
    },
  });

  pi.registerTool({
    name: "write_file",
    label: "write_file",
    description: descriptions.write_file,
    promptSnippet: "Use write_file to create or fully rewrite a file.",
    promptGuidelines: [
      "Provide the complete file content. Do not use omission placeholders for unchanged sections.",
    ],
    parameters: Type.Object(
      {
        file_path: Type.String({ description: "The path to the file to write." }),
        content: Type.String({ description: "The complete content to write to the file." }),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme, context) {
      const state = context.state as DiffCallRendererState;
      const component =
        context.lastComponent instanceof DiffCallRenderComponent
          ? context.lastComponent
          : (state.callComponent ?? new DiffCallRenderComponent());
      state.callComponent = component;
      updateGeminiHeader(component, theme, "write_file", "M", args.file_path);
      return component;
    },
    renderResult: renderGeminiResult,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (containsOmissionPlaceholder(params.content)) {
        throw new Error(
          "write_file content contains an omission placeholder; provide the complete literal file content",
        );
      }
      const mutation =
        takeGeminiMutation(toolCallId) ??
        (await calculateGeminiMutation(toolCallId, "write_file", params, ctx, signal));
      return withFileMutationQueue(mutation.absolutePath, () =>
        withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
          const current = await fs.readFileOptional(mutation.absolutePath, signal);
          if (current !== mutation.before)
            throw new Error(
              `write_file target '${params.file_path}' changed after proposal calculation; retry with current content`,
            );
          if (mutation.before === undefined)
            await fs.createFile(mutation.absolutePath, mutation.after, signal);
          else if (mutation.after !== mutation.before)
            await fs.writeFile(mutation.absolutePath, mutation.after, false, signal);
          const correction = mutation.corrected ? " after content correction" : "";
          const userEdit = mutation.modifiedByUser ? " with user-modified proposed content" : "";
          return {
            content: [
              {
                type: "text",
                text: `${mutation.before === undefined ? "Created" : "Overwrote"} ${params.file_path}${correction}${userEdit}.`,
              },
            ],
            details: resultDetails(
              "write_file",
              mutation.action,
              params.file_path,
              mutation.before ?? "",
              mutation.after,
            ),
          };
        }),
      );
    },
  });
}
