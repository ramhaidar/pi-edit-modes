import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGeminiTools } from "../src/tools/gemini/index.ts";
import { handleGeminiToolCall } from "../src/tools/gemini/lifecycle.ts";

function tool(name: string): any {
  const tools: any[] = [];
  registerGeminiTools({
    registerTool: (value: any) => tools.push(value),
    on: () => undefined,
  } as any);
  return tools.find((value) => value.name === name);
}

test("Gemini replace creates a missing file only with empty old_string", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-create-"));
  try {
    const replace = tool("replace");
    await replace.execute(
      "create",
      { file_path: "new.txt", instruction: "Create it", old_string: "", new_string: "new\n" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "new\n");
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
    await tool("replace").execute(
      "correct",
      event.input,
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(await readFile(path, "utf8"), "fixed\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Gemini approval prepares a diff and commits user-modified proposed content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gemini-approval-"));
  try {
    const path = join(cwd, "file.txt");
    await writeFile(path, "old\n", "utf8");
    let confirmation = "";
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        confirm: async (_title: string, message: string) => {
          confirmation = message;
          return true;
        },
        select: async () => "Edit proposed content",
        editor: async () => "user approved\n",
      },
    };
    const event = {
      toolCallId: "approval-call",
      toolName: "write_file",
      input: { file_path: "file.txt", content: "proposed\n" },
    };
    assert.equal(await handleGeminiToolCall(event, ctx, "ask_user"), undefined);
    assert.match(confirmation, /proposed/);
    await tool("write_file").execute(
      "approval-call",
      event.input,
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(await readFile(path, "utf8"), "user approved\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "hello\nworld\n");
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
