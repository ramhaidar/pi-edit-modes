import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { copyFileDaclWin32, replaceFileWin32 } from "./win32.ts";
import { readTextWindowStreaming, StreamReadError } from "./stream-read.ts";

export type DeepSeekFsErrorCode =
  | "FS_NOT_FOUND"
  | "FS_NOT_TEXT"
  | "FS_NOT_REGULAR_FILE"
  | "FS_STALE_VERSION"
  | "FS_NOT_OBSERVED"
  | "FS_AMBIGUOUS_EDIT"
  | "FS_EDIT_NOT_FOUND"
  | "FS_ABORTED";

export class DeepSeekFsError extends Error {
  readonly code: DeepSeekFsErrorCode;

  constructor(message: string, code: DeepSeekFsErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekFsError";
    this.code = code;
  }
}

export interface DeepSeekTarget {
  displayPath: string;
  targetKey: string;
}

export interface DeepSeekPathInfo {
  version: string;
  mode: number;
  type: "file" | "directory" | "other";
  size: number;
}

type Observation = { kind: "present"; version: string } | { kind: "absent" };

const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8192;
export const DEEPSEEK_READ_LIMIT = 2000;
export const DEEPSEEK_READ_MAX_LINE_LENGTH = 2000;
export const DEEPSEEK_READ_MAX_BYTES = 50 * 1024;
export const DEEPSEEK_READ_STREAM_MIN_SIZE = 10 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      ("code" in error && (error as NodeJS.ErrnoException).code === "ABORT_ERR"))
  );
}

function throwIfAborted(signal: AbortSignal | undefined, verb: "read" | "write" | "edit"): void {
  if (signal?.aborted) throw new DeepSeekFsError(`${verb} aborted`, "FS_ABORTED");
}

async function statBigInt(path: string): Promise<any> {
  return stat(path, { bigint: true });
}

function pathType(info: any): DeepSeekPathInfo["type"] {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  return "other";
}

async function probe(path: string): Promise<DeepSeekPathInfo | undefined> {
  try {
    const info = await statBigInt(path);
    return {
      version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      mode: Number(info.mode & 0o777n),
      type: pathType(info),
      size: Number(info.size),
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function resolveTarget(cwd: string, path: string): Promise<DeepSeekTarget> {
  if (path.trim().length === 0)
    throw new DeepSeekFsError("file_path must be a non-empty string", "FS_NOT_FOUND");
  const displayPath = resolve(cwd, path);
  try {
    return { displayPath, targetKey: await realpath(displayPath) };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    ) {
      throw new DeepSeekFsError(
        `cannot resolve "${displayPath}": a parent path segment is not a directory`,
        "FS_NOT_FOUND",
        { cause: error },
      );
    }
    if (!isMissing(error)) throw error;
  }

  const missing: string[] = [basename(displayPath)];
  let ancestor = dirname(displayPath);
  while (true) {
    try {
      const realAncestor = await realpath(ancestor);
      if (process.platform === "win32") {
        const parentInfo = await stat(realAncestor);
        if (!parentInfo.isDirectory()) {
          throw new DeepSeekFsError(
            `cannot resolve "${displayPath}": a parent path segment is not a directory`,
            "FS_NOT_FOUND",
          );
        }
      }
      return { displayPath, targetKey: resolve(realAncestor, ...missing.reverse()) };
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

function assertWithinWorkspace(cwdReal: string, targetKey: string): void {
  const rel = relative(cwdReal, targetKey);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path '${targetKey}' is outside the current workspace.`);
  }
}

function decodeUtf8(buffer: Uint8Array, verb: "read" | "edit", displayPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new DeepSeekFsError(
      `cannot ${verb} "${displayPath}": invalid UTF-8 text`,
      "FS_NOT_TEXT",
      { cause: error },
    );
  }
}

export function normalizeDeepSeekLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

export function detectDeepSeekLineEndings(raw: string): "LF" | "CRLF" {
  const sample = raw.slice(0, 4096);
  const crlfCount = sample.split("\r\n").length - 1;
  const lfCount = sample.split("\n").length - 1 - crlfCount;
  return crlfCount > lfCount ? "CRLF" : "LF";
}

export function restoreDeepSeekLineEndings(content: string, lineEndings: "LF" | "CRLF"): string {
  return lineEndings === "LF"
    ? content
    : normalizeDeepSeekLineEndings(content).split("\n").join("\r\n");
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

export function applyDeepSeekLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeDeepSeekLineEndings(oldString);
  if (oldNorm.length === 0)
    throw new DeepSeekFsError("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND");
  const newNorm = normalizeDeepSeekLineEndings(newString);
  const replacements = countOccurrences(content, oldNorm);
  if (replacements === 0)
    throw new DeepSeekFsError(`old_string was not found in "${displayPath}"`, "FS_EDIT_NOT_FOUND");
  if (!replaceAll && replacements > 1) {
    throw new DeepSeekFsError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      "FS_AMBIGUOUS_EDIT",
    );
  }
  return { content: content.split(oldNorm).join(newNorm), replacements };
}

function remediate(error: unknown): unknown {
  if (!(error instanceof DeepSeekFsError)) return error;
  if (error.code === "FS_STALE_VERSION") {
    return new DeepSeekFsError(`${error.message} — re-read the file, then retry`, error.code, {
      cause: error,
    });
  }
  if (error.code === "FS_NOT_OBSERVED") {
    return new DeepSeekFsError(`${error.message} — read the file, then retry`, error.code, {
      cause: error,
    });
  }
  return error;
}

async function readRaw(path: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readFile(path, signal ? { signal } : undefined);
  } catch (error) {
    if (isAbort(error)) throw new DeepSeekFsError("read aborted", "FS_ABORTED", { cause: error });
    throw error;
  }
}

async function readForDiff(path: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const info = await statBigInt(path);
    if (!info.isFile() || Number(info.size) >= DIFF_BASIS_MAX_BYTES) return null;
    const bytes = await readRaw(path, signal);
    if (bytes.length !== Number(info.size) || bytes.includes(0)) return null;
    try {
      return normalizeDeepSeekLineEndings(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return null;
    }
  } catch (error) {
    if (error instanceof DeepSeekFsError) throw error;
    if (error instanceof Error && "code" in error) return null;
    throw error;
  }
}

async function atomicWrite(
  targetKey: string,
  displayPath: string,
  content: string,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  createIfAbsent: boolean,
): Promise<void> {
  throwIfAborted(signal, "write");
  const directory = dirname(targetKey);
  await mkdir(directory, { recursive: true });
  throwIfAborted(signal, "write");

  const stagingDir = resolve(
    directory,
    `.${basename(targetKey)}.${process.pid}.${randomUUID()}.tmpdir`,
  );
  const tempPath = resolve(stagingDir, `${basename(targetKey)}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stagingCreated = false;
  try {
    await mkdir(stagingDir, { mode: 0o700 });
    stagingCreated = true;
    await chmod(stagingDir, 0o700);
    handle = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    await handle.chmod(0o600);
    if (process.platform === "win32" && mode !== undefined)
      await copyFileDaclWin32(targetKey, tempPath);
    await handle.writeFile(content, { encoding: "utf8", ...(signal ? { signal } : {}) });
    await handle.sync();
    if (mode !== undefined) await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    throwIfAborted(signal, "write");

    if (createIfAbsent) {
      try {
        await link(tempPath, targetKey);
      } catch (error) {
        let collision: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          collision = await lstat(targetKey);
        } catch (metadataError) {
          if (!isMissing(metadataError)) throw metadataError;
        }
        if (collision) {
          if (!collision.isFile())
            throw new DeepSeekFsError(
              `cannot write "${displayPath}": not a regular file`,
              "FS_NOT_REGULAR_FILE",
              { cause: error },
            );
          throw new DeepSeekFsError(
            `cannot overwrite existing "${displayPath}" without reading it first`,
            "FS_NOT_OBSERVED",
            { cause: error },
          );
        }
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          throw new DeepSeekFsError(
            `cannot overwrite existing "${displayPath}" without reading it first`,
            "FS_NOT_OBSERVED",
            { cause: error },
          );
        }
        throw error;
      }
    } else if (process.platform === "win32" && mode !== undefined) {
      try {
        await replaceFileWin32(targetKey, tempPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
        await rename(tempPath, targetKey);
      }
    } else {
      await rename(tempPath, targetKey);
    }
  } catch (error) {
    if (isAbort(error)) throw new DeepSeekFsError("write aborted", "FS_ABORTED", { cause: error });
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    if (stagingCreated)
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface DeepSeekReadResult {
  path: string;
  offset: number;
  lines: Array<{ number: number; text: string }>;
  totalLines: number;
  truncatedByBytes: boolean;
}

export function formatDeepSeekReadOutput(result: DeepSeekReadResult): string {
  const endLine = result.lines.at(-1)?.number ?? Math.max(0, result.offset - 1);
  const footer = result.truncatedByBytes
    ? `(Output capped. Showing lines ${result.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
    : endLine < result.totalLines
      ? `(Showing lines ${result.offset}-${endLine} of ${result.totalLines}. Use offset=${endLine + 1} to continue.)`
      : `(End of file - total ${result.totalLines} lines)`;
  const body =
    result.lines.length > 0
      ? `${result.lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`
      : footer;
  return `<path>${result.path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}

function buildReadWindow(
  content: string,
  displayPath: string,
  offset: number,
  limit: number,
): Omit<DeepSeekReadResult, "path" | "offset"> {
  const rawLines = content.length === 0 ? [] : content.split("\n");
  // DeepSeek Harness counts newline-terminated lines but does not manufacture an
  // extra empty line after a trailing newline.
  if (rawLines.at(-1) === "") rawLines.pop();
  const lines = rawLines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (offset > lines.length && !(lines.length === 0 && offset === 1)) {
    throw new DeepSeekFsError(
      `offset ${offset} is out of range for "${displayPath}" (${lines.length} lines)`,
      "FS_NOT_FOUND",
    );
  }
  const selected: Array<{ number: number; text: string }> = [];
  let bytes = 0;
  let truncatedByBytes = false;
  for (let i = offset - 1; i < lines.length && selected.length < limit; i += 1) {
    const raw = lines[i] ?? "";
    const text =
      raw.length > DEEPSEEK_READ_MAX_LINE_LENGTH
        ? `${raw.substring(0, DEEPSEEK_READ_MAX_LINE_LENGTH)}... (line truncated to ${DEEPSEEK_READ_MAX_LINE_LENGTH} chars)`
        : raw;
    const cost = Buffer.byteLength(text, "utf8") + (selected.length > 0 ? 1 : 0);
    if (bytes + cost > DEEPSEEK_READ_MAX_BYTES) {
      truncatedByBytes = true;
      break;
    }
    bytes += cost;
    selected.push({ number: i + 1, text });
  }
  return { lines: selected, totalLines: lines.length, truncatedByBytes };
}

export class DeepSeekFsParity {
  readonly cwd: string;
  private readonly containToWorkspace: boolean;
  private observations = new Map<string, Observation>();
  private locks = new Map<string, Promise<unknown>>();
  private cwdRealPromise: Promise<string>;

  constructor(cwd: string, containToWorkspace = true) {
    this.cwd = cwd;
    this.containToWorkspace = containToWorkspace;
    this.cwdRealPromise = realpath(resolve(cwd)).catch(() => resolve(cwd));
  }

  clear(): void {
    this.observations.clear();
  }

  private async target(path: string): Promise<DeepSeekTarget> {
    const target = await resolveTarget(this.cwd, path);
    if (this.containToWorkspace) assertWithinWorkspace(await this.cwdRealPromise, target.targetKey);
    return target;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async read(
    filePath: string,
    offset = 1,
    limit = DEEPSEEK_READ_LIMIT,
    signal?: AbortSignal,
  ): Promise<DeepSeekReadResult> {
    if (filePath.trim().length === 0) throw new Error("file_path must be a non-empty string");
    if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 1)
      throw new Error("offset must be a positive integer");
    if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1)
      throw new Error("limit must be a positive integer");
    if (limit > DEEPSEEK_READ_LIMIT)
      throw new Error(`limit must be less than or equal to ${DEEPSEEK_READ_LIMIT}`);
    const target = await this.target(filePath);
    throwIfAborted(signal, "read");
    const info = await probe(target.targetKey);
    if (!info) {
      this.observations.set(target.targetKey, { kind: "absent" });
      throw new DeepSeekFsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
    }
    if (info.type !== "file")
      throw new DeepSeekFsError(
        `cannot read "${target.displayPath}": not a regular file`,
        "FS_NOT_REGULAR_FILE",
      );
    let window: Omit<DeepSeekReadResult, "path" | "offset">;
    if (info.size >= DEEPSEEK_READ_STREAM_MIN_SIZE) {
      try {
        window = await readTextWindowStreaming(target.targetKey, {
          offset,
          limit,
          maxBytes: DEEPSEEK_READ_MAX_BYTES,
          maxLineLength: DEEPSEEK_READ_MAX_LINE_LENGTH,
          binarySampleBytes: BINARY_SAMPLE_BYTES,
          signal,
        });
      } catch (error) {
        if (!(error instanceof StreamReadError)) throw error;
        if (error.kind === "aborted")
          throw new DeepSeekFsError("read aborted", "FS_ABORTED", { cause: error });
        if (error.kind === "binary" || error.kind === "utf8") {
          throw new DeepSeekFsError(
            `cannot read "${target.displayPath}": ${error.kind === "binary" ? "binary file" : "invalid UTF-8 text"}`,
            "FS_NOT_TEXT",
            { cause: error },
          );
        }
        throw new DeepSeekFsError(
          `offset ${offset} is out of range for "${target.displayPath}" (${info.size} byte file)`,
          "FS_NOT_FOUND",
          { cause: error },
        );
      }
    } else {
      const bytes = await readRaw(target.targetKey, signal);
      throwIfAborted(signal, "read");
      if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
        throw new DeepSeekFsError(
          `cannot read "${target.displayPath}": binary file`,
          "FS_NOT_TEXT",
        );
      }
      const content = decodeUtf8(bytes, "read", target.displayPath);
      window = buildReadWindow(content, target.displayPath, offset, limit);
    }
    this.observations.set(target.targetKey, { kind: "present", version: info.version });
    return { path: target.displayPath, offset, ...window };
  }

  async write(
    filePath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{
    path: string;
    operation: "create" | "update";
    before: string | null;
    after: string;
  }> {
    if (filePath.trim().length === 0) throw new Error("file_path must be a non-empty string");
    const target = await this.target(filePath);
    // Match fs-observation-policy: derive the write intent before entering the
    // provider's per-target lock. Parallel calls from the same observation must
    // therefore carry the same CAS/no-clobber intent; only one can commit.
    const observed = this.observations.get(target.targetKey);
    const intent =
      observed?.kind === "present"
        ? { kind: "replaceIfVersion" as const, version: observed.version }
        : { kind: "createIfAbsent" as const };

    return this.withLock(target.targetKey, async () => {
      try {
        throwIfAborted(signal, "write");
        const existing = await probe(target.targetKey);
        if (existing && existing.type !== "file")
          throw new DeepSeekFsError(
            `cannot write "${target.displayPath}": not a regular file`,
            "FS_NOT_REGULAR_FILE",
          );
        if (intent.kind === "replaceIfVersion") {
          if (!existing)
            throw new DeepSeekFsError(
              `cannot write "${target.displayPath}": file no longer exists`,
              "FS_STALE_VERSION",
            );
          if (existing.version !== intent.version)
            throw new DeepSeekFsError(
              `cannot write "${target.displayPath}": file changed since it was read`,
              "FS_STALE_VERSION",
            );
        } else if (existing) {
          throw new DeepSeekFsError(
            `cannot overwrite existing "${target.displayPath}" without reading it first`,
            "FS_NOT_OBSERVED",
          );
        }
        const diffable =
          Boolean(existing) && Buffer.byteLength(content, "utf8") < DIFF_BASIS_MAX_BYTES;
        const before = diffable ? await readForDiff(target.targetKey, signal) : null;
        await atomicWrite(
          target.targetKey,
          target.displayPath,
          content,
          existing?.mode,
          signal,
          intent.kind === "createIfAbsent",
        );
        const afterInfo = await probe(target.targetKey);
        if (afterInfo)
          this.observations.set(target.targetKey, { kind: "present", version: afterInfo.version });
        return {
          path: target.displayPath,
          operation: existing ? "update" : "create",
          before,
          after: normalizeDeepSeekLineEndings(content),
        };
      } catch (error) {
        throw remediate(error);
      }
    });
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
    signal?: AbortSignal,
  ): Promise<{ path: string; before: string; after: string }> {
    if (filePath.trim().length === 0) throw new Error("file_path must be a non-empty string");
    if (oldString.length === 0) throw new Error("old_string must be a non-empty string");
    if (oldString === newString) throw new Error("old_string and new_string must differ");
    const target = await this.target(filePath);
    // Match fs/edit-intent: capture the observed version before provider locking.
    // This makes concurrent edits based on one read deterministic: one commits,
    // later contenders fail stale instead of inheriting the first edit's fresh observation.
    const observed = this.observations.get(target.targetKey);
    if (!observed)
      throw remediate(
        new DeepSeekFsError(
          `edit requires reading "${target.displayPath}" first`,
          "FS_NOT_OBSERVED",
        ),
      );
    if (observed.kind === "absent")
      throw new DeepSeekFsError(`cannot edit "${target.displayPath}": not found`, "FS_NOT_FOUND");
    const expectedVersion = observed.version;

    return this.withLock(target.targetKey, async () => {
      try {
        const existing = await probe(target.targetKey);
        if (!existing)
          throw new DeepSeekFsError(
            `cannot edit "${target.displayPath}": file changed since it was read`,
            "FS_STALE_VERSION",
          );
        if (existing.type !== "file")
          throw new DeepSeekFsError(
            `cannot edit "${target.displayPath}": not a regular file`,
            "FS_NOT_REGULAR_FILE",
          );
        if (existing.version !== expectedVersion)
          throw new DeepSeekFsError(
            `cannot edit "${target.displayPath}": file changed since it was read`,
            "FS_STALE_VERSION",
          );
        throwIfAborted(signal, "edit");
        const bytes = await readRaw(target.targetKey, signal);
        throwIfAborted(signal, "edit");
        if (bytes.includes(0))
          throw new DeepSeekFsError(
            `cannot edit "${target.displayPath}": binary file`,
            "FS_NOT_TEXT",
          );
        const raw = decodeUtf8(bytes, "edit", target.displayPath);
        const lineEndings = detectDeepSeekLineEndings(raw);
        const before = normalizeDeepSeekLineEndings(raw);
        const edited = applyDeepSeekLiteralEdit(
          before,
          oldString,
          newString,
          replaceAll,
          target.displayPath,
        );
        const storage = restoreDeepSeekLineEndings(edited.content, lineEndings);
        await atomicWrite(
          target.targetKey,
          target.displayPath,
          storage,
          existing.mode,
          signal,
          false,
        );
        const afterInfo = await probe(target.targetKey);
        if (afterInfo)
          this.observations.set(target.targetKey, { kind: "present", version: afterInfo.version });
        return { path: target.displayPath, before, after: edited.content };
      } catch (error) {
        throw remediate(error);
      }
    });
  }

  async editorView(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ target: DeepSeekTarget; info: DeepSeekPathInfo; content?: string }> {
    const target = await this.target(path);
    throwIfAborted(signal, "read");
    const info = await probe(target.targetKey);
    if (!info) {
      this.observations.set(target.targetKey, { kind: "absent" });
      throw new DeepSeekFsError(
        `The path ${target.displayPath} does not exist. Please provide a valid path.`,
        "FS_NOT_FOUND",
      );
    }
    if (info.type === "directory") return { target, info };
    if (info.type !== "file") {
      throw new DeepSeekFsError(
        `cannot view "${target.displayPath}": not a regular file or directory`,
        "FS_NOT_REGULAR_FILE",
      );
    }
    const bytes = await readRaw(target.targetKey, signal);
    throwIfAborted(signal, "read");
    if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
      throw new DeepSeekFsError(`cannot read "${target.displayPath}": binary file`, "FS_NOT_TEXT");
    }
    const content = decodeUtf8(bytes, "read", target.displayPath);
    this.observations.set(target.targetKey, { kind: "present", version: info.version });
    return { target, info, content };
  }

  async editorCreate(
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; before: string; after: string }> {
    const target = await this.target(path);
    throwIfAborted(signal, "write");
    // str_replace_editor performs an explicit stat before asking for write-intent.
    // An existing file/directory is rejected by the tool itself, not the provider.
    const preflight = await probe(target.targetKey);
    if (preflight) {
      throw new Error(
        `File already exists at: ${target.displayPath}. Cannot overwrite files using command \`create\`.`,
      );
    }
    const observed = this.observations.get(target.targetKey);
    const intent =
      observed?.kind === "present"
        ? { kind: "replaceIfVersion" as const, version: observed.version }
        : { kind: "createIfAbsent" as const };

    return this.withLock(target.targetKey, async () => {
      throwIfAborted(signal, "write");
      const existing = await probe(target.targetKey);
      if (existing && existing.type !== "file") {
        throw new DeepSeekFsError(
          `cannot write "${target.displayPath}": not a regular file`,
          "FS_NOT_REGULAR_FILE",
        );
      }
      if (intent.kind === "replaceIfVersion") {
        if (!existing)
          throw new DeepSeekFsError(
            `cannot write "${target.displayPath}": file no longer exists`,
            "FS_STALE_VERSION",
          );
        if (existing.version !== intent.version) {
          throw new DeepSeekFsError(
            `cannot write "${target.displayPath}": file changed since it was read`,
            "FS_STALE_VERSION",
          );
        }
      } else if (existing) {
        throw new DeepSeekFsError(
          `cannot overwrite existing "${target.displayPath}" without reading it first`,
          "FS_NOT_OBSERVED",
        );
      }
      await atomicWrite(
        target.targetKey,
        target.displayPath,
        content,
        existing?.mode,
        signal,
        intent.kind === "createIfAbsent",
      );
      const afterInfo = await probe(target.targetKey);
      if (afterInfo)
        this.observations.set(target.targetKey, { kind: "present", version: afterInfo.version });
      return { path: target.displayPath, before: "", after: content };
    });
  }

  async editorReplace(
    path: string,
    oldString: string | undefined,
    newString: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ path: string; before: string; after: string }> {
    const target = await this.target(path);
    // Match str_replace_editor ordering: edit-intent runs before required old_str
    // validation and before stat/read of the file.
    const observed = this.observations.get(target.targetKey);
    if (!observed)
      throw new DeepSeekFsError(
        `edit requires reading "${target.displayPath}" first`,
        "FS_NOT_OBSERVED",
      );
    if (observed.kind === "absent")
      throw new DeepSeekFsError(`cannot edit "${target.displayPath}": not found`, "FS_NOT_FOUND");
    const expectedVersion = observed.version;
    if (oldString === undefined)
      throw new Error("Parameter `old_str` is required for command: str_replace");
    if (oldString.length === 0)
      throw new Error("Parameter `old_str` is empty for command: str_replace");
    const replacement = newString ?? "";

    const info = await probe(target.targetKey);
    if (!info) {
      this.observations.set(target.targetKey, { kind: "absent" });
      throw new DeepSeekFsError(
        `The path ${target.displayPath} does not exist. Please provide a valid path.`,
        "FS_NOT_FOUND",
      );
    }
    if (info.type === "directory") {
      throw new DeepSeekFsError(
        `The path ${target.displayPath} is a directory and only the \`view\` command can be used on directories`,
        "FS_NOT_REGULAR_FILE",
      );
    }
    if (info.type !== "file")
      throw new DeepSeekFsError(
        `cannot edit "${target.displayPath}": not a regular file`,
        "FS_NOT_REGULAR_FILE",
      );
    const bytes = await readRaw(target.targetKey, signal);
    if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
      throw new DeepSeekFsError(`cannot read "${target.displayPath}": binary file`, "FS_NOT_TEXT");
    }
    const before = decodeUtf8(bytes, "read", target.displayPath);
    const offsets: number[] = [];
    let cursor = 0;
    while (true) {
      const match = before.indexOf(oldString, cursor);
      if (match < 0) break;
      offsets.push(match);
      cursor = match + oldString.length;
    }
    const offset = offsets[0];
    if (offset === undefined) {
      throw new DeepSeekFsError(
        `No replacement was performed, old_str \`${oldString}\` did not appear verbatim in ${target.displayPath}.`,
        "FS_EDIT_NOT_FOUND",
      );
    }
    if (offsets.length > 1) {
      let line = 1;
      let scan = 0;
      const lines = offsets.map((matchOffset) => {
        while (scan < matchOffset) {
          if (before[scan] === "\n") line += 1;
          scan += 1;
        }
        return line;
      });
      throw new DeepSeekFsError(
        `No replacement was performed. Multiple occurrences of old_str \`${oldString}\` in lines [${lines.join(", ")}]. Please ensure it is unique`,
        "FS_AMBIGUOUS_EDIT",
      );
    }
    const after = before.slice(0, offset) + replacement + before.slice(offset + oldString.length);

    return this.withLock(target.targetKey, async () => {
      const current = await probe(target.targetKey);
      if (!current)
        throw new DeepSeekFsError(
          `cannot write "${target.displayPath}": file no longer exists`,
          "FS_STALE_VERSION",
        );
      if (current.type !== "file")
        throw new DeepSeekFsError(
          `cannot write "${target.displayPath}": not a regular file`,
          "FS_NOT_REGULAR_FILE",
        );
      if (current.version !== expectedVersion) {
        throw new DeepSeekFsError(
          `cannot write "${target.displayPath}": file changed since it was read`,
          "FS_STALE_VERSION",
        );
      }
      await atomicWrite(target.targetKey, target.displayPath, after, current.mode, signal, false);
      const afterInfo = await probe(target.targetKey);
      if (afterInfo)
        this.observations.set(target.targetKey, { kind: "present", version: afterInfo.version });
      return { path: target.displayPath, before, after };
    });
  }

  async editorInsert(
    path: string,
    insertLine: number,
    newString: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; before: string; after: string }> {
    const target = await this.target(path);
    const observed = this.observations.get(target.targetKey);
    if (!observed)
      throw new DeepSeekFsError(
        `edit requires reading "${target.displayPath}" first`,
        "FS_NOT_OBSERVED",
      );
    if (observed.kind === "absent")
      throw new DeepSeekFsError(`cannot edit "${target.displayPath}": not found`, "FS_NOT_FOUND");
    const expectedVersion = observed.version;

    const info = await probe(target.targetKey);
    if (!info) {
      this.observations.set(target.targetKey, { kind: "absent" });
      throw new DeepSeekFsError(
        `The path ${target.displayPath} does not exist. Please provide a valid path.`,
        "FS_NOT_FOUND",
      );
    }
    if (info.type === "directory") {
      throw new DeepSeekFsError(
        `The path ${target.displayPath} is a directory and only the \`view\` command can be used on directories`,
        "FS_NOT_REGULAR_FILE",
      );
    }
    if (info.type !== "file")
      throw new DeepSeekFsError(
        `cannot insert into "${target.displayPath}": not a regular file`,
        "FS_NOT_REGULAR_FILE",
      );
    const bytes = await readRaw(target.targetKey, signal);
    if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
      throw new DeepSeekFsError(`cannot read "${target.displayPath}": binary file`, "FS_NOT_TEXT");
    }
    const before = decodeUtf8(bytes, "read", target.displayPath);
    const lines = before.split("\n");
    if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
      throw new Error(
        `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
      );
    }
    const after = [
      ...lines.slice(0, insertLine),
      ...newString.split("\n"),
      ...lines.slice(insertLine),
    ].join("\n");

    return this.withLock(target.targetKey, async () => {
      const current = await probe(target.targetKey);
      if (!current)
        throw new DeepSeekFsError(
          `cannot write "${target.displayPath}": file no longer exists`,
          "FS_STALE_VERSION",
        );
      if (current.type !== "file")
        throw new DeepSeekFsError(
          `cannot write "${target.displayPath}": not a regular file`,
          "FS_NOT_REGULAR_FILE",
        );
      if (current.version !== expectedVersion) {
        throw new DeepSeekFsError(
          `cannot write "${target.displayPath}": file changed since it was read`,
          "FS_STALE_VERSION",
        );
      }
      await atomicWrite(target.targetKey, target.displayPath, after, current.mode, signal, false);
      const afterInfo = await probe(target.targetKey);
      if (afterInfo)
        this.observations.set(target.targetKey, { kind: "present", version: afterInfo.version });
      return { path: target.displayPath, before, after };
    });
  }

  async observeAbsolutePath(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ target: DeepSeekTarget; info?: DeepSeekPathInfo }> {
    const target = await this.target(path);
    throwIfAborted(signal, "read");
    const info = await probe(target.targetKey);
    this.observations.set(
      target.targetKey,
      info ? { kind: "present", version: info.version } : { kind: "absent" },
    );
    return { target, info };
  }

  async expectedVersion(path: string): Promise<string | undefined> {
    const target = await this.target(path);
    const observed = this.observations.get(target.targetKey);
    return observed?.kind === "present" ? observed.version : undefined;
  }
}

export function formatDeepSeekWriteOutput(path: string, operation: "create" | "update"): string {
  const verb = operation === "create" ? "Created" : "Updated";
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${verb} file\n</content>`;
}

export function formatDeepSeekEditOutput(path: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${path} has been updated. All occurrences were successfully replaced.`
    : `The file ${path} has been updated successfully.`;
}
