import { beforeEach, describe, expect, it, vi } from "vitest";

const { pinFile, unpinFile } = vi.hoisted(() => ({ pinFile: vi.fn(), unpinFile: vi.fn() }));
vi.mock("../services/tauri", () => ({ api: { pinFile, unpinFile } }));

import { useWorkspaces } from "./workspaces";
import type { Workspace } from "../types/files";

const workspace: Workspace = {
  id: "ws-1",
  name: "Local files",
  folders: [],
  pinnedFiles: [{ path: "C:\\notes\\a.txt", name: "a.txt", exists: true }],
  restoreLastSession: true,
  lastOpenedMs: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaces.setState({ items: [workspace], activeId: "ws-1", loading: false });
});

describe("workspace pins", () => {
  it("pins a file that is not pinned yet and keeps the returned list", async () => {
    const pins = [...workspace.pinnedFiles, { path: "C:\\notes\\b.txt", name: "b.txt", exists: true }];
    pinFile.mockResolvedValue(pins);
    await useWorkspaces.getState().togglePin("C:\\notes\\b.txt");
    expect(pinFile).toHaveBeenCalledWith("ws-1", "C:\\notes\\b.txt");
    expect(useWorkspaces.getState().items[0].pinnedFiles).toEqual(pins);
  });

  it("unpins using the spelling the workspace stored, not the tab's verbatim path", async () => {
    unpinFile.mockResolvedValue([]);
    await useWorkspaces.getState().togglePin("\\\\?\\C:\\notes\\a.txt");
    expect(unpinFile).toHaveBeenCalledWith("ws-1", "C:\\notes\\a.txt");
    expect(pinFile).not.toHaveBeenCalled();
    expect(useWorkspaces.getState().items[0].pinnedFiles).toEqual([]);
  });

  it("does nothing when no workspace is selected, because pins belong to one", async () => {
    useWorkspaces.setState({ activeId: null });
    await useWorkspaces.getState().togglePin("C:\\notes\\b.txt");
    expect(pinFile).not.toHaveBeenCalled();
    expect(unpinFile).not.toHaveBeenCalled();
  });

  it("leaves other workspaces untouched", async () => {
    const other: Workspace = { ...workspace, id: "ws-2", pinnedFiles: [] };
    useWorkspaces.setState({ items: [workspace, other] });
    pinFile.mockResolvedValue([]);
    await useWorkspaces.getState().togglePin("C:\\notes\\b.txt");
    expect(useWorkspaces.getState().items[1]).toBe(other);
  });
});
