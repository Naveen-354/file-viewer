import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { readDocument, openSystem, printFile, saveTextAs } = vi.hoisted(() => ({
  readDocument: vi.fn(),
  openSystem: vi.fn(),
  printFile: vi.fn(),
  saveTextAs: vi.fn(),
}));

vi.mock("../../services/tauri", () => ({ api: { readDocument, openSystem, printFile, saveTextAs } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import DocumentViewer from "./DocumentViewer";
import type { DocumentContent, DocumentProperties, FileDescriptor } from "../../types/files";

const run = (text: string) => ({ text, bold: false, italic: false, underline: false });

const properties: DocumentProperties = {
  title: "Quarterly Report", subject: null, author: "Dana Lin", lastModifiedBy: "Sam Ito",
  keywords: null, revision: "7", created: "2024-03-01T10:00:00Z", modified: "2024-03-04T08:30:00Z",
  generator: "Microsoft Office Word", generatorVersion: "16.0000", company: null,
  totalEditMinutes: 135, pages: 4, words: 812, characters: 4210, paragraphs: 66,
  protection: "Comments only", trackChanges: true, hasMacros: true, hasSignature: false,
  fonts: ["Calibri", "Cambria"],
  parts: [{ name: "word/document.xml", size: 41000, compressedSize: 5200 }],
};

const content: DocumentContent = {
  blocks: [
    { kind: "paragraph", style: "Heading1", headingLevel: 1, listLevel: null, ordered: false, runs: [run("Overview")] },
    { kind: "paragraph", style: null, headingLevel: null, listLevel: null, ordered: false, runs: [run("Revenue grew.")] },
    { kind: "paragraph", style: "Heading2", headingLevel: 2, listLevel: null, ordered: false, runs: [run("Risks")] },
    { kind: "table", rows: [["Region", "Units"], ["North", "120"]] },
  ],
  wordCount: 812,
  truncated: false,
  properties,
  insertions: 3,
  deletions: 1,
};

const file: FileDescriptor = {
  path: "C:\\report.docx", name: "report.docx", extension: "docx", mimeType: null,
  detectedType: "Word document", handlerId: "document", size: 40960,
  createdMs: null, modifiedMs: 42, readonly: false,
};

function mount(overrides: Partial<DocumentContent> = {}) {
  readDocument.mockResolvedValue({ ...content, ...overrides });
  return render(<DocumentViewer file={file} tabId="t1" onStatusChange={() => {}} onDirtyChange={() => {}} />);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("document viewer", () => {
  it("renders the page, the headings index and the inspector without crashing", async () => {
    mount();
    const page = await screen.findByRole("article");
    expect(within(page).getByText("Overview")).toBeTruthy();
    expect(within(screen.getByLabelText("Headings index")).getByText("Risks")).toBeTruthy();
    const inspector = screen.getByLabelText("Document inspector");
    expect(inspector.textContent).toContain("Quarterly Report");
    expect(inspector.textContent).toContain("Dana Lin");
    expect(inspector.textContent).toContain("2 h 15 min");
  });

  it("reports macro and protection state from the package rather than guessing", async () => {
    mount();
    const inspector = await screen.findByLabelText("Document inspector");
    expect(inspector.textContent).toContain("Macro project present");
    expect(inspector.textContent).toContain("No signature part");
    expect(inspector.textContent).toContain("Editing restricted: Comments only");
  });

  it("omits a metadata row the document does not record", async () => {
    mount({ properties: { ...properties, author: null } });
    const inspector = await screen.findByLabelText("Document inspector");
    await waitFor(() => expect(inspector.textContent).toContain("Quarterly Report"));
    expect(inspector.textContent).not.toContain("Dana Lin");
  });

  it("lists fonts and parts on their own tabs", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Fonts" }));
    expect(screen.getByText("Cambria")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Parts" }));
    expect(screen.getByText("document.xml")).toBeTruthy();
  });

  it("filters the page to matching blocks", async () => {
    mount();
    fireEvent.change(await screen.findByPlaceholderText("Find in document"), { target: { value: "revenue" } });
    const page = screen.getByRole("article");
    await waitFor(() => expect(within(page).queryByText("Risks")).toBeNull());
    expect(within(page).getByText("Revenue grew.")).toBeTruthy();
  });

  it("switches to the outline layout and back to the page", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Outline" }));
    expect(within(screen.getByRole("article")).queryByText("Revenue grew.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Page Layout" }));
    expect(within(screen.getByRole("article")).getByText("Revenue grew.")).toBeTruthy();
  });

  it("shows the read failure with an escape hatch instead of a blank pane", async () => {
    readDocument.mockRejectedValue(new Error("not a Word document"));
    render(<DocumentViewer file={file} tabId="t1" onStatusChange={() => {}} onDirtyChange={() => {}} />);
    expect(await screen.findByText("not a Word document")).toBeTruthy();
  });
});
