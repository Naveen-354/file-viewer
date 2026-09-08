import { describe, expect, it } from "vitest";
import { suggestedName } from "./image";

describe("converted file names", () => {
  it("replaces the existing extension rather than appending one", () => {
    expect(suggestedName("photo.png", "jpg")).toBe("photo.jpg");
    expect(suggestedName("scan.tar.gz", "png")).toBe("scan.tar.png");
  });

  it("adds an extension when the name has none", () => {
    expect(suggestedName("photo", "webp")).toBe("photo.webp");
  });

  it("keeps a leading dot on a dotfile instead of treating it as an extension", () => {
    expect(suggestedName(".hidden", "png")).toBe(".hidden.png");
  });
});
