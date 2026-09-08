import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * jsdom has no layout engine, so a rendering test cannot catch a pane that
 * silently fails to scroll. These assert the stylesheet invariants instead.
 *
 * The recurring bug: `.viewer-area` is a *block* with `overflow: hidden`, so a
 * child using `flex: 1` to fill it gets no height from the parent, grows to its
 * content, and its inner `overflow: auto` region never becomes scrollable — the
 * content is simply clipped and unreachable.
 */
const css = readFileSync(join(__dirname, "styles.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return match ? match[1] : "";
}

describe("full-height panes inside .viewer-area", () => {
  it("keeps the container a clipped block, which is what makes the rest necessary", () => {
    const area = rule(".viewer-area");
    expect(area).toContain("overflow: hidden");
    expect(area).not.toContain("display: flex");
    expect(area).not.toContain("display: grid");
  });

  // Every pane rendered directly into .viewer-area by App.tsx.
  for (const selector of [".viewer", ".diff-view", ".diff-setup"]) {
    it(`${selector} takes its height from the parent rather than from content`, () => {
      const body = rule(selector);
      expect(body, `${selector} has no rule`).not.toBe("");
      expect(body, `${selector} must set height: 100%`).toContain("height: 100%");
      expect(body, `${selector} must not rely on flex: 1 inside a block parent`).not.toMatch(/flex:\s*1/);
    });
  }

  it("gives each scrolling region inside those panes a floor of zero", () => {
    // Without min-height: 0 a flex child refuses to shrink below its content,
    // which reintroduces the same unreachable-content bug one level down.
    for (const selector of [".diff-scroll", ".diff-body"]) {
      const body = rule(selector);
      expect(body, `${selector} has no rule`).not.toBe("");
      expect(body).toContain("min-height: 0");
      expect(body).toMatch(/overflow(-y)?:\s*auto/);
    }
  });

  it("keeps the settings page bounded by its own fixed positioning", () => {
    const page = rule(".settings-page");
    expect(page).toContain("position: fixed");
    expect(page).toContain("inset: 0");
    // Its grid children need the same floor for the same reason.
    expect(rule(".settings-main")).toContain("min-height: 0");
  });
});
