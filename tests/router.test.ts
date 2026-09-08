import test from "node:test";
import assert from "node:assert/strict";
import { computeToolTransition, initialToolOwnership } from "../src/modes/router.ts";

const all = new Set(["read", "edit", "write", "apply_patch", "replace_file_content", "multi_replace_file_content", "write_to_file", "str_replace_editor"]);

function step(
  activeTools: string[],
  desiredMode: "pi" | "codex" | "gemini" | "deepseek",
  ownership = initialToolOwnership(),
  surface: "replace" | "additive" = "replace",
  codexSupported = true,
  availableTools = all,
) {
  return computeToolTransition({ activeTools, desiredMode, ownership, surface, codexSupported, availableTools });
}

test("pi -> codex replace removes native tools and activates apply_patch", () => {
  const r = step(["read", "edit", "write"], "codex");
  assert.deepEqual(r.nextTools, ["read", "apply_patch"]);
  assert.equal(r.nextOwnership.editRemovedByUs, true);
  assert.equal(r.nextOwnership.writeRemovedByUs, true);
  assert.equal(r.surface, "codex-replace");
});

test("codex replace -> gemini replace is one suppression transition", () => {
  const c = step(["read", "edit", "write"], "codex");
  const g = step(c.nextTools, "gemini", c.nextOwnership);
  assert.equal(g.nextTools.includes("edit"), false);
  assert.equal(g.nextTools.includes("write"), false);
  assert.equal(g.nextTools.includes("apply_patch"), false);
  assert.deepEqual(g.nextTools.filter((x) => x.includes("file_content") || x === "write_to_file"), ["replace_file_content", "multi_replace_file_content", "write_to_file"]);
  assert.equal(g.surface, "gemini-replace");
});

test("gemini replace -> pi restores only owned native tools", () => {
  const g = step(["read", "edit", "write"], "gemini");
  const p = step(g.nextTools, "pi", g.nextOwnership);
  assert.deepEqual(p.nextTools, ["read", "edit", "write"]);
});

test("external native activation relinquishes ownership and is not fought", () => {
  const c = step(["read", "edit", "write"], "codex");
  const externallyActivated = [...c.nextTools, "edit"];
  const repeated = step(externallyActivated, "codex", c.nextOwnership);
  assert.equal(repeated.nextTools.includes("edit"), true);
  assert.equal(repeated.nextOwnership.editRemovedByUs, false);
  const again = step(repeated.nextTools, "codex", repeated.nextOwnership);
  assert.equal(again.nextTools.includes("edit"), true);
});

test("codex additive keeps native tools", () => {
  const r = step(["read", "edit", "write"], "codex", initialToolOwnership(), "additive");
  assert.deepEqual(r.nextTools, ["read", "edit", "write", "apply_patch"]);
  assert.equal(r.surface, "codex-additive");
});

test("gemini additive keeps native tools", () => {
  const r = step(["read", "edit", "write"], "gemini", initialToolOwnership(), "additive");
  assert.deepEqual(r.nextTools, ["read", "edit", "write", "replace_file_content", "multi_replace_file_content", "write_to_file"]);
  assert.equal(r.surface, "gemini-additive");
});

test("replace -> additive restores owned native tools without changing custom mode", () => {
  const replace = step(["read", "edit", "write"], "gemini", initialToolOwnership(), "replace");
  const additive = step(replace.nextTools, "gemini", replace.nextOwnership, "additive");
  assert.equal(additive.nextTools.includes("edit"), true);
  assert.equal(additive.nextTools.includes("write"), true);
  assert.equal(additive.nextTools.includes("replace_file_content"), true);
  assert.equal(additive.nextOwnership.suppressesNative, false);
});

test("unavailable codex restores native tools", () => {
  const c = step(["read", "edit", "write"], "codex");
  const unavailable = step(c.nextTools, "codex", c.nextOwnership, "replace", false);
  assert.deepEqual(unavailable.nextTools, ["read", "edit", "write"]);
  assert.equal(unavailable.surface, "codex-unavailable");
});

test("excluded Gemini tool is not resurrected", () => {
  const available = new Set([...all].filter((name) => name !== "write_to_file"));
  const g = step(["read", "edit", "write"], "gemini", initialToolOwnership(), "replace", true, available);
  assert.equal(g.nextTools.includes("write_to_file"), false);
  assert.equal(g.nextTools.includes("replace_file_content"), true);
});

test("all Gemini tools excluded falls back to native tools", () => {
  const available = new Set(["read", "edit", "write", "apply_patch"]);
  const g = step(["read", "edit", "write"], "gemini", initialToolOwnership(), "replace", true, available);
  assert.deepEqual(g.nextTools, ["read", "edit", "write"]);
  assert.equal(g.surface, "gemini-unavailable");
});


test("deepseek replace keeps write/edit and activates str_replace_editor", () => {
  const r = step(["read", "edit", "write"], "deepseek");
  assert.deepEqual(r.nextTools, ["read", "edit", "write", "str_replace_editor"]);
  assert.equal(r.nextOwnership.suppressesNative, false);
  assert.equal(r.surface, "deepseek-replace");
});

test("codex replace -> deepseek replace restores native write/edit", () => {
  const codex = step(["read", "edit", "write"], "codex");
  const deepseek = step(codex.nextTools, "deepseek", codex.nextOwnership, "replace");
  assert.deepEqual(deepseek.nextTools, ["read", "edit", "write", "str_replace_editor"]);
  assert.equal(deepseek.nextOwnership.suppressesNative, false);
});

test("deepseek additive also keeps native tools", () => {
  const r = step(["read", "edit", "write"], "deepseek", initialToolOwnership(), "additive");
  assert.deepEqual(r.nextTools, ["read", "edit", "write", "str_replace_editor"]);
  assert.equal(r.surface, "deepseek-additive");
});

test("deepseek unavailable falls back to native tools", () => {
  const available = new Set(["read", "edit", "write"]);
  const r = step(["read", "edit", "write"], "deepseek", initialToolOwnership(), "replace", true, available);
  assert.deepEqual(r.nextTools, ["read", "edit", "write"]);
  assert.equal(r.surface, "deepseek-unavailable");
});
