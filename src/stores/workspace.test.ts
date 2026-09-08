import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDescriptor } from "../types/files";

const { detectFile, renameFile } = vi.hoisted(() => ({ detectFile: vi.fn(), renameFile: vi.fn() }));
vi.mock("../services/tauri", () => ({ api: { detectFile, renameFile } }));

import { useWorkspace } from "./workspace";
import { defaults as settingsDefaults, useSettings } from "./settings";

const descriptor: FileDescriptor = {
  path: "C:\\Files\\hello world.txt", name: "hello world.txt", extension: "txt", mimeType: "text/plain",
  detectedType: "Text document", handlerId: "text", size: 4, createdMs: null, modifiedMs: 1, readonly: false,
};

describe("workspace", () => {
  beforeEach(() => {
    detectFile.mockReset().mockResolvedValue(descriptor);
    useWorkspace.setState({ tabs: [], closed: [], activeId: null, busy: false, error: null });
  });

  it("does not open duplicate tabs", async () => {
    await useWorkspace.getState().openPaths([descriptor.path, descriptor.path.toUpperCase()]);
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(detectFile).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent duplicate requests", async () => {
    let resolve!: (value: FileDescriptor) => void;
    detectFile.mockReturnValue(new Promise<FileDescriptor>((done) => { resolve = done; }));
    const first = useWorkspace.getState().openPaths([descriptor.path]);
    const second = useWorkspace.getState().openPaths([descriptor.path]);
    resolve(descriptor);
    await Promise.all([first, second]);
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(detectFile).toHaveBeenCalledTimes(1);
  });

  it("keeps errors scoped to the workspace", async () => {
    detectFile.mockRejectedValueOnce(new Error("Missing file"));
    await useWorkspace.getState().openPaths(["missing.txt"]);
    expect(useWorkspace.getState().error).toBe("Missing file");
    expect(useWorkspace.getState().tabs).toHaveLength(0);
  });
});

describe("renaming a tab", () => {
  beforeEach(() => {
    renameFile.mockReset();
    useWorkspace.setState({ tabs: [], closed: [], activeId: null, busy: false, error: null });
  });

  const open = (dirty: boolean) => {
    useWorkspace.setState({
      tabs: [{ id: "t1", file: descriptor, dirty, status: "", loadKey: 1 }],
      activeId: "t1",
    });
  };

  it("swaps in the descriptor the command returns and remounts the viewer", async () => {
    open(false);
    const before = useWorkspace.getState().tabs[0].loadKey;
    const renamed = { ...descriptor, path: "C:\\Files\\notes.md", name: "notes.md", extension: "md" };
    renameFile.mockResolvedValue(renamed);
    await useWorkspace.getState().renameTab("t1", "notes.md");
    const tab = useWorkspace.getState().tabs[0];
    expect(renameFile).toHaveBeenCalledWith(descriptor.path, "notes.md");
    expect(tab.file).toEqual(renamed);
    expect(tab.loadKey).not.toBe(before);
  });

  it("refuses a dirty tab, because remounting would discard the edit", async () => {
    open(true);
    await expect(useWorkspace.getState().renameTab("t1", "notes.md")).rejects.toThrow(/unsaved changes/);
    expect(renameFile).not.toHaveBeenCalled();
  });

  it("refuses a tab that has since been closed", async () => {
    await expect(useWorkspace.getState().renameTab("gone", "notes.md")).rejects.toThrow(/no longer open/);
    expect(renameFile).not.toHaveBeenCalled();
  });

  it("leaves the tab untouched when the command fails", async () => {
    open(false);
    renameFile.mockRejectedValue(new Error("destination exists"));
    await expect(useWorkspace.getState().renameTab("t1", "taken.txt")).rejects.toThrow("destination exists");
    expect(useWorkspace.getState().tabs[0].file).toEqual(descriptor);
  });
});

describe("handler overrides", () => {
  beforeEach(() => {
    useWorkspace.setState({ tabs: [], closed: [], activeId: null, busy: false, error: null });
    useSettings.setState({ ...settingsDefaults, handlerOverrides: {} });
  });

  it("routes an opened file to the overridden viewer", async () => {
    detectFile.mockResolvedValue({ ...descriptor, path: "D:/files/data.json", name: "data.json", extension: "json", handlerId: "structured" });
    useSettings.setState({ handlerOverrides: { json: "text" } });
    await useWorkspace.getState().openPaths(["D:/files/data.json"]);
    expect(useWorkspace.getState().tabs[0].file.handlerId).toBe("text");
  });

  it("leaves the detected viewer alone with no override", async () => {
    detectFile.mockResolvedValue({ ...descriptor, path: "D:/files/data.json", name: "data.json", extension: "json", handlerId: "structured" });
    await useWorkspace.getState().openPaths(["D:/files/data.json"]);
    expect(useWorkspace.getState().tabs[0].file.handlerId).toBe("structured");
  });

  it("does not let an override redirect a format that was never on offer", async () => {
    detectFile.mockResolvedValue({ ...descriptor, path: "D:/files/doc.pdf", name: "doc.pdf", extension: "pdf", handlerId: "pdf" });
    useSettings.setState({ handlerOverrides: { pdf: "text" } });
    await useWorkspace.getState().openPaths(["D:/files/doc.pdf"]);
    expect(useWorkspace.getState().tabs[0].file.handlerId).toBe("pdf");
  });
});
