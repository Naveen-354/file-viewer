import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDocument, readBytes } = vi.hoisted(() => {
  const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getPage = vi.fn(async () => ({
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, convertToPdfPoint: (x: number, y: number) => [x, y], convertToViewportPoint: (x: number, y: number) => [x, y] }),
    render: renderPage,
    getTextContent: async () => ({ items: [] }),
  }));
  const document = { numPages: 3, getPage, destroy: vi.fn() };
  const destroy = vi.fn();
  return { readBytes: vi.fn(), getDocument: vi.fn(() => ({ promise: Promise.resolve(document), destroy, onPassword: null })) };
});

vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, PasswordResponses: { INCORRECT_PASSWORD: 2 }, getDocument }));
vi.mock("../../utils/file", () => ({ readBytes }));

import { PDFDocument } from "pdf-lib";
import PdfViewer from "./PdfViewer";
import { buildEditedPdf, DEFAULT_STYLE } from "./editing";

describe("PdfViewer", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    readBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  });

  it("shows, closes, and reopens the page preview panel", async () => {
    const file = { path: "C:\\fixture.pdf", name: "fixture.pdf", extension: "pdf", mimeType: "application/pdf", detectedType: "PDF document", handlerId: "pdf" as const, size: 3, createdMs: null, modifiedMs: null, readonly: false };
    const { container } = render(<PdfViewer file={file} tabId="pdf" onDirtyChange={vi.fn()} onStatusChange={vi.fn()} />);
    await screen.findByRole("complementary", { name: "PDF page previews" });
    expect(container.querySelector(".pdf-scroll")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close page previews" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "PDF page previews" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Show previews" }));
    expect(await screen.findByRole("complementary", { name: "PDF page previews" })).toBeInTheDocument();
  });

  it("opens the in-app PDF editing controls", async () => {
    const file = { path: "C:\\fixture.pdf", name: "fixture.pdf", extension: "pdf", mimeType: "application/pdf", detectedType: "PDF document", handlerId: "pdf" as const, size: 3, createdMs: null, modifiedMs: null, readonly: false };
    render(<PdfViewer file={file} tabId="pdf" onDirtyChange={vi.fn()} onStatusChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit PDF" }));
    expect(screen.getByRole("button", { name: "Rotate page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as…" })).toBeDisabled();
  });

  it("applies page edits to saved PDF bytes", async () => {
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    source.addPage([300, 400]);
    const output = await buildEditedPdf(await source.save(), {
      annotations: [{ id: "note", page: 1, x: 20, y: 300, runs: [{ ...DEFAULT_STYLE, text: "Note" }] }],
      images: [],
      rotations: { 1: 90 },
      deletedPages: [2],
    });
    const saved = await PDFDocument.load(output);
    expect(saved.getPageCount()).toBe(1);
    expect(saved.getPage(0).getRotation().angle).toBe(90);
  });
});
