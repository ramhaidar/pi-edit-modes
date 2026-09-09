import {
  generateDiffString,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { withSharedSecureFilesystem } from "../codex/engine.ts";
import { calculateGeminiMutation, takeGeminiMutation } from "./lifecycle.ts";
import { getDiffContextSnippet, getGeminiToolContract } from "./upstream-parity.ts";
import { validateGeminiWorkspacePath } from "./workspace-access.ts";
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

export function registerGeminiTools(pi: ExtensionAPI): void {
  const contract = getGeminiToolContract();
  pi.registerTool({
    name: "replace",
    label: "replace",
    description: contract.replace.description,
    parameters: Type.Object(
      {
        file_path: Type.String({ description: contract.replace.parameters.file_path }),
        instruction: Type.String({ description: contract.replace.parameters.instruction }),
        old_string: Type.String({ description: contract.replace.parameters.old_string }),
        new_string: Type.String({ description: contract.replace.parameters.new_string }),
        allow_multiple: Type.Optional(
          Type.Boolean({ description: contract.replace.parameters.allow_multiple }),
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
        takeGeminiMutation(toolCallId, ctx) ??
        (await calculateGeminiMutation(toolCallId, "replace", params, ctx, signal));
      await validateGeminiWorkspacePath(ctx.cwd, mutation.absolutePath);
      return withFileMutationQueue(mutation.absolutePath, () =>
        withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
          const current = await fs.readFileOptional(mutation.absolutePath, signal);
          if (current !== mutation.before)
            throw new Error(
              `replace target '${params.file_path}' changed after proposal calculation; re-read and retry`,
            );
          await validateGeminiWorkspacePath(ctx.cwd, mutation.absolutePath);
          if (mutation.before === undefined)
            await fs.createFile(mutation.absolutePath, mutation.after, signal);
          else if (mutation.after !== mutation.before)
            await fs.writeFile(mutation.absolutePath, mutation.after, false, signal);
          const strategy =
            mutation.strategy && mutation.strategy !== "exact" && mutation.strategy !== "fuzzy"
              ? ` using ${mutation.strategy} recovery`
              : "";
          const fuzzyFeedback =
            mutation.strategy === "fuzzy" && mutation.matchRanges?.length
              ? `Applied fuzzy match at line${mutation.matchRanges.length > 1 ? "s" : ""} ${mutation.matchRanges
                  .map((range) =>
                    range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`,
                  )
                  .join(", ")}.`
              : undefined;
          const count = mutation.occurrences ?? 0;
          const successParts = [
            mutation.before === undefined
              ? `Successfully created and wrote to new file: ${mutation.absolutePath}.`
              : `Successfully modified file: ${mutation.absolutePath} (${count} replacements).`,
          ];
          if (mutation.modifiedByUser) {
            successParts.push(
              `The confirmation step modified the \`new_string\` content to be: ${mutation.effectiveNewString ?? ""}.`,
            );
          }
          if (fuzzyFeedback) successParts.push(fuzzyFeedback);
          if (mutation.before === undefined || mutation.after !== mutation.before) {
            successParts.push(
              `Here is the updated code:\n${getDiffContextSnippet(mutation.before ?? "", mutation.after, 5)}`,
            );
          }
          return {
            content: [
              {
                type: "text",
                text: `${successParts.join(" ")}${strategy}`,
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
    description: contract.write_file.description,
    parameters: Type.Object(
      {
        file_path: Type.String({ description: contract.write_file.parameters.file_path }),
        content: Type.String({ description: contract.write_file.parameters.content }),
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
      const mutation =
        takeGeminiMutation(toolCallId, ctx) ??
        (await calculateGeminiMutation(toolCallId, "write_file", params, ctx, signal));
      await validateGeminiWorkspacePath(ctx.cwd, mutation.absolutePath);
      return withFileMutationQueue(mutation.absolutePath, () =>
        withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
          const current = await fs.readFileOptional(mutation.absolutePath, signal);
          if (current !== mutation.before)
            throw new Error(
              `write_file target '${params.file_path}' changed after proposal calculation; retry with current content`,
            );
          await validateGeminiWorkspacePath(ctx.cwd, mutation.absolutePath);
          if (mutation.before === undefined)
            await fs.createFile(mutation.absolutePath, mutation.after, signal);
          else if (mutation.after !== mutation.before)
            await fs.writeFile(mutation.absolutePath, mutation.after, false, signal);
          const correction = mutation.corrected ? " after content correction" : "";
          const successParts = [
            mutation.before === undefined
              ? `Successfully created and wrote to new file: ${mutation.absolutePath}.`
              : `Successfully overwrote file: ${mutation.absolutePath}.`,
          ];
          if (mutation.modifiedByUser) {
            successParts.push(
              `User modified the \`content\` to be: ${mutation.effectiveContent ?? ""}`,
            );
          }
          if (mutation.before === undefined || mutation.after !== mutation.before) {
            successParts.push(
              `Here is the updated code:\n${getDiffContextSnippet(mutation.before ?? "", mutation.after, 5)}`,
            );
          }
          return {
            content: [
              {
                type: "text",
                text: `${successParts.join(" ")}${correction}`,
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
