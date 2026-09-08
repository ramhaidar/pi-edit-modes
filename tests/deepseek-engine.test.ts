import test from "node:test";
import assert from "node:assert/strict";
import { formatDeepSeekFileView, insertAfterLine, uniqueExactReplace } from "../src/tools/deepseek/engine.ts";

test("deepseek exact replacement requires a unique match", () => {
  assert.equal(uniqueExactReplace("a\nb\nc", "b", "B").content, "a\nB\nc");
  assert.throws(() => uniqueExactReplace("x\nx", "x", "y"), /Multiple occurrences/);
  assert.throws(() => uniqueExactReplace("x", "z", "y"), /not found/);
});

test("deepseek insert uses insert_line as after-line index", () => {
  assert.equal(insertAfterLine("a\nb", 1, "x\ny"), "a\nx\ny\nb");
  assert.equal(insertAfterLine("a\nb", 0, "x"), "x\na\nb");
});

test("deepseek view emits cat-like line numbers and supports -1", () => {
  const result = formatDeepSeekFileView("/repo/a.txt", "a\nb\nc", [2, -1]);
  assert.match(result, /2  b/);
  assert.match(result, /3  c/);
  assert.doesNotMatch(result, /1  a/);
});
