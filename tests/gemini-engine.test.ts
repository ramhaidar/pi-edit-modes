import test from "node:test";
import assert from "node:assert/strict";
import {
  planSingleReplacement,
  preserveReplacementLineEndings,
} from "../src/tools/gemini/replacement-engine.ts";
import { registerGeminiTools } from "../src/tools/gemini/index.ts";

test("Gemini replace uses exact current CLI parameter vocabulary", () => {
  const tools: any[] = [];
  registerGeminiTools({ registerTool: (tool: any) => tools.push(tool) } as any);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["replace", "write_file"],
  );
  assert.deepEqual(Object.keys(tools[0].parameters.properties), [
    "file_path",
    "instruction",
    "old_string",
    "new_string",
    "allow_multiple",
  ]);
  assert.deepEqual(tools[0].parameters.required, [
    "file_path",
    "instruction",
    "old_string",
    "new_string",
  ]);
  assert.deepEqual(Object.keys(tools[1].parameters.properties), ["file_path", "content"]);
  assert.deepEqual(tools[1].parameters.required, ["file_path", "content"]);
});

test("single unique exact match", () => {
  const plan = planSingleReplacement("a\nb\nc\n", {
    file_path: "x.txt",
    instruction: "uppercase b",
    old_string: "b",
    new_string: "B",
  });
  assert.equal(plan.content, "a\nB\nc\n");
  assert.equal(plan.occurrences, 1);
  assert.equal(plan.strategy, "exact");
});

test("missing target fails", () => {
  assert.throws(
    () =>
      planSingleReplacement("abc", {
        old_string: "x",
        new_string: "y",
      }),
    /Could not find/,
  );
});

test("duplicate target requires allow_multiple", () => {
  assert.throws(
    () => planSingleReplacement("x x", { old_string: "x", new_string: "y" }),
    /expected 1 occurrence but found 2/i,
  );
  const plan = planSingleReplacement("x x", {
    old_string: "x",
    new_string: "y",
    allow_multiple: true,
  });
  assert.equal(plan.content, "y y");
  assert.equal(plan.occurrences, 2);
});

test("flexible recovery mirrors Gemini indentation/whitespace strategy", () => {
  const plan = planSingleReplacement("function x() {\n  return 1;\n}\n", {
    old_string: "function x() {\nreturn 1;\n}",
    new_string: "function x() {\nreturn 2;\n}",
  });
  assert.equal(plan.strategy, "flexible");
  assert.equal(plan.content, "function x() {\nreturn 2;\n}\n");
});

test("regex recovery tolerates token whitespace differences", () => {
  const plan = planSingleReplacement("const   value=foo ( bar ) ;\n", {
    old_string: "const value = foo(bar);",
    new_string: "const value = baz(bar);",
  });
  assert.equal(plan.strategy, "regex");
  assert.equal(plan.content, "const value = baz(bar);\n");
});

test("fuzzy recovery handles a small textual mismatch", () => {
  const plan = planSingleReplacement("const message = helloWorle;\n", {
    old_string: "const message = helloWorld;\n",
    new_string: "const message = goodbyeWorld;\n",
  });
  assert.equal(plan.strategy, "fuzzy");
  assert.deepEqual(plan.matchRanges, [{ start: 1, end: 1 }]);
  assert.equal(plan.content, "const message = goodbyeWorld;\n");
});

test("Gemini line-ending normalization preserves existing CRLF", () => {
  const original = "a\r\nb\r\nc\r\n";
  const plan = planSingleReplacement(original, { old_string: "a\nb", new_string: "A\nB" });
  assert.equal(plan.content, "A\r\nB\r\nc\r\n");
  assert.equal(preserveReplacementLineEndings("x\ny", original), "x\r\ny");
});
