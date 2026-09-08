import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDescriptor } from "../types/files";

const { readChunk } = vi.hoisted(() => ({ readChunk: vi.fn() }));
vi.mock("../services/tauri", () => ({ api: { readChunk } }));

import { useWorkspace } from "../stores/workspace";
import { ViewerHost } from "./ViewerHost";

const file: FileDescriptor = {
  path: "C:\\fixture.bin", name: "fixture.bin", extension: "bin", mimeType: "application/octet-stream",
  detectedType: "Unknown binary file", handlerId: "fallback", size: 2, createdMs: null, modifiedMs: null, readonly: false,
};

function Harness() {
  const tab = useWorkspace((state) => state.tabs[0]);
  return tab ? <ViewerHost tab={tab} /> : null;
}

describe("ViewerHost", () => {
  beforeEach(() => {
    readChunk.mockReset().mockResolvedValue({ offset: 0, bytes: [1, 2], text: null, encoding: null, eof: true });
    const tab = { id: "viewer-test", file, dirty: false, status: "", loadKey: 1 };
    useWorkspace.setState({ tabs: [tab], activeId: tab.id, closed: [], busy: false, error: null });
    performance.mark(`preview-${tab.id}`);
  });

  it("does not reload a viewer when its status changes", async () => {
    render(<Harness />);
    await waitFor(() => expect(useWorkspace.getState().tabs[0].status).toBe("256-byte hex preview"), { timeout: 10_000 });
    expect(readChunk).toHaveBeenCalledTimes(1);
  }, 15_000);
});
