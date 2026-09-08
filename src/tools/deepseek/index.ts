import { isAbsolute, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { generateDiffString, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { formatDeepSeekFileView } from "./engine.ts";
import { getDeepSeekFsRuntime } from "./runtime.ts";
import {
  DiffCallRenderComponent,
  displayToolPath,
  firstText,
  type CompactFileAction,
  type DiffCallRendererState,
} from "../diff-call-renderer.ts";

export const DEEPSEEK_TOOL_NAME = "str_replace_editor" as const;
const MAX_OUTPUT_CHARS = 16_000;
const TRUNCATED_MESSAGE = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";
const DEFAULT_DESCRIPTION = [
  "Custom editing tool for viewing, creating and editing files",
  "* State is persistent across command calls and discussions with the user",
  "* If `path` is a file, `view` displays the result of applying `cat -n`. If `path` is a directory, `view` lists non-hidden files and directories up to 2 levels deep",
  "* The `create` command cannot be used if the specified `path` already exists as a file",
  "* If a `command` generates a long output, it will be truncated and marked with `<response clipped>`",
  "* A null placeholder for a parameter unused by the selected command is treated as omitted. Required parameters still need values; omit `str_replace.new_str` rather than setting it to null when deleting a match",
  "Notes for using the `str_replace` command:",
  "* The `old_str` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!",
  "* If the `old_str` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in `old_str` to make it unique",
  "* The `new_str` parameter should contain the edited lines that should replace the `old_str`",
].join("\n");

function requireAbsolute(path: string): string {
  if (!path.trim()) throw new Error("path must be a non-empty string");
  if (!isAbsolute(path)) throw new Error(`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`);
  return resolve(path);
}

function requiredForCommand(value: string | undefined, parameter: string, command: string, allowEmpty = true): string {
  if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
  if (!allowEmpty && value.length === 0) throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`);
  return value;
}

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_MESSAGE;
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function directoryListing(displayPath: string, targetKey: string, signal?: AbortSignal): Promise<string> {
  async function visit(displayDir: string, actualDir: string, depth: number): Promise<string[]> {
    if (signal?.aborted) throw new Error("list aborted");
    const entries = await readdir(actualDir, { withFileTypes: true });
    const rows: string[] = [];
    for (const entry of entries.filter((candidate) =>
      !candidate.name.startsWith(".") && candidate.name !== "node_modules" && candidate.name !== "__pycache__")) {
      if (signal?.aborted) throw new Error("list aborted");
      const actualChild = resolve(actualDir, entry.name);
      const displayChild = resolve(displayDir, entry.name);
      let type: "file" | "directory" | "other" = "other";
      try {
        const info = await stat(actualChild);
        type = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
      } catch {
        type = "other";
      }
      rows.push(`${type === "directory" ? "d" : type === "file" ? "f" : "?"}\t${displayChild}`);
      if (type === "directory" && depth < 2) rows.push(...await visit(displayChild, actualChild, depth + 1));
    }
    return rows;
  }
  const rows = [`d\t${displayPath}`, ...await visit(displayPath, targetKey, 1)];
  rows.sort((left, right) => codepointCompare(left.slice(left.indexOf("\t") + 1), right.slice(right.indexOf("\t") + 1)));
  const listing = truncate(rows.join("\n") + "\n");
  return `Here're the files and directories up to 2 levels deep in ${displayPath}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

function deepSeekAction(command: "view" | "create" | "str_replace" | "insert"): CompactFileAction {
  if (command === "view") return "V";
  if (command === "create") return "A";
  return "M";
}

function updateDeepSeekHeader(component: DiffCallRenderComponent, theme: any, action: CompactFileAction, path: string): void {
  component.updateHeader(
    theme.fg("toolTitle", theme.bold(`${DEEPSEEK_TOOL_NAME} ${action} `))
      + theme.fg("accent", displayToolPath(path)),
  );
}

function details(path: string, before: string, after: string, action: CompactFileAction) {
  return { target: path, action, diff: generateDiffString(before, after).diff };
}

function renderResult(result: any, options: any, theme: any, context?: any) {
  const text = firstText(result);
  const isError = context?.isError === true || options?.isError === true;
  const resultDetails = result.details as { target?: string; action?: CompactFileAction; diff?: string } | undefined;

  if (!isError && resultDetails && Object.hasOwn(resultDetails, "diff")) {
    const state = context?.state as DiffCallRendererState | undefined;
    if (state?.callComponent) {
      if (resultDetails.target && resultDetails.action) updateDeepSeekHeader(state.callComponent, theme, resultDetails.action, resultDetails.target);
      state.callComponent.updateResult(text, resultDetails.diff);
    }
    const component = context?.lastComponent instanceof Container ? context.lastComponent : new Container();
    component.clear();
    return component;
  }

  return new Text(theme.fg(isError ? "error" : "success", text ?? (isError ? "Error" : "Done")), 0, 0);
}

export function registerDeepSeekTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: DEEPSEEK_TOOL_NAME,
    label: DEEPSEEK_TOOL_NAME,
    description: DEFAULT_DESCRIPTION,
    promptSnippet: "Use write for file creation/full replacement, edit for targeted literal replacements, and str_replace_editor when its view/create/str_replace/insert interface is useful. Do not edit files through bash, PowerShell, shell redirection, scripts, or inline shell commands.",
    promptGuidelines: [
      "Use view before editing when you need exact file context.",
      "old_str must be an exact unique match for str_replace.",
      "create refuses to overwrite an existing file.",
      "For file mutations, use write, edit, or str_replace_editor instead of bash/PowerShell/shell commands; shell tools are for inspection and execution only.",
    ],
    parameters: Type.Object({
      command: Type.Union([Type.Literal("view"), Type.Literal("create"), Type.Literal("str_replace"), Type.Literal("insert")], { description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`." }),
      path: Type.String({ description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`." }),
      file_text: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Required string parameter of `create` command, with the content of the file to be created. A null placeholder is treated as omitted by commands that do not use this parameter." })),
      insert_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { description: "Required integer parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`. A null placeholder is treated as omitted by commands that do not use this parameter." })),
      new_str: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Optional string parameter of `str_replace` command containing the new string (if omitted, no string will be added). Required string parameter of `insert` command containing the string to insert. A null placeholder is accepted only by commands that do not use this parameter." })),
      old_str: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Required string parameter of `str_replace` command containing the string in `path` to replace. A null placeholder is treated as omitted by commands that do not use this parameter." })),
      view_range: Type.Optional(Type.Union([Type.Array(Type.Integer()), Type.Null()], { description: "Optional parameter of `view` command when `path` points to a file. If omitted or null, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file." })),
    }, { additionalProperties: false }),
    renderCall(args, theme, context) {
      const state = context.state as DiffCallRendererState;
      const component = context.lastComponent instanceof DiffCallRenderComponent
        ? context.lastComponent
        : state.callComponent ?? new DiffCallRenderComponent();
      state.callComponent = component;
      updateDeepSeekHeader(component, theme, deepSeekAction(args.command), args.path);
      return component;
    },
    renderResult,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = getDeepSeekFsRuntime(ctx.cwd);

      if (params.command === "view") {
        const targetPath = requireAbsolute(params.path);
        const viewed = await runtime.editorView(targetPath, signal);
        if (viewed.info.type === "directory") {
          if (params.view_range !== undefined && params.view_range !== null) {
            throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
          }
          return { content: [{ type: "text", text: await directoryListing(viewed.target.displayPath, viewed.target.targetKey, signal) }] };
        }
        return { content: [{ type: "text", text: truncate(formatDeepSeekFileView(viewed.target.displayPath, viewed.content ?? "", params.view_range ?? undefined)) }] };
      }

      if (params.command === "create") {
        const content = requiredForCommand(params.file_text ?? undefined, "file_text", "create");
        const targetPath = requireAbsolute(params.path);
        const outcome = await runtime.editorCreate(targetPath, content, signal);
        return {
          content: [{ type: "text", text: `New file created successfully at: ${outcome.path}` }],
          details: details(outcome.path, outcome.before, outcome.after, "A"),
        };
      }

      if (params.command === "str_replace") {
        if (params.new_str === null) throw new Error("Parameter `new_str` must be omitted or contain a string for command: str_replace");
        const targetPath = requireAbsolute(params.path);
        const outcome = await runtime.editorReplace(targetPath, params.old_str ?? undefined, params.new_str ?? undefined, signal);
        return {
          content: [{ type: "text", text: `The file ${outcome.path} has been edited successfully.` }],
          details: details(outcome.path, outcome.before, outcome.after, "M"),
        };
      }

      if (params.insert_line === undefined || params.insert_line === null) throw new Error("Parameter `insert_line` is required for command: insert");
      const value = requiredForCommand(params.new_str ?? undefined, "new_str", "insert");
      const targetPath = requireAbsolute(params.path);
      const outcome = await runtime.editorInsert(targetPath, params.insert_line, value, signal);
      return {
        content: [{ type: "text", text: `The file ${outcome.path} has been edited successfully.` }],
        details: details(outcome.path, outcome.before, outcome.after, "M"),
      };
    },
  });
}
