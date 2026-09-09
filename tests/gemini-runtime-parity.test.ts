import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerGeminiTools } from "../src/tools/gemini/index.ts";
import {
  clearGeminiPreparedMutations,
  handleGeminiToolCall,
  rememberGeminiMutation,
  takeGeminiMutation,
  type PreparedGeminiMutation,
} from "../src/tools/gemini/lifecycle.ts";
import {
  detectOmissionPlaceholders,
  normalizeNewFileLineEndings,
} from "../src/tools/gemini/upstream-parity.ts";
import {
  hasGeminiBlockedPathSegment,
  validateGeminiWorkspacePath,
  validateGeminiPath,
} from "../src/tools/gemini/workspace-access.ts";

function tool(name: string): any {
  const tools: any[] = [];
  registerGeminiTools({
    registerTool: (value: any) => tools.push(value),
    on: () => undefined,
  } as any);
  return tools.find((value) => value.name === name);
}

function firstText(result: any): string {
  return result?.content?.find((part: any) => part?.type === "text")?.text ?? "";
}

function sessionScope(cwd: string, id: string) {
  return { cwd, sessionManager: { getSessionId: () => id } };
}

test("Gemini tools rely on upstream-shaped declarations without standalone Pi prompt guidance", () => {
  for (const name of ["replace", "write_file"]) {
    const definition = tool(name);
    assert.equal(Object.hasOwn(definition, "promptSnippet"), false);
    assert.equal(Object.hasOwn(definition, "promptGuidelines"), false);
  }
});

test("Gemini replace creates a missing file only with empty old_string", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-create-"));
  try {
    const replace = tool("replace");
    const result = await replace.execute(
      "create",
      { file_path: "new.txt", instruction: "Create it", old_string: "", new_string: "new\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), `new${EOL}`);
    assert.match(firstText(result), /Here is the updated code:/);
    assert.match(firstText(result), /new/);
    await assert.rejects(
      () =>
        replace.execute(
          "missing",
          {
            file_path: "missing.txt",
            instruction: "Edit it",
            old_string: "old",
            new_string: "new",
          },
          new AbortController().signal,
          undefined,
          { cwd },
        ),
      /empty old_string/i,
    );
    await assert.rejects(
      () =>
        replace.execute(
          "exists",
          { file_path: "new.txt", instruction: "Create it", old_string: "", new_string: "other" },
          new AbortController().signal,
          undefined,
          { cwd },
        ),
      /already exists/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini replace and write_file reject relative and absolute paths outside workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gemini-workspace-fence-"));
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  try {
    const expectBlocked = async (operation: () => Promise<unknown>) =>
      assert.rejects(operation, (error: any) => {
        assert.equal(error?.code, "PATH_NOT_IN_WORKSPACE");
        assert.match(error?.message ?? "", /not in the current workspace/i);
        return true;
      });

    await expectBlocked(() =>
      tool("replace").execute(
        "relative-escape",
        {
          file_path: "../outside/relative.txt",
          instruction: "Create outside",
          old_string: "",
          new_string: "blocked\n",
        },
        new AbortController().signal,
        undefined,
        { cwd },
      ),
    );
    await expectBlocked(() =>
      tool("write_file").execute(
        "absolute-escape",
        { file_path: join(outside, "absolute.txt"), content: "blocked\n" },
        new AbortController().signal,
        undefined,
        { cwd },
      ),
    );
    await assert.rejects(() => readFile(join(outside, "relative.txt"), "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(join(outside, "absolute.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini normalizes defensive @ references, URI paths, file URLs, and null bytes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-path-normalization-"));
  try {
    await mkdir(join(cwd, "real"));
    const write = tool("write_file");

    await write.execute(
      "at-reference",
      { file_path: "@/real/at.txt", content: "at\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "real", "at.txt"), "utf8"), `at${EOL}`);

    await write.execute(
      "uri-reference",
      { file_path: "real/encoded%20name.txt", content: "uri\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "real", "encoded name.txt"), "utf8"), `uri${EOL}`);

    const fileUrlTarget = join(cwd, "real", "file-url.txt");
    await write.execute(
      "file-url-reference",
      { file_path: pathToFileURL(fileUrlTarget).href, content: "url\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(fileUrlTarget, "utf8"), `url${EOL}`);

    await write.execute(
      "null-byte-reference",
      { file_path: "real\0/null.txt", content: "null\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "real", "null.txt"), "utf8"), `null${EOL}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini path preflight matches current upstream untrusted-path validation", async () => {
  assert.deepEqual(validateGeminiPath("safe/path.txt"), { isValid: true });
  assert.equal(validateGeminiPath("bad\npath.txt").isValid, false);
  assert.equal(validateGeminiPath("bad\rpath.txt").isValid, false);
  assert.equal(validateGeminiPath("bad\tpath.txt").isValid, false);
  assert.equal(validateGeminiPath("bad\0path.txt").isValid, false);
  assert.equal(validateGeminiPath("logs/AssertionError: boom").isValid, false);
  assert.equal(validateGeminiPath(`logs/${"x".repeat(256)}.txt`).isValid, false);
  assert.equal(
    validateGeminiPath("x/this is a suspicious ... path with context.txt").isValid,
    false,
  );
  assert.equal(validateGeminiPath(`/${"a/".repeat(2050)}tail.txt`).isValid, false);

  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-path-preflight-"));
  try {
    const write = tool("write_file");
    for (const [id, filePath] of [
      ["newline", "logs/bad\npath.txt"],
      ["log-fragment", "logs/AssertionError: boom"],
      ["long-component", `logs/${"x".repeat(256)}.txt`],
      ["suspicious", "logs/this is a suspicious ... path with context.txt"],
    ] as const) {
      await assert.rejects(
        () =>
          write.execute(
            id,
            { file_path: filePath, content: "blocked\n" },
            new AbortController().signal,
            undefined,
            { cwd },
          ),
        (error: any) => {
          assert.equal(error?.code, "PATH_NOT_IN_WORKSPACE");
          assert.match(error?.message ?? "", /^Invalid path:/);
          return true;
        },
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini blocks sensitive workspace path segments before reads or correction prompts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-sensitive-paths-"));
  try {
    await mkdir(join(cwd, ".git"));
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(cwd, ".git", "config"), "secret-git\n", "utf8");
    await writeFile(join(cwd, ".env"), "SECRET=value\n", "utf8");
    await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "secret-node\n", "utf8");
    await writeFile(join(cwd, "gha-creds-test.json"), '{"token":"secret"}\n', "utf8");

    assert.equal(hasGeminiBlockedPathSegment(".git/config"), true);
    assert.equal(hasGeminiBlockedPathSegment(".ENV"), true);
    assert.equal(hasGeminiBlockedPathSegment("node_modules/pkg/index.js"), true);
    assert.equal(hasGeminiBlockedPathSegment("gha-creds-test.json"), true);
    assert.equal(hasGeminiBlockedPathSegment("GI1234~1/config"), true);
    assert.equal(hasGeminiBlockedPathSegment("EN1234~1"), true);
    assert.equal(hasGeminiBlockedPathSegment("NO1234~1/pkg"), true);
    assert.equal(hasGeminiBlockedPathSegment("GH1234~1.JSO"), true);
    assert.equal(hasGeminiBlockedPathSegment("src/.env.example"), false);

    let correctionCalls = 0;
    const ctx = {
      cwd,
      model: { id: "gemini-3-pro" },
      modelRegistry: {
        complete: async () => {
          correctionCalls += 1;
          return { content: [] };
        },
      },
    };
    await assert.rejects(
      () =>
        handleGeminiToolCall(
          {
            toolCallId: "blocked-env-replace",
            toolName: "replace",
            input: {
              file_path: ".env",
              instruction: "Change secret",
              old_string: "missing",
              new_string: "replacement",
            },
          },
          ctx,
          "auto_edit",
          false,
        ),
      (error: any) => error?.code === "PATH_NOT_IN_WORKSPACE",
    );
    assert.equal(correctionCalls, 0);

    for (const filePath of [
      ".git/config",
      ".env",
      "node_modules/pkg/index.js",
      "gha-creds-test.json",
      "GI1234~1/config",
    ]) {
      await assert.rejects(
        () =>
          tool("write_file").execute(
            `blocked-${filePath}`,
            { file_path: filePath, content: "blocked\n" },
            new AbortController().signal,
            undefined,
            { cwd },
          ),
        (error: any) => error?.code === "PATH_NOT_IN_WORKSPACE",
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini replace corrects a unique missing relative suffix within the workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-path-correct-"));
  try {
    await mkdir(join(cwd, "src", "components"), { recursive: true });
    const target = join(cwd, "src", "components", "foo.ts");
    await writeFile(target, "const value = 1;\n", "utf8");
    await tool("replace").execute(
      "correct-relative-suffix",
      {
        file_path: "components/foo.ts",
        instruction: "Update value",
        old_string: "const value = 1;",
        new_string: "const value = 2;",
      },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(target, "utf8"), "const value = 2;\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini relative-path correction respects .gitignore discovery filtering", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-correct-gitignore-"));
  try {
    await mkdir(join(cwd, ".git"));
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "generated"));
    await writeFile(join(cwd, ".gitignore"), "generated/\n", "utf8");
    await writeFile(join(cwd, "src", "foo.ts"), "old\n", "utf8");
    await writeFile(join(cwd, "generated", "foo.ts"), "generated old\n", "utf8");

    await tool("replace").execute(
      "gitignore-correction",
      {
        file_path: "foo.ts",
        instruction: "Update foo",
        old_string: "old",
        new_string: "new",
      },
      new AbortController().signal,
      undefined,
      { cwd },
    );

    assert.equal(await readFile(join(cwd, "src", "foo.ts"), "utf8"), "new\n");
    assert.equal(await readFile(join(cwd, "generated", "foo.ts"), "utf8"), "generated old\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini relative-path correction respects .geminiignore and nested .gitignore files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-correct-ignore-stack-"));
  try {
    await mkdir(join(cwd, ".git"));
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "ignored-by-gemini"));
    await mkdir(join(cwd, "nested"));
    await mkdir(join(cwd, "nested", "ignored"));
    await writeFile(join(cwd, ".geminiignore"), "ignored-by-gemini/\n", "utf8");
    await writeFile(join(cwd, "nested", ".gitignore"), "ignored/\n", "utf8");
    await writeFile(join(cwd, "src", "foo.ts"), "old\n", "utf8");
    await writeFile(join(cwd, "ignored-by-gemini", "foo.ts"), "gemini ignored\n", "utf8");
    await writeFile(join(cwd, "nested", "ignored", "foo.ts"), "git ignored\n", "utf8");

    await tool("replace").execute(
      "ignore-stack-correction",
      {
        file_path: "foo.ts",
        instruction: "Update foo",
        old_string: "old",
        new_string: "new",
      },
      new AbortController().signal,
      undefined,
      { cwd },
    );

    assert.equal(await readFile(join(cwd, "src", "foo.ts"), "utf8"), "new\n");
    assert.equal(
      await readFile(join(cwd, "ignored-by-gemini", "foo.ts"), "utf8"),
      "gemini ignored\n",
    );
    assert.equal(await readFile(join(cwd, "nested", "ignored", "foo.ts"), "utf8"), "git ignored\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini relative-path correction honors configurable ignore toggles and custom ignore files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-correct-configurable-ignore-"));
  try {
    await mkdir(join(cwd, ".git"));
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "generated"));
    await mkdir(join(cwd, "custom"));
    await writeFile(join(cwd, ".gitignore"), "generated/\n", "utf8");
    await writeFile(join(cwd, ".customignore"), "custom/\n", "utf8");
    await writeFile(join(cwd, "src", "foo.ts"), "src\n", "utf8");
    await writeFile(join(cwd, "generated", "foo.ts"), "generated\n", "utf8");
    await writeFile(join(cwd, "custom", "foo.ts"), "custom\n", "utf8");

    await assert.rejects(
      () =>
        validateGeminiWorkspacePath(cwd, "foo.ts", {
          correctRelative: true,
          fileFiltering: {
            respectGitIgnore: false,
            respectGeminiIgnore: true,
            customIgnoreFilePaths: [".customignore"],
          },
        }),
      /ambiguous and matches multiple files/i,
    );

    const corrected = await validateGeminiWorkspacePath(cwd, "foo.ts", {
      correctRelative: true,
      fileFiltering: {
        respectGitIgnore: true,
        respectGeminiIgnore: true,
        customIgnoreFilePaths: [".customignore"],
      },
    });
    assert.equal(corrected, join(cwd, "src", "foo.ts"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini custom ignore file paths remain project-root-relative", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gemini-custom-ignore-root-relative-"));
  const cwd = join(root, "workspace");
  const outsideIgnore = join(root, "outside.ignore");
  try {
    await mkdir(cwd);
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "generated"));
    await writeFile(outsideIgnore, "generated/\n", "utf8");
    await writeFile(join(cwd, "src", "foo.ts"), "src\n", "utf8");
    await writeFile(join(cwd, "generated", "foo.ts"), "generated\n", "utf8");

    await assert.rejects(
      () =>
        validateGeminiWorkspacePath(cwd, "foo.ts", {
          correctRelative: true,
          fileFiltering: {
            respectGitIgnore: false,
            respectGeminiIgnore: false,
            customIgnoreFilePaths: [outsideIgnore],
          },
        }),
      /ambiguous and matches multiple files/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini replace rejects ambiguous relative-path correction", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-path-ambiguous-"));
  try {
    await mkdir(join(cwd, "src", "components"), { recursive: true });
    await mkdir(join(cwd, "test", "components"), { recursive: true });
    await writeFile(join(cwd, "src", "components", "foo.ts"), "one\n", "utf8");
    await writeFile(join(cwd, "test", "components", "foo.ts"), "two\n", "utf8");
    await assert.rejects(
      () =>
        tool("replace").execute(
          "ambiguous-relative-suffix",
          {
            file_path: "components/foo.ts",
            instruction: "Update value",
            old_string: "one",
            new_string: "changed",
          },
          new AbortController().signal,
          undefined,
          { cwd },
        ),
      /ambiguous and matches multiple files/i,
    );
    assert.equal(await readFile(join(cwd, "src", "components", "foo.ts"), "utf8"), "one\n");
    assert.equal(await readFile(join(cwd, "test", "components", "foo.ts"), "utf8"), "two\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini rejects symlink escapes during proposal calculation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gemini-symlink-fence-"));
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  try {
    try {
      await symlink(
        outside,
        join(cwd, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error: any) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("symlink creation is unavailable in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () =>
        tool("write_file").execute(
          "symlink-escape",
          { file_path: "escape/file.txt", content: "blocked\n" },
          new AbortController().signal,
          undefined,
          { cwd },
        ),
      (error: any) => error?.code === "PATH_NOT_IN_WORKSPACE",
    );
    await assert.rejects(() => readFile(join(outside, "file.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini canonicalizes safe in-workspace symlinks before mutation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-safe-symlink-"));
  const realDir = join(cwd, "real");
  const linkDir = join(cwd, "link");
  await mkdir(realDir);
  try {
    try {
      await symlink(realDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error: any) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("symlink creation is unavailable in this environment");
        return;
      }
      throw error;
    }

    await tool("write_file").execute(
      "safe-symlink",
      { file_path: "link/file.txt", content: "safe\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(join(realDir, "file.txt"), "utf8"), `safe${EOL}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini revalidates workspace access immediately before commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gemini-commit-fence-"));
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  const safe = join(cwd, "safe");
  await mkdir(cwd);
  await mkdir(outside);
  await mkdir(safe);
  try {
    const ctx = { cwd };
    const event = {
      toolCallId: "commit-fence",
      toolName: "write_file",
      input: { file_path: "safe/file.txt", content: "blocked\n" },
    };
    assert.equal(await handleGeminiToolCall(event, ctx, "auto_edit"), undefined);
    await rm(safe, { recursive: true, force: true });
    try {
      await symlink(outside, safe, process.platform === "win32" ? "junction" : "dir");
    } catch (error: any) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        clearGeminiPreparedMutations();
        t.skip("symlink creation is unavailable in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () =>
        tool("write_file").execute(
          event.toolCallId,
          event.input,
          new AbortController().signal,
          undefined,
          ctx,
        ),
      (error: any) => error?.code === "PATH_NOT_IN_WORKSPACE",
    );
    await assert.rejects(() => readFile(join(outside, "file.txt"), "utf8"), /ENOENT/);
  } finally {
    clearGeminiPreparedMutations();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini replace retries failed matching through utility correction", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-correct-"));
  try {
    const path = join(cwd, "file.txt");
    await writeFile(path, "alpha beta gamma\n", "utf8");
    const ctx = {
      cwd,
      model: { id: "gemini-3-pro" },
      modelRegistry: {
        complete: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                search: "alpha beta gamma",
                replace: "fixed",
                explanation: "correct search",
                noChangesRequired: false,
              }),
            },
          ],
        }),
      },
    };
    const event = {
      toolCallId: "correct",
      toolName: "replace",
      input: {
        file_path: "file.txt",
        instruction: "Replace the line",
        old_string: "unrelated search text that cannot match",
        new_string: "fixed",
      },
    };
    await handleGeminiToolCall(event, ctx, "auto_edit", false);
    const result = await tool("replace").execute(
      "correct",
      event.input,
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(await readFile(path, "utf8"), "fixed\n");
    assert.match(firstText(result), /Here is the updated code:/);
    assert.match(firstText(result), /fixed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini correction retry failure reports the original edit error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-correct-fallback-"));
  try {
    const path = join(cwd, "file.txt");
    await writeFile(path, "alpha alpha\n", "utf8");
    const ctx = {
      cwd,
      model: { id: "gemini-3-pro" },
      modelRegistry: {
        complete: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                search: "alpha",
                replace: "fixed",
                explanation: "retry with a broader search",
                noChangesRequired: false,
              }),
            },
          ],
        }),
      },
    };
    const event = {
      toolCallId: "correct-fallback",
      toolName: "replace",
      input: {
        file_path: "file.txt",
        instruction: "Replace the requested text",
        old_string: "missing original text",
        new_string: "fixed",
      },
    };
    await assert.rejects(
      () => handleGeminiToolCall(event, ctx, "auto_edit", false),
      (error: any) => {
        assert.match(error?.message ?? "", /Could not find an exact match/);
        assert.doesNotMatch(error?.message ?? "", /expected 1 occurrence but found 2/i);
        return true;
      },
    );
    assert.equal(await readFile(path, "utf8"), "alpha alpha\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini correction noChangesRequired is returned as an upstream-style tool error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-no-change-"));
  try {
    const path = join(cwd, "file.txt");
    await writeFile(path, "alpha beta gamma\n", "utf8");
    const ctx = {
      cwd,
      model: { id: "gemini-3-pro" },
      modelRegistry: {
        complete: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                noChangesRequired: true,
                explanation: "The requested state already holds",
              }),
            },
          ],
        }),
      },
    };
    const event = {
      toolCallId: "no-change",
      toolName: "replace",
      input: {
        file_path: "file.txt",
        instruction: "Make the requested change",
        old_string: "text that cannot match the file",
        new_string: "replacement",
      },
    };
    const blocked = await handleGeminiToolCall(event, ctx, "auto_edit", false);
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /secondary check by an LLM/i);
    assert.match(blocked?.reason ?? "", /The requested state already holds/);
    assert.match(blocked?.reason ?? "", /Could not find an exact match/);
    assert.equal(await readFile(path, "utf8"), "alpha beta gamma\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini fuzzy recovery reports the upstream line range to the model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-fuzzy-feedback-"));
  try {
    const path = join(cwd, "file.txt");
    await writeFile(path, "const message = helloWorle;\n", "utf8");
    const result = await tool("replace").execute(
      "fuzzy-feedback",
      {
        file_path: "file.txt",
        instruction: "Update the message",
        old_string: "const message = helloWorld;\n",
        new_string: "const message = goodbyeWorld;\n",
      },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(path, "utf8"), "const message = goodbyeWorld;\n");
    assert.match(firstText(result), /Applied fuzzy match at line 1\./);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini write approval returns actual user-modified content and diff context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-approval-"));
  try {
    const path = join(cwd, "file.txt");
    await writeFile(path, "old\n", "utf8");
    let confirmation = "";
    let editorInitial = "";
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        confirm: async (_title: string, message: string) => {
          confirmation = message;
          return true;
        },
        select: async () => "Edit proposed content",
        editor: async (_title: string, initial: string) => {
          editorInitial = initial;
          return "user approved\n";
        },
      },
    };
    const event = {
      toolCallId: "approval-call",
      toolName: "write_file",
      input: { file_path: "file.txt", content: "proposed\n" },
    };
    assert.equal(await handleGeminiToolCall(event, ctx, "ask_user"), undefined);
    assert.match(confirmation, /proposed/);
    assert.equal(editorInitial, "proposed\n");
    const result = await tool("write_file").execute(
      "approval-call",
      event.input,
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(await readFile(path, "utf8"), "user approved\n");
    const text = firstText(result);
    assert.match(text, /User modified the `content` to be: user approved/);
    assert.match(text, /Here is the updated code:/);
    assert.match(text, /user approved/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini replace approval edits the whole proposed file like current Gemini CLI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-replace-approval-"));
  try {
    const path = join(cwd, "file.txt");
    await writeFile(path, "before\nold\nafter\n", "utf8");
    let editorTitle = "";
    let editorInitial = "";
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        confirm: async () => true,
        select: async () => "Edit proposed content",
        editor: async (title: string, initial: string) => {
          editorTitle = title;
          editorInitial = initial;
          return "before\nuser replacement\nafter\nuser-added tail\n";
        },
      },
    };
    const event = {
      toolCallId: "replace-approval",
      toolName: "replace",
      input: {
        file_path: "file.txt",
        instruction: "Replace the middle line",
        old_string: "old",
        new_string: "proposed replacement",
      },
    };
    assert.equal(await handleGeminiToolCall(event, ctx, "ask_user"), undefined);
    assert.match(editorTitle, /replace content/);
    assert.equal(editorInitial, "before\nproposed replacement\nafter\n");
    const result = await tool("replace").execute(
      event.toolCallId,
      event.input,
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(
      await readFile(path, "utf8"),
      "before\nuser replacement\nafter\nuser-added tail\n",
    );
    const text = firstText(result);
    assert.match(text, /modified the `new_string` content to be:/);
    assert.match(text, /user-added tail/);
    assert.match(text, /Here is the updated code:/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini omission placeholder detection matches current upstream rules", async () => {
  assert.deepEqual(detectOmissionPlaceholders("// rest of methods ..."), ["rest of methods ..."]);
  assert.deepEqual(detectOmissionPlaceholders("(unchanged code ....)"), ["unchanged code ..."]);
  assert.deepEqual(detectOmissionPlaceholders("(rest of methods)"), []);
  assert.deepEqual(detectOmissionPlaceholders("ordinary (rest of methods ...) prose"), []);

  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-omission-"));
  try {
    const write = tool("write_file");
    const replace = tool("replace");
    await assert.rejects(
      () =>
        write.execute(
          "omit-write",
          { file_path: "write.txt", content: "start\n// rest of methods ...\nend\n" },
          new AbortController().signal,
          undefined,
          { cwd },
        ),
      /omission placeholder/i,
    );

    const path = join(cwd, "replace.txt");
    await writeFile(path, "start\nold\nend\n", "utf8");
    await assert.rejects(
      () =>
        replace.execute(
          "omit-replace",
          {
            file_path: "replace.txt",
            instruction: "Replace old",
            old_string: "old",
            new_string: "// rest of methods ...",
          },
          new AbortController().signal,
          undefined,
          { cwd },
        ),
      /omission placeholder/i,
    );

    await writeFile(path, "(rest of methods ...)\nold\n", "utf8");
    await replace.execute(
      "preserve-placeholder",
      {
        file_path: "replace.txt",
        instruction: "Keep the existing placeholder while updating the following line",
        old_string: "(rest of methods ...)\nold",
        new_string: "(rest of methods ...)\nnew",
      },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(path, "utf8"), "(rest of methods ...)\nnew\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini prepared mutations are isolated by session and workspace scope", () => {
  clearGeminiPreparedMutations();
  const cwd = join(tmpdir(), "pi-gemini-scope");
  const a = sessionScope(cwd, "session-a");
  const b = sessionScope(cwd, "session-b");
  const mutation: PreparedGeminiMutation = {
    toolCallId: "reused-id",
    toolName: "write_file",
    filePath: "file.txt",
    absolutePath: join(cwd, "file.txt"),
    before: undefined,
    after: "A",
    action: "A",
  };
  rememberGeminiMutation(mutation, a);
  assert.equal(takeGeminiMutation("reused-id", b), undefined);
  assert.equal(takeGeminiMutation("reused-id", a), mutation);

  rememberGeminiMutation(mutation, a);
  clearGeminiPreparedMutations(a);
  assert.equal(takeGeminiMutation("reused-id", a), undefined);
  clearGeminiPreparedMutations();
});

test("Gemini new-file line endings follow host OS semantics", () => {
  assert.equal(normalizeNewFileLineEndings("a\nb\n", "win32"), "a\r\nb\r\n");
  assert.equal(normalizeNewFileLineEndings("a\nb\n", "linux"), "a\nb\n");
  assert.equal(normalizeNewFileLineEndings("a\r\nb\r\n", "win32"), "a\r\nb\r\n");
});

test("Gemini write_file applies eligible escaping correction", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-write-correct-"));
  try {
    const ctx = {
      cwd,
      model: { id: "gemini-3-pro" },
      modelRegistry: {
        complete: async () => ({
          content: [
            { type: "text", text: JSON.stringify({ corrected_string_escaping: "hello\nworld\n" }) },
          ],
        }),
      },
    };
    const event = {
      toolCallId: "write-correct",
      toolName: "write_file",
      input: { file_path: "file.txt", content: "hello\\\\nworld\\\\n" },
    };
    await handleGeminiToolCall(event, ctx, "auto_edit", false);
    await tool("write_file").execute(
      "write-correct",
      event.input,
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), `hello${EOL}world${EOL}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini LLM correction is disabled by default for current Gemini families", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-write-default-"));
  try {
    let calls = 0;
    const ctx = {
      cwd,
      model: { id: "gemini-3-pro" },
      modelRegistry: {
        complete: async () => {
          calls += 1;
          return { content: [] };
        },
      },
    };
    const content = String.raw`hello\\nworld\\n`;
    await tool("write_file").execute(
      "write-default",
      { file_path: "file.txt", content },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), content);
    assert.equal(calls, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
