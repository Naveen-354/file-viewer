import { describe, expect, it } from "vitest";
import { findPath, normalizePath, samePath } from "./paths";

describe("path comparison", () => {
  it("treats a verbatim Windows path as the same file as its plain spelling", () => {
    expect(samePath("\\\\?\\C:\\notes\\a.txt", "C:\\notes\\a.txt")).toBe(true);
  });

  it("ignores case, which is how the file system compares on Windows", () => {
    expect(samePath("C:\\Notes\\A.TXT", "c:\\notes\\a.txt")).toBe(true);
  });

  it("keeps the UNC share when unwrapping a verbatim UNC path", () => {
    expect(normalizePath("\\\\?\\UNC\\server\\share\\a.txt")).toBe("\\\\server\\share\\a.txt");
  });

  it("does not confuse two different files", () => {
    expect(samePath("C:\\notes\\a.txt", "C:\\notes\\b.txt")).toBe(false);
  });

  it("returns the stored spelling so a pin can be deleted by the exact row", () => {
    const pins = [{ path: "C:\\notes\\a.txt" }];
    expect(findPath(pins, "\\\\?\\C:\\NOTES\\A.TXT")).toBe("C:\\notes\\a.txt");
    expect(findPath(pins, "C:\\notes\\b.txt")).toBeNull();
  });
});
