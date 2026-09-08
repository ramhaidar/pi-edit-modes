import { createRequire } from "node:module";
import {
	close as closeFd,
	constants as FS_CONSTANTS,
	fstat as fstatFd,
	ftruncate as ftruncateFd,
	read as readFd,
	write as writeFd,
} from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import {
	generateDiffString,
	generateUnifiedPatch,
	type EditToolDetails,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { compactFileHeader, displayToolPath, scanApplyPatchPreviewTargets } from "../diff-call-renderer.ts";

// Compatibility baseline: OpenAI Codex main @ 6525b95dae2082ac9fee672b14c2cffdef172bb8 (2026-08-26).
// Pi is only the transport/lifecycle/rendering/security adapter around Codex semantics.
// NOTE: this pinned upstream grammar intentionally contains /(.*)/ for add/change payloads,
// and the pinned verifier intentionally rejects duplicate source-path operations.
// Platform contract: use the race-resistant descriptor/openat backend when available.
// Otherwise fall back to a portable Node filesystem backend with best-effort symlink checks.
// Set PI_APPLY_PATCH_REQUIRE_SECURE_FS=1 to restore fail-closed behavior on platforms without
// the descriptor/openat backend.

const APPLY_PATCH_DESCRIPTION =
	"The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

const APPLY_PATCH_COMPAT_DESCRIPTION =
	"Apply a Codex-style patch. Pass the raw `*** Begin Patch` / `*** End Patch` patch text verbatim in the `input` string.";

// Pinned Codex usage guidance adapted to Pi's active-tool prompt surface.
// Pi includes these only while apply_patch is active; the native tool description stays exact.
const APPLY_PATCH_PROMPT_SNIPPET = "Edit files with Codex-style apply_patch patches.";
const APPLY_PATCH_PROMPT_GUIDELINES = [
	"Use `apply_patch` for manual file edits, file creation, deletion, and moves.",
	"The patch payload itself is raw `*** Begin Patch` / `*** End Patch` text. With ordinary function-tool compatibility transport, put that raw patch verbatim in the `input` string.",
	"Use `*** Add File:`, `*** Delete File:`, or `*** Update File:` for each file operation; prefix Add File content with `+`.",
	"For updates, use `@@` context hunks with space/`-`/`+` line prefixes; put `*** Move to:` immediately after an Update File header when renaming.",
];

const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

const FILE_READ_CHUNK_BYTES = 64 * 1024;
const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

const APPLY_PATCH_PARAMETERS = Type.Object(
	{ input: Type.String() },
	{ additionalProperties: false },
);

type UpdateChunk = {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	contextLineIndices: Array<[number, number]>;
	isEndOfFile: boolean;
};

type PatchHunk =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; movePath?: string; chunks: UpdateChunk[] };

type ParsedPatch = {
	patch: string;
	hunks: PatchHunk[];
	environmentId?: string;
};

const NORMALIZE_TO_LF_MODE = "normalize-to-lf" as const;
const PRESERVE_LINE_ENDINGS_MODE = "preserve-line-endings" as const;

type ApplyPatchFileUpdateMode =
	| typeof NORMALIZE_TO_LF_MODE
	| typeof PRESERVE_LINE_ENDINGS_MODE;

type ApplyPatchToolMode = "replace" | "additive" | "off";

type ManagedToolSurface = "unsupported" | ApplyPatchToolMode;

type FileToolOwnership = {
	surface: ManagedToolSurface;
	editRemovedByUs: boolean;
	writeRemovedByUs: boolean;
	editRestoreIndex?: number;
	writeRestoreIndex?: number;
};

type ApplyPatchTransport = "native" | "compatibility";
type ApplyPatchFilesystemBackend = "secure" | "portable" | "unavailable";

type NativeApplyPatchSupport = {
	supported: boolean;
	apiCompatible: boolean;
	grammarCompatible: boolean;
	secureBackendAvailable: boolean;
	toolAvailable: boolean;
	reason?: string;
};

type ApplyPatchSupport = {
	supported: boolean;
	transport?: ApplyPatchTransport;
	apiCompatible: boolean;
	grammarCompatible: boolean;
	secureBackendAvailable: boolean;
	filesystemBackend: ApplyPatchFilesystemBackend;
	toolAvailable: boolean;
	reason?: string;
};

type ProposedChange =
	| { type: "add"; sourcePath: string; displayPath: string; content: string }
	| { type: "delete"; sourcePath: string; displayPath: string; originalContent: string }
	| {
			type: "update";
			sourcePath: string;
			displayPath: string;
			targetPath: string;
			targetDisplayPath: string;
			originalContent: string;
			newContent: string;
	  };

type AppliedChange =
	| {
			type: "add";
			operationIndex: number;
			path: string;
			displayPath: string;
			content: string;
			overwrittenContent?: string;
	  }
	| {
			type: "delete";
			operationIndex: number;
			path: string;
			displayPath: string;
			originalContent: string;
	  }
	| {
			type: "update";
			operationIndex: number;
			path: string;
			displayPath: string;
			targetPath: string;
			targetDisplayPath: string;
			originalContent: string;
			newContent: string;
			overwrittenMoveContent?: string;
	  };

type AppliedDelta = {
	changes: AppliedChange[];
	exact: boolean;
};

type AffectedPaths = {
	added: string[];
	modified: string[];
	deleted: string[];
};

type RuntimeApplySuccess = {
	affected: AffectedPaths;
	delta: AppliedDelta;
};

type PiPolicyLimits = {
	maxPatchBytes?: number;
	maxHunks?: number;
	maxTargetFileBytes?: number;
};

type FileChangeSummary = {
	action: "A" | "D" | "M";
	path: string;
};

type PatchOperationResult =
	| {
			operationIndex: number;
			toolName: "write";
			content: [{ type: "text"; text: string }];
			details: undefined;
			renderDiff?: string;
	  }
	| {
			operationIndex: number;
			toolName: "edit";
			content: [{ type: "text"; text: string }];
			details: EditToolDetails;
			renderDiff?: string;
	  };

type ApplyPatchDetails = {
	files: FileChangeSummary[];
	operations: PatchOperationResult[];
	verification: Array<{ action: "A" | "D" | "M"; path: string }>;
	affected?: AffectedPaths;
	committed: { exact: boolean; files: FileChangeSummary[] };
	updateMode: ApplyPatchFileUpdateMode;
	errorStage?: "pi-policy" | "runtime";
	failedOperationIndex?: number;
};

type PatchRenderOperation = {
	key: string;
	action: "A" | "D" | "M";
	path: string;
	movePath?: string;
	addedLines?: number;
	removedLines?: number;
};

type PatchRenderState = {
	callComponent?: PatchCallRenderComponent;
};

type PatchRendererContext = {
	toolCallId: string;
	invalidate: () => void;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	expanded: boolean;
	showImages: boolean;
};

type PatchToolRow = {
	key: string;
	operation: PatchRenderOperation;
	resultText?: string;
	errorText?: string;
	renderDiff?: string;
};

class PatchParseError extends Error {
	readonly kind: "patch" | "hunk";
	readonly lineNumber?: number;

	private constructor(kind: "patch" | "hunk", message: string, lineNumber?: number) {
		super(
			kind === "patch"
				? `invalid patch: ${message}`
				: `invalid hunk at line ${lineNumber ?? 0}, ${message}`,
		);
		this.name = "PatchParseError";
		this.kind = kind;
		this.lineNumber = lineNumber;
	}

	static patch(message: string): PatchParseError {
		return new PatchParseError("patch", message);
	}

	static hunk(message: string, lineNumber: number): PatchParseError {
		return new PatchParseError("hunk", message, lineNumber);
	}
}

class ApplyPatchRuntimeError extends Error {
	readonly delta: AppliedDelta;
	readonly failedHunkIndex?: number;

	constructor(message: string, delta: AppliedDelta, failedHunkIndex?: number) {
		super(message);
		this.name = "ApplyPatchRuntimeError";
		this.delta = delta;
		this.failedHunkIndex = failedHunkIndex;
	}
}

class PiPatchPolicyError extends Error {
	readonly policyKind: "security" | "resource";

	constructor(policyKind: "security" | "resource", message: string) {
		super(message);
		this.name = "PiPatchPolicyError";
		this.policyKind = policyKind;
	}
}

function cloneChunk(chunk: UpdateChunk): UpdateChunk {
	return {
		changeContext: chunk.changeContext,
		oldLines: [...chunk.oldLines],
		newLines: [...chunk.newLines],
		contextLineIndices: chunk.contextLineIndices.map(([oldIndex, newIndex]) => [oldIndex, newIndex]),
		isEndOfFile: chunk.isEndOfFile,
	};
}

function cloneHunk(hunk: PatchHunk): PatchHunk {
	if (hunk.type === "add") return { ...hunk };
	if (hunk.type === "delete") return { ...hunk };
	return { ...hunk, chunks: hunk.chunks.map(cloneChunk) };
}

class StreamingPatchParser {
	private lineBuffer = "";
	private mode:
		| { type: "not-started" }
		| { type: "started" }
		| { type: "add" }
		| { type: "delete" }
		| { type: "update"; hunkLineNumber: number }
		| { type: "ended" } = { type: "not-started" };
	private lineNumber = 0;
	private parsedHunks: PatchHunk[] = [];
	private parsedEnvironmentId: string | undefined;

	get environmentId(): string | undefined {
		return this.parsedEnvironmentId;
	}

	get hunks(): PatchHunk[] {
		return this.parsedHunks.map(cloneHunk);
	}

	private invalidHeader(trimmed: string): PatchParseError {
		return PatchParseError.hunk(
			`'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
			this.lineNumber,
		);
	}

	private ensureUpdateHunkIsNotEmpty(line: string): void {
		const last = this.parsedHunks.at(-1);
		if (!last || last.type !== "update") return;

		if (last.chunks.length === 0 && this.mode.type === "update") {
			throw PatchParseError.hunk(
				`Update file hunk for path '${last.path}' is empty`,
				this.mode.hunkLineNumber,
			);
		}

		const lastChunk = last.chunks.at(-1);
		if (lastChunk && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
			if (line === END_PATCH_MARKER) {
				throw PatchParseError.hunk("Update hunk does not contain any lines", this.lineNumber);
			}
			throw PatchParseError.hunk(
				`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
				this.lineNumber,
			);
		}
	}

	private handleHeadersAndEndPatch(structuralLine: string): boolean {
		if (this.mode.type === "started" && structuralLine.startsWith(ENVIRONMENT_ID_MARKER)) {
			if (this.parsedEnvironmentId !== undefined) {
				throw PatchParseError.patch("apply_patch environment_id cannot be specified more than once");
			}
			const environmentId = structuralLine.slice(ENVIRONMENT_ID_MARKER.length).trim();
			if (environmentId.length === 0) {
				throw PatchParseError.patch("apply_patch environment_id cannot be empty");
			}
			this.parsedEnvironmentId = environmentId;
			return true;
		}

		if (structuralLine === END_PATCH_MARKER) {
			this.ensureUpdateHunkIsNotEmpty(structuralLine);
			this.mode = { type: "ended" };
			return true;
		}

		if (structuralLine.startsWith(ADD_FILE_MARKER)) {
			this.ensureUpdateHunkIsNotEmpty(structuralLine);
			this.parsedHunks.push({
				type: "add",
				path: structuralLine.slice(ADD_FILE_MARKER.length),
				contents: "",
			});
			this.mode = { type: "add" };
			return true;
		}

		if (structuralLine.startsWith(DELETE_FILE_MARKER)) {
			this.ensureUpdateHunkIsNotEmpty(structuralLine);
			this.parsedHunks.push({
				type: "delete",
				path: structuralLine.slice(DELETE_FILE_MARKER.length),
			});
			this.mode = { type: "delete" };
			return true;
		}

		if (structuralLine.startsWith(UPDATE_FILE_MARKER)) {
			this.ensureUpdateHunkIsNotEmpty(structuralLine);
			this.parsedHunks.push({
				type: "update",
				path: structuralLine.slice(UPDATE_FILE_MARKER.length),
				chunks: [],
			});
			this.mode = { type: "update", hunkLineNumber: this.lineNumber };
			return true;
		}

		return false;
	}

	private processLine(line: string): void {
		const trimmed = line.trim();

		if (this.mode.type === "not-started") {
			if (trimmed === BEGIN_PATCH_MARKER) {
				this.mode = { type: "started" };
				return;
			}
			throw PatchParseError.patch("The first line of the patch must be '*** Begin Patch'");
		}

		if (this.mode.type === "started") {
			if (this.handleHeadersAndEndPatch(trimmed)) return;
			throw this.invalidHeader(trimmed);
		}

		if (this.mode.type === "add") {
			if (this.handleHeadersAndEndPatch(trimmed)) return;
			const last = this.parsedHunks.at(-1);
			if (line.startsWith("+") && last?.type === "add") {
				last.contents += `${line.slice(1)}\n`;
				return;
			}
			throw this.invalidHeader(trimmed);
		}

		if (this.mode.type === "delete") {
			if (this.handleHeadersAndEndPatch(trimmed)) return;
			throw this.invalidHeader(trimmed);
		}

		if (this.mode.type === "ended") {
			if (trimmed.length === 0) return;
			throw PatchParseError.patch("The last line of the patch must be '*** End Patch'");
		}

		const hunkLineNumber = this.mode.hunkLineNumber;
		const updateLine = line.trimEnd();
		if (this.handleHeadersAndEndPatch(updateLine)) return;

		const last = this.parsedHunks.at(-1);
		if (!last || last.type !== "update") {
			throw PatchParseError.hunk("Internal update parser state is invalid", this.lineNumber);
		}

		const lastChunk = last.chunks.at(-1);
		if (lastChunk?.isEndOfFile) {
			if (updateLine.length === 0) return;
			if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
				throw PatchParseError.hunk(
					`Expected update hunk to start with a @@ context marker, got: '${line}'`,
					this.lineNumber,
				);
			}
		}

		if (last.chunks.length === 0 && last.movePath === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
			last.movePath = updateLine.slice(MOVE_TO_MARKER.length);
			this.mode = { type: "update", hunkLineNumber };
			return;
		}

		if (
			(updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) &&
			last.chunks.at(-1)?.oldLines.length === 0 &&
			last.chunks.at(-1)?.newLines.length === 0
		) {
			throw PatchParseError.hunk(
				`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
				this.lineNumber,
			);
		}

		if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
			last.chunks.push({
				oldLines: [],
				newLines: [],
				contextLineIndices: [],
				isEndOfFile: false,
			});
			this.mode = { type: "update", hunkLineNumber };
			return;
		}

		if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
			last.chunks.push({
				changeContext: updateLine.slice(CHANGE_CONTEXT_MARKER.length),
				oldLines: [],
				newLines: [],
				contextLineIndices: [],
				isEndOfFile: false,
			});
			this.mode = { type: "update", hunkLineNumber };
			return;
		}

		if (updateLine === EOF_MARKER) {
			const chunk = last.chunks.at(-1);
			if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
				throw PatchParseError.hunk("Update hunk does not contain any lines", this.lineNumber);
			}
			if (chunk) chunk.isEndOfFile = true;
			this.mode = { type: "update", hunkLineNumber };
			return;
		}

		const ensureChunk = (): UpdateChunk => {
			let chunk = last.chunks.at(-1);
			if (!chunk) {
				chunk = {
					oldLines: [],
					newLines: [],
					contextLineIndices: [],
					isEndOfFile: false,
				};
				last.chunks.push(chunk);
			}
			return chunk;
		};

		if (line.length === 0) {
			const chunk = ensureChunk();
			chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
			chunk.oldLines.push("");
			chunk.newLines.push("");
			this.mode = { type: "update", hunkLineNumber };
			return;
		}

		if (line.startsWith(" ")) {
			const chunk = ensureChunk();
			chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
			const content = line.slice(1);
			chunk.oldLines.push(content);
			chunk.newLines.push(content);
			this.mode = { type: "update", hunkLineNumber };
			return;
		}

		if (line.startsWith("+")) {
			ensureChunk().newLines.push(line.slice(1));
			this.mode = { type: "update", hunkLineNumber };
			return;
		}

		if (line.startsWith("-")) {
			ensureChunk().oldLines.push(line.slice(1));
			this.mode = { type: "update", hunkLineNumber };
			return;
		}

		if (last.chunks.at(-1) && (last.chunks.at(-1)!.oldLines.length > 0 || last.chunks.at(-1)!.newLines.length > 0)) {
			throw PatchParseError.hunk(
				`Expected update hunk to start with a @@ context marker, got: '${line}'`,
				this.lineNumber,
			);
		}

		throw PatchParseError.hunk(
			`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
			this.lineNumber,
		);
	}

	pushDelta(delta: string): PatchHunk[] {
		for (const ch of delta) {
			if (ch === "\n") {
				let line = this.lineBuffer;
				this.lineBuffer = "";
				if (line.endsWith("\r")) line = line.slice(0, -1);
				this.lineNumber += 1;
				this.processLine(line);
			} else {
				this.lineBuffer += ch;
			}
		}
		return this.hunks;
	}

	finish(): PatchHunk[] {
		if (this.lineBuffer.length > 0) {
			const line = this.lineBuffer;
			this.lineBuffer = "";
			this.lineNumber += 1;
			if (line.trim() === END_PATCH_MARKER) {
				this.ensureUpdateHunkIsNotEmpty(line.trim());
				this.mode = { type: "ended" };
			} else {
				this.processLine(line);
			}
		}
		if (this.mode.type !== "ended") {
			throw PatchParseError.patch("The last line of the patch must be '*** End Patch'");
		}
		return this.hunks;
	}
}

function parsePatch(patchText: string): ParsedPatch {
	if (typeof patchText !== "string") {
		throw PatchParseError.patch("apply_patch input must be a string");
	}
	const trimmed = patchText.trim();
	const originalLines = trimmed.length === 0
		? []
		: trimmed.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

	const strictBoundaries = (lines: string[]): string[] => {
		const first = lines[0]?.trim();
		const last = lines.at(-1)?.trim();
		if (first !== BEGIN_PATCH_MARKER) {
			throw PatchParseError.patch("The first line of the patch must be '*** Begin Patch'");
		}
		if (last !== END_PATCH_MARKER) {
			throw PatchParseError.patch("The last line of the patch must be '*** End Patch'");
		}
		return lines;
	};

	let patchLines: string[];
	try {
		patchLines = strictBoundaries(originalLines);
	} catch (strictError) {
		const first = originalLines[0];
		const last = originalLines.at(-1);
		const isRecognizedHeredoc = first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"';
		if (isRecognizedHeredoc && last?.endsWith("EOF") && originalLines.length >= 4) {
			patchLines = strictBoundaries(originalLines.slice(1, -1));
		} else {
			throw strictError;
		}
	}

	const patch = patchLines.join("\n");
	const parser = new StreamingPatchParser();
	parser.pushDelta(patch);
	const hunks = parser.finish();
	return { patch, hunks, environmentId: parser.environmentId };
}

function normalizeUnicodeForMatch(value: string): string {
	let output = "";
	for (const char of value.trim()) {
		switch (char) {
			case "\u2010":
			case "\u2011":
			case "\u2012":
			case "\u2013":
			case "\u2014":
			case "\u2015":
			case "\u2212":
				output += "-";
				break;
			case "\u2018":
			case "\u2019":
			case "\u201A":
			case "\u201B":
				output += "'";
				break;
			case "\u201C":
			case "\u201D":
			case "\u201E":
			case "\u201F":
				output += '"';
				break;
			case "\u00A0":
			case "\u2002":
			case "\u2003":
			case "\u2004":
			case "\u2005":
			case "\u2006":
			case "\u2007":
			case "\u2008":
			case "\u2009":
			case "\u200A":
			case "\u202F":
			case "\u205F":
			case "\u3000":
				output += " ";
				break;
			default:
				output += char;
		}
	}
	return output;
}

function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	endOfFile: boolean,
	mode: ApplyPatchFileUpdateMode,
): number {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return -1;

	const eofStart = lines.length - pattern.length;
	const searchStart = endOfFile
		? mode === "normalize-to-lf"
			? eofStart
			: Math.max(eofStart, start)
		: start;
	const finalStart = lines.length - pattern.length;
	if (searchStart > finalStart) return -1;

	const matchWith = (compare: (actual: string, expected: string) => boolean): number => {
		for (let index = searchStart; index <= finalStart; index++) {
			if (pattern.every((expected, offset) => compare(lines[index + offset], expected))) return index;
		}
		return -1;
	};

	let found = matchWith((actual, expected) => actual === expected);
	if (found !== -1) return found;
	found = matchWith((actual, expected) => actual.trimEnd() === expected.trimEnd());
	if (found !== -1) return found;
	found = matchWith((actual, expected) => actual.trim() === expected.trim());
	if (found !== -1) return found;
	return matchWith(
		(actual, expected) => normalizeUnicodeForMatch(actual) === normalizeUnicodeForMatch(expected),
	);
}

type Replacement = [start: number, oldLength: number, newLines: string[]];

function computeReplacements(
	originalLines: string[],
	path: string,
	chunks: UpdateChunk[],
	mode: ApplyPatchFileUpdateMode,
): Replacement[] {
	const replacements: Replacement[] = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false, mode);
			if (contextIndex === -1) {
				throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
			}
			lineIndex = contextIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex = mode === "normalize-to-lf"
				? originalLines.at(-1) === ""
					? originalLines.length - 1
					: originalLines.length
				: originalLines.length;
			replacements.push([insertionIndex, 0, [...chunk.newLines]]);
			continue;
		}

		let pattern = chunk.oldLines;
		let replacement = chunk.newLines;
		let matchIndex = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, mode);

		if (matchIndex === -1 && pattern.at(-1) === "") {
			pattern = pattern.slice(0, -1);
			if (replacement.at(-1) === "") replacement = replacement.slice(0, -1);
			matchIndex = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, mode);
		}

		if (matchIndex === -1) {
			throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
		}

		if (mode === "normalize-to-lf") {
			replacements.push([matchIndex, pattern.length, [...replacement]]);
		} else {
			let oldStart = 0;
			let newStart = 0;
			for (const [oldContext, newContext] of chunk.contextLineIndices) {
				if (oldContext >= pattern.length || newContext >= replacement.length) break;
				if (oldStart !== oldContext || newStart !== newContext) {
					replacements.push([
						matchIndex + oldStart,
						oldContext - oldStart,
						replacement.slice(newStart, newContext),
					]);
				}
				oldStart = oldContext + 1;
				newStart = newContext + 1;
			}
			if (oldStart !== pattern.length || newStart !== replacement.length) {
				replacements.push([
					matchIndex + oldStart,
					pattern.length - oldStart,
					replacement.slice(newStart),
				]);
			}
		}
		lineIndex = matchIndex + pattern.length;
	}

	replacements.sort(([left], [right]) => left - right);
	return replacements;
}

function applyLineReplacements(lines: string[], replacements: Replacement[]): string[] {
	const result = [...lines];
	for (let index = replacements.length - 1; index >= 0; index--) {
		const [start, oldLength, newLines] = replacements[index];
		result.splice(start, oldLength, ...newLines);
	}
	return result;
}

type SourceLine = { text: string; ending?: "\n" | "\r\n" | "\r" };

class SourceFile {
	private lines: SourceLine[];
	private readonly preferredEnding: "\n" | "\r\n" | "\r";

	private constructor(lines: SourceLine[], preferredEnding: "\n" | "\r\n" | "\r") {
		this.lines = lines;
		this.preferredEnding = preferredEnding;
	}

	static parse(contents: string): SourceFile {
		const lines: SourceLine[] = [];
		let preferredEnding: "\n" | "\r\n" | "\r" | undefined;
		let lineStart = 0;
		let cursor = 0;

		while (cursor < contents.length) {
			let ending: "\n" | "\r\n" | "\r" | undefined;
			let endingLength = 0;
			if (contents[cursor] === "\r" && contents[cursor + 1] === "\n") {
				ending = "\r\n";
				endingLength = 2;
			} else if (contents[cursor] === "\r") {
				ending = "\r";
				endingLength = 1;
			} else if (contents[cursor] === "\n") {
				ending = "\n";
				endingLength = 1;
			}
			if (!ending) {
				cursor += 1;
				continue;
			}
			preferredEnding ??= ending;
			lines.push({ text: contents.slice(lineStart, cursor), ending });
			cursor += endingLength;
			lineStart = cursor;
		}

		if (lineStart < contents.length) lines.push({ text: contents.slice(lineStart) });
		return new SourceFile(lines, preferredEnding ?? "\n");
	}

	lineTexts(): string[] {
		return this.lines.map((line) => line.text);
	}

	applyReplacements(replacements: Replacement[]): void {
		const source = this.lines;
		const output: SourceLine[] = [];
		let sourceIndex = 0;

		for (const [start, oldLength, newSegment] of replacements) {
			for (; sourceIndex < start; sourceIndex++) output.push(source[sourceIndex]);
			sourceIndex += oldLength;
			for (const text of newSegment) output.push({ text, ending: this.preferredEnding });
		}
		for (; sourceIndex < source.length; sourceIndex++) output.push(source[sourceIndex]);
		for (const line of output) line.ending ??= this.preferredEnding;
		this.lines = output;
	}

	intoContents(): string {
		return this.lines.map((line) => `${line.text}${line.ending ?? ""}`).join("");
	}
}

function deriveNewContents(
	filePath: string,
	chunks: UpdateChunk[],
	originalContent: string,
	mode: ApplyPatchFileUpdateMode,
): string {
	if (mode === "normalize-to-lf") {
		const originalLines = originalContent.split("\n");
		if (originalLines.at(-1) === "") originalLines.pop();
		const replacements = computeReplacements(originalLines, filePath, chunks, mode);
		const newLines = applyLineReplacements(originalLines, replacements);
		if (newLines.at(-1) !== "") newLines.push("");
		return newLines.join("\n");
	}

	const sourceFile = SourceFile.parse(originalContent);
	const originalLines = sourceFile.lineTexts();
	const replacements = computeReplacements(originalLines, filePath, chunks, mode);
	sourceFile.applyReplacements(replacements);
	return sourceFile.intoContents();
}

function getUpdateMode(): ApplyPatchFileUpdateMode {
	return process.env.CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS === "1"
		? "preserve-line-endings"
		: "normalize-to-lf";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error(signal.reason === undefined ? "Operation aborted" : String(signal.reason));
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function isMissing(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return errorCode(error) === "EEXIST";
}

function resolvePatchPath(cwd: string, patchPath: string): string {
	if (patchPath.includes("\0")) throw new Error("Patch path contains a NUL byte");
	return resolve(cwd, patchPath);
}

function displayPatchPath(rawPath: string): string {
	return rawPath;
}

const O_NOFOLLOW = FS_CONSTANTS.O_NOFOLLOW ?? 0;
const O_DIRECTORY = FS_CONSTANTS.O_DIRECTORY ?? 0;
const O_NONBLOCK = FS_CONSTANTS.O_NONBLOCK ?? 0;
const SECURE_FD_DIRECTORY = process.platform === "linux" ? "/proc/self/fd" : undefined;
const SECURE_DIRECTORY_FLAGS = FS_CONSTANTS.O_RDONLY | O_NOFOLLOW | O_DIRECTORY | O_NONBLOCK;
const TRUSTED_CWD_DIRECTORY_FLAGS = FS_CONSTANTS.O_RDONLY | O_DIRECTORY | O_NONBLOCK;
const SECURE_READ_FLAGS = FS_CONSTANTS.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const SECURE_WRITE_FLAGS = FS_CONSTANTS.O_WRONLY | O_NOFOLLOW | O_NONBLOCK;

type DarwinAtStat = {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
};

type DarwinOpenAtBinding = {
	openat(dirfd: number, path: string, flags: number, mode: number): number;
	mkdirat(dirfd: number, path: string, mode: number): void;
	unlinkat(dirfd: number, path: string): void;
	lstatAt(dirfd: number, path: string): DarwinAtStat;
};

type DescriptorSecureFilesystemContext = {
	backend: "secure";
	semanticCwd: string;
	root: FileHandle;
	cwdAnchor: FileHandle;
	close(): Promise<void>;
};

type PortableFilesystemContext = {
	backend: "portable";
	semanticCwd: string;
	portableCwdReal: string;
	close(): Promise<void>;
};

type SecureFilesystemContext = DescriptorSecureFilesystemContext | PortableFilesystemContext;
type SecureFilesystemAccess = SecureFilesystemContext | FileHandle;

type SecurePathRoute = {
	anchor: FileHandle;
	components: string[];
	kind: "cwd-relative" | "root-absolute";
	displayBase: string;
};

function isDarwinOpenAtBinding(value: unknown): value is DarwinOpenAtBinding {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<DarwinOpenAtBinding>;
	return typeof candidate.openat === "function" &&
		typeof candidate.mkdirat === "function" &&
		typeof candidate.unlinkat === "function" &&
		typeof candidate.lstatAt === "function";
}

function loadDarwinOpenAtBinding(): DarwinOpenAtBinding | undefined {
	if (process.platform !== "darwin") return undefined;
	const extensionRequire = createRequire(import.meta.url);

	const explicit = process.env.PI_APPLY_PATCH_DARWIN_BINDING;
	if (typeof explicit === "string" && explicit.trim() !== "") {
		try {
			const loaded = extensionRequire(explicit);
			const candidate = loaded?.default ?? loaded;
			if (isDarwinOpenAtBinding(candidate)) return candidate;
		} catch {
			// Fail closed below. An explicitly configured but unusable binding must not trigger an unsafe fallback.
		}
	}

	// Reuse the race-resistant native addon shipped by pi-codex-tools when that package is installed.
	// We load its package-local node-gyp-build rather than importing private TypeScript internals.
	try {
		const entry = extensionRequire.resolve("pi-codex-tools");
		const packageRequire = createRequire(entry);
		const nodeGypBuild = packageRequire("node-gyp-build") as (root: string) => unknown;
		for (const packageRoot of [dirname(entry), dirname(dirname(entry))]) {
			try {
				const loaded = nodeGypBuild(packageRoot);
				const candidate = (loaded as { default?: unknown } | undefined)?.default ?? loaded;
				if (isDarwinOpenAtBinding(candidate)) return candidate;
			} catch {
				// Try the next plausible package root.
			}
		}
	} catch {
		// Package/addon unavailable. secureFilesystemSupported() remains false on Darwin.
	}
	return undefined;
}

const DARWIN_OPENAT_BINDING = loadDarwinOpenAtBinding();
const LINUX_SECURE_FILESYSTEM_SUPPORTED =
	process.platform === "linux" && SECURE_FD_DIRECTORY !== undefined && O_NOFOLLOW !== 0 && O_DIRECTORY !== 0;

function secureFilesystemSupported(): boolean {
	if (LINUX_SECURE_FILESYSTEM_SUPPORTED) return true;
	return process.platform === "darwin" && DARWIN_OPENAT_BINDING !== undefined && O_NOFOLLOW !== 0 && O_DIRECTORY !== 0;
}

function portableFilesystemAllowed(): boolean {
	return process.env.PI_APPLY_PATCH_REQUIRE_SECURE_FS !== "1";
}

function applyPatchFilesystemBackend(): ApplyPatchFilesystemBackend {
	if (secureFilesystemSupported()) return "secure";
	if (portableFilesystemAllowed()) return "portable";
	return "unavailable";
}

function fdChildPath(parentFd: number, child: string): string {
	if (SECURE_FD_DIRECTORY === undefined) {
		throw new Error("/proc/self/fd backend is unavailable on this platform");
	}
	return join(SECURE_FD_DIRECTORY, String(parentFd), child);
}

function closeRawFd(fd: number): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		closeFd(fd, (error) => error ? reject(error) : resolvePromise());
	});
}

function statRawFd(fd: number): Promise<any> {
	return new Promise((resolvePromise, reject) => {
		fstatFd(fd, (error, stats) => error ? reject(error) : resolvePromise(stats));
	});
}

function truncateRawFd(fd: number, length: number): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		ftruncateFd(fd, length, (error) => error ? reject(error) : resolvePromise());
	});
}

function readRawFd(
	fd: number,
	buffer: Buffer,
	offset: number,
	length: number,
	position: number,
): Promise<{ bytesRead: number; buffer: Buffer }> {
	return new Promise((resolvePromise, reject) => {
		readFd(fd, buffer, offset, length, position, (error, bytesRead, readBuffer) =>
			error ? reject(error) : resolvePromise({ bytesRead, buffer: readBuffer as Buffer }));
	});
}

function writeRawFd(
	fd: number,
	buffer: Buffer,
	offset: number,
	length: number,
	position: number,
): Promise<{ bytesWritten: number; buffer: Buffer }> {
	return new Promise((resolvePromise, reject) => {
		writeFd(fd, buffer, offset, length, position, (error, bytesWritten, writtenBuffer) =>
			error ? reject(error) : resolvePromise({ bytesWritten, buffer: writtenBuffer as Buffer }));
	});
}

function wrapRawFd(fd: number): FileHandle {
	let closed = false;
	return {
		fd,
		async close() {
			if (closed) return;
			closed = true;
			await closeRawFd(fd);
		},
		stat: () => statRawFd(fd),
		truncate: (length = 0) => truncateRawFd(fd, length),
		read: (buffer: Buffer, offset: number, length: number, position: number) =>
			readRawFd(fd, buffer, offset, length, position),
		write: (buffer: Buffer, offset: number, length: number, position: number) =>
			writeRawFd(fd, buffer, offset, length, position),
	} as unknown as FileHandle;
}

async function openSecureChild(
	parent: FileHandle,
	child: string,
	flags: number,
	mode = 0,
): Promise<FileHandle> {
	if (process.platform === "darwin" && DARWIN_OPENAT_BINDING !== undefined) {
		return wrapRawFd(DARWIN_OPENAT_BINDING.openat(parent.fd, child, flags, mode));
	}
	return open(fdChildPath(parent.fd, child), flags, mode);
}

function absoluteComponents(absolutePath: string): string[] {
	const normalized = resolve(absolutePath);
	return normalized.split(sep).filter((component: string) => component.length > 0);
}

async function openSecureRoot(signal?: AbortSignal): Promise<FileHandle> {
	throwIfAborted(signal);
	if (!secureFilesystemSupported()) {
		throw new Error(
			"Secure apply_patch filesystem access is unavailable on this platform; apply_patch is disabled to avoid symlink/TOCTOU races.",
		);
	}
	return open(sep, SECURE_DIRECTORY_FLAGS);
}

async function openTrustedCwdAnchor(semanticCwd: string, signal?: AbortSignal): Promise<FileHandle> {
	throwIfAborted(signal);
	let handle: FileHandle | undefined;
	try {
		// Deliberate one-time exception to the no-follow rule: ctx.cwd is selected by Pi/the user,
		// not by patch text. Pin its resolved directory object once, then use no-follow traversal
		// for every model-controlled descendant component.
		handle = await open(semanticCwd, TRUSTED_CWD_DIRECTORY_FLAGS);
		throwIfAborted(signal);
		const info = await handle.stat();
		if (!info.isDirectory()) {
			throw new Error(`Pi workspace cwd is not a directory: ${semanticCwd}`);
		}
		return handle;
	} catch (error) {
		await handle?.close().catch(() => undefined);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to open Pi workspace cwd '${semanticCwd}': ${message}`);
	}
}

async function openSecureFilesystemContext(
	semanticCwd: string,
	signal?: AbortSignal,
): Promise<SecureFilesystemContext> {
	throwIfAborted(signal);
	if (!secureFilesystemSupported()) {
		if (!portableFilesystemAllowed()) {
			throw new Error(
				"Secure apply_patch filesystem access is unavailable on this platform and PI_APPLY_PATCH_REQUIRE_SECURE_FS=1 is set.",
			);
		}
		let portableCwdReal: string;
		try {
			portableCwdReal = await realpath(semanticCwd);
			const info = await lstat(portableCwdReal);
			if (!info.isDirectory()) throw new Error(`Pi workspace cwd is not a directory: ${semanticCwd}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to open Pi workspace cwd '${semanticCwd}': ${message}`);
		}
		return {
			backend: "portable",
			semanticCwd,
			portableCwdReal,
			async close() {},
		};
	}

	const root = await openSecureRoot(signal);
	let cwdAnchor: FileHandle | undefined;
	try {
		cwdAnchor = await openTrustedCwdAnchor(semanticCwd, signal);
	} catch (error) {
		await root.close().catch(() => undefined);
		throw error;
	}
	let closed = false;
	return {
		backend: "secure",
		semanticCwd,
		root,
		cwdAnchor,
		async close() {
			if (closed) return;
			closed = true;
			// These are read-only directory anchors. Cleanup failures must never mask the primary
			// patch verification/runtime/policy result.
			await cwdAnchor.close().catch(() => undefined);
			await root.close().catch(() => undefined);
		},
	};
}

function pathIsWithinSemanticCwd(semanticCwd: string, absolutePath: string): boolean {
	const rel = relative(semanticCwd, absolutePath);
	if (rel === "") return true;
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function isPortableFilesystemContext(value: SecureFilesystemAccess): value is PortableFilesystemContext {
	return typeof value === "object"
		&& value !== null
		&& "backend" in value
		&& (value as { backend?: unknown }).backend === "portable";
}

type PortablePathRoute = {
	base: string;
	components: string[];
	physicalPath: string;
};

function resolvePortablePathRoute(context: PortableFilesystemContext, absolutePath: string): PortablePathRoute {
	if (pathIsWithinSemanticCwd(context.semanticCwd, absolutePath)) {
		const rel = relative(context.semanticCwd, absolutePath);
		if (rel === "") throw new Error(`Cannot use Pi workspace cwd as a file path: ${absolutePath}`);
		const components = rel.split(sep).filter((component) => component.length > 0 && component !== ".");
		return {
			base: context.portableCwdReal,
			components,
			physicalPath: join(context.portableCwdReal, ...components),
		};
	}

	const normalized = resolve(absolutePath);
	const root = parsePath(normalized).root || sep;
	const rel = relative(root, normalized);
	const components = rel.split(sep).filter((component) => component.length > 0 && component !== ".");
	if (components.length === 0) throw new Error(`Cannot use filesystem root as a file path: ${absolutePath}`);
	return { base: root, components, physicalPath: normalized };
}

async function inspectPortablePath(
	context: PortableFilesystemContext,
	absolutePath: string,
	options: { allowMissingFinal: boolean; createParents: boolean },
	signal?: AbortSignal,
): Promise<{ physicalPath: string; exists: boolean; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }> {
	const route = resolvePortablePathRoute(context, absolutePath);
	const components = [...route.components];
	const final = components.pop()!;
	let current = route.base;

	for (const component of components) {
		throwIfAborted(signal);
		current = join(current, component);
		let info;
		try {
			info = await lstat(current);
		} catch (error) {
			if (!isMissing(error) || !options.createParents) throw error;
			await mkdir(current);
			info = await lstat(current);
		}
		if (info.isSymbolicLink()) {
			throw new PiPatchPolicyError(
				"security",
				`Pi apply_patch portable filesystem policy refused symlink traversal: ${absolutePath}`,
			);
		}
		if (!info.isDirectory()) throw new Error(`Cannot traverse non-directory '${current}'`);
	}

	throwIfAborted(signal);
	const physicalPath = join(current, final);
	try {
		const info = await lstat(physicalPath);
		return {
			physicalPath,
			exists: true,
			isFile: info.isFile(),
			isDirectory: info.isDirectory(),
			isSymbolicLink: info.isSymbolicLink(),
		};
	} catch (error) {
		if (isMissing(error) && options.allowMissingFinal) {
			return { physicalPath, exists: false, isFile: false, isDirectory: false, isSymbolicLink: false };
		}
		throw error;
	}
}

function resolveSecurePathRoute(
	context: DescriptorSecureFilesystemContext,
	absolutePath: string,
): SecurePathRoute {
	if (pathIsWithinSemanticCwd(context.semanticCwd, absolutePath)) {
		const rel = relative(context.semanticCwd, absolutePath);
		if (rel === "") {
			throw new Error(`Cannot use Pi workspace cwd as a file path: ${absolutePath}`);
		}
		return {
			anchor: context.cwdAnchor,
			components: rel.split(sep).filter((component) => component.length > 0 && component !== "."),
			kind: "cwd-relative",
			displayBase: context.semanticCwd,
		};
	}
	return {
		anchor: context.root,
		components: absoluteComponents(absolutePath),
		kind: "root-absolute",
		displayBase: sep,
	};
}

function isSecureFilesystemContext(value: SecureFilesystemAccess): value is DescriptorSecureFilesystemContext {
	return typeof value === "object"
		&& value !== null
		&& "backend" in value
		&& (value as { backend?: unknown }).backend === "secure";
}

function resolveSecurePathRouteForAccess(
	access: SecureFilesystemAccess,
	absolutePath: string,
): SecurePathRoute {
	if (isSecureFilesystemContext(access)) return resolveSecurePathRoute(access, absolutePath);
	return {
		anchor: access,
		components: absoluteComponents(absolutePath),
		kind: "root-absolute",
		displayBase: sep,
	};
}

async function openSecureDirectoryChild(parent: FileHandle, child: string, signal?: AbortSignal): Promise<FileHandle> {
	throwIfAborted(signal);
	return openSecureChild(parent, child, SECURE_DIRECTORY_FLAGS);
}

async function lstatSecureChild(parent: FileHandle, child: string): Promise<DarwinAtStat> {
	if (process.platform === "darwin" && DARWIN_OPENAT_BINDING !== undefined) {
		return DARWIN_OPENAT_BINDING.lstatAt(parent.fd, child);
	}
	const info = await lstat(fdChildPath(parent.fd, child));
	return {
		isFile: info.isFile(),
		isDirectory: info.isDirectory(),
		isSymbolicLink: info.isSymbolicLink(),
	};
}

async function classifySecureDirectoryTraversalError(
	parent: FileHandle,
	child: string,
	absoluteChildPath: string,
	error: unknown,
): Promise<unknown> {
	const code = errorCode(error);
	if (code !== "ELOOP" && code !== "ENOTDIR") return error;

	// O_NOFOLLOW | O_DIRECTORY commonly reports ENOTDIR for a symlink-to-directory on Linux.
	// The lstat is descriptor-anchored and is used only to classify the already-failed open;
	// authorization still comes exclusively from the no-follow open itself.
	try {
		const info = await lstatSecureChild(parent, child);
		if (info.isSymbolicLink) {
			return new PiPatchPolicyError(
				"security",
				`Pi apply_patch security policy refused symlink traversal: ${absoluteChildPath}`,
			);
		}
	} catch (classificationError) {
		if (classificationError instanceof PiPatchPolicyError) return classificationError;
		// A race while classifying must not replace the original filesystem error.
	}

	return error;
}

async function createSecureDirectoryChild(parent: FileHandle, child: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	if (process.platform === "darwin" && DARWIN_OPENAT_BINDING !== undefined) {
		DARWIN_OPENAT_BINDING.mkdirat(parent.fd, child, 0o777);
		return;
	}
	await import("node:fs/promises").then(({ mkdir }) => mkdir(fdChildPath(parent.fd, child), { mode: 0o777 }));
}

async function openSecureParent(
	context: SecureFilesystemAccess,
	absolutePath: string,
	createParents: boolean,
	signal?: AbortSignal,
): Promise<{ parent: FileHandle; name: string; closeParent: boolean }> {
	const route = resolveSecurePathRouteForAccess(context, absolutePath);
	const components = [...route.components];
	if (components.length === 0) throw new Error(`Cannot use directory anchor as a file path: ${absolutePath}`);
	const name = components.pop()!;
	let current = route.anchor;
	let closeCurrent = false;
	const traversed: string[] = [];

	try {
		for (const component of components) {
			throwIfAborted(signal);
			const absoluteChildPath = join(route.displayBase, ...traversed, component);
			let next: FileHandle;
			try {
				next = await openSecureDirectoryChild(current, component, signal);
			} catch (error) {
				const classified = await classifySecureDirectoryTraversalError(
					current,
					component,
					absoluteChildPath,
					error,
				);
				if (classified instanceof PiPatchPolicyError) throw classified;
				if (!createParents || !isMissing(classified)) throw classified;
				try {
					await createSecureDirectoryChild(current, component, signal);
				} catch (mkdirError) {
					if (!isAlreadyExists(mkdirError)) throw mkdirError;
				}
				try {
					next = await openSecureDirectoryChild(current, component, signal);
				} catch (retryError) {
					throw await classifySecureDirectoryTraversalError(
						current,
						component,
						absoluteChildPath,
						retryError,
					);
				}
			}
			if (closeCurrent) await current.close().catch(() => undefined);
			current = next;
			closeCurrent = true;
			traversed.push(component);
		}
		return { parent: current, name, closeParent: closeCurrent };
	} catch (error) {
		if (closeCurrent) await current.close().catch(() => undefined);
		throw error;
	}
}

async function lstatSecureFinal(
	context: SecureFilesystemAccess,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }> {
	if (isPortableFilesystemContext(context)) {
		const info = await inspectPortablePath(
			context,
			absolutePath,
			{ allowMissingFinal: true, createParents: false },
			signal,
		);
		return {
			exists: info.exists,
			isFile: info.isFile,
			isDirectory: info.isDirectory,
			isSymbolicLink: info.isSymbolicLink,
		};
	}
	const { parent, name, closeParent } = await openSecureParent(context, absolutePath, false, signal);
	try {
		throwIfAborted(signal);
		try {
			if (process.platform === "darwin" && DARWIN_OPENAT_BINDING !== undefined) {
				const info = DARWIN_OPENAT_BINDING.lstatAt(parent.fd, name);
				return { exists: true, ...info };
			}
			const info = await lstat(fdChildPath(parent.fd, name));
			return {
				exists: true,
				isFile: info.isFile(),
				isDirectory: info.isDirectory(),
				isSymbolicLink: info.isSymbolicLink(),
			};
		} catch (error) {
			if (isMissing(error)) {
				return { exists: false, isFile: false, isDirectory: false, isSymbolicLink: false };
			}
			throw error;
		}
	} finally {
		if (closeParent) await parent.close().catch(() => undefined);
	}
}

async function validateSecureTarget(
	context: SecureFilesystemAccess,
	absolutePath: string,
	allowMissingFinal: boolean,
	signal?: AbortSignal,
): Promise<void> {
	try {
		const info = await lstatSecureFinal(context, absolutePath, signal);
		if (!info.exists) {
			if (allowMissingFinal) return;
			throw new Error(`No such file: ${absolutePath}`);
		}
		if (info.isSymbolicLink) throw new Error(`Refusing to follow symlink: ${absolutePath}`);
		if (!info.isFile) throw new Error(`Refusing to operate on non-file: ${absolutePath}`);
	} catch (error) {
		if (allowMissingFinal && isMissing(error)) return;
		throw error;
	}
}

async function readSecureFile(
	context: SecureFilesystemAccess,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<string> {
	if (isPortableFilesystemContext(context)) {
		try {
			const info = await inspectPortablePath(
				context,
				absolutePath,
				{ allowMissingFinal: false, createParents: false },
				signal,
			);
			if (info.isSymbolicLink) {
				throw new PiPatchPolicyError("security", `Refusing to follow symlink: ${absolutePath}`);
			}
			if (!info.isFile) throw new Error(`Cannot read non-file '${absolutePath}'`);
			throwIfAborted(signal);
			const bytes = await readFile(info.physicalPath);
			throwIfAborted(signal);
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch (error) {
			if (error instanceof TypeError && /encoded data/i.test(error.message)) {
				throw new Error(`File '${absolutePath}' is not valid UTF-8`);
			}
			throw error;
		}
	}
	const { parent, name, closeParent } = await openSecureParent(context, absolutePath, false, signal);
	let file: FileHandle | undefined;
	try {
		throwIfAborted(signal);
		file = await openSecureChild(parent, name, SECURE_READ_FLAGS);
		const info = await file.stat();
		if (!info.isFile()) throw new Error(`Cannot read non-file '${absolutePath}'`);
		const chunks: Buffer[] = [];
		let total = 0;
		let position = 0;
		while (true) {
			throwIfAborted(signal);
			const buffer = Buffer.allocUnsafe(FILE_READ_CHUNK_BYTES);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			total += bytesRead;
			chunks.push(buffer.subarray(0, bytesRead));
		}
		const bytes = Buffer.concat(chunks, total);
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch (error) {
		if (error instanceof TypeError && /encoded data/i.test(error.message)) {
			throw new Error(`File '${absolutePath}' is not valid UTF-8`);
		}
		throw error;
	} finally {
		await file?.close().catch(() => undefined);
		if (closeParent) await parent.close().catch(() => undefined);
	}
}

async function readSecureFileOptional(
	context: SecureFilesystemAccess,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		return await readSecureFile(context, absolutePath, signal);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function writeAll(file: FileHandle, content: string, signal?: AbortSignal): Promise<void> {
	const data = Buffer.from(content, "utf8");
	let offset = 0;
	while (offset < data.length) {
		throwIfAborted(signal);
		const { bytesWritten } = await file.write(data, offset, data.length - offset, offset);
		if (bytesWritten <= 0) throw new Error("Short write while applying patch");
		offset += bytesWritten;
	}
}

async function writeSecureFile(
	context: SecureFilesystemAccess,
	absolutePath: string,
	content: string,
	allowCreate: boolean,
	signal?: AbortSignal,
): Promise<void> {
	if (isPortableFilesystemContext(context)) {
		const info = await inspectPortablePath(
			context,
			absolutePath,
			{ allowMissingFinal: allowCreate, createParents: allowCreate },
			signal,
		);
		if (info.exists) {
			if (info.isSymbolicLink) {
				throw new PiPatchPolicyError("security", `Refusing to follow symlink: ${absolutePath}`);
			}
			if (!info.isFile) throw new Error(`Cannot write non-file '${absolutePath}'`);
		}
		throwIfAborted(signal);
		await writeFile(info.physicalPath, Buffer.from(content, "utf8"));
		throwIfAborted(signal);
		return;
	}
	const { parent, name, closeParent } = await openSecureParent(context, absolutePath, allowCreate, signal);
	let file: FileHandle | undefined;
	try {
		throwIfAborted(signal);
		try {
			file = await openSecureChild(parent, name, SECURE_WRITE_FLAGS);
			const info = await file.stat();
			if (!info.isFile()) throw new Error(`Cannot write non-file '${absolutePath}'`);
			await file.truncate(0);
		} catch (error) {
			await file?.close().catch(() => undefined);
			file = undefined;
			if (!allowCreate || !isMissing(error)) throw error;
			try {
				file = await openSecureChild(
					parent,
					name,
					SECURE_WRITE_FLAGS | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL,
					0o666,
				);
			} catch (createError) {
				if (!isAlreadyExists(createError)) throw createError;
				file = await openSecureChild(parent, name, SECURE_WRITE_FLAGS);
				const info = await file.stat();
				if (!info.isFile()) throw new Error(`Cannot write non-file '${absolutePath}'`);
				await file.truncate(0);
			}
		}
		await writeAll(file, content, signal);
	} finally {
		await file?.close().catch(() => undefined);
		if (closeParent) await parent.close().catch(() => undefined);
	}
}

async function removeSecureFile(
	context: SecureFilesystemAccess,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<void> {
	if (isPortableFilesystemContext(context)) {
		const info = await inspectPortablePath(
			context,
			absolutePath,
			{ allowMissingFinal: false, createParents: false },
			signal,
		);
		if (info.isSymbolicLink) {
			throw new PiPatchPolicyError("security", `Refusing to remove symlink: ${absolutePath}`);
		}
		if (!info.isFile) throw new Error(`Cannot remove non-file '${absolutePath}'`);
		throwIfAborted(signal);
		await unlink(info.physicalPath);
		throwIfAborted(signal);
		return;
	}
	const { parent, name, closeParent } = await openSecureParent(context, absolutePath, false, signal);
	try {
		throwIfAborted(signal);
		if (process.platform === "darwin" && DARWIN_OPENAT_BINDING !== undefined) {
			const info = DARWIN_OPENAT_BINDING.lstatAt(parent.fd, name);
			if (info.isSymbolicLink) throw new PiPatchPolicyError("security", `Refusing to remove symlink: ${absolutePath}`);
			if (!info.isFile) throw new Error(`Cannot remove non-file '${absolutePath}'`);
			DARWIN_OPENAT_BINDING.unlinkat(parent.fd, name);
			return;
		}
		const info = await lstat(fdChildPath(parent.fd, name));
		if (info.isSymbolicLink()) throw new PiPatchPolicyError("security", `Refusing to remove symlink: ${absolutePath}`);
		if (!info.isFile()) throw new Error(`Cannot remove non-file '${absolutePath}'`);
		await import("node:fs/promises").then(({ unlink }) => unlink(fdChildPath(parent.fd, name)));
	} finally {
		if (closeParent) await parent.close().catch(() => undefined);
	}
}

async function withMutationQueues<T>(filePaths: string[], task: () => Promise<T>): Promise<T> {
	const paths = [...new Set(filePaths)].sort();
	async function acquire(index: number): Promise<T> {
		if (index === paths.length) return task();
		return withFileMutationQueue(paths[index], () => acquire(index + 1));
	}
	return acquire(0);
}

function optionalPositiveLimit(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new PiPatchPolicyError("resource", `${name} must be a positive integer when configured`);
	}
	return value;
}

function getPiPolicyLimits(): PiPolicyLimits {
	return {
		maxPatchBytes: optionalPositiveLimit("PI_APPLY_PATCH_MAX_PATCH_BYTES"),
		maxHunks: optionalPositiveLimit("PI_APPLY_PATCH_MAX_HUNKS"),
		maxTargetFileBytes: optionalPositiveLimit("PI_APPLY_PATCH_MAX_TARGET_FILE_BYTES"),
	};
}

function throwPiSecurityTraversal(error: unknown, path: string): never {
	// Parent-component ELOOP/ENOTDIR is classified descriptor-relatively inside openSecureParent().
	// At the final file open, O_NOFOLLOW reports ELOOP for a symlink on supported backends.
	if (errorCode(error) === "ELOOP") {
		throw new PiPatchPolicyError("security", `Pi apply_patch security policy refused symlink traversal: ${path}`);
	}
	throw error;
}

async function verifyCodexPatchSemantics(
	parsed: ParsedPatch,
	cwd: string,
	fsContext: SecureFilesystemAccess,
	mode: ApplyPatchFileUpdateMode,
	signal?: AbortSignal,
): Promise<ProposedChange[]> {
	// Mirrors the pinned Codex verifier: verification is against the verification-time filesystem,
	// and duplicate source paths are rejected before hunk-specific verification.
	const sourcePaths = new Set<string>();
	const proposed: ProposedChange[] = [];

	for (const hunk of parsed.hunks) {
		throwIfAborted(signal);
		const sourcePath = resolvePatchPath(cwd, hunk.path);
		if (sourcePaths.has(sourcePath)) {
			throw new Error(`invalid patch: multiple operations target ${sourcePath}`);
		}
		sourcePaths.add(sourcePath);

		if (hunk.type === "add") {
			// Codex semantic verification does not pre-read or type-check the Add destination.
			proposed.push({
				type: "add",
				sourcePath,
				displayPath: displayPatchPath(hunk.path),
				content: hunk.contents,
			});
			continue;
		}

		if (hunk.type === "delete") {
			let originalContent: string;
			try {
				originalContent = await readSecureFile(fsContext, sourcePath, signal);
			} catch (error) {
				try {
					throwPiSecurityTraversal(error, sourcePath);
				} catch (classified) {
					if (classified instanceof PiPatchPolicyError) throw classified;
					const message = classified instanceof Error ? classified.message : String(classified);
					throw new Error(`Failed to read ${sourcePath}: ${message}`);
				}
			}
			proposed.push({
				type: "delete",
				sourcePath,
				displayPath: displayPatchPath(hunk.path),
				originalContent,
			});
			continue;
		}

		let originalContent: string;
		try {
			originalContent = await readSecureFile(fsContext, sourcePath, signal);
		} catch (error) {
			try {
				throwPiSecurityTraversal(error, sourcePath);
			} catch (classified) {
				if (classified instanceof PiPatchPolicyError) throw classified;
				const message = classified instanceof Error ? classified.message : String(classified);
				throw new Error(`Failed to read file to update ${sourcePath}: ${message}`);
			}
		}
		const newContent = deriveNewContents(sourcePath, hunk.chunks, originalContent, mode);
		const targetPath = hunk.movePath === undefined ? sourcePath : resolvePatchPath(cwd, hunk.movePath);
		proposed.push({
			type: "update",
			sourcePath,
			displayPath: displayPatchPath(hunk.path),
			targetPath,
			targetDisplayPath: displayPatchPath(hunk.movePath ?? hunk.path),
			originalContent,
			newContent,
		});
	}

	return proposed;
}

async function enforcePiPatchSecurityPolicy(
	parsed: ParsedPatch,
	cwd: string,
	fsContext: SecureFilesystemAccess,
	proposed: ProposedChange[],
	signal?: AbortSignal,
): Promise<void> {
	// This is deliberately separate from Codex semantic verification. Any rejection here is a
	// Pi adapter policy/resource denial and must never be reported as a Codex verification error.
	for (const hunk of parsed.hunks) {
		throwIfAborted(signal);
		const sourcePath = resolvePatchPath(cwd, hunk.path);
		try {
			await validateSecureTarget(fsContext, sourcePath, hunk.type === "add", signal);
			if (hunk.type === "update" && hunk.movePath !== undefined) {
				await validateSecureTarget(fsContext, resolvePatchPath(cwd, hunk.movePath), true, signal);
			}
		} catch (error) {
			if (error instanceof PiPatchPolicyError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new PiPatchPolicyError("security", `Pi apply_patch security policy denied '${hunk.path}': ${message}`);
		}
	}

	const limits = getPiPolicyLimits();
	if (limits.maxPatchBytes !== undefined && Buffer.byteLength(parsed.patch, "utf8") > limits.maxPatchBytes) {
		throw new PiPatchPolicyError(
			"resource",
			`Pi apply_patch resource policy: patch exceeds configured ${limits.maxPatchBytes}-byte limit`,
		);
	}
	if (limits.maxHunks !== undefined && parsed.hunks.length > limits.maxHunks) {
		throw new PiPatchPolicyError(
			"resource",
			`Pi apply_patch resource policy: patch exceeds configured ${limits.maxHunks}-hunk limit`,
		);
	}
	if (limits.maxTargetFileBytes !== undefined) {
		for (const change of proposed) {
			const contents = change.type === "add"
				? change.content
				: change.type === "delete"
					? change.originalContent
					: change.newContent;
			if (Buffer.byteLength(contents, "utf8") > limits.maxTargetFileBytes) {
				throw new PiPatchPolicyError(
					"resource",
					`Pi apply_patch resource policy: '${change.displayPath}' exceeds configured ${limits.maxTargetFileBytes}-byte target-file limit`,
				);
			}
		}
	}
}

async function runtimeApplyPatch(
	patch: string,
	cwd: string,
	fsContext: SecureFilesystemAccess,
	mode: ApplyPatchFileUpdateMode,
	signal?: AbortSignal,
): Promise<RuntimeApplySuccess> {
	const reparsed = parsePatch(patch);
	const delta: AppliedDelta = { changes: [], exact: true };
	const affected: AffectedPaths = { added: [], modified: [], deleted: [] };

	const fail = (message: string, error?: unknown, failedHunkIndex?: number): never => {
		const suffix = error instanceof Error ? `: ${error.message}` : error === undefined ? "" : `: ${String(error)}`;
		throw new ApplyPatchRuntimeError(`${message}${suffix}`, delta, failedHunkIndex);
	};

	if (reparsed.hunks.length === 0) fail("No files were modified.");

	for (let hunkIndex = 0; hunkIndex < reparsed.hunks.length; hunkIndex++) {
		const hunk = reparsed.hunks[hunkIndex];
		try {
			throwIfAborted(signal);
		} catch (error) {
			fail("apply_patch aborted", error, hunkIndex);
		}
		const sourcePath = resolvePatchPath(cwd, hunk.path);

		if (hunk.type === "add") {
			let overwrittenContent: string | undefined;
			try {
				overwrittenContent = await readSecureFileOptional(fsContext, sourcePath, signal);
			} catch {
				// Codex may not be able to recover overwritten content; mutation can still proceed.
				delta.exact = false;
			}
			try {
				await writeSecureFile(fsContext, sourcePath, hunk.contents, true, signal);
			} catch (error) {
				delta.exact = false;
				fail(`Failed to write file ${sourcePath}`, error, hunkIndex);
			}
			delta.changes.push({
				type: "add",
				operationIndex: hunkIndex,
				path: sourcePath,
				displayPath: hunk.path,
				content: hunk.contents,
				overwrittenContent,
			});
			affected.added.push(hunk.path);
			continue;
		}

		if (hunk.type === "delete") {
			let originalContent: string | undefined;
			try {
				originalContent = await readSecureFile(fsContext, sourcePath, signal);
			} catch {
				delta.exact = false;
			}
			try {
				await removeSecureFile(fsContext, sourcePath, signal);
			} catch (error) {
				if (originalContent !== undefined) {
					try {
						const current = await readSecureFile(fsContext, sourcePath, signal);
						if (current !== originalContent) delta.exact = false;
					} catch {
						delta.exact = false;
					}
				} else {
					delta.exact = false;
				}
				fail(`Failed to delete file ${sourcePath}`, error, hunkIndex);
			}
			if (originalContent !== undefined) {
				delta.changes.push({
					type: "delete",
					operationIndex: hunkIndex,
					path: sourcePath,
					displayPath: hunk.path,
					originalContent,
				});
			}
			affected.deleted.push(hunk.path);
			continue;
		}

		let updateContents: { originalContent: string; newContent: string } | undefined;
		let readContent: string;
		try {
			readContent = await readSecureFile(fsContext, sourcePath, signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fail(`Failed to read file to update ${sourcePath}: ${message}`, undefined, hunkIndex);
		}
		try {
			updateContents = {
				originalContent: readContent!,
				newContent: deriveNewContents(sourcePath, hunk.chunks, readContent!, mode),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			fail(message, undefined, hunkIndex);
		}
		const { originalContent, newContent } = updateContents!;

		if (hunk.movePath === undefined) {
			try {
				await writeSecureFile(fsContext, sourcePath, newContent, false, signal);
			} catch (error) {
				delta.exact = false;
				fail(`Failed to write file ${sourcePath}`, error, hunkIndex);
			}
			delta.changes.push({
				type: "update",
				operationIndex: hunkIndex,
				path: sourcePath,
				displayPath: hunk.path,
				targetPath: sourcePath,
				targetDisplayPath: hunk.path,
				originalContent,
				newContent,
			});
			affected.modified.push(hunk.path);
			continue;
		}

		const targetPath = resolvePatchPath(cwd, hunk.movePath);
		let overwrittenMoveContent: string | undefined;
		try {
			overwrittenMoveContent = await readSecureFileOptional(fsContext, targetPath, signal);
		} catch {
			delta.exact = false;
		}

		try {
			await writeSecureFile(fsContext, targetPath, newContent, true, signal);
		} catch (error) {
			delta.exact = false;
			fail(`Failed to write file ${targetPath}`, error, hunkIndex);
		}

		const provisionalIndex = delta.changes.length;
		delta.changes.push({
			type: "add",
			operationIndex: hunkIndex,
			path: targetPath,
			displayPath: hunk.movePath,
			content: newContent,
			overwrittenContent: overwrittenMoveContent,
		});

		try {
			await removeSecureFile(fsContext, sourcePath, signal);
		} catch (error) {
			// Destination write is already committed. Keep the provisional Add delta.
			try {
				const currentSource = await readSecureFile(fsContext, sourcePath, signal);
				if (currentSource !== originalContent) delta.exact = false;
			} catch {
				delta.exact = false;
			}
			fail(`Failed to remove original ${sourcePath}`, error, hunkIndex);
		}

		delta.changes[provisionalIndex] = {
			type: "update",
			operationIndex: hunkIndex,
			path: sourcePath,
			displayPath: hunk.path,
			targetPath,
			targetDisplayPath: hunk.movePath,
			originalContent,
			newContent,
			overwrittenMoveContent,
		};
		// Pinned Codex 6525b95: AffectedPaths records the source hunk path even for Move updates.
		affected.modified.push(hunk.path);
	}

	return { affected, delta };
}

function summaryFromAppliedChange(change: AppliedChange): FileChangeSummary {
	if (change.type === "add") return { action: "A", path: change.displayPath };
	if (change.type === "delete") return { action: "D", path: change.displayPath };
	return { action: "M", path: change.displayPath };
}

function orderedFileSummaries(delta: AppliedDelta): FileChangeSummary[] {
	const summaries = delta.changes.map(summaryFromAppliedChange);
	return [
		...summaries.filter((summary) => summary.action === "A"),
		...summaries.filter((summary) => summary.action === "M"),
		...summaries.filter((summary) => summary.action === "D"),
	];
}

function fileSummariesFromAffected(affected: AffectedPaths): FileChangeSummary[] {
	return [
		...affected.added.map((path) => ({ action: "A" as const, path })),
		...affected.modified.map((path) => ({ action: "M" as const, path })),
		...affected.deleted.map((path) => ({ action: "D" as const, path })),
	];
}

function verificationSummaries(proposed: ProposedChange[]): Array<{ action: "A" | "D" | "M"; path: string }> {
	return proposed.map((change) => ({
		action: change.type === "add" ? "A" : change.type === "delete" ? "D" : "M",
		path: change.displayPath,
	}));
}

function patchOperationResults(delta: AppliedDelta): PatchOperationResult[] {
	return delta.changes.map((change) => {
		if (change.type === "add") {
			const diff = generateDiffString("", change.content);
			return {
				operationIndex: change.operationIndex,
				toolName: "write",
				content: [
					{
						type: "text",
						text: `Successfully wrote ${Buffer.byteLength(change.content, "utf8")} bytes to ${change.displayPath}`,
					},
				],
				details: undefined,
				renderDiff: diff.diff,
			};
		}

		if (change.type === "delete") {
			const original = change.originalContent;
			const diff = generateDiffString(original, "");
			return {
				operationIndex: change.operationIndex,
				toolName: "edit",
				content: [{ type: "text", text: `Successfully deleted ${change.displayPath}.` }],
				details: {
					diff: diff.diff,
					patch: generateUnifiedPatch(change.displayPath, original, ""),
					firstChangedLine: diff.firstChangedLine,
				},
				renderDiff: diff.diff,
			};
		}

		const diff = generateDiffString(change.originalContent, change.newContent);
		const moved = change.targetPath !== change.path;
		return {
			operationIndex: change.operationIndex,
			toolName: "edit",
			content: [
				{
					type: "text",
					text: moved
						? `Successfully updated ${change.displayPath} and moved it to ${change.targetDisplayPath}.`
						: `Successfully updated ${change.displayPath}.`,
				},
			],
			details: {
				diff: diff.diff,
				patch: generateUnifiedPatch(change.displayPath, change.originalContent, change.newContent),
				firstChangedLine: diff.firstChangedLine,
			},
			renderDiff: diff.diff,
		};
	});
}

function renderOperationsFromHunks(hunks: PatchHunk[]): PatchRenderOperation[] {
	return hunks.map((hunk, index) => {
		const action = hunk.type === "add" ? "A" : hunk.type === "delete" ? "D" : "M";
		const key = `${index}:${action}:${hunk.path}`;
		if (hunk.type === "add") {
			const addedLines = hunk.contents.length === 0
				? 0
				: hunk.contents.endsWith("\n")
					? hunk.contents.slice(0, -1).split("\n").length
					: hunk.contents.split("\n").length;
			return { key, action, path: hunk.path, addedLines, removedLines: 0 };
		}
		if (hunk.type === "delete") {
			return { key, action, path: hunk.path };
		}
		return {
			key,
			action,
			path: hunk.path,
			movePath: hunk.movePath,
			addedLines: hunk.chunks.reduce((total, chunk) => total + chunk.newLines.length, 0),
			removedLines: hunk.chunks.reduce((total, chunk) => total + chunk.oldLines.length, 0),
		};
	});
}

function previewRenderOperations(input: unknown): PatchRenderOperation[] {
	return scanApplyPatchPreviewTargets(input).map((target, index) => ({
		key: `${index}:${target.action}:${target.path}`,
		action: target.action,
		path: target.path,
		movePath: target.movePath,
	}));
}

function buildRenderOperations(input: unknown): PatchRenderOperation[] {
	if (typeof input !== "string" || input.length === 0) return [];
	try {
		return renderOperationsFromHunks(parsePatch(input).hunks);
	} catch {
		try {
			const parser = new StreamingPatchParser();
			const streamed = renderOperationsFromHunks(parser.pushDelta(input));
			if (streamed.length > 0) return streamed;
		} catch {
			// Fall through to the tolerant render-only scan below.
		}

		// The final streamed line often has no trailing newline yet. The strict
		// parser cannot consume that header, but the outer compact tool UI already
		// needs action + path for its one-line title. This scan is display-only;
		// execution still uses the strict parser and verifier.
		return previewRenderOperations(input);
	}
}

function firstTextContent(content: PatchOperationResult["content"]): string | undefined {
	return content.find((item) => item.type === "text")?.text;
}

/**
 * Lightweight apply_patch renderer.
 *
 * Deliberately does NOT instantiate nested Pi ToolExecutionComponent instances for `edit`
 * or `write`. Renderer-polishing extensions commonly monkeypatch ToolExecutionComponent and
 * may route nested edit/write rendering back through apply_patch, causing re-entrant render
 * invalidation and a stack overflow. Keeping this component self-contained makes rendering
 * composable with those extensions while leaving patch execution/details unchanged.
 */
class PatchCallRenderComponent {
	private rows: PatchToolRow[] = [];

	updateOperations(operations: PatchRenderOperation[], _context: PatchRendererContext): void {
		const previous = new Map(this.rows.map((row) => [row.key, row]));
		this.rows = operations.map((operation) => {
			const existing = previous.get(operation.key);
			return {
				key: operation.key,
				operation,
				resultText: existing?.resultText,
				errorText: existing?.errorText,
				renderDiff: existing?.renderDiff,
			};
		});
	}

	updateResults(operations: PatchOperationResult[]): void {
		for (const operation of operations) {
			const row = this.rows[operation.operationIndex];
			if (!row) continue;
			row.resultText = firstTextContent(operation.content);
			row.errorText = undefined;
			row.renderDiff = operation.renderDiff ?? operation.details?.diff;
		}
	}

	updateError(content: PatchOperationResult["content"], operationIndex?: number): void {
		const row = operationIndex === undefined ? this.rows[0] : this.rows[operationIndex] ?? this.rows[0];
		if (!row) return;
		row.errorText = firstTextContent(content) ?? "apply_patch failed";
	}

	render(width: number): string[] {
		if (this.rows.length === 0) return ["apply_patch"];

		// Keep the tool identity on its own row, but include a compact target so
		// header-only / `nothing` mode still tells the user which file is being
		// patched. The tri-mode wrapper owns the dynamic `(ctrl + o to toggle)`
		// suffix and will append it after this target.
		const firstOperation = this.rows[0].operation;
		const firstTarget = firstOperation.movePath === undefined
			? displayToolPath(firstOperation.path)
			: `${displayToolPath(firstOperation.path)} -> ${displayToolPath(firstOperation.movePath)}`;
		const extraTargetCount = this.rows.length - 1;
		const targetSuffix = extraTargetCount > 0
			? ` (+${extraTargetCount} more)`
			: "";
		const firstHeader = firstOperation.movePath === undefined
			? compactFileHeader("apply_patch", firstOperation.action, firstOperation.path)
			: `apply_patch ${firstOperation.action} ${firstTarget}`;
		const output = [`${firstHeader}${targetSuffix}`];
		for (const row of this.rows) {
			const operation = row.operation;
			const target = operation.movePath === undefined
				? displayToolPath(operation.path)
				: `${displayToolPath(operation.path)} -> ${displayToolPath(operation.movePath)}`;
			const counts = operation.addedLines === undefined && operation.removedLines === undefined
				? ""
				: ` (+${operation.addedLines ?? 0}/-${operation.removedLines ?? 0})`;

			if (row.errorText !== undefined) {
				output.push(`  ${operation.action} ${target}${counts} — ${row.errorText}`);
			} else if (row.resultText !== undefined) {
				output.push(`  ${operation.action} ${target}${counts} — ${row.resultText}`);
			} else {
				output.push(`  ${operation.action} ${target}${counts}`);
			}

			// The tri-mode extension can only hide/cap/expand rows that actually exist.
			// Expose the real post-apply diff as call-body rows so:
			//   nothing   -> header only
			//   collapsed -> capped diff preview
			//   expanded  -> complete diff
			// Keep the renderer self-contained; do not instantiate nested edit components.
			if (row.renderDiff) {
				const diffRows = row.renderDiff
					.replace(/\r\n/g, "\n")
					.split("\n");
				while (diffRows.length > 0 && diffRows[0].trim().length === 0) diffRows.shift();
				while (diffRows.length > 0 && diffRows.at(-1)!.trim().length === 0) diffRows.pop();
				for (const diffRow of diffRows) output.push(`    ${diffRow}`);
			}
		}

		if (width <= 0) return output;
		return output.map((row) => visibleWidth(row) > width ? truncateToWidth(row, width, "...") : row);
	}

	invalidate(): void {
		// No nested ToolExecutionComponent state to invalidate. Pi owns the outer render cycle.
	}
}

function isPiOpenAIGrammarToolApi(model: unknown): boolean {
	if (!model || typeof model !== "object") return false;
	const api = (model as { api?: unknown }).api;
	return api === "openai-completions"
		|| api === "openai-responses"
		|| api === "azure-openai-responses"
		|| api === "openai-codex-responses";
}

function supportsOpenAIGrammarTools(model: unknown): boolean {
	if (!model || typeof model !== "object") return false;
	return (model as { compat?: { supportsOpenAIGrammarTools?: unknown } }).compat
		?.supportsOpenAIGrammarTools === true;
}

function nativeApplyPatchSupport(
	model: unknown,
	secureBackendAvailable = secureFilesystemSupported(),
	toolAvailable = true,
): NativeApplyPatchSupport {
	const apiCompatible = isPiOpenAIGrammarToolApi(model);
	const grammarCompatible = supportsOpenAIGrammarTools(model);
	if (!apiCompatible) {
		return {
			supported: false, apiCompatible, grammarCompatible, secureBackendAvailable, toolAvailable,
			reason: "current Pi API does not support native OpenAI grammar custom tools",
		};
	}
	if (!grammarCompatible) {
		return {
			supported: false, apiCompatible, grammarCompatible, secureBackendAvailable, toolAvailable,
			reason: "current model does not support OpenAI grammar tools",
		};
	}
	if (!secureBackendAvailable) {
		return {
			supported: false, apiCompatible, grammarCompatible, secureBackendAvailable, toolAvailable,
			reason: "secure filesystem backend unavailable",
		};
	}
	if (!toolAvailable) {
		return {
			supported: false, apiCompatible, grammarCompatible, secureBackendAvailable, toolAvailable,
			reason: "tool excluded by Pi tool configuration",
		};
	}
	return { supported: true, apiCompatible, grammarCompatible, secureBackendAvailable, toolAvailable };
}

function supportsNativeApplyPatch(model: unknown): boolean {
	return nativeApplyPatchSupport(model).supported;
}

function applyPatchSupport(
	model: unknown,
	filesystemBackend: ApplyPatchFilesystemBackend = applyPatchFilesystemBackend(),
	toolAvailable = true,
): ApplyPatchSupport {
	const apiCompatible = isPiOpenAIGrammarToolApi(model);
	const grammarCompatible = supportsOpenAIGrammarTools(model);
	const secureBackendAvailable = filesystemBackend === "secure";
	if (!toolAvailable) {
		return {
			supported: false, apiCompatible, grammarCompatible, secureBackendAvailable, filesystemBackend, toolAvailable,
			reason: "tool excluded by Pi tool configuration",
		};
	}
	if (filesystemBackend === "unavailable") {
		return {
			supported: false, apiCompatible, grammarCompatible, secureBackendAvailable, filesystemBackend, toolAvailable,
			reason: "filesystem backend unavailable",
		};
	}
	const transport: ApplyPatchTransport = apiCompatible && grammarCompatible ? "native" : "compatibility";
	return {
		supported: true,
		transport,
		apiCompatible,
		grammarCompatible,
		secureBackendAvailable,
		filesystemBackend,
		toolAvailable,
	};
}

function nativePatchSurfaceInvariant(support: ApplyPatchSupport, activeTools: readonly string[]): boolean {
	return activeTools.includes("apply_patch") === support.supported;
}

function toolNamesFromConfiguredTools(tools: readonly unknown[]): Set<string> {
	const names = new Set<string>();
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const name = (tool as { name?: unknown }).name;
		if (typeof name === "string") names.add(name);
	}
	return names;
}

function applyPatchAvailableInPi(tools: readonly unknown[]): boolean {
	return toolNamesFromConfiguredTools(tools).has("apply_patch");
}

type ProviderPatchGuardResult = {
	payload: unknown;
	changed: boolean;
	violation?: string;
	fatal?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerWireToolName(tool: unknown): string | undefined {
	if (!isRecord(tool)) return undefined;
	if (typeof tool.name === "string") return tool.name;
	if (isRecord(tool.function) && typeof tool.function.name === "string") return tool.function.name;
	if (isRecord(tool.custom) && typeof tool.custom.name === "string") return tool.custom.name;
	return undefined;
}

function providerWireToolDescription(tool: unknown): string | undefined {
	if (!isRecord(tool)) return undefined;
	if (typeof tool.description === "string") return tool.description;
	if (isRecord(tool.custom) && typeof tool.custom.description === "string") return tool.custom.description;
	return undefined;
}

type ProviderGrammarDefinition = { syntax: string; definition: string };

function providerWireGrammarDefinition(tool: unknown): ProviderGrammarDefinition | undefined {
	if (!isRecord(tool)) return undefined;
	const holder = isRecord(tool.custom) ? tool.custom : tool;
	if (!isRecord(holder.format) || holder.format.type !== "grammar") return undefined;
	const format = holder.format;
	if (typeof format.syntax === "string" && typeof format.definition === "string") {
		return { syntax: format.syntax, definition: format.definition };
	}
	if (isRecord(format.grammar)
		&& typeof format.grammar.syntax === "string"
		&& typeof format.grammar.definition === "string") {
		return { syntax: format.grammar.syntax, definition: format.grammar.definition };
	}
	return undefined;
}

function normalizeProviderGrammarDefinition(value: string): string {
	// Pi/OpenAI serializers preserve the Lark body; tolerate only platform newline normalization.
	return value.replace(/\r\n?/g, "\n");
}

function providerWireApplyPatchIsNativeGrammar(tool: unknown): boolean {
	if (!isRecord(tool) || tool.type !== "custom" || providerWireToolName(tool) !== "apply_patch") return false;
	const grammar = providerWireGrammarDefinition(tool);
	if (!grammar || grammar.syntax !== "lark") return false;
	if (normalizeProviderGrammarDefinition(grammar.definition) !== normalizeProviderGrammarDefinition(APPLY_PATCH_GRAMMAR)) {
		return false;
	}
	// Responses carries description at the top level and Chat Completions carries it in custom.
	// If a serializer intentionally omits it, absence is accepted; if present, it must be exact.
	const description = providerWireToolDescription(tool);
	return description === undefined || description === APPLY_PATCH_DESCRIPTION;
}

function providerWireFunctionParameters(tool: unknown): Record<string, unknown> | undefined {
	if (!isRecord(tool)) return undefined;
	const holder = isRecord(tool.function) ? tool.function : tool;
	if (isRecord(holder.parameters)) return holder.parameters;
	if (isRecord(holder.input_schema)) return holder.input_schema;
	if (isRecord(holder.inputSchema)) return holder.inputSchema;
	return undefined;
}

function providerWireApplyPatchIsFunction(tool: unknown): boolean {
	if (!isRecord(tool) || providerWireToolName(tool) !== "apply_patch") return false;
	if (tool.type === "custom") return false;
	const parameters = providerWireFunctionParameters(tool);
	if (!parameters || parameters.type !== "object") return false;
	if (!isRecord(parameters.properties) || !isRecord(parameters.properties.input)) return false;
	if (parameters.properties.input.type !== "string") return false;
	if (!Array.isArray(parameters.required) || !parameters.required.includes("input")) return false;
	if (parameters.additionalProperties === true) return false;
	return true;
}

function rewriteCompatibilityApplyPatchDescription(tool: unknown): unknown {
	if (!isRecord(tool) || !providerWireApplyPatchIsFunction(tool)) return tool;
	if (isRecord(tool.function)) {
		return {
			...tool,
			function: { ...tool.function, description: APPLY_PATCH_COMPAT_DESCRIPTION },
		};
	}
	return { ...tool, description: APPLY_PATCH_COMPAT_DESCRIPTION };
}

function toolChoiceForcesNamedTool(choice: unknown, name: string): boolean {
	if (choice === name) return true;
	if (!isRecord(choice)) return false;
	if (choice.type === name || choice.name === name) return true;
	if (isRecord(choice.function) && choice.function.name === name) return true;
	if (isRecord(choice.custom) && choice.custom.name === name) return true;
	return false;
}

function providerToolChoiceForcesApplyPatch(payload: unknown): boolean {
	if (!isRecord(payload)) return false;
	return toolChoiceForcesNamedTool(payload.tool_choice, "apply_patch")
		|| toolChoiceForcesNamedTool(payload.toolChoice, "apply_patch");
}

function guardApplyPatchProviderPayload(
	payload: unknown,
	support: ApplyPatchSupport,
): ProviderPatchGuardResult {
	if (!isRecord(payload)) return { payload, changed: false };
	const forcedPatch = providerToolChoiceForcesApplyPatch(payload);
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const patchEntries = tools.filter((tool) => providerWireToolName(tool) === "apply_patch");

	if (!support.supported) {
		if (patchEntries.length === 0) {
			if (forcedPatch) {
				return {
					payload,
					changed: false,
					fatal: true,
					violation: "apply_patch is unavailable but this request forced apply_patch",
				};
			}
			return { payload, changed: false };
		}
		if (forcedPatch) {
			return {
				payload,
				changed: false,
				fatal: true,
				violation: "apply_patch is unavailable but this request forced apply_patch",
			};
		}
		return {
			payload: { ...payload, tools: tools.filter((tool) => providerWireToolName(tool) !== "apply_patch") },
			changed: true,
			violation: "apply_patch unavailable: removed apply_patch from provider payload",
		};
	}

	if (patchEntries.length === 0) {
		if (forcedPatch) {
			return {
				payload,
				changed: false,
				fatal: true,
				violation: "apply_patch is active but missing from provider payload while the request forced it",
			};
		}
		return { payload, changed: false };
	}

	if (support.transport === "native") {
		const invalid = patchEntries.some((tool) => !providerWireApplyPatchIsNativeGrammar(tool));
		if (!invalid) return { payload, changed: false };
		return {
			payload,
			changed: false,
			fatal: true,
			violation: "apply_patch native serialization invariant violated: expected the exact Codex Lark custom tool",
		};
	}

	const invalid = patchEntries.some((tool) => !providerWireApplyPatchIsFunction(tool));
	if (invalid) {
		return {
			payload,
			changed: false,
			fatal: true,
			violation: "apply_patch compatibility serialization invariant violated: expected a normal function tool with one required string `input` parameter",
		};
	}
	const rewrittenTools = tools.map((tool) =>
		providerWireToolName(tool) === "apply_patch" ? rewriteCompatibilityApplyPatchDescription(tool) : tool
	);
	return { payload: { ...payload, tools: rewrittenTools }, changed: true };
}

// Backward-compatible test-surface alias. The production path uses the transport-aware guard.
function guardNativeApplyPatchProviderPayload(
	payload: unknown,
	support: NativeApplyPatchSupport,
): ProviderPatchGuardResult {
	const filesystemBackend: ApplyPatchFilesystemBackend = support.secureBackendAvailable ? "secure" : "unavailable";
	const transportAware: ApplyPatchSupport = {
		...support,
		filesystemBackend,
		transport: support.supported ? "native" : undefined,
	};
	return guardApplyPatchProviderPayload(payload, transportAware);
}

function parseApplyPatchToolMode(value: unknown): { mode: ApplyPatchToolMode; warning?: string } {
	if (value === undefined || value === null) return { mode: "replace" };
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed === "") return { mode: "replace" };
		if (trimmed === "replace" || trimmed === "additive" || trimmed === "off") return { mode: trimmed };
		return {
			mode: "replace",
			warning: `Invalid apply_patch mode '${trimmed}'. Expected: replace, additive, or off. Using replace.`,
		};
	}
	return {
		mode: "replace",
		warning: `Invalid apply_patch mode '${String(value)}'. Expected: replace, additive, or off. Using replace.`,
	};
}

function isApplyPatchToolMode(value: string): value is ApplyPatchToolMode {
	return value === "replace" || value === "additive" || value === "off";
}

function initialFileToolOwnership(): FileToolOwnership {
	return {
		surface: "unsupported",
		editRemovedByUs: false,
		writeRemovedByUs: false,
	};
}

function insertToolAt(tools: string[], tool: string, index: number | undefined): void {
	if (tools.includes(tool)) return;
	const target = index === undefined ? tools.length : Math.max(0, Math.min(index, tools.length));
	tools.splice(target, 0, tool);
}

function restoreOwnedFileTools(
	tools: string[],
	ownership: FileToolOwnership,
	availableTools?: ReadonlySet<string>,
): void {
	const candidates = [
		{ name: "edit", owned: ownership.editRemovedByUs, index: ownership.editRestoreIndex },
		{ name: "write", owned: ownership.writeRemovedByUs, index: ownership.writeRestoreIndex },
	].filter((item) =>
		item.owned
		&& !tools.includes(item.name)
		&& (availableTools === undefined || availableTools.has(item.name))
	);

	candidates.sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
	for (const candidate of candidates) insertToolAt(tools, candidate.name, candidate.index);

	// Explicit Pi tool filtering supersedes our restoration ownership. If a tool is now
	// excluded, clear ownership rather than resurrecting it on a later sync.
	ownership.editRemovedByUs = false;
	ownership.writeRemovedByUs = false;
	ownership.editRestoreIndex = undefined;
	ownership.writeRestoreIndex = undefined;
}

function computeDesiredToolTransition(input: {
	activeTools: string[];
	support: boolean;
	mode: ApplyPatchToolMode;
	ownership: FileToolOwnership;
	availableTools?: ReadonlySet<string>;
}): { nextTools: string[]; nextOwnership: FileToolOwnership } {
	let nextTools = [...input.activeTools];
	const nextOwnership: FileToolOwnership = { ...input.ownership };

	// If a tool we previously removed is active again, another actor restored it. Relinquish
	// ownership immediately so future transitions preserve that external/manual activation.
	if (nextOwnership.editRemovedByUs && nextTools.includes("edit")) {
		nextOwnership.editRemovedByUs = false;
		nextOwnership.editRestoreIndex = undefined;
	}
	if (nextOwnership.writeRemovedByUs && nextTools.includes("write")) {
		nextOwnership.writeRemovedByUs = false;
		nextOwnership.writeRestoreIndex = undefined;
	}

	if (input.mode === "off") {
		nextTools = nextTools.filter((name) => name !== "apply_patch");
		restoreOwnedFileTools(nextTools, nextOwnership, input.availableTools);
		nextOwnership.surface = "off";
		return { nextTools, nextOwnership };
	}

	if (!input.support) {
		nextTools = nextTools.filter((name) => name !== "apply_patch");
		restoreOwnedFileTools(nextTools, nextOwnership, input.availableTools);
		nextOwnership.surface = "unsupported";
		return { nextTools, nextOwnership };
	}

	if (input.mode === "additive") {
		if (!nextTools.includes("apply_patch")) nextTools.push("apply_patch");
		restoreOwnedFileTools(nextTools, nextOwnership, input.availableTools);
		nextOwnership.surface = "additive";
		return { nextTools, nextOwnership };
	}

	// Entering replace mode takes ownership only of file tools that are active at that
	// transition. A repeated B -> B sync does not fight a later external reactivation.
	if (nextOwnership.surface !== "replace") {
		const editIndex = nextTools.indexOf("edit");
		const writeIndex = nextTools.indexOf("write");
		if (editIndex !== -1) {
			nextOwnership.editRemovedByUs = true;
			nextOwnership.editRestoreIndex = editIndex;
		}
		if (writeIndex !== -1) {
			nextOwnership.writeRemovedByUs = true;
			nextOwnership.writeRestoreIndex = writeIndex;
		}
		nextTools = nextTools.filter((name) => name !== "edit" && name !== "write");
	}
	if (!nextTools.includes("apply_patch")) nextTools.push("apply_patch");
	nextOwnership.surface = "replace";
	return { nextTools, nextOwnership };
}

function sameToolList(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

function effectiveFileToolSurface(activeTools: string[]): string {
	const names = ["edit", "write", "apply_patch"].filter((name) => activeTools.includes(name));
	return names.length === 0 ? "(none)" : names.join(", ");
}



export type CodexApplyPatchSupport = ApplyPatchSupport;

export function registerCodexApplyPatchTool(pi: ExtensionAPI): void {
	const pendingFailureDetails = new Map<string, ApplyPatchDetails>();
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: APPLY_PATCH_DESCRIPTION,
		promptSnippet: APPLY_PATCH_PROMPT_SNIPPET,
		promptGuidelines: APPLY_PATCH_PROMPT_GUIDELINES,
		parameters: APPLY_PATCH_PARAMETERS,
		constrainedSampling: {
			type: "grammar",
			variants: { openai_lark: APPLY_PATCH_GRAMMAR },
		},
		executionMode: "sequential",
		// The pinned Codex ApplyPatchHandler does not opt into parallel local dispatch. Pi's
		// public executionMode models that local property. Do not rewrite provider request-level
		// parallel_tool_calls here: that setting is model/request policy in Codex, not apply_patch semantics.
		renderShell: "default",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			pendingFailureDetails.delete(toolCallId);
			const publishFailureDetails = (details: ApplyPatchDetails, text: string): void => {
				pendingFailureDetails.set(toolCallId, details);
				try {
					onUpdate?.({ content: [{ type: "text", text }], details });
				} catch (error) {
					pendingFailureDetails.delete(toolCallId);
					throw error;
				}
			};
			throwIfAborted(signal);

			let parsed: ParsedPatch;
			try {
				parsed = parsePatch(params.input);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`apply_patch verification failed: ${message}`);
			}

			if (parsed.environmentId !== undefined) {
				throw new Error("apply_patch environment selection is unavailable for this turn");
			}

			// Semantic path resolution must preserve the turn cwd spelling. Do not realpath() it.
			const semanticCwd = resolve(ctx.cwd);
			const mode = getUpdateMode();
			const lockPaths = parsed.hunks.flatMap((hunk) => {
				const paths = [resolvePatchPath(semanticCwd, hunk.path)];
				if (hunk.type === "update" && hunk.movePath !== undefined) {
					paths.push(resolvePatchPath(semanticCwd, hunk.movePath));
				}
				return paths;
			});

			return withMutationQueues(lockPaths, async () => {
				// Open/pin the trusted workspace cwd exactly once for this tool call. Semantic path
				// resolution remains lexical; only inside-cwd filesystem traversal uses this descriptor.
				const fsContext = await openSecureFilesystemContext(semanticCwd, signal);
				try {
					let proposed: ProposedChange[];
					try {
						proposed = await verifyCodexPatchSemantics(parsed, semanticCwd, fsContext, mode, signal);
					} catch (error) {
						if (error instanceof PiPatchPolicyError) {
							const details: ApplyPatchDetails = {
								files: [],
								operations: [],
								verification: [],
								committed: { exact: true, files: [] },
								updateMode: mode,
								errorStage: "pi-policy",
							};
							publishFailureDetails(details, error.message);
							throw new Error(error.message);
						}
						const message = error instanceof Error ? error.message : String(error);
						throw new Error(`apply_patch verification failed: ${message}`);
					}

					try {
						await enforcePiPatchSecurityPolicy(parsed, semanticCwd, fsContext, proposed, signal);
					} catch (error) {
						if (!(error instanceof PiPatchPolicyError)) throw error;
						const details: ApplyPatchDetails = {
							files: [],
							operations: [],
							verification: verificationSummaries(proposed),
							committed: { exact: true, files: [] },
							updateMode: mode,
							errorStage: "pi-policy",
						};
						publishFailureDetails(details, error.message);
						throw new Error(error.message);
					}

					throwIfAborted(signal);
					let runtime: RuntimeApplySuccess;
					try {
						runtime = await runtimeApplyPatch(parsed.patch, semanticCwd, fsContext, mode, signal);
					} catch (error) {
						if (error instanceof ApplyPatchRuntimeError) {
							const committedFiles = orderedFileSummaries(error.delta);
							const details: ApplyPatchDetails = {
								files: committedFiles,
								operations: patchOperationResults(error.delta),
								verification: verificationSummaries(proposed),
								committed: { exact: error.delta.exact, files: committedFiles },
								updateMode: mode,
								errorStage: "runtime",
								failedOperationIndex: error.failedHunkIndex,
							};
							publishFailureDetails(details, error.message);
							throw new Error(error.message);
						}
						throw error;
					}

					const files = fileSummariesFromAffected(runtime.affected);
					const output = [
						"Success. Updated the following files:",
						...files.map((file) => `${file.action} ${file.path}`),
						"",
					].join("\n");
					const committedFiles = orderedFileSummaries(runtime.delta);

					return {
						content: [{ type: "text", text: output }],
						details: {
							files,
							operations: patchOperationResults(runtime.delta),
							verification: verificationSummaries(proposed),
							affected: runtime.affected,
							committed: { exact: runtime.delta.exact, files: committedFiles },
							updateMode: mode,
						} satisfies ApplyPatchDetails,
					};
				} finally {
					await fsContext.close();
				}
			});
		},

		renderCall(args, _theme, context) {
			const component =
				context.lastComponent instanceof PatchCallRenderComponent
					? context.lastComponent
					: context.state.callComponent ?? new PatchCallRenderComponent();
			context.state.callComponent = component;
			component.updateOperations(buildRenderOperations(args.input), context);
			return component;
		},

		renderResult(result, _options, _theme, context) {
			const callComponent = context.state.callComponent;
			const details = result.details as ApplyPatchDetails | undefined;
			if (details?.operations) {
				callComponent?.updateResults(details.operations);
			}
			if (context.isError) {
				const error = result.content.find((content) => content.type === "text");
				if (error?.type === "text") {
					callComponent?.updateError([error], details?.failedOperationIndex);
				}
			}

			const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
			component.clear();
			return component;
		},
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "apply_patch") return;
		const details = pendingFailureDetails.get(event.toolCallId);
		pendingFailureDetails.delete(event.toolCallId);
		if (!event.isError || !details) return;
		return { details };
	});
}

export function getCodexApplyPatchSupport(model: unknown, toolAvailable: boolean): CodexApplyPatchSupport {
	return applyPatchSupport(model, applyPatchFilesystemBackend(), toolAvailable);
}

export function guardCodexProviderPayload(payload: unknown, support: CodexApplyPatchSupport): ProviderPatchGuardResult {
	return guardApplyPatchProviderPayload(payload, support);
}

async function createSecureFileExclusive(
	context: SecureFilesystemAccess,
	absolutePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	if (isPortableFilesystemContext(context)) {
		const info = await inspectPortablePath(context, absolutePath, { allowMissingFinal: true, createParents: true }, signal);
		if (info.exists) throw new Error(`File already exists: ${absolutePath}`);
		throwIfAborted(signal);
		await writeFile(info.physicalPath, Buffer.from(content, "utf8"), { flag: "wx" });
		throwIfAborted(signal);
		return;
	}
	const { parent, name, closeParent } = await openSecureParent(context, absolutePath, true, signal);
	let file: FileHandle | undefined;
	try {
		throwIfAborted(signal);
		file = await openSecureChild(parent, name, SECURE_WRITE_FLAGS | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL, 0o666);
		const info = await file.stat();
		if (!info.isFile()) throw new Error(`Cannot create non-file '${absolutePath}'`);
		await writeAll(file, content, signal);
	} finally {
		await file?.close().catch(() => undefined);
		if (closeParent) await parent.close().catch(() => undefined);
	}
}

export interface SharedSecureFilesystem {
	readFile(path: string, signal?: AbortSignal): Promise<string>;
	readFileOptional(path: string, signal?: AbortSignal): Promise<string | undefined>;
	writeFile(path: string, content: string, allowCreate: boolean, signal?: AbortSignal): Promise<void>;
	createFile(path: string, content: string, signal?: AbortSignal): Promise<void>;
	stat(path: string, signal?: AbortSignal): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>;
}

export async function withSharedSecureFilesystem<T>(
	semanticCwd: string,
	signal: AbortSignal | undefined,
	fn: (filesystem: SharedSecureFilesystem) => Promise<T>,
): Promise<T> {
	const cwd = resolve(semanticCwd);
	const context = await openSecureFilesystemContext(cwd, signal);
	const absolute = (path: string): string => isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	try {
		const filesystem: SharedSecureFilesystem = {
			readFile: (path, innerSignal = signal) => readSecureFile(context, absolute(path), innerSignal),
			readFileOptional: (path, innerSignal = signal) => readSecureFileOptional(context, absolute(path), innerSignal),
			writeFile: (path, content, allowCreate, innerSignal = signal) => writeSecureFile(context, absolute(path), content, allowCreate, innerSignal),
			createFile: (path, content, innerSignal = signal) => createSecureFileExclusive(context, absolute(path), content, innerSignal),
			stat: (path, innerSignal = signal) => lstatSecureFinal(context, absolute(path), innerSignal),
		};
		return await fn(filesystem);
	} finally {
		await context.close();
	}
}

export function codexFilesystemBackend(): ApplyPatchFilesystemBackend {
	return applyPatchFilesystemBackend();
}

export const CODEX_APPLY_PATCH_BASELINE_SHA = "6525b95dae2082ac9fee672b14c2cffdef172bb8";

export const __applyPatchParityTesting = {
	NORMALIZE_TO_LF_MODE,
	PRESERVE_LINE_ENDINGS_MODE,
	APPLY_PATCH_DESCRIPTION,
	APPLY_PATCH_COMPAT_DESCRIPTION,
	APPLY_PATCH_PROMPT_SNIPPET,
	APPLY_PATCH_PROMPT_GUIDELINES,
	APPLY_PATCH_GRAMMAR,
	parsePatch,
	deriveNewContents,
	resolvePatchPath,
	getUpdateMode,
	secureFilesystemSupported,
	portableFilesystemAllowed,
	applyPatchFilesystemBackend,
	openSecureRoot,
	openTrustedCwdAnchor,
	openSecureFilesystemContext,
	pathIsWithinSemanticCwd,
	resolveSecurePathRoute,
	readSecureFile,
	writeSecureFile,
	removeSecureFile,
	verifyCodexPatchSemantics,
	enforcePiPatchSecurityPolicy,
	runtimeApplyPatch,
	fileSummariesFromAffected,
	orderedFileSummaries,
	verificationSummaries,
	parseApplyPatchToolMode,
	isApplyPatchToolMode,
	isPiOpenAIGrammarToolApi,
	toolNamesFromConfiguredTools,
	applyPatchAvailableInPi,
	providerWireToolName,
	providerWireGrammarDefinition,
	providerWireApplyPatchIsNativeGrammar,
	providerWireApplyPatchIsFunction,
	providerToolChoiceForcesApplyPatch,
	guardNativeApplyPatchProviderPayload,
	guardApplyPatchProviderPayload,
	nativeApplyPatchSupport,
	applyPatchSupport,
	nativePatchSurfaceInvariant,
	supportsNativeApplyPatch,
	initialFileToolOwnership,
	computeDesiredToolTransition,
	effectiveFileToolSurface,
	classifySecureDirectoryTraversalError,
};
