import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";


export type CompactFileAction = "A" | "M" | "D" | "V";

/**
 * Render workspace-relative targets in the same compact form as Pi native file tools.
 * Absolute POSIX/Windows paths are preserved; relative paths get a leading slash.
 */
export function displayToolPath(target: unknown): string {
  if (typeof target !== "string") return "...";
  const raw = target;
  const value = raw.trim();
  if (!value) return raw;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return value;
  const relative = value.replace(/^\.([\\/])/, "").replace(/^[\\/]+/, "");
  return `/${relative}`;
}

export function compactFileHeader(toolName: string, action: CompactFileAction, target: string): string {
  return `${toolName} ${action} ${displayToolPath(target)}`;
}


export type ApplyPatchPreviewTarget = {
  action: "A" | "M" | "D";
  path: string;
  movePath?: string;
};

/**
 * Fault-tolerant V4A target scan for render-time previews.
 *
 * apply_patch arguments are streamed, so the strict/streaming grammar parser can
 * temporarily have no complete hunk yet even though the file header is already
 * visible in the current input buffer. This scan intentionally ignores malformed
 * non-header lines and also considers the unterminated final line, allowing the
 * compact call title to expose action + path as soon as they arrive.
 */
export function scanApplyPatchPreviewTargets(input: unknown): ApplyPatchPreviewTarget[] {
  if (typeof input !== "string" || input.length === 0) return [];

  const targets: ApplyPatchPreviewTarget[] = [];
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (const raw of normalized.split("\n")) {
    const line = raw.trim();
    let action: ApplyPatchPreviewTarget["action"] | undefined;
    let path: string | undefined;

    if (line.startsWith("*** Add File: ")) {
      action = "A";
      path = line.slice("*** Add File: ".length).trim();
    } else if (line.startsWith("*** Delete File: ")) {
      action = "D";
      path = line.slice("*** Delete File: ".length).trim();
    } else if (line.startsWith("*** Update File: ")) {
      action = "M";
      path = line.slice("*** Update File: ".length).trim();
    } else if (line.startsWith("*** Move to: ")) {
      const current = targets.at(-1);
      const movePath = line.slice("*** Move to: ".length).trim();
      if (current?.action === "M" && movePath) current.movePath = movePath;
      continue;
    }

    if (action && path) targets.push({ action, path });
  }

  return targets;
}

export type DiffCallRendererState = {
  callComponent?: DiffCallRenderComponent;
};

function normalizedDiffRows(diff: string): string[] {
  const rows = diff.replace(/\r\n/g, "\n").split("\n");
  while (rows.length > 0 && rows[0]!.trim().length === 0) rows.shift();
  while (rows.length > 0 && rows.at(-1)!.trim().length === 0) rows.pop();
  return rows;
}

/**
 * Render edit results in the call body rather than only in renderResult.
 *
 * This deliberately mirrors the apply_patch renderer. Tool-display wrappers can
 * then treat the first row as the header and the remaining rows as body output:
 * header-only modes hide them, collapsed modes cap them, and expanded modes show
 * the complete diff. Keeping this component self-contained also avoids nesting
 * Pi's native edit/write renderers inside custom tools.
 */
export class DiffCallRenderComponent {
  private header = "edit";
  private resultText?: string;
  private diff?: string;

  updateHeader(header: string): void {
    this.header = header;
  }

  updateResult(resultText: string | undefined, diff: string | undefined): void {
    this.resultText = resultText;
    this.diff = diff;
  }

  render(width: number): string[] {
    const output = [this.header];
    if (this.resultText) {
      for (const row of this.resultText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
        output.push(row.length > 0 ? `  ${row}` : "");
      }
    }
    if (this.diff) {
      for (const row of normalizedDiffRows(this.diff)) output.push(`    ${row}`);
    }
    if (width <= 0) return output;
    return output.map((row) => visibleWidth(row) > width ? truncateToWidth(row, width, "...") : row);
  }

  invalidate(): void {
    // Pi owns the outer render lifecycle.
  }
}

export function firstText(result: { content?: Array<{ type?: string; text?: string }> }): string | undefined {
  return result.content?.find((item) => item?.type === "text")?.text;
}
