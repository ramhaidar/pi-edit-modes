import assert from "node:assert/strict";
import test from "node:test";
import {
  DiffCallRenderComponent,
  displayToolPath,
  firstText,
  scanApplyPatchPreviewTargets,
} from "../src/tools/diff-call-renderer.ts";

test("diff call renderer exposes result and diff as call-body rows", () => {
  const component = new DiffCallRenderComponent();
  component.updateHeader("str_replace_editor str_replace /tmp/a.ts");
  component.updateResult("edited", "\n@@ -1 +1 @@\n-old\n+new\n");

  assert.deepEqual(component.render(120), [
    "str_replace_editor str_replace /tmp/a.ts",
    "  edited",
    "    @@ -1 +1 @@",
    "    -old",
    "    +new",
  ]);
});

test("diff call renderer keeps success summary for empty diffs", () => {
  const component = new DiffCallRenderComponent();
  component.updateHeader("replace_file_content a.ts");
  component.updateResult("No content change required for a.ts.", "");
  assert.deepEqual(component.render(120), [
    "replace_file_content a.ts",
    "  No content change required for a.ts.",
  ]);
});

test("firstText returns the first text content block", () => {
  assert.equal(firstText({ content: [{ type: "image" }, { type: "text", text: "ok" }] }), "ok");
});

test("diff call renderer normalizes CRLF and trims only blank edge rows", () => {
  const component = new DiffCallRenderComponent();
  component.updateHeader("tool file");
  component.updateResult(undefined, "\r\n@@ hunk\r\n context\r\n\r\n");
  assert.deepEqual(component.render(80), ["tool file", "    @@ hunk", "     context"]);
});

test("call header refresh does not discard a completed diff", () => {
  const component = new DiffCallRenderComponent();
  component.updateHeader("old header");
  component.updateResult("done", "-a\n+b");
  component.updateHeader("new header");
  assert.deepEqual(component.render(80), ["new header", "  done", "    -a", "    +b"]);
});

test("compact file headers include action and workspace-root path", async () => {
  const { compactFileHeader, displayToolPath } = await import("../src/tools/diff-call-renderer.ts");
  assert.equal(displayToolPath("index.php"), "/index.php");
  assert.equal(displayToolPath("./src/index.ts"), "/src/index.ts");
  assert.equal(displayToolPath("/repo/index.php"), "/repo/index.php");
  assert.equal(compactFileHeader("apply_patch", "A", "index.php"), "apply_patch A /index.php");
  assert.equal(
    compactFileHeader("replace_file_content", "M", "src/index.ts"),
    "replace_file_content M /src/index.ts",
  );
  assert.equal(
    compactFileHeader("str_replace_editor", "M", "/repo/a.ts"),
    "str_replace_editor M /repo/a.ts",
  );
});

test("apply_patch preview scan sees an unterminated streamed file header", () => {
  assert.deepEqual(
    scanApplyPatchPreviewTargets(
      "*** Begin Patch\n*** Update File: D:\\GitHub\\LMP\\routes\\web.php",
    ),
    [{ action: "M", path: "D:\\GitHub\\LMP\\routes\\web.php" }],
  );
});

test("apply_patch preview scan reports add, delete, update, and move targets", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+new",
    "*** Delete File: src/old.ts",
    "*** Update File: src/a.ts",
    "*** Move to: src/b.ts",
  ].join("\n");

  assert.deepEqual(scanApplyPatchPreviewTargets(patch), [
    { action: "A", path: "src/new.ts" },
    { action: "D", path: "src/old.ts" },
    { action: "M", path: "src/a.ts", movePath: "src/b.ts" },
  ]);
});

test("apply_patch preview scan ignores incomplete empty target markers", () => {
  assert.deepEqual(scanApplyPatchPreviewTargets("*** Begin Patch\n*** Update File: "), []);
});

test("displayToolPath tolerates missing streamed path values", () => {
  assert.equal(displayToolPath(undefined), "...");
  assert.equal(displayToolPath(null), "...");
});

test("diff call renderer truncates every row to the supplied terminal width", async () => {
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  const component = new DiffCallRenderComponent();
  component.updateHeader("edit /very/long/path/that/exceeds/the/terminal/width.ts");
  component.updateResult(
    "a very long status message that cannot fit on a narrow terminal",
    '+class="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs focus:ring-sky-500"',
  );

  const rows = component.render(32);
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((row) => visibleWidth(row) <= 32));
});

test("diff call renderer splits multiline result text into physical rows", () => {
  const component = new DiffCallRenderComponent();
  component.updateHeader("write A D:\\repo\\a.php");
  component.updateResult(
    "<path>D:\\repo\\a.php</path>\n<type>file</type>\n<content>\nCreated file\n</content>",
    undefined,
  );

  const rows = component.render(120);
  assert.deepEqual(rows, [
    "write A D:\\repo\\a.php",
    "  <path>D:\\repo\\a.php</path>",
    "  <type>file</type>",
    "  <content>",
    "  Created file",
    "  </content>",
  ]);
  assert.ok(rows.every((row) => !row.includes("\n") && !row.includes("\r")));
});
