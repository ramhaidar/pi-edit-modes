export interface ReplacementChunk {
  TargetContent: string;
  ReplacementContent: string;
  AllowMultiple?: boolean;
  StartLine?: number;
  EndLine?: number;
}

export interface PlannedReplacement {
  start: number;
  end: number;
  replacement: string;
  chunkIndex: number;
}

export interface ReplacementPlan {
  content: string;
  replacements: PlannedReplacement[];
}

function lineRangeOffsets(content: string, startLine?: number, endLine?: number): { start: number; end: number } {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 13) {
      if (content.charCodeAt(i + 1) === 10) i += 1;
      starts.push(i + 1);
    } else if (code === 10) {
      starts.push(i + 1);
    }
  }
  const lineCount = starts.length;
  const start = startLine ?? 1;
  const end = endLine ?? lineCount;
  if (!Number.isSafeInteger(start) || start < 1) throw new Error("StartLine must be a positive integer");
  if (!Number.isSafeInteger(end) || end < 1) throw new Error("EndLine must be a positive integer");
  if (start > end) throw new Error("StartLine must be <= EndLine");
  if (start > lineCount) throw new Error(`StartLine ${start} exceeds file line count ${lineCount}`);
  if (end > lineCount) throw new Error(`EndLine ${end} exceeds file line count ${lineCount}`);
  return { start: starts[start - 1]!, end: end < lineCount ? starts[end]! : content.length };
}

function preferredLineEnding(content: string): "\r\n" | "\n" | "\r" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  const cr = content.indexOf("\r");
  if (crlf !== -1 && (lf === crlf || crlf < lf) && (cr === crlf || crlf < cr)) return "\r\n";
  if (lf !== -1 && (cr === -1 || lf < cr)) return "\n";
  if (cr !== -1) return "\r";
  return "\n";
}

export function preserveReplacementLineEndings(replacement: string, original: string): string {
  const ending = preferredLineEnding(original);
  return replacement.replace(/\r\n|\r|\n/g, ending);
}

function allExactMatches(haystack: string, needle: string, baseOffset: number): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;
    matches.push({ start: baseOffset + found, end: baseOffset + found + needle.length });
    cursor = found + Math.max(1, needle.length);
  }
  return matches;
}

function allLineEndingInsensitiveMatches(haystack: string, needle: string, baseOffset: number): Array<{ start: number; end: number }> {
  // Non-strict mode is deliberately narrow: only CRLF/CR/LF representation may differ.
  const normalizeWithMap = (text: string) => {
    let normalized = "";
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < text.length;) {
      starts.push(i);
      if (text[i] === "\r" && text[i + 1] === "\n") {
        normalized += "\n";
        i += 2;
        ends.push(i);
      } else if (text[i] === "\r") {
        normalized += "\n";
        i += 1;
        ends.push(i);
      } else {
        normalized += text[i]!;
        i += 1;
        ends.push(i);
      }
    }
    return { normalized, starts, ends };
  };
  const h = normalizeWithMap(haystack);
  const n = normalizeWithMap(needle).normalized;
  if (n.length === 0) return [];
  const normalizedMatches = allExactMatches(h.normalized, n, 0);
  return normalizedMatches.map((match) => ({
    start: baseOffset + (h.starts[match.start] ?? haystack.length),
    end: baseOffset + (h.ends[match.end - 1] ?? haystack.length),
  }));
}

export function planReplacementChunks(
  original: string,
  chunks: readonly ReplacementChunk[],
  options: { strictExactMatch: boolean },
): ReplacementPlan {
  if (chunks.length === 0) throw new Error("ReplacementChunks must contain at least one chunk");
  const planned: PlannedReplacement[] = [];

  chunks.forEach((chunk, chunkIndex) => {
    if (typeof chunk.TargetContent !== "string" || chunk.TargetContent.length === 0) {
      throw new Error(`Replacement chunk ${chunkIndex + 1}: TargetContent must be a non-empty string`);
    }
    if (typeof chunk.ReplacementContent !== "string") {
      throw new Error(`Replacement chunk ${chunkIndex + 1}: ReplacementContent must be a string`);
    }
    const scope = lineRangeOffsets(original, chunk.StartLine, chunk.EndLine);
    const candidate = original.slice(scope.start, scope.end);
    const matches = options.strictExactMatch
      ? allExactMatches(candidate, chunk.TargetContent, scope.start)
      : allLineEndingInsensitiveMatches(candidate, chunk.TargetContent, scope.start);
    if (matches.length === 0) throw new Error(`Replacement chunk ${chunkIndex + 1}: TargetContent was not found in the requested range`);
    if (matches.length > 1 && chunk.AllowMultiple !== true) {
      throw new Error(`Replacement chunk ${chunkIndex + 1}: TargetContent matched ${matches.length} locations; set AllowMultiple=true to replace all`);
    }
    const selected = chunk.AllowMultiple === true ? matches : [matches[0]!];
    const replacement = preserveReplacementLineEndings(chunk.ReplacementContent, original);
    for (const match of selected) planned.push({ ...match, replacement, chunkIndex });
  });

  planned.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < planned.length; i++) {
    const previous = planned[i - 1]!;
    const current = planned[i]!;
    if (current.start < previous.end) {
      throw new Error(`Replacement chunks ${previous.chunkIndex + 1} and ${current.chunkIndex + 1} overlap`);
    }
  }

  let content = original;
  for (const replacement of [...planned].sort((a, b) => b.start - a.start || b.end - a.end)) {
    content = content.slice(0, replacement.start) + replacement.replacement + content.slice(replacement.end);
  }
  return { content, replacements: planned };
}

export function planSingleReplacement(
  original: string,
  chunk: ReplacementChunk,
  options: { strictExactMatch: boolean },
): ReplacementPlan {
  return planReplacementChunks(original, [chunk], options);
}
