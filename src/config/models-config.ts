import { readFile, stat } from "node:fs/promises";
import type { ModelOverrideMap, ToolMode } from "./types.ts";
import { isToolMode } from "./schema.ts";

function key(provider: string | undefined, id: string | undefined): string {
  return `${(provider ?? "").trim().toLowerCase()}\u0000${(id ?? "").trim().toLowerCase()}`;
}

export class MutableModelOverrideMap implements ModelOverrideMap {
  private readonly values = new Map<string, ToolMode>();
  set(provider: string | undefined, id: string | undefined, mode: ToolMode): void {
    if (!id) return;
    this.values.set(key(provider, id), mode);
  }
  get(provider: string | undefined, id: string | undefined): ToolMode | undefined {
    if (!id) return undefined;
    return this.values.get(key(provider, id));
  }
}

export interface ParsedModelOverrides {
  overrides: MutableModelOverrideMap;
  warnings: string[];
}

export function parseModelOverrides(value: unknown): ParsedModelOverrides {
  const overrides = new MutableModelOverrideMap();
  const warnings: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { overrides, warnings };
  const providers = (value as Record<string, unknown>).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers))
    return { overrides, warnings };

  for (const [providerName, providerValue] of Object.entries(
    providers as Record<string, unknown>,
  )) {
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue))
      continue;
    const provider = providerValue as Record<string, unknown>;
    if (Array.isArray(provider.models)) {
      for (const modelValue of provider.models) {
        if (!modelValue || typeof modelValue !== "object" || Array.isArray(modelValue)) continue;
        const model = modelValue as Record<string, unknown>;
        const id = typeof model.id === "string" ? model.id : undefined;
        const rawMode = model["x-pi-tool-mode"];
        if (rawMode === undefined) continue;
        if (!isToolMode(rawMode)) {
          warnings.push(
            `Invalid x-pi-tool-mode '${String(rawMode)}' for ${providerName}/${id ?? "(unknown)"}; ignoring override.`,
          );
          continue;
        }
        overrides.set(providerName, id, rawMode);
      }
    }
    if (
      provider.modelOverrides &&
      typeof provider.modelOverrides === "object" &&
      !Array.isArray(provider.modelOverrides)
    ) {
      for (const [modelId, overrideValue] of Object.entries(
        provider.modelOverrides as Record<string, unknown>,
      )) {
        if (!overrideValue || typeof overrideValue !== "object" || Array.isArray(overrideValue))
          continue;
        const rawMode = (overrideValue as Record<string, unknown>)["x-pi-tool-mode"];
        if (rawMode === undefined) continue;
        if (!isToolMode(rawMode)) {
          warnings.push(
            `Invalid x-pi-tool-mode '${String(rawMode)}' for ${providerName}/${modelId}; ignoring override.`,
          );
          continue;
        }
        overrides.set(providerName, modelId, rawMode);
      }
    }
  }
  return { overrides, warnings };
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        output += char;
      } else {
        output += " ";
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else {
        output += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
      continue;
    }
    output += char;
  }
  return output;
}

export function parsePiJsonText(text: string): unknown {
  return JSON.parse(stripJsonComments(stripBom(text)));
}

export async function readModelOverrides(path: string): Promise<ParsedModelOverrides> {
  try {
    const text = await readFile(path, "utf8");
    return parseModelOverrides(parsePiJsonText(text));
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "ENOENT") return { overrides: new MutableModelOverrideMap(), warnings: [] };
    return {
      overrides: new MutableModelOverrideMap(),
      warnings: [
        `Unable to read models.json overrides: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export async function fileMtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return -1;
  }
}
