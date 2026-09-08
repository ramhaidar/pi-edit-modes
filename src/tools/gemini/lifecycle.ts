import { randomUUID } from "node:crypto";
import { extname, isAbsolute, resolve } from "node:path";
import { generateDiffString, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withSharedSecureFilesystem } from "../codex/engine.ts";
import {
  planSingleReplacement,
  preserveReplacementLineEndings,
  type ReplacementStrategy,
} from "./replacement-engine.ts";

export type GeminiMutationToolName = "replace" | "write_file";
export interface PreparedGeminiMutation {
  toolCallId: string;
  toolName: GeminiMutationToolName;
  filePath: string;
  absolutePath: string;
  before: string | undefined;
  after: string;
  action: "A" | "M";
  occurrences?: number;
  strategy?: ReplacementStrategy;
  corrected?: boolean;
  modifiedByUser?: boolean;
}

const prepared = new Map<string, PreparedGeminiMutation>();
const JSON_FAMILY = new Set([".json", ".json5", ".jsonc", ".ipynb"]);
const targetPath = (cwd: string, path: string) =>
  isAbsolute(path) ? resolve(path) : resolve(cwd, path);

function effectiveSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(40_000);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

function responseText(response: any): string {
  return Array.isArray(response?.content)
    ? response.content
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim()
    : "";
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  for (const candidate of [text, start >= 0 && end > start ? text.slice(start, end + 1) : ""]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {}
  }
  return undefined;
}

async function utilityJson(
  ctx: ExtensionContext | any,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
) {
  if (!ctx?.model || typeof ctx?.modelRegistry?.complete !== "function") return undefined;
  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt,
        messages: [
          { role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() },
        ],
      },
      {
        maxTokens: 2048,
        signal: effectiveSignal(signal),
        cacheRetention: "none",
        sessionId: `pi-edit-modes-${randomUUID()}`,
      },
    );
    return parseJson(responseText(response));
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

export function unescapeStringForGeminiBug(input: string): string {
  return input.replace(/\\+(n|t|r|'|"|`|\\|\n)/g, (match, captured: string) => {
    switch (captured) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "'":
        return "'";
      case '"':
        return '"';
      case "`":
        return "`";
      case "\\":
        return "\\";
      case "\n":
        return "\n";
      default:
        return match;
    }
  });
}

function shouldAggressivelyUnescape(ctx: any): boolean {
  const id = String(ctx?.model?.id ?? ctx?.model?.name ?? "").toLowerCase();
  if (!id.includes("gemini")) return false;
  return !/(?:^|[-_/])gemini[-_ ]?[23](?:\D|$)/i.test(id);
}

async function correctWriteContent(
  ctx: any,
  filePath: string,
  content: string,
  disableLLMCorrection: boolean,
  signal?: AbortSignal,
) {
  if (JSON_FAMILY.has(extname(filePath).toLowerCase())) return { content, corrected: false };
  const unescaped = unescapeStringForGeminiBug(content);
  if (unescaped === content) return { content, corrected: false };
  if (disableLLMCorrection) {
    const aggressive = shouldAggressivelyUnescape(ctx);
    return aggressive ? { content: unescaped, corrected: true } : { content, corrected: false };
  }
  const result = await utilityJson(
    ctx,
    "Correct only unintended over-escaping in generated file content. Do not rewrite, shorten, or improve anything else. Return only JSON with string field corrected_string_escaping.",
    `Potentially over-escaped content:\n${content}`,
    signal,
  );
  const corrected = result?.corrected_string_escaping;
  return typeof corrected === "string" && corrected.length > 0
    ? { content: corrected, corrected: corrected !== content }
    : { content, corrected: false };
}

async function correctFailedReplace(
  ctx: any,
  params: Record<string, unknown>,
  error: Error,
  latest: string,
  signal?: AbortSignal,
) {
  const result = await utilityJson(
    ctx,
    "Correct a failed literal search-and-replace with the smallest possible search-text change. Do not redesign the requested edit. Preserve replacement unless minimally necessary. Return only JSON with string fields search, replace, explanation and boolean noChangesRequired.",
    `Instruction:\n${String(params.instruction ?? "")}\n\nFailed search:\n${String(params.old_string ?? "")}\n\nReplacement:\n${String(params.new_string ?? "")}\n\nError:\n${error.message}\n\nLatest file content:\n${latest}`,
    signal,
  );
  if (result?.noChangesRequired === true) return { noChangesRequired: true as const };
  if (
    typeof result?.search !== "string" ||
    typeof result?.replace !== "string" ||
    result.search.length === 0
  )
    return undefined;
  return { noChangesRequired: false as const, oldString: result.search, newString: result.replace };
}

export async function calculateGeminiMutation(
  toolCallId: string,
  toolName: GeminiMutationToolName,
  params: Record<string, unknown>,
  ctx: any,
  signal?: AbortSignal,
  options: { disableLLMCorrection?: boolean } = {},
): Promise<PreparedGeminiMutation> {
  const disableLLMCorrection = options.disableLLMCorrection ?? true;
  const filePath = typeof params.file_path === "string" ? params.file_path : "";
  if (!filePath) throw new Error("file_path must be a non-empty string");
  const absolutePath = targetPath(ctx.cwd, filePath);
  return withSharedSecureFilesystem(ctx.cwd, signal, async (fs) => {
    const before = await fs.readFileOptional(absolutePath, signal);
    if (toolName === "write_file") {
      if (typeof params.content !== "string") throw new Error("content must be a string");
      const corrected = await correctWriteContent(
        ctx,
        filePath,
        params.content,
        disableLLMCorrection,
        signal,
      );
      const after =
        before === undefined
          ? corrected.content
          : preserveReplacementLineEndings(corrected.content, before);
      return {
        toolCallId,
        toolName,
        filePath,
        absolutePath,
        before,
        after,
        action: before === undefined ? "A" : "M",
        corrected: corrected.corrected,
      };
    }

    const oldString = typeof params.old_string === "string" ? params.old_string : undefined;
    const newString = typeof params.new_string === "string" ? params.new_string : undefined;
    if (oldString === undefined || newString === undefined)
      throw new Error("old_string and new_string must be strings");
    if (before === undefined) {
      if (oldString !== "")
        throw new Error(
          "File not found. Cannot apply edit. Use an empty old_string to create a new file.",
        );
      return {
        toolCallId,
        toolName,
        filePath,
        absolutePath,
        before,
        after: newString,
        action: "A",
        occurrences: 1,
      };
    }
    if (oldString === "")
      throw new Error("Failed to edit. Attempted to create a file that already exists.");

    try {
      const plan = planSingleReplacement(before, {
        file_path: filePath,
        instruction: String(params.instruction ?? ""),
        old_string: oldString,
        new_string: newString,
        allow_multiple: params.allow_multiple === true,
      });
      return {
        toolCallId,
        toolName,
        filePath,
        absolutePath,
        before,
        after: plan.content,
        action: "M",
        occurrences: plan.occurrences,
        strategy: plan.strategy,
      };
    } catch (initial) {
      const error = initial instanceof Error ? initial : new Error(String(initial));
      if (disableLLMCorrection || JSON_FAMILY.has(extname(filePath).toLowerCase())) throw error;
      const latest = await fs.readFileOptional(absolutePath, signal);
      if (latest === undefined) throw error;
      const fixed = await correctFailedReplace(ctx, params, error, latest, signal);
      if (!fixed) throw error;
      if (fixed.noChangesRequired)
        return {
          toolCallId,
          toolName,
          filePath,
          absolutePath,
          before: latest,
          after: latest,
          action: "M",
          occurrences: 0,
          corrected: true,
        };
      const retry = planSingleReplacement(latest, {
        file_path: filePath,
        instruction: String(params.instruction ?? ""),
        old_string: fixed.oldString,
        new_string: fixed.newString,
        allow_multiple: params.allow_multiple === true,
      });
      return {
        toolCallId,
        toolName,
        filePath,
        absolutePath,
        before: latest,
        after: retry.content,
        action: "M",
        occurrences: retry.occurrences,
        strategy: retry.strategy,
        corrected: true,
      };
    }
  });
}

export function mutationDiff(mutation: PreparedGeminiMutation): string {
  return generateDiffString(mutation.before ?? "", mutation.after).diff;
}
export function rememberGeminiMutation(mutation: PreparedGeminiMutation): void {
  prepared.set(mutation.toolCallId, mutation);
}
export function takeGeminiMutation(toolCallId: string): PreparedGeminiMutation | undefined {
  const value = prepared.get(toolCallId);
  if (value) prepared.delete(toolCallId);
  return value;
}
export function modifyGeminiMutation(
  mutation: PreparedGeminiMutation,
  after: string,
): PreparedGeminiMutation {
  const normalized =
    mutation.before === undefined ? after : preserveReplacementLineEndings(after, mutation.before);
  return { ...mutation, after: normalized, modifiedByUser: true };
}

export async function handleGeminiToolCall(
  event: any,
  ctx: any,
  approval: "ask_user" | "auto_edit",
  disableLLMCorrection = true,
): Promise<{ block: true; reason: string } | undefined> {
  if (event?.toolName !== "replace" && event?.toolName !== "write_file") return;
  if (!event.input || typeof event.input !== "object") return;
  const mutation = await calculateGeminiMutation(
    event.toolCallId,
    event.toolName,
    event.input,
    ctx,
    ctx.signal,
    { disableLLMCorrection },
  );
  if (approval === "auto_edit") {
    rememberGeminiMutation(mutation);
    return;
  }

  const path = typeof event.input.file_path === "string" ? event.input.file_path : "(unknown path)";
  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `Gemini ${event.toolName} requires user approval, but this session has no interactive UI.`,
    };
  }
  const approved = await ctx.ui.confirm(
    "Approve Gemini file edit",
    `${event.toolName} ${path}\n\n${mutationDiff(mutation) || "(No content change required.)"}`,
  );
  if (!approved)
    return { block: true, reason: `User rejected Gemini ${event.toolName} for ${path}.` };

  let approvedMutation = mutation;
  const action = await ctx.ui.select("Gemini proposed content", [
    "Use proposed content",
    "Edit proposed content",
    "Reject",
  ]);
  if (action === "Reject" || action === undefined)
    return { block: true, reason: `User rejected Gemini ${event.toolName} for ${path}.` };
  if (action === "Edit proposed content") {
    const edited = await ctx.ui.editor(`Edit proposed ${event.toolName}: ${path}`, mutation.after);
    if (edited === undefined)
      return {
        block: true,
        reason: `User cancelled Gemini ${event.toolName} content review for ${path}.`,
      };
    approvedMutation = modifyGeminiMutation(mutation, edited);
  }
  rememberGeminiMutation(approvedMutation);
}

export function geminiDescriptions(modelId?: string) {
  const gemini3 = /(?:^|[-_/])gemini[-_]?3(?:\D|$)/i.test(modelId ?? "");
  return gemini3
    ? {
        replace:
          "Replaces text within a file. By default exactly one occurrence of old_string must change; set allow_multiple=true only when all matching occurrences should change. Prefer this for surgical edits, provide significant context, and note that the user may modify new_string before saving.",
        write_file:
          "Writes complete content to a file, creating missing parent directories and overwriting existing files. The user may modify content before saving. Prefer replace for targeted edits to larger files.",
      }
    : {
        replace:
          "Replaces literal text within a file. Read the current file first, provide substantial exact context, keep old_string/new_string unescaped, and use allow_multiple only when every match should change. The user may modify new_string before saving.",
        write_file:
          "Writes content to a specified file in the local filesystem. The user may modify content before saving.",
      };
}
