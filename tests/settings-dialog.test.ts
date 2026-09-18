import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/config/schema.ts";
import {
  SettingsDialog,
  type DialogResult,
  type SettingsDialogDraft,
} from "../src/ui/settings-dialog.ts";

const theme = { fg: (_token: string, text: string) => text };
const TOTAL_ROWS = 16; // rows 0..14 plus the save row
const SAVE_ROW = 15;

/**
 * SettingsDialog clones the draft it is given, so tests must drive the dialog to
 * its save row and inspect the returned draft rather than the object they passed in.
 */
function drive(initial: {
  bashOnly?: boolean;
  sessionBashOnly?: boolean | "auto";
  select: number;
  presses?: Array<"\x1b[B" | "\x1b[C" | "\x1b[D" | "\r">;
}): SettingsDialogDraft | undefined {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.bashOnly = initial.bashOnly ?? false;
  const results: DialogResult[] = [];
  const dialog = new SettingsDialog(
    {
      sessionMode: "auto",
      sessionSurface: "auto",
      sessionBashOnly: initial.sessionBashOnly ?? "auto",
      settings,
    },
    "test/model",
    "pi",
    "pi (edit/write)",
    undefined,
    "default",
    theme,
    (result) => results.push(result),
    () => {},
  );
  const sequence: Array<"\x1b[B" | "\x1b[C" | "\x1b[D" | "\r"> = [
    ...Array<"\x1b[B">(initial.select).fill("\x1b[B"),
    ...(initial.presses ?? []),
    ...Array<"\x1b[B">(SAVE_ROW - initial.select).fill("\x1b[B"),
    "\r",
  ];
  for (const key of sequence) dialog.handleInput(key);
  const saved = results[0];
  return saved?.action === "save" ? saved.draft : undefined;
}

test("all mode is available in the popup session and default selectors", () => {
  const draft = drive({ select: 0, presses: ["\x1b[C", "\x1b[C", "\x1b[C", "\x1b[C"] });
  assert.equal(draft?.sessionMode, "all");

  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.defaultMode = "all";
  const dialog = new SettingsDialog(
    { sessionMode: "auto", sessionSurface: "auto", sessionBashOnly: "auto", settings },
    "test/model",
    "pi",
    "pi (edit/write)",
    undefined,
    "default",
    theme,
    () => {},
    () => {},
  );
  assert.match(dialog.render(76).join("\n"), /all/);
});

test("bash-only rows render in the dialog", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const dialog = new SettingsDialog(
    { sessionMode: "auto", sessionSurface: "auto", sessionBashOnly: "auto", settings },
    "test/model",
    "pi",
    "pi (edit/write)",
    undefined,
    "default",
    theme,
    () => {},
    () => {},
  );
  const rendered = dialog.render(76).join("\n");
  assert.match(rendered, /Session bash-only/);
  assert.match(rendered, /Default bash-only/);
});

test("row 5 toggles saved bashOnly and leaves auto discovery alone", () => {
  const draft = drive({ select: 5, presses: ["\x1b[C"] });
  assert.equal(draft?.settings.bashOnly, true);
  assert.equal(draft?.settings.autoDiscovery.enabled, true);
});

test("row 6 still toggles auto discovery, proving alignment below the inserted rows", () => {
  const draft = drive({ select: 6, presses: ["\x1b[C"] });
  assert.equal(draft?.settings.autoDiscovery.enabled, false);
  assert.equal(draft?.settings.bashOnly, false);
});

test("session bash-only cycles auto -> off -> on and only affects the session draft", () => {
  const draft = drive({ select: 2, presses: ["\x1b[C", "\x1b[C", "\x1b[C", "\x1b[C"] });
  assert.equal(draft?.sessionBashOnly, false);
  assert.equal(draft?.settings.bashOnly, false);
});

test("every row index is reachable and the save row is last", () => {
  // A back/forward sweep over all rows must not throw or lose the save row.
  const draft = drive({
    select: 0,
    presses: Array.from({ length: TOTAL_ROWS * 2 }, () => "\x1b[B" as const),
  });
  assert.ok(draft, "save row must remain reachable after wrapping navigation");
});
