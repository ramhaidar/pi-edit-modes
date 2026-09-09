import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const MAX_PATH_LENGTH = 4096;
const MAX_COMPONENT_LENGTH = 255;
const GIT_SFN_REGEX = /^(git|gi[0-9a-f]{4})~\d+$/;
const ENV_SFN_REGEX = /^(env|en[0-9a-f]{4})~\d+$/;
const NODE_MODULES_SFN_REGEX = /^(node_m|no[0-9a-f]{4})~\d+$/;
const GHA_CREDS_SFN_REGEX = /^(gha-cr|gh[0-9a-f]{4})~\d+\.jso(n)?$/;

function trimTrailingSpacesAndDots(value: string): string {
  let end = value.length - 1;
  while (end >= 0 && (value[end] === " " || value[end] === ".")) end -= 1;
  return value.slice(0, end + 1);
}

export function hasGeminiBlockedPathSegment(pathValue: string): boolean {
  for (const segment of pathValue.split(/[/\\]/)) {
    const clean = trimTrailingSpacesAndDots(segment.split(":")[0] ?? "").toLowerCase();
    if (
      clean === ".git" ||
      clean === ".env" ||
      clean === "node_modules" ||
      GIT_SFN_REGEX.test(clean) ||
      ENV_SFN_REGEX.test(clean) ||
      NODE_MODULES_SFN_REGEX.test(clean)
    ) {
      return true;
    }
    if (
      (clean.startsWith("gha-creds-") && clean.endsWith(".json")) ||
      GHA_CREDS_SFN_REGEX.test(clean)
    ) {
      return true;
    }
  }
  return false;
}

export function validateGeminiPath(pathValue: string): { isValid: boolean; error?: string } {
  if (!pathValue || typeof pathValue !== "string") {
    return { isValid: false, error: "Path must be a non-empty string." };
  }
  if (/[\n\r\0\t]/.test(pathValue)) {
    return {
      isValid: false,
      error: "Path contains invalid characters (newlines or control characters).",
    };
  }
  const logMarkers = [
    /(^|[/\\])AssertionError:/,
    /(^|[/\\])FAIL /,
    /(^|[/\\])✓ /,
    /(^|[/\\])× /,
    /(^|[/\\])TestingLibraryElementError:/,
  ];
  if (logMarkers.some((regex) => regex.test(pathValue))) {
    return { isValid: false, error: "Path appears to be a misinterpreted log fragment." };
  }
  if ((pathValue.includes('"') || pathValue.includes("...")) && pathValue.length > 20) {
    return {
      isValid: false,
      error:
        "Path contains suspicious characters (double quotes or ellipses) and is too long to be a simple filename.",
    };
  }
  if (pathValue.length > MAX_PATH_LENGTH) {
    return {
      isValid: false,
      error: `Path is too long (maximum ${MAX_PATH_LENGTH} characters).`,
    };
  }
  for (const component of pathValue.split(/[/\\]/)) {
    if (component.length > MAX_COMPONENT_LENGTH) {
      return {
        isValid: false,
        error: `Path component "${component.substring(0, 20)}..." is too long (maximum ${MAX_COMPONENT_LENGTH} characters).`,
      };
    }
  }
  return { isValid: true };
}

function normalizeWindowsExtendedPath(value: string): string {
  if (process.platform !== "win32") return value;
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function decodePathReference(value: string): string {
  let decoded = value;
  try {
    if (decoded.startsWith("file://")) decoded = fileURLToPath(decoded);
    decoded = decodeURIComponent(decoded);
  } catch {
    // Match Gemini CLI's defensive behavior: malformed URI input falls back to
    // the last successfully decoded representation instead of failing early.
  }
  return normalizeWindowsExtendedPath(decoded);
}

function resolveDefensiveToolPath(filePath: string, workspace: string): string {
  const cleanPath = filePath.replace(/\0/g, "");

  try {
    const literalPath = resolve(workspace, cleanPath);
    if (existsSync(literalPath)) return cleanPath;

    if (cleanPath.startsWith("@") && cleanPath.length > 1) {
      if (cleanPath.startsWith("@/") || cleanPath.startsWith("@\\")) {
        const stripped = cleanPath.substring(1).replace(/^[\\/]+/, "");
        return stripped.length > 0 ? stripped : cleanPath;
      }

      const strippedPath = cleanPath.substring(1).replace(/^[\\/]+/, "");
      const firstSegment = strippedPath.split(/[\\/]/)[0];
      if (firstSegment) {
        const literalFirstSegment = resolve(workspace, `@${firstSegment}`);
        if (existsSync(literalFirstSegment)) return cleanPath;
        return strippedPath;
      }
    }
  } catch {
    // Match Gemini CLI: fall back to the cleaned original path.
  }

  return cleanPath;
}

async function canonicalizeExistingAncestors(path: string): Promise<string> {
  try {
    return normalizeWindowsExtendedPath(await realpath(path));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const parent = dirname(path);
  if (parent === path) return resolve(path);
  return resolve(await canonicalizeExistingAncestors(parent), path.slice(parent.length + 1));
}

export class GeminiPathAccessError extends Error {
  readonly code = "PATH_NOT_IN_WORKSPACE";

  constructor(path: string, cwd: string) {
    super(`Path '${path}' is not in the current workspace '${cwd}'.`);
    this.name = "GeminiPathAccessError";
  }
}

export class GeminiPathCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiPathCorrectionError";
  }
}

async function correctGeminiRelativePath(
  workspace: string,
  filePath: string,
): Promise<string | undefined> {
  const sanitizedPath = resolveDefensiveToolPath(filePath, workspace);
  const directPath = join(workspace, sanitizedPath);
  if (existsSync(directPath)) return directPath;

  const targetBasename = basename(sanitizedPath);
  const normalizedTarget = sanitizedPath.replace(/\\/g, "/");
  const foundFiles: string[] = [];
  const queue = [workspace];
  let visitedDirs = 0;

  while (queue.length > 0 && visitedDirs < 50) {
    const current = queue.shift()!;
    visitedDirs += 1;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!hasGeminiBlockedPathSegment(entry.name)) queue.push(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== targetBasename) continue;
      const normalized = fullPath.replace(/\\/g, "/");
      if (normalized.endsWith(normalizedTarget)) foundFiles.push(fullPath);
    }
  }

  if (foundFiles.length === 0) return undefined;
  if (foundFiles.length > 1) {
    throw new GeminiPathCorrectionError(
      `The file path '${filePath}' is ambiguous and matches multiple files. Please provide a more specific path. Matches: ${foundFiles.join(", ")}`,
    );
  }
  return foundFiles[0];
}

export async function validateGeminiWorkspacePath(
  cwd: string,
  filePath: string,
  options: { correctRelative?: boolean } = {},
): Promise<string> {
  const workspace = resolve(cwd);
  const correctedPath =
    options.correctRelative && !isAbsolute(filePath)
      ? await correctGeminiRelativePath(workspace, filePath)
      : undefined;
  const sanitizedPath = correctedPath ?? resolveDefensiveToolPath(filePath, workspace);
  const decodedPath = decodePathReference(sanitizedPath);
  const target = isAbsolute(decodedPath) ? resolve(decodedPath) : resolve(workspace, decodedPath);

  const pathValidation = validateGeminiPath(target);
  if (!pathValidation.isValid) {
    const error = new GeminiPathAccessError(target, workspace);
    error.message = `Invalid path: ${pathValidation.error}`;
    throw error;
  }
  if (!isWithin(workspace, target)) throw new GeminiPathAccessError(target, workspace);

  const workspaceReal = normalizeWindowsExtendedPath(
    await realpath(workspace).catch(() => workspace),
  );
  const canonicalTarget = await canonicalizeExistingAncestors(target);
  if (!isWithin(workspaceReal, canonicalTarget)) {
    throw new GeminiPathAccessError(canonicalTarget, workspaceReal);
  }

  const relativeCanonical = relative(workspaceReal, canonicalTarget);
  if (hasGeminiBlockedPathSegment(relativeCanonical)) {
    throw new GeminiPathAccessError(canonicalTarget, workspaceReal);
  }

  return canonicalTarget;
}
