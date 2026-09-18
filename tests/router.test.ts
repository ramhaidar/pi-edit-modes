import test from "node:test";
import assert from "node:assert/strict";
import { computeToolTransition, initialToolOwnership } from "../src/modes/router.ts";

const all = new Set([
  "read",
  "read_image",
  "edit",
  "write",
  "apply_patch",
  "replace",
  "write_file",
  "str_replace_editor",
]);

function step(
  activeTools: string[],
  desiredMode: "pi" | "codex" | "gemini" | "deepseek",
  ownership = initialToolOwnership(),
  surface: "replace" | "additive" = "replace",
  codexSupported = true,
  availableTools = all,
  deepseekPreset: "standard" | "minimal" = "standard",
  deepseekImageSupported = false,
  bashOnly = false,
) {
  return computeToolTransition({
    activeTools,
    desiredMode,
    ownership,
    surface,
    bashOnly,
    codexSupported,
    availableTools,
    deepseekPreset,
    deepseekImageSupported,
  });
}

test("bash-only removes every mutating tool and keeps read-only tools", () => {
  const result = step(
    ["read", "edit", "write", "bash"],
    "pi",
    initialToolOwnership(),
    "replace",
    true,
    all,
    "standard",
    false,
    true,
  );
  assert.deepEqual(result.nextTools, ["read", "bash"]);
  assert.equal(result.surface, "bash-only");
  assert.equal(result.nextOwnership.editRemovedByUs, true);
  assert.equal(result.nextOwnership.writeRemovedByUs, true);
});

test("bash-only wins over every custom mode and suppresses its tools", () => {
  for (const mode of ["codex", "gemini", "deepseek"] as const) {
    const result = step(
      ["read", "edit", "write", "bash", "apply_patch", "replace", "write_file"],
      mode,
      initialToolOwnership(),
      "replace",
      true,
      all,
      "standard",
      false,
      true,
    );
    assert.equal(result.surface, "bash-only", `${mode} should report bash-only`);
    assert.deepEqual(result.nextTools, ["read", "bash"], `${mode} should strip mutating tools`);
  }
});

test("bash-only holds even on the additive surface", () => {
  const result = step(
    ["read", "edit", "write", "bash"],
    "gemini",
    initialToolOwnership(),
    "additive",
    true,
    all,
    "standard",
    false,
    true,
  );
  assert.deepEqual(result.nextTools, ["read", "bash"]);
  assert.equal(result.surface, "bash-only");
});

test("leaving bash-only restores native edit/write at their original indices", () => {
  const bashOnly = step(
    ["read", "edit", "write", "bash"],
    "pi",
    initialToolOwnership(),
    "replace",
    true,
    all,
    "standard",
    false,
    true,
  );
  const restored = step(
    bashOnly.nextTools,
    "pi",
    bashOnly.nextOwnership,
    "replace",
    true,
    all,
    "standard",
    false,
    false,
  );
  assert.deepEqual(restored.nextTools, ["read", "edit", "write", "bash"]);
  assert.equal(restored.surface, "pi");
  assert.equal(restored.nextOwnership.editRemovedByUs, false);
  assert.equal(restored.nextOwnership.writeRemovedByUs, false);
});

test("bash-only does not require bash itself to be available", () => {
  const available = new Set(["read", "edit", "write", "grep"]);
  const result = step(
    ["read", "edit", "write", "grep"],
    "pi",
    initialToolOwnership(),
    "replace",
    true,
    available,
    "standard",
    false,
    true,
  );
  assert.deepEqual(result.nextTools, ["read", "grep"]);
  assert.equal(result.surface, "bash-only");
});

test("bash-only removes mode-owned managed tools, including read-only read_image", () => {
  const result = step(
    ["read", "read_image", "edit", "write", "bash", "apply_patch"],
    "deepseek",
    initialToolOwnership(),
    "replace",
    true,
    all,
    "standard",
    true,
    true,
  );
  // read_image only exists inside DeepSeek mode, which bash-only disables, so it
  // is removed with the rest of the managed custom tools. Pi-native read tools stay.
  assert.deepEqual(result.nextTools, ["read", "bash"]);
  assert.equal(result.surface, "bash-only");
});

test("pi -> codex replace removes edit/write and activates apply_patch", () => {
  const result = step(["read", "edit", "write"], "codex");
  assert.deepEqual(result.nextTools, ["read", "apply_patch"]);
  assert.equal(result.nextOwnership.editRemovedByUs, true);
  assert.equal(result.nextOwnership.writeRemovedByUs, true);
  assert.equal(result.surface, "codex-replace");
});

test("codex replace -> gemini replace keeps native edit/write suppressed", () => {
  const codex = step(["read", "edit", "write"], "codex");
  const gemini = step(codex.nextTools, "gemini", codex.nextOwnership);
  assert.deepEqual(gemini.nextTools, ["read", "replace", "write_file"]);
  assert.equal(gemini.surface, "gemini-replace");
});

test("gemini replace exposes only current Gemini editing vocabulary", () => {
  const result = step(
    [
      "read",
      "edit",
      "write",
      "replace_file_content",
      "multi_replace_file_content",
      "write_to_file",
    ],
    "gemini",
  );
  assert.deepEqual(result.nextTools, ["read", "replace", "write_file"]);
});

test("strict replace surface removes externally reactivated native tools again", () => {
  const first = step(["read", "edit", "write"], "gemini");
  const repeated = step([...first.nextTools, "edit"], "gemini", first.nextOwnership);
  assert.equal(repeated.nextTools.includes("edit"), false);
  assert.equal(repeated.nextOwnership.editRemovedByUs, true);
});

test("gemini replace -> pi restores owned native tools", () => {
  const gemini = step(["read", "edit", "write"], "gemini");
  const pi = step(gemini.nextTools, "pi", gemini.nextOwnership);
  assert.deepEqual(pi.nextTools, ["read", "edit", "write"]);
});

test("additive surfaces are hybrids and retain native tools", () => {
  const codex = step(["read", "edit", "write"], "codex", initialToolOwnership(), "additive");
  assert.deepEqual(codex.nextTools, ["read", "edit", "write", "apply_patch"]);
  const gemini = step(["read", "edit", "write"], "gemini", initialToolOwnership(), "additive");
  assert.deepEqual(gemini.nextTools, ["read", "edit", "write", "replace", "write_file"]);
});

test("replace -> additive restores owned native tools without losing Gemini tools", () => {
  const strict = step(["read", "edit", "write"], "gemini");
  const additive = step(strict.nextTools, "gemini", strict.nextOwnership, "additive");
  assert.deepEqual(additive.nextTools, ["read", "edit", "write", "replace", "write_file"]);
  assert.equal(additive.nextOwnership.suppressesNative, false);
});

test("excluded Gemini tool is not resurrected", () => {
  const available = new Set([...all].filter((name) => name !== "write_file"));
  const result = step(
    ["read", "edit", "write"],
    "gemini",
    initialToolOwnership(),
    "replace",
    true,
    available,
  );
  assert.equal(result.nextTools.includes("write_file"), false);
  assert.equal(result.nextTools.includes("replace"), true);
});

test("all Gemini tools excluded falls back to native tools", () => {
  const available = new Set(["read", "edit", "write", "apply_patch"]);
  const result = step(
    ["read", "edit", "write"],
    "gemini",
    initialToolOwnership(),
    "replace",
    true,
    available,
  );
  assert.deepEqual(result.nextTools, ["read", "edit", "write"]);
  assert.equal(result.surface, "gemini-unavailable");
});

test("DeepSeek standard replace exposes read/write/edit without str_replace_editor", () => {
  const result = step(["read", "edit", "write"], "deepseek");
  assert.deepEqual(result.nextTools, ["read", "edit", "write"]);
  assert.equal(result.nextOwnership.suppressesNative, false);
  assert.equal(result.surface, "deepseek-replace");
});

test("DeepSeek standard conditionally exposes read_image for vision models", () => {
  const result = step(
    ["read", "edit", "write"],
    "deepseek",
    initialToolOwnership(),
    "replace",
    true,
    all,
    "standard",
    true,
  );
  assert.deepEqual(result.nextTools, ["read", "edit", "write", "read_image"]);
});

test("DeepSeek minimal replace exposes str_replace_editor and suppresses native filesystem family", () => {
  const result = step(
    ["read", "edit", "write", "bash"],
    "deepseek",
    initialToolOwnership(),
    "replace",
    true,
    all,
    "minimal",
  );
  assert.deepEqual(result.nextTools, ["bash", "str_replace_editor"]);
  assert.equal(result.nextOwnership.readRemovedByUs, true);
  assert.equal(result.nextOwnership.editRemovedByUs, true);
  assert.equal(result.nextOwnership.writeRemovedByUs, true);
});

test("Codex replace -> DeepSeek minimal also suppresses read", () => {
  const codex = step(["read", "edit", "write"], "codex");
  const minimal = step(
    codex.nextTools,
    "deepseek",
    codex.nextOwnership,
    "replace",
    true,
    all,
    "minimal",
  );
  assert.deepEqual(minimal.nextTools, ["str_replace_editor"]);
});

test("DeepSeek additive is explicitly hybrid", () => {
  const standard = step(
    ["read", "edit", "write"],
    "deepseek",
    initialToolOwnership(),
    "additive",
    true,
    all,
    "standard",
  );
  assert.deepEqual(standard.nextTools, ["read", "edit", "write", "str_replace_editor"]);
  const minimal = step(
    ["read", "edit", "write"],
    "deepseek",
    initialToolOwnership(),
    "additive",
    true,
    all,
    "minimal",
  );
  assert.deepEqual(minimal.nextTools, ["read", "edit", "write", "str_replace_editor"]);
});

test("DeepSeek standard availability does not depend on str_replace_editor", () => {
  const available = new Set(["read", "edit", "write"]);
  const result = step(
    ["read", "edit", "write"],
    "deepseek",
    initialToolOwnership(),
    "replace",
    true,
    available,
    "standard",
  );
  assert.equal(result.surface, "deepseek-replace");
});

test("DeepSeek minimal is unavailable without str_replace_editor", () => {
  const available = new Set(["read", "edit", "write"]);
  const result = step(
    ["read", "edit", "write"],
    "deepseek",
    initialToolOwnership(),
    "replace",
    true,
    available,
    "minimal",
  );
  assert.deepEqual(result.nextTools, ["read", "edit", "write"]);
  assert.equal(result.surface, "deepseek-unavailable");
});
