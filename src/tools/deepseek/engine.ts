export function uniqueExactReplace(content: string, oldStr: string, newStr = ""): { content: string; line: number } {
  if (oldStr.length === 0) throw new Error("Parameter `old_str` is empty for command: str_replace");
  const first = content.indexOf(oldStr);
  if (first < 0) throw new Error("No replacement was performed because `old_str` was not found in the file.");
  const offsets: number[] = [];
  let cursor = 0;
  while (true) {
    const match = content.indexOf(oldStr, cursor);
    if (match < 0) break;
    offsets.push(match);
    cursor = match + oldStr.length;
  }
  if (offsets.length > 1) {
    const lines = offsets.map((offset) => 1 + content.slice(0, offset).split("\n").length - 1);
    throw new Error(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines [${lines.join(", ")}]. Please ensure it is unique`);
  }
  return {
    content: content.slice(0, first) + newStr + content.slice(first + oldStr.length),
    line: 1 + content.slice(0, first).split("\n").length - 1,
  };
}

export function insertAfterLine(content: string, insertLine: number, newStr: string): string {
  const lines = content.split("\n");
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    throw new Error(`Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`);
  }
  return [...lines.slice(0, insertLine), ...newStr.split("\n"), ...lines.slice(insertLine)].join("\n");
}

export function formatDeepSeekFileView(path: string, content: string, viewRange?: number[]): string {
  const allLines = content.split("\n");
  let initialLine = 1;
  let finalLine: number | undefined;
  let lines = allLines;
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;

  if (viewRange !== undefined) {
    if (viewRange.length !== 2 || !viewRange.every(Number.isInteger)) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.");
    }
    initialLine = viewRange[0]!;
    finalLine = viewRange[1]!;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`);
    }
    if (finalLine > allLines.length) {
      throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``);
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``);
    }
    lines = finalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, finalLine);
    prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
  }

  const numbered = lines.map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`).join("\n");
  return `${prompt}:\n${numbered}\n`;
}
