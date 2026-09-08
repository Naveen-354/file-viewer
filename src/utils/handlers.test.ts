import { describe, expect, it } from "vitest";
import { OVERRIDABLE, handlerRows, resolveHandler } from "./handlers";
import { handlers } from "../handlers/registry";

describe("handler table", () => {
  it("lists every registered viewer, so the page cannot drift from the registry", () => {
    const rows = handlerRows();
    expect(rows).toHaveLength(handlers.length);
    expect(rows.map((row) => row.id)).toEqual(handlers.map((handler) => handler.id));
  });

  it("marks the viewers that decode in Rust", () => {
    const rows = handlerRows();
    const rust = rows.filter((row) => row.runtime === "Rust core").map((row) => row.id).sort();
    expect(rust).toEqual(["archive", "document", "image", "spreadsheet"]);
    expect(rows.find((row) => row.id === "text")!.runtime).toBe("WebView");
  });

  it("keeps the fallback viewer, which claims no extension at all", () => {
    expect(handlerRows().find((row) => row.id === "fallback")!.extensions).toEqual([]);
  });
});

describe("override options", () => {
  it("only offers viewers that are actually registered", () => {
    const known = new Set(handlers.map((handler) => handler.id));
    for (const choice of OVERRIDABLE) {
      for (const option of choice.options) expect(known.has(option.id)).toBe(true);
      expect(known.has(choice.fallback)).toBe(true);
    }
  });

  it("always includes the detected default among the options", () => {
    for (const choice of OVERRIDABLE) {
      expect(choice.options.some((option) => option.id === choice.fallback)).toBe(true);
    }
  });

  it("offers a choice only for extensions a registered viewer claims", () => {
    const claimed = new Set(handlers.flatMap((handler) => handler.supportedExtensions));
    for (const choice of OVERRIDABLE) expect(claimed.has(choice.extension)).toBe(true);
  });
});

describe("resolving a handler", () => {
  it("redirects an extension that has an override", () => {
    expect(resolveHandler("structured", "json", { json: "text" })).toBe("text");
  });

  it("leaves the detected handler alone when nothing is overridden", () => {
    expect(resolveHandler("structured", "json", {})).toBe("structured");
    expect(resolveHandler("pdf", "pdf", {})).toBe("pdf");
  });

  it("matches the extension case-insensitively", () => {
    expect(resolveHandler("structured", "JSON", { json: "text" })).toBe("text");
  });

  it("ignores an override for an extension no choice was offered for", () => {
    // A hand-edited setting must not be able to send a PDF to the code editor.
    expect(resolveHandler("pdf", "pdf", { pdf: "text" })).toBe("pdf");
    expect(resolveHandler("image", "png", { png: "text" })).toBe("image");
  });

  it("ignores an override naming a viewer that was never on offer", () => {
    expect(resolveHandler("structured", "json", { json: "media" })).toBe("structured");
    expect(resolveHandler("structured", "json", { json: "nonsense" })).toBe("structured");
  });

  it("handles a file with no extension", () => {
    expect(resolveHandler("fallback", null, { json: "text" })).toBe("fallback");
  });
});
