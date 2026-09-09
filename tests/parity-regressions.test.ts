import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCodexApplyPatchTool } from "../src/tools/codex/engine.ts";
import { registerGeminiTools } from "../src/tools/gemini/index.ts";
import { clearDeepSeekFsRuntimes, getDeepSeekFsRuntime } from "../src/tools/deepseek/runtime.ts";
import {
  assertDeepSeekImageDimensions,
  DEEPSEEK_IMAGE_MAX_DIMENSION,
  DEEPSEEK_IMAGE_MAX_BYTES,
  DEEPSEEK_IMAGE_MAX_PIXELS,
  registerDeepSeekFilesystemTools,
  registerDeepSeekReadImageTool,
} from "../src/tools/deepseek/fs-tools.ts";

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
    await assert.rejects(
      () => runtimeB.edit(path, "alpha", "beta", false),
      /not observed|observe|read/i,
    );
  } finally {
    clearDeepSeekFsRuntimes();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("DeepSeek standard tool prompt guidance is projected exactly once", () => {
  const tools = captureTools(registerDeepSeekFilesystemTools);
  const expected = new Map([
    [
      "read",
      "Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.",
    ],
    [
      "write",
      "Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.",
    ],
    [
      "edit",
      "Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.",
    ],
  ]);

  for (const [name, snippet] of expected) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    assert.equal(tool.promptSnippet, snippet);
    assert.equal(Object.hasOwn(tool, "promptGuidelines"), false);
  }
});

test("DeepSeek read_image exposes exact schema and rejects paths outside workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-deepseek-image-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-deepseek-image-outside-"));
  try {
    const tool = captureTools(registerDeepSeekReadImageTool)[0];
    assert.equal(tool.name, "read_image");
    assert.equal(
      tool.description,
      "Read a PNG/JPEG/WebP/GIF file and return the image itself. " +
        "A path without a file extension is accepted; the format is detected from the file content, so normalized attachment paths can be passed directly without copying or renaming. " +
        "Harness validates and downscales large supported images before the next model request, so use this tool directly instead of installing image libraries or creating thumbnails merely to inspect an image. " +
        "Independent files may be read concurrently in small batches. Requires the current model to accept image input.",
    );
    assert.equal(Object.hasOwn(tool, "promptSnippet"), false);
    assert.equal(Object.hasOwn(tool, "promptGuidelines"), false);
    assert.deepEqual(Object.keys(tool.parameters.properties), ["file_path"]);
    assert.deepEqual(tool.parameters.required, ["file_path"]);
    assert.equal(
      tool.parameters.properties.file_path.description,
      "Path to the image file, resolved by the filesystem backend.",
    );

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(cwd, "ok.png"), png);
    await writeFile(join(cwd, "extensionless"), png);
    await writeFile(join(cwd, "wrong.txt"), png);
    await writeFile(join(cwd, "mismatch.jpg"), png);
    await writeFile(join(cwd, "image.bmp"), Buffer.from("BM", "ascii"));
    await writeFile(join(cwd, "fake.png"), "not an image", "utf8");
    await writeFile(join(cwd, "observed.png"), png);
    await writeFile(join(outside, "secret.png"), png);
    const ctx = { cwd, model: { input: ["text", "image"] } };
    const result = await tool.execute(
      "image-1",
      { file_path: "ok.png" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    const text = result.content.find((part: any) => part.type === "text");
    const image = result.content.find((part: any) => part.type === "image");
    assert.equal(
      text.text,
      `<path>${join(cwd, "ok.png")}</path>\n<type>image</type>\n<content>\nimage/png image, 1x1 px, ${png.byteLength} bytes\n</content>`,
    );
    assert.equal(image.mimeType, "image/png");

    await tool.execute(
      "image-observed",
      { file_path: "observed.png" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    const observedWrite = await getDeepSeekFsRuntime(ctx).write("observed.png", "replacement\n");
    assert.equal(observedWrite.operation, "update");
    assert.equal(await readFile(join(cwd, "observed.png"), "utf8"), "replacement\n");

    const extensionless = await tool.execute(
      "image-extensionless",
      { file_path: "extensionless" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(
      extensionless.content.find((part: any) => part.type === "image").mimeType,
      "image/png",
    );

    await assert.rejects(
      () =>
        tool.execute(
          "image-bmp",
          { file_path: "image.bmp" },
          new AbortController().signal,
          undefined,
          ctx,
        ),
      /\.bmp extension does not declare a supported image format/i,
    );
    await assert.rejects(
      () =>
        tool.execute(
          "image-wrong-extension",
          { file_path: "wrong.txt" },
          new AbortController().signal,
          undefined,
          ctx,
        ),
      /\.txt extension does not declare a supported image format/i,
    );
    await assert.rejects(
      () =>
        tool.execute(
          "image-mismatch",
          { file_path: "mismatch.jpg" },
          new AbortController().signal,
          undefined,
          ctx,
        ),
      /\.jpg extension declares image\/jpeg, but the bytes use a different image format/i,
    );

    await assert.rejects(
      () =>
        tool.execute(
          "image-fake",
          { file_path: "fake.png" },
          new AbortController().signal,
          undefined,
          ctx,
        ),
      /file content is not a supported image format/i,
    );
    await assert.rejects(
      () =>
        tool.execute(
          "image-2",
          { file_path: join(outside, "secret.png") },
          new AbortController().signal,
          undefined,
          ctx,
        ),
      /outside the workspace/i,
    );

    await assert.rejects(
      () =>
        tool.execute(
          "image-blank",
          { file_path: "   " },
          new AbortController().signal,
          undefined,
          ctx,
        ),
      (error: any) => error?.message === "file_path must be a non-empty string",
    );

    const oversizedPath = join(cwd, "oversized.png");
    const oversized = await open(oversizedPath, "w");
    try {
      await oversized.write(png.subarray(0, 8), 0, 8, 0);
      await oversized.truncate(DEEPSEEK_IMAGE_MAX_BYTES + 1);
    } finally {
      await oversized.close();
    }
    await assert.rejects(
      () =>
        tool.execute(
          "image-oversized",
          { file_path: "oversized.png" },
          new AbortController().signal,
          undefined,
          ctx,
        ),
      new RegExp(`image exceeds the ${DEEPSEEK_IMAGE_MAX_BYTES}-byte source limit`, "i"),
    );
  } finally {
    clearDeepSeekFsRuntimes();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("published package includes the documented fetch-vendors script", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.scripts["fetch-vendors"], "node scripts/fetch-vendors.mjs");
  assert.ok(packageJson.files.includes("scripts/fetch-vendors.mjs"));
  await readFile(new URL("../scripts/fetch-vendors.mjs", import.meta.url), "utf8");
});

test("DeepSeek image admission enforces current Harness dimension and pixel defaults", () => {
  assert.doesNotThrow(() =>
    assertDeepSeekImageDimensions("ok.png", DEEPSEEK_IMAGE_MAX_DIMENSION, 100),
  );
  assert.throws(
    () => assertDeepSeekImageDimensions("wide.png", DEEPSEEK_IMAGE_MAX_DIMENSION + 1, 1),
    new RegExp(`${DEEPSEEK_IMAGE_MAX_DIMENSION}px limit`),
  );
  assert.equal(DEEPSEEK_IMAGE_MAX_PIXELS, 40_000_000);
});

test("Codex apply_patch advertises Environment ID but rejects selection on single-environment Pi", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codex-env-"));
  try {
    const tool = captureTools(registerCodexApplyPatchTool)[0];
    const grammar = tool.constrainedSampling.variants.openai_lark as string;
    assert.match(grammar, /environment_id\?/);
    assert.match(grammar, /\*\*\* Environment ID:/);
    await assert.rejects(
      () =>
        tool.execute(
          "patch-env",
          {
            input:
              "*** Begin Patch\n*** Environment ID: arbitrary\n*** Add File: env.txt\n+wrong\n*** End Patch\n",
          },
          new AbortController().signal,
          undefined,
          { cwd },
        ),
      /environment selection is unavailable/i,
    );
    await tool.execute(
      "patch-current",
      { input: "*** Begin Patch\n*** Add File: env.txt\n+ok\n*** End Patch\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "env.txt"), "utf8"), "ok\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
