import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readBytes, saveText, saveTextAs, replaceFile } = vi.hoisted(() => ({
  readBytes: vi.fn(),
  saveText: vi.fn(),
  saveTextAs: vi.fn(),
  replaceFile: vi.fn(),
}));

vi.mock("../../utils/file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/file")>()),
  readBytes,
}));
vi.mock("../../services/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tauri")>();
  return { ...actual, api: { saveText, saveTextAs, metadata: vi.fn() } };
});
vi.mock("../../stores/workspace", () => ({
  useWorkspace: (selector: (state: { replaceFile: typeof replaceFile }) => unknown) => selector({ replaceFile }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => "C:\\out.json") }));

// CodeMirror needs layout APIs jsdom lacks; a textarea stands in for the editor.
vi.mock("./JsonEditor", () => ({
  JsonEditor: ({ initial, onChange }: { initial: string; onChange: (text: string) => void }) => (
    <textarea aria-label="Raw editor" defaultValue={initial} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import StructuredViewer from "./StructuredViewer";
import type { FileDescriptor } from "../../types/files";

const DOC = '{"name":"one","port":8080}';

const file: FileDescriptor = {
  path: "C:\\config.json", name: "config.json", extension: "json", mimeType: "application/json",
  detectedType: "JSON data", handlerId: "structured", size: DOC.length,
  createdMs: null, modifiedMs: 99, readonly: false,
};

function mount(descriptor: FileDescriptor = file) {
  const onDirtyChange = vi.fn();
  const view = render(
    <StructuredViewer file={descriptor} tabId="json" onDirtyChange={onDirtyChange} onStatusChange={vi.fn()} />,
  );
  return { ...view, onDirtyChange };
}

const enterRawEdit = async (label = "Edit JSON") => {
  fireEvent.click(await screen.findByRole("button", { name: "Raw Code" }));
  fireEvent.click(await screen.findByRole("button", { name: label }));
  return screen.findByLabelText("Raw editor");
};

describe("StructuredViewer raw editing", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    readBytes.mockResolvedValue(new TextEncoder().encode(DOC));
    saveText.mockResolvedValue({ ...file, modifiedMs: 100 });
    saveTextAs.mockResolvedValue({ ...file, path: "C:\\out.json" });
  });

  it("offers an edit button only in raw mode", async () => {
    mount();
    await screen.findByRole("button", { name: "Raw Code" });
    expect(screen.queryByRole("button", { name: "Edit JSON" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Raw Code" }));
    expect(await screen.findByRole("button", { name: "Edit JSON" })).toBeInTheDocument();
  });

  it("marks the tab dirty only once the text actually changes", async () => {
    const { onDirtyChange } = mount();
    const editor = await enterRawEdit();
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    fireEvent.change(editor, { target: { value: '{"name":"two","port":8080}' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
  });

  it("refuses to save invalid JSON and says why", async () => {
    const { container } = mount();
    const editor = await enterRawEdit();
    fireEvent.change(editor, { target: { value: '{"name": }' } });
    await waitFor(() => {
      const banner = container.querySelector(".validation-error");
      expect(banner?.textContent).toMatch(/Invalid JSON: .*line 1/);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Save as…" })).toBeDisabled();
    expect(saveText).not.toHaveBeenCalled();
  });

  it("saves valid edits and refreshes the tab descriptor", async () => {
    const { onDirtyChange } = mount();
    const editor = await enterRawEdit();
    fireEvent.change(editor, { target: { value: '{"name":"two"}' } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(saveText).toHaveBeenCalledWith("C:\\config.json", '{"name":"two"}', 99));
    expect(replaceFile).toHaveBeenCalledWith("json", expect.objectContaining({ modifiedMs: 100 }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("keeps the edits and reports the failure when saving fails", async () => {
    saveText.mockRejectedValue(new Error("Permission denied"));
    mount();
    const editor = await enterRawEdit();
    fireEvent.change(editor, { target: { value: '{"name":"two"}' } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
    expect(replaceFile).not.toHaveBeenCalled();
  });

  it("cannot save over a read-only file but can save a copy", async () => {
    mount({ ...file, readonly: true });
    const editor = await enterRawEdit();
    fireEvent.change(editor, { target: { value: '{"name":"two"}' } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    await waitFor(() => expect(saveTextAs).toHaveBeenCalled());
  });

  it("reformats the buffer without touching the file", async () => {
    mount();
    const editor = await enterRawEdit();
    fireEvent.change(editor, { target: { value: '{"a":1}' } });
    fireEvent.click(await screen.findByRole("button", { name: "Format" }));
    await waitFor(() => expect((screen.getByLabelText("Raw editor") as HTMLTextAreaElement).value).toContain("\n"));
    expect(saveText).not.toHaveBeenCalled();
  });
});
