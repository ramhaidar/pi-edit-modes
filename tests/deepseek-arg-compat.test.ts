import test from "node:test";
import assert from "node:assert/strict";
import {
  addPiMutationAliases,
  normalizeDeepSeekEditArgs,
  normalizeDeepSeekWriteArgs,
  prepareDeepSeekEditArgsForPi,
  prepareDeepSeekWriteArgsForPi,
} from "../src/tools/deepseek/arg-compat.ts";

test("write prepareArguments preserves DeepSeek fields and publishes Pi path alias", () => {
  assert.deepEqual(
    prepareDeepSeekWriteArgsForPi({ file_path: "D:/repo/a.txt", content: "hello" }),
    { file_path: "D:/repo/a.txt", content: "hello", path: "D:/repo/a.txt" },
  );
});

test("write executor normalization survives a host that leaves only Pi-native path", () => {
  assert.deepEqual(normalizeDeepSeekWriteArgs({ path: "D:/repo/a.txt", content: "hello" }), {
    filePath: "D:/repo/a.txt",
    content: "hello",
  });
});

test("edit prepareArguments publishes both legacy and current Pi-native edit aliases", () => {
  assert.deepEqual(
    prepareDeepSeekEditArgsForPi({
      file_path: "D:/repo/a.txt",
      old_string: "before",
      new_string: "after",
      replace_all: true,
    }),
    {
      file_path: "D:/repo/a.txt",
      old_string: "before",
      new_string: "after",
      replace_all: true,
      path: "D:/repo/a.txt",
      oldText: "before",
      newText: "after",
      edits: [{ oldText: "before", newText: "after", replaceAll: true }],
    },
  );
});

test("edit executor normalization survives current Pi-native edits[] mutation", () => {
  assert.deepEqual(
    normalizeDeepSeekEditArgs({
      path: "D:/repo/a.txt",
      edits: [{ oldText: "before", newText: "after" }],
    }),
    { filePath: "D:/repo/a.txt", oldString: "before", newString: "after", replaceAll: false },
  );
});

test("edit executor normalization survives legacy Pi top-level oldText/newText mutation", () => {
  assert.deepEqual(
    normalizeDeepSeekEditArgs({ path: "D:/repo/a.txt", oldText: "before", newText: "after" }),
    { filePath: "D:/repo/a.txt", oldString: "before", newString: "after", replaceAll: false },
  );
});

test("last-resort tool_call bridge is idempotent", () => {
  const input: Record<string, unknown> = {
    file_path: "D:/repo/a.txt",
    old_string: "before",
    new_string: "after",
  };
  addPiMutationAliases("edit", input);
  const once = structuredClone(input);
  addPiMutationAliases("edit", input);
  assert.deepEqual(input, once);
  assert.deepEqual(input.edits, [{ oldText: "before", newText: "after" }]);
});
