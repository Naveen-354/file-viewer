import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { renameFile, detectFile, workspaces } = vi.hoisted(() => ({
  renameFile: vi.fn(),
  detectFile: vi.fn(),
  workspaces: vi.fn(),
}));
vi.mock("../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauri")>()),
  api: { renameFile, detectFile, workspaces },
}));

import { RenameDialog } from "./RenameDialog";
import { useWorkspace, type WorkspaceTab } from "../stores/workspace";
import { useWorkspaces } from "../stores/workspaces";
import type { FileDescriptor } from "../types/files";

const file: FileDescriptor = {
  path: "C:\\projects\\db\\schema.sql", name: "schema.sql", extension: "sql", mimeType: null,
  detectedType: "SQL script", handlerId: "sql", size: 100, createdMs: null, modifiedMs: 1, readonly: false,
};

const tab: WorkspaceTab = { id: "t1", file, dirty: false, status: "", loadKey: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  workspaces.mockResolvedValue([]);
  useWorkspace.setState({ tabs: [tab], activeId: "t1", closed: [], busy: false, error: null });
  useWorkspaces.setState({ items: [], activeId: null, loading: false });
});
afterEach(cleanup);

describe("rename dialog", () => {
  it("preselects the stem so typing keeps the extension", () => {
    render(<RenameDialog tab={tab} close={() => {}} />);
    const input = screen.getByLabelText(/New name/) as HTMLInputElement;
    expect(input.value).toBe("schema.sql");
    return waitFor(() => {
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe("schema".length);
    });
  });

  it("renames through the command and replaces the tab's file", async () => {
    const renamed = { ...file, path: "C:\\projects\\db\\tables.sql", name: "tables.sql" };
    renameFile.mockResolvedValue(renamed);
    const close = vi.fn();
    render(<RenameDialog tab={tab} close={close} />);
    fireEvent.change(screen.getByLabelText(/New name/), { target: { value: "tables.sql" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(renameFile).toHaveBeenCalledWith(file.path, "tables.sql");
    expect(useWorkspace.getState().tabs[0].file.name).toBe("tables.sql");
  });

  it("keeps the button disabled while the name is unchanged", () => {
    render(<RenameDialog tab={tab} close={() => {}} />);
    expect(screen.getByRole("button", { name: "Rename" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText(/New name/), { target: { value: "other.sql" } });
    expect(screen.getByRole("button", { name: "Rename" })).toHaveProperty("disabled", false);
  });

  it("warns before an extension change, because it swaps the viewer", () => {
    render(<RenameDialog tab={tab} close={() => {}} />);
    expect(screen.queryByText(/changes which viewer/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/New name/), { target: { value: "schema.txt" } });
    expect(screen.getByText(/changes which viewer/)).toBeTruthy();
  });

  it("refuses to rename a tab with unsaved changes rather than dropping the edit", () => {
    render(<RenameDialog tab={{ ...tab, dirty: true }} close={() => {}} />);
    expect(screen.getByText(/unsaved changes/)).toBeTruthy();
    expect(screen.queryByLabelText(/New name/)).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toHaveProperty("disabled", true);
  });

  it("shows the failure and stays open when the name is taken", async () => {
    renameFile.mockRejectedValue(new Error("tables.sql already exists in this folder"));
    const close = vi.fn();
    render(<RenameDialog tab={tab} close={close} />);
    fireEvent.change(screen.getByLabelText(/New name/), { target: { value: "tables.sql" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("tables.sql already exists in this folder")).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    expect(useWorkspace.getState().tabs[0].file.name).toBe("schema.sql");
  });

  it("reloads workspaces so a renamed pin points at the new path", async () => {
    renameFile.mockResolvedValue({ ...file, name: "tables.sql", path: "C:\\projects\\db\\tables.sql" });
    render(<RenameDialog tab={tab} close={() => {}} />);
    fireEvent.change(screen.getByLabelText(/New name/), { target: { value: "tables.sql" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(workspaces).toHaveBeenCalled());
  });
});
