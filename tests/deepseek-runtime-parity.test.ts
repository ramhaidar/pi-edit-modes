import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDeepSeekFilesystemTools } from "../src/tools/deepseek/fs-tools.ts";
import { DEEPSEEK_READ_STREAM_MIN_SIZE } from "../src/tools/deepseek/fs-parity.ts";
import { deepSeekDirectoryEntryMarker, registerDeepSeekTool } from "../src/tools/deepseek/index.ts";
import { clearDeepSeekFsRuntimes, getDeepSeekFsRuntime } from "../src/tools/deepseek/runtime.ts";

function tools(): any[] {
  const values: any[] = [];
  registerDeepSeekFilesystemTools({ registerTool: (value: any) => values.push(value) } as any);
  return values;
}

function minimalTool(): any {
  const values: any[] = [];
  registerDeepSeekTool({ registerTool: (value: any) => values.push(value) } as any);
  return values.find((value) => value.name === "str_replace_editor");
}

test("DeepSeek mutations are sequential while read stays parallel", () => {
  const values = tools();
  assert.equal(values.find((value) => value.name === "read")?.executionMode, "parallel");
  assert.equal(values.find((value) => value.name === "write")?.executionMode, "sequential");
  assert.equal(values.find((value) => value.name === "edit")?.executionMode, "sequential");
});

test("DeepSeek minimal str_replace_editor is sequential and adds no standalone prompt", () => {
  const editor = minimalTool();
  assert.equal(editor?.executionMode, "sequential");
  assert.equal(editor?.promptSnippet, undefined);
  assert.equal(editor?.promptGuidelines, undefined);
});

test("DeepSeek shipped minimal editor mutates current files without a prior view", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-deepseek-minimal-no-observation-"));
  try {
    const replacePath = join(cwd, "replace.txt");
    const insertPath = join(cwd, "insert.txt");
    await writeFile(replacePath, "alpha\n", "utf8");
    await writeFile(insertPath, "one\ntwo\n", "utf8");
    const editor = minimalTool();
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "minimal-no-observation" },
    };

    await editor.execute(
      "minimal-replace",
      { command: "str_replace", path: replacePath, old_str: "alpha", new_str: "beta" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(await readFile(replacePath, "utf8"), "beta\n");

    await editor.execute(
      "minimal-insert",
      { command: "insert", path: insertPath, insert_line: 1, new_str: "middle" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(await readFile(insertPath, "utf8"), "one\nmiddle\ntwo\n");
  } finally {
    clearDeepSeekFsRuntimes();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("DeepSeek minimal directory markers match Harness for symlinks and other entries", () => {
  assert.equal(deepSeekDirectoryEntryMarker("directory"), "d");
  assert.equal(deepSeekDirectoryEntryMarker("file"), "f");
  assert.equal(deepSeekDirectoryEntryMarker("symlink"), "?");
  assert.equal(deepSeekDirectoryEntryMarker("other"), "?");
});

test("DeepSeek large-file read keeps window semantics through streaming path", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-deepseek-stream-"));
  try {
    const path = join(cwd, "large.txt");
    const line = "0123456789abcdef\n";
    const count = Math.ceil((DEEPSEEK_READ_STREAM_MIN_SIZE + 1024) / Buffer.byteLength(line));
    await writeFile(path, line.repeat(count), "utf8");
    const runtime = getDeepSeekFsRuntime({
      cwd,
      sessionManager: { getSessionId: () => "stream-session" },
    });
    const result = await runtime.read(path, count - 2, 2);
    assert.deepEqual(
      result.lines.map((entry) => entry.number),
      [count - 2, count - 1],
    );
    assert.equal(result.totalLines, count);
  } finally {
    clearDeepSeekFsRuntimes();
    await rm(cwd, { recursive: true, force: true });
  }
});
