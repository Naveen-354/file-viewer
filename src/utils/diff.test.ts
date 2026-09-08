import { describe, expect, it } from "vitest";
import { checkPair, openFileChoices, sizeDelta } from "./diff";
import type { FileDescriptor, HandlerId } from "../types/files";

const file = (name: string, handlerId: HandlerId, extension: string | null, size = 100): FileDescriptor => ({
  path: `D:/files/${name}`, name, extension, mimeType: null,
  detectedType: "x", handlerId, size, createdMs: null, modifiedMs: 1, readonly: false,
});

describe("pair validation", () => {
  it("is not ready until both sides are chosen, without complaining", () => {
    expect(checkPair(null, null)).toEqual({ ready: false, problem: null, warning: null });
    expect(checkPair(file("a.sql", "sql", "sql"), null).problem).toBeNull();
  });

  it("accepts two text files of the same kind", () => {
    const check = checkPair(file("a.sql", "sql", "sql"), file("b.sql", "sql", "sql"));
    expect(check).toEqual({ ready: true, problem: null, warning: null });
  });

  it("refuses a binary side and names it", () => {
    const check = checkPair(file("a.sql", "sql", "sql"), file("logo.png", "image", "png"));
    expect(check.ready).toBe(false);
    expect(check.problem).toContain("logo.png");
    expect(check.problem).toContain("not text");
  });

  it("names both sides when neither is text", () => {
    const check = checkPair(file("a.png", "image", "png"), file("b.pdf", "pdf", "pdf"));
    expect(check.problem).toContain("a.png and b.pdf");
    expect(check.problem).toContain("are not text");
  });

  it("refuses the same file on both sides, however it is spelled", () => {
    const left = file("a.sql", "sql", "sql");
    const right = { ...left, path: "\\\\?\\D:/FILES/A.SQL" };
    expect(checkPair(left, right).problem).toBe("Both sides are the same file.");
  });

  it("warns about a mismatched extension but still allows it", () => {
    const check = checkPair(file("a.sql", "sql", "sql"), file("b.txt", "text", "txt"));
    expect(check.ready).toBe(true);
    expect(check.warning).toContain(".sql");
    expect(check.warning).toContain(".txt");
  });

  it("treats every text-shaped viewer as comparable", () => {
    for (const handler of ["text", "sql", "structured", "csv"] as HandlerId[]) {
      expect(checkPair(file("a", handler, "a"), file("b", handler, "b")).ready).toBe(true);
    }
  });
});

describe("size delta", () => {
  it("reports growth, shrinkage and no change", () => {
    expect(sizeDelta(file("a", "text", "txt", 100), file("b", "text", "txt", 150))).toMatchObject({ bytes: 50, direction: "grew" });
    expect(sizeDelta(file("a", "text", "txt", 100), file("b", "text", "txt", 40))).toMatchObject({ bytes: -60, direction: "shrank" });
    expect(sizeDelta(file("a", "text", "txt", 100), file("b", "text", "txt", 100)).direction).toBe("same");
  });

  it("computes the percentage against the base", () => {
    expect(sizeDelta(file("a", "text", "txt", 200), file("b", "text", "txt", 250)).percent).toBeCloseTo(25);
  });

  it("has no percentage to report when the base is empty", () => {
    expect(sizeDelta(file("a", "text", "txt", 0), file("b", "text", "txt", 10)).percent).toBeNull();
  });
});

describe("open-file suggestions", () => {
  const open = [
    file("a.sql", "sql", "sql"),
    file("b.json", "structured", "json"),
    file("c.png", "image", "png"),
  ];

  it("offers only text files that are not already chosen", () => {
    expect(openFileChoices(open, [null, null]).map((f) => f.name)).toEqual(["a.sql", "b.json"]);
  });

  it("drops a file once it is in a slot", () => {
    expect(openFileChoices(open, [open[0], null]).map((f) => f.name)).toEqual(["b.json"]);
    expect(openFileChoices(open, [open[0], open[1]])).toEqual([]);
  });

  it("matches a taken file case-insensitively", () => {
    const taken = { ...open[0], path: open[0].path.toUpperCase() };
    expect(openFileChoices(open, [taken, null]).map((f) => f.name)).toEqual(["b.json"]);
  });
});
