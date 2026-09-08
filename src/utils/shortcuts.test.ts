import { describe, expect, it } from "vitest";
import { GLOBAL_SHORTCUTS, SCOPED_SHORTCUTS, matchesQuery, shortcutCount } from "./shortcuts";

const press = (key: string, extra: Partial<KeyboardEventInit> = {}) =>
  new KeyboardEvent("keydown", { key, ...extra });

const fire = (event: KeyboardEvent) => GLOBAL_SHORTCUTS.filter((s) => s.matches(event)).map((s) => s.id);

describe("global shortcut matching", () => {
  it("matches each documented combination", () => {
    expect(fire(press("o", { ctrlKey: true }))).toEqual(["open"]);
    expect(fire(press("p", { ctrlKey: true }))).toEqual(["palette"]);
    expect(fire(press("t", { ctrlKey: true, shiftKey: true }))).toEqual(["reopen"]);
    expect(fire(press("w", { ctrlKey: true }))).toEqual(["close"]);
    expect(fire(press("F2"))).toEqual(["rename"]);
    expect(fire(press(",", { ctrlKey: true }))).toEqual(["settings"]);
  });

  it("accepts Cmd as well as Ctrl", () => {
    expect(fire(press("o", { metaKey: true }))).toEqual(["open"]);
  });

  it("is case-insensitive, so Caps Lock does not break it", () => {
    expect(fire(press("O", { ctrlKey: true }))).toEqual(["open"]);
    expect(fire(press("T", { ctrlKey: true, shiftKey: true }))).toEqual(["reopen"]);
  });

  it("ignores the bare key without a modifier", () => {
    for (const key of ["o", "p", "w", ","]) expect(fire(press(key))).toEqual([]);
  });

  it("does not fire the unshifted binding when Shift is held", () => {
    // Ctrl+Shift+T must reopen a tab, not also trigger anything else.
    expect(fire(press("t", { ctrlKey: true, shiftKey: true }))).toEqual(["reopen"]);
    expect(fire(press("o", { ctrlKey: true, shiftKey: true }))).toEqual([]);
    expect(fire(press("w", { ctrlKey: true, shiftKey: true }))).toEqual([]);
  });

  it("never lets one event match two shortcuts", () => {
    const events = [
      press("o", { ctrlKey: true }), press("p", { ctrlKey: true }),
      press("t", { ctrlKey: true, shiftKey: true }), press("w", { ctrlKey: true }),
      press("F2"), press(",", { ctrlKey: true }),
    ];
    for (const event of events) expect(fire(event).length).toBeLessThanOrEqual(1);
  });

  it("marks the shortcuts that need an open file", () => {
    const needing = GLOBAL_SHORTCUTS.filter((s) => s.needsActiveTab).map((s) => s.id).sort();
    expect(needing).toEqual(["close", "rename"]);
  });
});

describe("shortcut catalogue", () => {
  it("gives every entry a label, a detail and at least one key", () => {
    for (const shortcut of GLOBAL_SHORTCUTS) {
      expect(shortcut.label).toBeTruthy();
      expect(shortcut.detail).toBeTruthy();
      expect(shortcut.keys.length).toBeGreaterThan(0);
    }
    for (const group of SCOPED_SHORTCUTS) {
      expect(group.rows.length).toBeGreaterThan(0);
      for (const row of group.rows) {
        expect(row.label).toBeTruthy();
        expect(row.where).toBeTruthy();
        expect(row.keys.every((combo) => combo.length > 0)).toBe(true);
      }
    }
  });

  it("counts every documented binding once", () => {
    const scoped = SCOPED_SHORTCUTS.reduce((sum, group) => sum + group.rows.length, 0);
    expect(shortcutCount()).toBe(GLOBAL_SHORTCUTS.length + scoped);
  });

  it("does not document the same combination twice within one scope", () => {
    for (const group of SCOPED_SHORTCUTS) {
      const printed = group.rows.flatMap((row) => row.keys.map((combo) => `${combo.join("+")}|${row.label}`));
      expect(new Set(printed).size).toBe(printed.length);
    }
  });
});

describe("filtering", () => {
  it("matches on the label, the description or the printed keys", () => {
    expect(matchesQuery("rename", "Rename file", "Renames the open file", [["F2"]])).toBe(true);
    expect(matchesQuery("unsaved", "Close tab", "asking first when it has unsaved changes", [["Ctrl", "W"]])).toBe(true);
    expect(matchesQuery("ctrl+w", "Close tab", "", [["Ctrl", "W"]])).toBe(true);
    expect(matchesQuery("f2", "Rename file", "", [["F2"]])).toBe(true);
  });

  it("returns everything for an empty query and nothing for a miss", () => {
    expect(matchesQuery("   ", "Anything", "", [["A"]])).toBe(true);
    expect(matchesQuery("zzz", "Close tab", "nothing here", [["Ctrl", "W"]])).toBe(false);
  });
});
