import test from "node:test";
import assert from "node:assert/strict";
import { planReplacementChunks, planSingleReplacement, preserveReplacementLineEndings } from "../src/tools/gemini/replacement-engine.ts";

test("single unique exact match", () => {
  const p = planSingleReplacement("a\nb\nc\n", { TargetContent: "b", ReplacementContent: "B" }, { strictExactMatch: true });
  assert.equal(p.content, "a\nB\nc\n");
  assert.equal(p.replacements.length, 1);
});

test("missing target fails", () => {
  assert.throws(() => planSingleReplacement("abc", { TargetContent: "x", ReplacementContent: "y" }, { strictExactMatch: true }), /not found/);
});

test("duplicate target fails unless AllowMultiple", () => {
  assert.throws(() => planSingleReplacement("x x", { TargetContent: "x", ReplacementContent: "y" }, { strictExactMatch: true }), /matched 2/);
  const p = planSingleReplacement("x x", { TargetContent: "x", ReplacementContent: "y", AllowMultiple: true }, { strictExactMatch: true });
  assert.equal(p.content, "y y");
});

test("line range is authoritative", () => {
  const original = "same\nother\nsame\n";
  const p = planSingleReplacement(original, { TargetContent: "same", ReplacementContent: "hit", StartLine: 3, EndLine: 3 }, { strictExactMatch: true });
  assert.equal(p.content, "same\nother\nhit\n");
  assert.throws(() => planSingleReplacement(original, { TargetContent: "other", ReplacementContent: "x", StartLine: 3, EndLine: 3 }, { strictExactMatch: true }), /not found/);
});

test("empty replacement deletes target", () => {
  const p = planSingleReplacement("abc", { TargetContent: "b", ReplacementContent: "" }, { strictExactMatch: true });
  assert.equal(p.content, "ac");
});

test("multi replacement validates against same original and applies descending offsets", () => {
  const p = planReplacementChunks("alpha beta gamma", [
    { TargetContent: "alpha", ReplacementContent: "A" },
    { TargetContent: "gamma", ReplacementContent: "GAMMA-LONG" },
  ], { strictExactMatch: true });
  assert.equal(p.content, "A beta GAMMA-LONG");
});

test("overlapping chunks are rejected", () => {
  assert.throws(() => planReplacementChunks("abcdef", [
    { TargetContent: "abc", ReplacementContent: "x" },
    { TargetContent: "bc", ReplacementContent: "y" },
  ], { strictExactMatch: true }), /overlap/);
});

test("one invalid multi chunk aborts planning", () => {
  assert.throws(() => planReplacementChunks("abc def", [
    { TargetContent: "abc", ReplacementContent: "A" },
    { TargetContent: "missing", ReplacementContent: "M" },
  ], { strictExactMatch: true }), /chunk 2/);
});

test("multiple edits on same line work when non-overlapping", () => {
  const p = planReplacementChunks("one two three", [
    { TargetContent: "one", ReplacementContent: "1" },
    { TargetContent: "three", ReplacementContent: "3" },
  ], { strictExactMatch: true });
  assert.equal(p.content, "1 two 3");
});

test("replacement content preserves CRLF", () => {
  const original = "a\r\nb\r\nc\r\n";
  const p = planSingleReplacement(original, { TargetContent: "b", ReplacementContent: "B\nBB" }, { strictExactMatch: true });
  assert.equal(p.content, "a\r\nB\r\nBB\r\nc\r\n");
  assert.equal(preserveReplacementLineEndings("x\ny", original), "x\r\ny");
});

test("strict exact mode does not silently normalize CRLF target", () => {
  assert.throws(() => planSingleReplacement("a\r\nb", { TargetContent: "a\nb", ReplacementContent: "x" }, { strictExactMatch: true }), /not found/);
});

test("non-strict option only relaxes line-ending representation", () => {
  const p = planSingleReplacement("a\r\nb", { TargetContent: "a\nb", ReplacementContent: "x" }, { strictExactMatch: false });
  assert.equal(p.content, "x");
});

test("bare CR files support StartLine and EndLine ranges", () => {
  const original = "a\rb\rc";
  const p = planSingleReplacement(original, {
    TargetContent: "b",
    ReplacementContent: "B",
    StartLine: 2,
    EndLine: 2,
  }, { strictExactMatch: true });
  assert.equal(p.content, "a\rB\rc");
});
