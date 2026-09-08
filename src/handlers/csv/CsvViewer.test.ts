import { describe, expect, it } from "vitest";
import { detectDelimiter } from "../../utils/csv";

describe("detectDelimiter", () => {
  it("detects common delimiters outside quoted values", () => {
    expect(detectDelimiter('name,description\nA,"one,two"\nB,three')).toBe(",");
    expect(detectDelimiter("name\tvalue\nA\t1\nB\t2")).toBe("\t");
    expect(detectDelimiter("name;value\nA;1\nB;2")).toBe(";");
  });
});
