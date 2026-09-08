import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
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

test("Gemini replace approval edits new_string rather than the whole proposed file", async () => {
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
          return "user replacement";
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
    assert.match(editorTitle, /new_string/);
    assert.equal(editorInitial, "proposed replacement");
    const result = await tool("replace").execute(
      event.toolCallId,
      event.input,
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(await readFile(path, "utf8"), "before\nuser replacement\nafter\n");
    const text = firstText(result);
    assert.match(text, /modified the `new_string` content to be: user replacement/);
    assert.match(text, /Here is the updated code:/);
    assert.match(text, /user replacement/);
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
