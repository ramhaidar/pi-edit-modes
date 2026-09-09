const OMITTED_PREFIXES = new Set([
  "rest of",
  "rest of method",
  "rest of methods",
  "rest of code",
  "unchanged code",
  "unchanged method",
  "unchanged methods",
]);

function isAllDots(value: string): boolean {
  return value.length > 0 && [...value].every((char) => char === ".");
}

function normalizeWhitespace(value: string): string {
  return value
    .trim()
    .split(/[ \t\r\n]+/u)
    .filter(Boolean)
    .join(" ");
}

function normalizePlaceholder(line: string): string | undefined {
  let text = line.trim();
  if (!text) return undefined;
  if (text.startsWith("//")) text = text.slice(2).trim();
  if (text.startsWith("(") && text.endsWith(")")) text = text.slice(1, -1).trim();

  const ellipsisStart = text.indexOf("...");
  if (ellipsisStart < 0) return undefined;
  const prefix = normalizeWhitespace(text.slice(0, ellipsisStart).toLowerCase());
  const suffix = text.slice(ellipsisStart + 3).trim();
  if (!OMITTED_PREFIXES.has(prefix)) return undefined;
  if (suffix && !isAllDots(suffix)) return undefined;
  return `${prefix} ...`;
}

export function detectOmissionPlaceholders(text: string): string[] {
  const matches: string[] = [];
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const normalized = normalizePlaceholder(line);
    if (normalized) matches.push(normalized);
  }
  return matches;
}

export function validateGeminiOmissionPlaceholders(
  toolName: "replace" | "write_file",
  params: Record<string, unknown>,
): void {
  if (toolName === "write_file") {
    const content = typeof params.content === "string" ? params.content : "";
    if (detectOmissionPlaceholders(content).length > 0) {
      throw new Error(
        "`content` contains an omission placeholder (for example 'rest of methods ...'). Provide complete file content.",
      );
    }
    return;
  }

  const oldString = typeof params.old_string === "string" ? params.old_string : "";
  const newString = typeof params.new_string === "string" ? params.new_string : "";
  const oldPlaceholders = new Set(detectOmissionPlaceholders(oldString));
  for (const placeholder of detectOmissionPlaceholders(newString)) {
    if (!oldPlaceholders.has(placeholder)) {
      throw new Error(
        "`new_string` contains an omission placeholder (for example 'rest of methods ...'). Provide exact literal replacement text.",
      );
    }
  }
}

export function normalizeNewFileLineEndings(
  content: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? content.replace(/\r?\n/g, "\r\n") : content;
}

type ChangedRange = { start: number; end: number };
const LCS_CELL_LIMIT = 250_000;

function changedRanges(originalLines: string[], newLines: string[]): ChangedRange[] {
  const n = originalLines.length;
  const m = newLines.length;
  if (n * m > LCS_CELL_LIMIT) {
    let prefix = 0;
    while (prefix < n && prefix < m && originalLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < n - prefix &&
      suffix < m - prefix &&
      originalLines[n - 1 - suffix] === newLines[m - 1 - suffix]
    ) {
      suffix += 1;
    }
    return prefix === n && prefix === m ? [] : [{ start: prefix, end: m - suffix }];
  }

  const decisions = new Uint8Array(Math.max(1, n * m));
  let next = new Uint32Array(m + 1);
  let current = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i -= 1) {
    current[m] = 0;
    for (let j = m - 1; j >= 0; j -= 1) {
      const index = i * m + j;
      if (originalLines[i] === newLines[j]) {
        current[j] = 1 + next[j + 1]!;
        decisions[index] = 0;
      } else if (next[j]! >= current[j + 1]!) {
        current[j] = next[j]!;
        decisions[index] = 1;
      } else {
        current[j] = current[j + 1]!;
        decisions[index] = 2;
      }
    }
    [current, next] = [next, current];
  }

  const ranges: ChangedRange[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (originalLines[i] === newLines[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const decision = decisions[i * m + j];
    if (decision === 1) {
      ranges.push({ start: j, end: j });
      i += 1;
    } else {
      ranges.push({ start: j, end: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    ranges.push({ start: j, end: j });
    i += 1;
  }
  while (j < m) {
    ranges.push({ start: j, end: j + 1 });
    j += 1;
  }
  return ranges;
}

export function getDiffContextSnippet(
  originalContent: string,
  newContent: string,
  contextLines = 5,
): string {
  if (!originalContent) return newContent;
  const originalLines = originalContent.split(/\r?\n/u);
  const newLines = newContent.split(/\r?\n/u);
  const ranges = changedRanges(originalLines, newLines);
  if (ranges.length === 0) return newContent;

  const expanded = ranges
    .map((range) => ({
      start: Math.max(0, range.start - contextLines),
      end: Math.min(newLines.length, range.end + contextLines),
    }))
    .sort((left, right) => left.start - right.start);
  const merged: ChangedRange[] = [];
  for (const range of expanded) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }

  const parts: string[] = [];
  let lastEnd = 0;
  for (const range of merged) {
    if (range.start > lastEnd) parts.push("...");
    parts.push(newLines.slice(range.start, range.end).join("\n"));
    lastEnd = range.end;
  }
  if (lastEnd < newLines.length) parts.push("...");
  return parts.join("\n");
}

export interface GeminiToolContractEntry {
  description: string;
  parameters: Record<string, string>;
}

export interface GeminiToolContract {
  replace: GeminiToolContractEntry;
  write_file: GeminiToolContractEntry;
}

const GEMINI_3_CONTRACT: GeminiToolContract = {
  write_file: {
    description:
      "Writes the complete content to a file, automatically creating missing parent directories. Overwrites existing files. The user has the ability to modify 'content' before it is saved. Best for new or small files; use 'replace' for targeted edits to large files to minimize token usage and simplify reviews.",
    parameters: {
      file_path: "Path to the file.",
      content:
        "The complete content to write. Provide the full file; do not use placeholders like '// ... rest of code'.",
    },
  },
  replace: {
    description:
      "Replaces text within a file. By default, the tool expects to find and replace exactly ONE occurrence of `old_string`. If you want to replace multiple occurrences of the exact same string, set `allow_multiple` to true. This tool is preferred for surgical edits to existing files as it minimizes token usage, simplifies code reviews, and avoids accidental deletions. This tool requires providing significant context around the change to ensure precise targeting.\nThe user has the ability to modify the `new_string` content. If modified, this will be stated in the response.",
    parameters: {
      file_path: "The path to the file to modify.",
      instruction:
        "A clear, semantic instruction for the code change, acting as a high-quality prompt for an expert LLM assistant. It must be self-contained and explain the goal of the change.",
      old_string:
        "The exact literal text to replace, unescaped. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail.",
      new_string:
        "The exact literal text to replace `old_string` with, unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic. Do not use omission placeholders like '(rest of methods ...)', '...', or 'unchanged code'; provide exact literal code.",
      allow_multiple:
        "If true, the tool will replace all occurrences of `old_string`. If false (default), it will only succeed if exactly one occurrence is found.",
    },
  },
};

const LEGACY_CONTRACT: GeminiToolContract = {
  write_file: {
    description:
      "Writes content to a specified file in the local filesystem.\n\n      The user has the ability to modify `content`. If modified, this will be stated in the response.",
    parameters: {
      file_path: "The path to the file to write to.",
      content:
        "The content to write to the file. Do not use omission placeholders like '(rest of methods ...)', '...', or 'unchanged code'; provide complete literal content.",
    },
  },
  replace: {
    description:
      "Replaces text within a file. By default, the tool expects to find and replace exactly ONE occurrence of `old_string`. If you want to replace multiple occurrences of the exact same string, set `allow_multiple` to true. This tool requires providing significant context around the change to ensure precise targeting. Always use the read_file tool to examine the file's current content before attempting a text replacement.\n      \n      The user has the ability to modify the `new_string` content. If modified, this will be stated in the response.\n      \n      Expectation for required parameters:\n      1. `old_string` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code etc.).\n      2. `new_string` MUST be the exact literal text to replace `old_string` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic and that `old_string` and `new_string` are different.\n      3. `instruction` is the detailed instruction of what needs to be changed. It is important to Make it specific and detailed so developers or large language models can understand what needs to be changed and perform the changes on their own if necessary. \n      4. NEVER escape `old_string` or `new_string`, that would break the exact literal text requirement.\n      **Important:** If ANY of the above are not satisfied, the tool will fail. CRITICAL for `old_string`: Must uniquely identify the instance(s) to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations and `allow_multiple` is not true, the tool will fail.\n      5. Prefer to break down complex and long changes into multiple smaller atomic calls to this tool. Always check the content of the file after changes or not finding a string to match.\n      **Multiple replacements:** Set `allow_multiple` to true if you want to replace ALL occurrences that match `old_string` exactly.",
    parameters: {
      file_path: "The path to the file to modify.",
      instruction:
        'A clear, semantic instruction for the code change, acting as a high-quality prompt for an expert LLM assistant. It must be self-contained and explain the goal of the change.\n\nA good instruction should concisely answer:\n1.  WHY is the change needed? (e.g., "To fix a bug where users can be null...")\n2.  WHERE should the change happen? (e.g., "...in the \'renderUserProfile\' function...")\n3.  WHAT is the high-level change? (e.g., "...add a null check for the \'user\' object...")\n4.  WHAT is the desired outcome? (e.g., "...so that it displays a loading spinner instead of crashing.")\n\n**GOOD Example:** "In the \'calculateTotal\' function, correct the sales tax calculation by updating the \'taxRate\' constant from 0.05 to 0.075 to reflect the new regional tax laws."\n\n**BAD Examples:**\n- "Change the text." (Too vague)\n- "Fix the bug." (Doesn\'t explain the bug or the fix)\n- "Replace the line with this new line." (Brittle, just repeats the other parameters)\n',
      old_string:
        "The exact literal text to replace, preferably unescaped. For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail.",
      new_string:
        "The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic. Do not use omission placeholders like '(rest of methods ...)', '...', or 'unchanged code'; provide exact literal code.",
      allow_multiple:
        "If true, the tool will replace all occurrences of `old_string`. If false (default), it will only succeed if exactly one occurrence is found.",
    },
  },
};

export function getGeminiToolContract(modelId?: string): GeminiToolContract {
  return /^gemini-3(?:\.|-|$)/i.test(modelId ?? "") ? GEMINI_3_CONTRACT : LEGACY_CONTRACT;
}
