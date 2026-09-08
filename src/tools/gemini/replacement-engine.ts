export interface GeminiReplaceParams {
  file_path?: string;
  instruction?: string;
  old_string: string;
  new_string: string;
  allow_multiple?: boolean;
}

export type ReplacementStrategy = "exact" | "flexible" | "regex" | "fuzzy";

export interface ReplacementPlan {
  content: string;
  occurrences: number;
  strategy: ReplacementStrategy;
  finalOldString: string;
  finalNewString: string;
  matchRanges?: Array<{ start: number; end: number }>;
}

const FUZZY_MATCH_THRESHOLD = 0.1;
const WHITESPACE_PENALTY_FACTOR = 0.1;
const FUZZY_COMPLEXITY_LIMIT = 400_000_000;

function normalizeLf(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(value: string): "\r\n" | "\n" | "\r" {
  const match = value.match(/\r\n|\r|\n/);
  return (match?.[0] as "\r\n" | "\n" | "\r" | undefined) ?? "\n";
}

export function preserveReplacementLineEndings(replacement: string, original: string): string {
  const ending = detectLineEnding(original);
  return normalizeLf(replacement).replace(/\n/g, ending);
}

function restoreOriginalLineEndings(original: string, normalized: string): string {
  return normalized.replace(/\n/g, detectLineEnding(original));
}

function restoreTrailingNewline(original: string, modified: string): string {
  const hadTrailing = /(?:\r\n|\r|\n)$/.test(original);
  const hasTrailing = /(?:\r\n|\r|\n)$/.test(modified);
  if (hadTrailing && !hasTrailing) return modified + detectLineEnding(original);
  if (!hadTrailing && hasTrailing) return modified.replace(/(?:\r\n|\r|\n)$/, "");
  return modified;
}

function occurrenceCount(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    count += 1;
    cursor = found + Math.max(1, needle.length);
  }
  return count;
}

function literalReplaceAll(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}

function applyIndentation(lines: string[], targetIndentation: string): string[] {
  if (lines.length === 0) return [];
  const referenceIndent = lines[0]?.match(/^([ \t]*)/)?.[1] ?? "";
  return lines.map((line) => {
    if (line.trim() === "") return "";
    if (line.startsWith(referenceIndent)) return targetIndentation + line.slice(referenceIndent.length);
    return targetIndentation + line.trimStart();
  });
}

function sourceLinesWithEndings(content: string): string[] {
  if (content.length === 0) return [];
  return content.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
}

function exactReplacement(original: string, params: GeminiReplaceParams): ReplacementPlan | undefined {
  const normalized = normalizeLf(original);
  const oldString = normalizeLf(params.old_string);
  const newString = normalizeLf(params.new_string);
  const occurrences = occurrenceCount(normalized, oldString);
  if (occurrences === 0) return undefined;
  const next = literalReplaceAll(normalized, oldString, newString);
  return {
    content: restoreTrailingNewline(original, restoreOriginalLineEndings(original, next)),
    occurrences,
    strategy: "exact",
    finalOldString: oldString,
    finalNewString: newString,
  };
}

function flexibleReplacement(original: string, params: GeminiReplaceParams): ReplacementPlan | undefined {
  const normalized = normalizeLf(original);
  const oldString = normalizeLf(params.old_string);
  const newString = normalizeLf(params.new_string);
  const sourceLines = sourceLinesWithEndings(normalized);
  const searchLines = oldString.split("\n").map((line) => line.trim());
  const replacementLines = newString.split("\n");
  if (searchLines.length === 0) return undefined;

  let occurrences = 0;
  let i = 0;
  while (i <= sourceLines.length - searchLines.length) {
    const window = sourceLines.slice(i, i + searchLines.length);
    const matches = window.every((line, index) => line.trim() === searchLines[index]);
    if (matches) {
      occurrences += 1;
      const indentation = window[0]?.match(/^([ \t]*)/)?.[1] ?? "";
      let replacement = applyIndentation(replacementLines, indentation).join("\n");
      if (params.new_string !== "" && window.at(-1)?.endsWith("\n") && !replacement.endsWith("\n")) replacement += "\n";
      sourceLines.splice(i, searchLines.length, replacement);
    }
    i += 1;
  }

  if (occurrences === 0) return undefined;
  const next = sourceLines.join("");
  return {
    content: restoreTrailingNewline(original, restoreOriginalLineEndings(original, next)),
    occurrences,
    strategy: "flexible",
    finalOldString: oldString,
    finalNewString: newString,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function regexReplacement(original: string, params: GeminiReplaceParams): ReplacementPlan | undefined {
  const oldString = normalizeLf(params.old_string);
  const newString = normalizeLf(params.new_string);
  const delimiters = ["(", ")", ":", "[", "]", "{", "}", ">", "<", "="];
  let processed = oldString;
  for (const delimiter of delimiters) processed = processed.split(delimiter).join(` ${delimiter} `);
  const tokens = processed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  const pattern = tokens.map(escapeRegex).join("\\s*");
  const finalPattern = `^([ \\t]*)${pattern}`;
  const normalized = normalizeLf(original);
  const allMatches = normalized.match(new RegExp(finalPattern, "gm"));
  if (!allMatches) return undefined;

  const replacementLines = newString.split("\n");
  const flags = params.allow_multiple ? "gm" : "m";
  const next = normalized.replace(new RegExp(finalPattern, flags), (_match, indentation: string) =>
    applyIndentation(replacementLines, indentation ?? "").join("\n"));
  return {
    content: restoreTrailingNewline(original, restoreOriginalLineEndings(original, next)),
    occurrences: allMatches.length,
    strategy: "regex",
    finalOldString: oldString,
    finalNewString: newString,
  };
}

function stripWhitespace(value: string): string {
  return value.replace(/\s/g, "");
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array<number>(right.length + 1);
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function fuzzyReplacement(original: string, params: GeminiReplaceParams): ReplacementPlan | undefined {
  if (params.old_string.length < 10) return undefined;
  const normalized = normalizeLf(original);
  const oldString = normalizeLf(params.old_string);
  const newString = normalizeLf(params.new_string);
  const sourceLines = sourceLinesWithEndings(normalized);
  if (sourceLines.length * Math.pow(params.old_string.length, 2) > FUZZY_COMPLEXITY_LIMIT) return undefined;
  const searchLines = sourceLinesWithEndings(oldString).map((line) => line.trimEnd());
  if (searchLines.length === 0) return undefined;

  const windowSize = searchLines.length;
  const searchBlock = searchLines.join("\n");
  const candidates: Array<{ index: number; score: number }> = [];
  for (let i = 0; i <= sourceLines.length - windowSize; i += 1) {
    const windowText = sourceLines.slice(i, i + windowSize).map((line) => line.trimEnd()).join("\n");
    const lengthDiff = Math.abs(windowText.length - searchBlock.length);
    if (searchBlock.length === 0 || lengthDiff / searchBlock.length > FUZZY_MATCH_THRESHOLD / WHITESPACE_PENALTY_FACTOR) continue;
    const rawDistance = levenshtein(windowText, searchBlock);
    const normalizedDistance = levenshtein(stripWhitespace(windowText), stripWhitespace(searchBlock));
    const weightedDistance = normalizedDistance + (rawDistance - normalizedDistance) * WHITESPACE_PENALTY_FACTOR;
    const score = weightedDistance / searchBlock.length;
    if (score <= FUZZY_MATCH_THRESHOLD) candidates.push({ index: i, score });
  }
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  const selected: Array<{ index: number; score: number }> = [];
  for (const candidate of candidates) {
    if (!selected.some((match) => Math.abs(match.index - candidate.index) < windowSize)) selected.push(candidate);
  }
  if (selected.length === 0) return undefined;
  const matchRanges = selected.map((match) => ({ start: match.index + 1, end: match.index + windowSize })).sort((a, b) => a.start - b.start);
  const replacementLines = newString.split("\n");
  for (const match of [...selected].sort((a, b) => b.index - a.index)) {
    const indentation = sourceLines[match.index]?.match(/^([ \t]*)/)?.[1] ?? "";
    let replacement = applyIndentation(replacementLines, indentation).join("\n");
    if (sourceLines[match.index + windowSize - 1]?.endsWith("\n") && !replacement.endsWith("\n")) replacement += "\n";
    sourceLines.splice(match.index, windowSize, replacement);
  }
  return {
    content: restoreTrailingNewline(original, restoreOriginalLineEndings(original, sourceLines.join(""))),
    occurrences: selected.length,
    strategy: "fuzzy",
    finalOldString: oldString,
    finalNewString: newString,
    matchRanges,
  };
}

export function planSingleReplacement(original: string, params: GeminiReplaceParams): ReplacementPlan {
  if (typeof params.old_string !== "string" || params.old_string.length === 0) throw new Error("old_string must be a non-empty string");
  if (typeof params.new_string !== "string") throw new Error("new_string must be a string");

  const plan = exactReplacement(original, params)
    ?? flexibleReplacement(original, params)
    ?? regexReplacement(original, params)
    ?? fuzzyReplacement(original, params);
  const target = params.file_path ? ` in '${params.file_path}'` : "";
  if (!plan) throw new Error(`Could not find an exact match for old_string${target}.`);
  if (!params.allow_multiple && plan.occurrences !== 1) {
    throw new Error(`Failed to edit, expected 1 occurrence but found ${plan.occurrences}${target}. Set allow_multiple=true to replace all.`);
  }
  if (plan.finalOldString === plan.finalNewString) throw new Error(`No changes to apply. old_string and new_string are identical${target}.`);
  return plan;
}
