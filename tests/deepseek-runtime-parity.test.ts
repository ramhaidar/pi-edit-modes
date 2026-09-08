import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("DeepSeek mutations are sequential while read stays parallel", () => {
  const values = tools();
  assert.equal(values.find((value) => value.name === "read")?.executionMode, "parallel");
  assert.equal(values.find((value) => value.name === "write")?.executionMode, "sequential");
  assert.equal(values.find((value) => value.name === "edit")?.executionMode, "sequential");
});

test("DeepSeek minimal str_replace_editor is sequential and does not advertise unavailable write/edit", () => {
  const values: any[] = [];
  registerDeepSeekTool({ registerTool: (value: any) => values.push(value) } as any);
  const editor = values.find((value) => value.name === "str_replace_editor");
  assert.equal(editor?.executionMode, "sequential");
  assert.match(editor?.promptSnippet ?? "", /str_replace_editor/);
  assert.doesNotMatch(editor?.promptSnippet ?? "", /Use write|edit for targeted/);
  assert.doesNotMatch((editor?.promptGuidelines ?? []).join("\n"), /use write, edit, or/i);
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
