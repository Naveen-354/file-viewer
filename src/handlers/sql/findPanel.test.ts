import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { countMatches } from "./findPanel";

const doc = "select a from t;\nSELECT b FROM t;\nselect c from t;";

function stateWith(selection?: { from: number; to: number }): EditorState {
  return EditorState.create({
    doc,
    selection: selection ? EditorSelection.single(selection.from, selection.to) : undefined,
  });
}

describe("find bar match counter", () => {
  it("counts every match, case-insensitively by default", () => {
    const count = countMatches(stateWith(), new SearchQuery({ search: "select" }));
    expect(count.total).toBe(3);
    expect(count.capped).toBe(false);
  });

  it("honours case sensitivity", () => {
    expect(countMatches(stateWith(), new SearchQuery({ search: "select", caseSensitive: true })).total).toBe(2);
    expect(countMatches(stateWith(), new SearchQuery({ search: "SELECT", caseSensitive: true })).total).toBe(1);
  });

  it("reports which match the selection is on, so the bar can say 2 of 3", () => {
    const second = doc.indexOf("SELECT");
    const count = countMatches(stateWith({ from: second, to: second + 6 }), new SearchQuery({ search: "select" }));
    expect(count).toEqual({ index: 2, total: 3, capped: false });
  });

  it("reports index zero when the cursor is not on a match", () => {
    expect(countMatches(stateWith({ from: 0, to: 0 }), new SearchQuery({ search: "select" })).index).toBe(0);
  });

  it("counts regular-expression matches", () => {
    const count = countMatches(stateWith(), new SearchQuery({ search: "from\\s+t", regexp: true }));
    expect(count.total).toBe(3);
  });

  it("returns nothing for an empty or invalid query instead of throwing", () => {
    expect(countMatches(stateWith(), new SearchQuery({ search: "" })).total).toBe(0);
    const broken = new SearchQuery({ search: "(unclosed", regexp: true });
    expect(broken.valid).toBe(false);
    expect(() => countMatches(stateWith(), broken)).not.toThrow();
    expect(countMatches(stateWith(), broken).total).toBe(0);
  });

  it("stops counting on a pathological file rather than scanning forever", () => {
    const huge = EditorState.create({ doc: "x ".repeat(5000) });
    const count = countMatches(huge, new SearchQuery({ search: "x" }));
    expect(count.capped).toBe(true);
    expect(count.total).toBe(1000);
  });

  it("matches whole words only when asked", () => {
    const state = EditorState.create({ doc: "id user_id id" });
    expect(countMatches(state, new SearchQuery({ search: "id" })).total).toBe(3);
    expect(countMatches(state, new SearchQuery({ search: "id", wholeWord: true })).total).toBe(2);
  });
});
