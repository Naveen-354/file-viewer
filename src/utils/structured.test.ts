import { describe, expect, it } from "vitest";
import { parseStructured } from "./structured";

describe("structured parsing", () => {
  it("rejects corrupt JSON and XML", () => {
    expect(() => parseStructured('{"broken":', "json")).toThrow();
    expect(() => parseStructured("<root><broken></root>", "xml")).toThrow();
  });

  it("converts valid XML without evaluating it", () => {
    expect(parseStructured('<root id="1"><name>OneOpen</name></root>', "xml")).toEqual({ root: { "@id": "1", name: "OneOpen" } });
  });
});
