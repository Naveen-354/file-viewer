import { describe, expect, it } from "vitest";
import {
  diffLines, endsWithNewline, normalise, splitLines, toPatch, toUnified, type DiffOptions,
} from "./lineDiff";

const plain: DiffOptions = { ignoreWhitespace: false, ignoreCase: false };
const shape = (text: string) => diffLines(text, text, plain);

describe("splitting", () => {
  it("treats an empty file as no lines, not one blank line", () => {
    expect(splitLines("")).toEqual([]);
  });

  it("normalises CRLF and lone CR so line endings are not a difference", () => {
    expect(splitLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
    expect(diffLines("a\r\nb", "a\nb", plain).identical).toBe(true);
  });

  it("treats a final newline as a terminator, not an extra blank line", () => {
    // This test previously asserted the opposite, and that phantom line put a
    // context line into every exported patch that the file did not have, which
    // made `git apply` reject it.
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(endsWithNewline("a\n")).toBe(true);
    expect(endsWithNewline("a")).toBe(false);
  });
});

describe("comparison keys", () => {
  it("collapses whitespace only when asked", () => {
    expect(normalise("  a   b  ", { ignoreWhitespace: true, ignoreCase: false })).toBe("a b");
    expect(normalise("  a   b  ", plain)).toBe("  a   b  ");
  });

  it("lowercases only when asked", () => {
    expect(normalise("ABC", { ignoreWhitespace: false, ignoreCase: true })).toBe("abc");
    expect(normalise("ABC", plain)).toBe("ABC");
  });
});

describe("diffing", () => {
  it("reports an identical file as identical", () => {
    const result = shape("one\ntwo\nthree");
    expect(result.identical).toBe(true);
    expect(result.rows.every((row) => row.kind === "same")).toBe(true);
    expect(result.hunks).toEqual([]);
  });

  it("finds a pure insertion", () => {
    const result = diffLines("a\nb", "a\nx\nb", plain);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(0);
    const added = result.rows.find((row) => row.kind === "added")!;
    expect(added.right).toBe("x");
    expect(added.leftNumber).toBeNull();
    expect(added.rightNumber).toBe(2);
  });

  it("finds a pure deletion", () => {
    const result = diffLines("a\nx\nb", "a\nb", plain);
    expect(result.deletions).toBe(1);
    expect(result.additions).toBe(0);
    expect(result.rows.find((row) => row.kind === "removed")!.left).toBe("x");
  });

  it("pairs a replaced line as one modified row, not a delete plus an insert", () => {
    const result = diffLines("a\nold\nb", "a\nnew\nb", plain);
    expect(result.modifications).toBe(1);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
    const row = result.rows.find((r) => r.kind === "modified")!;
    expect([row.left, row.right]).toEqual(["old", "new"]);
    expect([row.leftNumber, row.rightNumber]).toEqual([2, 2]);
  });

  it("pairs what it can and leaves the remainder as pure changes", () => {
    const result = diffLines("a\nx\ny\nb", "a\np\nb", plain);
    expect(result.modifications).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.additions).toBe(0);
  });

  it("keeps line numbers correct on both sides across a change", () => {
    const result = diffLines("a\nb\nc", "a\nB1\nB2\nc", plain);
    const last = result.rows[result.rows.length - 1];
    expect(last.kind).toBe("same");
    expect(last.leftNumber).toBe(3);
    expect(last.rightNumber).toBe(4);
  });

  it("marks the start of each run of changes for navigation", () => {
    const result = diffLines("a\nb\nc\nd\ne", "a\nX\nc\nd\nY", plain);
    expect(result.hunks).toHaveLength(2);
    for (const index of result.hunks) {
      expect(result.rows[index].kind).not.toBe("same");
      if (index > 0) expect(result.rows[index - 1].kind).toBe("same");
    }
  });

  it("honours ignore-whitespace", () => {
    expect(diffLines("a  b", "a b", plain).identical).toBe(false);
    expect(diffLines("a  b", "a b", { ignoreWhitespace: true, ignoreCase: false }).identical).toBe(true);
  });

  it("honours ignore-case", () => {
    expect(diffLines("Select 1", "SELECT 1", plain).identical).toBe(false);
    expect(diffLines("Select 1", "SELECT 1", { ignoreWhitespace: false, ignoreCase: true }).identical).toBe(true);
  });

  it("still shows the original text when comparing loosely", () => {
    const result = diffLines("A  B\nkeep", "a b\nCHANGED", { ignoreWhitespace: true, ignoreCase: true });
    expect(result.rows[0].kind).toBe("same");
    // Display is never the normalised form.
    expect(result.rows[0].left).toBe("A  B");
    expect(result.rows[0].right).toBe("a b");
  });

  it("handles one side being empty", () => {
    expect(diffLines("", "a\nb", plain).additions).toBe(2);
    expect(diffLines("a\nb", "", plain).deletions).toBe(2);
    expect(diffLines("", "", plain).identical).toBe(true);
  });

  it("handles two completely different files", () => {
    const result = diffLines("a\nb\nc", "x\ny\nz", plain);
    expect(result.modifications).toBe(3);
    expect(result.rows).toHaveLength(3);
  });

  it("stops at the line cap and says so", () => {
    const big = Array.from({ length: 20_050 }, (_, index) => `line ${index}`).join("\n");
    const result = diffLines(big, big, plain);
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeLessThanOrEqual(20_000);
  });

  it("reports how long it took", () => {
    expect(diffLines("a", "b", plain).milliseconds).toBeGreaterThanOrEqual(0);
  });
});

describe("unified view", () => {
  it("splits a modified row into a removal followed by an addition", () => {
    const rows = diffLines("a\nold\nb", "a\nnew\nb", plain).rows;
    const unified = toUnified(rows);
    expect(unified.map((row) => row.kind)).toEqual(["same", "removed", "added", "same"]);
    expect(unified[1].text).toBe("old");
    expect(unified[2].text).toBe("new");
  });
});

describe("patch export", () => {
  const rows = diffLines("a\nb\nold\nd\ne", "a\nb\nnew\nd\ne", plain).rows;

  it("writes the file headers and a hunk header", () => {
    const patch = toPatch(rows, "left.sql", "right.sql");
    expect(patch.startsWith("--- a/left.sql\n+++ b/right.sql\n")).toBe(true);
    expect(patch).toContain("@@ -");
  });

  it("marks each line with a space, plus or minus", () => {
    const lines = toPatch(rows, "l", "r").split("\n");
    expect(lines).toContain("-old");
    expect(lines).toContain("+new");
    expect(lines).toContain(" a");
  });

  it("returns nothing for identical files, so there is no empty patch to save", () => {
    expect(toPatch(shape("a\nb").rows, "l", "r")).toBe("");
  });

  it("ends with a newline, as patch tools expect", () => {
    expect(toPatch(rows, "l", "r").endsWith("\n")).toBe(true);
  });

  it("emits separate hunks for changes that are far apart", () => {
    const spread = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const changed = [...spread];
    changed[2] = "changed near the top";
    changed[35] = "changed near the bottom";
    const patch = toPatch(diffLines(spread.join("\n"), changed.join("\n"), plain).rows, "l", "r");
    expect(patch.match(/^@@ /gm)).toHaveLength(2);
  });
});
