import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDeepSeekFilesystemTools } from "../src/tools/deepseek/fs-tools.ts";
import { DEEPSEEK_READ_STREAM_MIN_SIZE } from "../src/tools/deepseek/fs-parity.ts";
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
