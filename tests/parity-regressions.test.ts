import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCodexApplyPatchTool } from "../src/tools/codex/engine.ts";
import { registerGeminiTools } from "../src/tools/gemini/index.ts";
import { clearDeepSeekFsRuntimes, getDeepSeekFsRuntime } from "../src/tools/deepseek/runtime.ts";
import { registerDeepSeekReadImageTool } from "../src/tools/deepseek/fs-tools.ts";

function captureTools(register: (pi: any) => void): any[] {
  const tools: any[] = [];
  register({
    registerTool: (tool: any) => tools.push(tool),
    on: () => undefined,
  });
  return tools;
}

test("Gemini write_file overwrites an existing file without a hidden overwrite flag", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-write-"));
  try {
    const path = join(cwd, "file.txt");
    await writeFile(path, "old\n", "utf8");
    const tool = captureTools(registerGeminiTools).find((item) => item.name === "write_file");
    assert.ok(tool);
    await tool.execute(
      "call-1",
      { file_path: "file.txt", content: "new\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(path, "utf8"), "new\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("DeepSeek observation state is session-scoped even when sessions share cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-deepseek-session-"));
  try {
    const path = join(cwd, "shared.txt");
    await writeFile(path, "alpha\n", "utf8");
    const sessionA = { cwd, sessionManager: { getSessionId: () => "session-a" } };
    const sessionB = { cwd, sessionManager: { getSessionId: () => "session-b" } };
    const runtimeA = getDeepSeekFsRuntime(sessionA);
    const runtimeB = getDeepSeekFsRuntime(sessionB);
    await runtimeA.read(path);
    await assert.rejects(() => runtimeB.edit(path, "alpha", "beta", false), /not observed|observe|read/i);
  } finally {
    clearDeepSeekFsRuntimes();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("DeepSeek read_image exposes exact schema and rejects paths outside workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-deepseek-image-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-deepseek-image-outside-"));
  try {
    const tool = captureTools(registerDeepSeekReadImageTool)[0];
    assert.equal(tool.name, "read_image");
    assert.deepEqual(Object.keys(tool.parameters.properties), ["file_path"]);
    assert.deepEqual(tool.parameters.required, ["file_path"]);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(cwd, "ok.png"), png);
    await writeFile(join(outside, "secret.png"), png);
    const ctx = { cwd, model: { input: ["text", "image"] } };
    const result = await tool.execute("image-1", { file_path: "ok.png" }, new AbortController().signal, undefined, ctx);
    const image = result.content.find((part: any) => part.type === "image");
    assert.equal(image.mimeType, "image/png");

    await assert.rejects(
      () => tool.execute("image-2", { file_path: join(outside, "secret.png") }, new AbortController().signal, undefined, ctx),
      /outside the workspace/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Codex apply_patch advertises and accepts Environment ID in its current grammar", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-env-"));
  try {
    const tool = captureTools(registerCodexApplyPatchTool)[0];
    const grammar = tool.constrainedSampling.variants.openai_lark as string;
    assert.match(grammar, /environment_id\?/);
    assert.match(grammar, /\*\*\* Environment ID:/);
    await tool.execute(
      "patch-1",
      { input: "*** Begin Patch\n*** Environment ID: current\n*** Add File: env.txt\n+ok\n*** End Patch\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "env.txt"), "utf8"), "ok\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
