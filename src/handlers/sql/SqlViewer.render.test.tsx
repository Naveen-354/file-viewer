import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { metadata, saveText, saveTextAs, openSystem, showInFolder, settings, updateSettings, readChunk } =
  vi.hoisted(() => ({
    metadata: vi.fn(),
    saveText: vi.fn(),
    saveTextAs: vi.fn(),
    openSystem: vi.fn(),
    showInFolder: vi.fn(),
    settings: vi.fn(),
    updateSettings: vi.fn(),
    readChunk: vi.fn(),
  }));

vi.mock("../../services/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/tauri")>()),
  api: { metadata, saveText, saveTextAs, openSystem, showInFolder, settings, updateSettings, readChunk },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

const { readBytes } = vi.hoisted(() => ({ readBytes: vi.fn() }));
vi.mock("../../utils/file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/file")>()),
  readBytes,
}));

import SqlViewer from "./SqlViewer";
import type { FileDescriptor } from "../../types/files";

const SCRIPT = `-- Schema definition
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TYPE user_role AS ENUM ('admin', 'member');

CREATE TABLE app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_users_email ON app_users(email);

CREATE TABLE user_sessions (
  session_token VARCHAR(64) PRIMARY KEY
);

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON app_users;
`;

const file: FileDescriptor = {
  path: "C:\\projects\\db\\schema.sql", name: "schema.sql", extension: "sql", mimeType: "application/sql",
  detectedType: "SQL script", handlerId: "sql", size: 15155, createdMs: null, modifiedMs: 1000, readonly: false,
};

function mount(overrides: Partial<FileDescriptor> = {}, script = SCRIPT) {
  readBytes.mockResolvedValue(new TextEncoder().encode(script));
  metadata.mockResolvedValue({ ...file, modifiedMs: 1000 });
  return render(
    <SqlViewer file={{ ...file, ...overrides }} tabId="t1" onStatusChange={() => {}} onDirtyChange={() => {}} />,
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("sql viewer", () => {
  it("lists the objects the script creates, grouped and counted", async () => {
    mount();
    const outline = await screen.findByLabelText("Schema outline");
    await waitFor(() => expect(within(outline).getByText("app_users")).toBeTruthy());
    expect(within(outline).getByText("user_sessions")).toBeTruthy();
    expect(within(outline).getByText("idx_users_email")).toBeTruthy();
    expect(within(outline).getByText("trg_users_updated")).toBeTruthy();
    expect(within(outline).getByText("pgcrypto")).toBeTruthy();
    expect(outline.textContent).toContain("Tables");
  });

  it("reports the detected dialect and says what gave it away", async () => {
    mount();
    const inspector = await screen.findByLabelText("File inspector");
    await waitFor(() => expect(inspector.textContent).toContain("PostgreSQL"));
    expect(screen.getByTitle(/Guessed from/)).toBeTruthy();
  });

  it("says the dialect is not identifiable rather than guessing on portable SQL", async () => {
    mount({}, "CREATE TABLE t (id INT);\n");
    const inspector = await screen.findByLabelText("File inspector");
    await waitFor(() => expect(inspector.textContent).toContain("Not identifiable"));
    expect(inspector.textContent).not.toContain("PostgreSQL");
  });

  it("shows an empty outline for a script that creates nothing", async () => {
    mount({}, "SELECT 1;\n");
    const outline = await screen.findByLabelText("Schema outline");
    await waitFor(() => expect(outline.textContent).toContain("does not create any objects"));
  });

  it("opens a large script read-only and disables saving", async () => {
    mount({ size: 20 * 1024 * 1024 });
    await waitFor(() => expect(screen.getByText(/larger than 8 MiB/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /^Save Ctrl\+S$/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Format SQL/ })).toHaveProperty("disabled", true);
  });

  it("offers reload or keep-my-changes when the file changes on disk", async () => {
    vi.useFakeTimers();
    mount();
    await vi.waitFor(() => expect(readBytes).toHaveBeenCalled());
    metadata.mockResolvedValue({ ...file, modifiedMs: 2000 });
    await vi.advanceTimersByTimeAsync(3100);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText(/was modified outside OneOpen/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Reload from disk" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
    expect(screen.queryByText(/was modified outside OneOpen/)).toBeNull();
  });

  it("highlights the script, so the SQL language mode is actually attached", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    // Highlighted keywords get a token class; plain text would produce none.
    // CodeMirror emits generated class names, so tokenisation is checked by
    // asserting a keyword and a string literal get *different* classes.
    await waitFor(() => expect(container.querySelectorAll(".cm-line span").length).toBeGreaterThan(0));
    const spans = [...container.querySelectorAll<HTMLElement>(".cm-line span")];
    const keyword = spans.find((span) => span.textContent === "CREATE");
    const literal = spans.find((span) => span.textContent === "'admin'");
    const comment = spans.find((span) => span.textContent?.startsWith("-- Schema"));
    expect(keyword).toBeTruthy();
    expect(literal).toBeTruthy();
    expect(comment).toBeTruthy();
    expect(keyword!.className).not.toBe(literal!.className);
    expect(keyword!.className).not.toBe(comment!.className);
  });

  it("opens the custom find bar above the code, not CodeMirror's stock panel", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Find/ }));

    const bar = await waitFor(() => {
      const found = container.querySelector(".find-bar");
      if (!found) throw new Error("no find bar");
      return found;
    });
    // The stock panel puts its inputs in a plain form with no counter.
    expect(bar.querySelector(".find-count")).toBeTruthy();
    expect(within(bar as HTMLElement).getByLabelText("Match case")).toBeTruthy();
    expect(within(bar as HTMLElement).getByLabelText("Regular expression")).toBeTruthy();
    expect(container.querySelector(".cm-panels-top")?.contains(bar)).toBe(true);
    expect(container.querySelector(".cm-panels-bottom")).toBeNull();
  });

  it("counts matches as the query is typed", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Find/ }));
    const input = await screen.findByLabelText("Find");
    fireEvent.input(input, { target: { value: "CREATE" } });
    // Nothing is selected yet, so the bar reports the total, not "1 of 6".
    await waitFor(() => expect(container.querySelector(".find-count")?.textContent).toBe("6 found"));
    fireEvent.click(screen.getByLabelText("Next match"));
    await waitFor(() => expect(container.querySelector(".find-count")?.textContent).toBe("1 of 6"));
    fireEvent.click(screen.getByLabelText("Next match"));
    await waitFor(() => expect(container.querySelector(".find-count")?.textContent).toBe("2 of 6"));
    fireEvent.input(input, { target: { value: "nothing_here" } });
    await waitFor(() => expect(container.querySelector(".find-count")?.textContent).toBe("No results"));
  });

  it("says the pattern is invalid rather than throwing on a half-typed regexp", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Find/ }));
    fireEvent.click(await screen.findByLabelText("Regular expression"));
    fireEvent.input(screen.getByLabelText("Find"), { target: { value: "(unclosed" } });
    await waitFor(() => expect(container.querySelector(".find-count")?.textContent).toBe("Invalid pattern"));
  });

  it("surfaces the read failure instead of an empty editor", async () => {
    readBytes.mockRejectedValue(new Error("file is gone"));
    metadata.mockResolvedValue(file);
    render(<SqlViewer file={file} tabId="t1" onStatusChange={() => {}} onDirtyChange={() => {}} />);
    expect(await screen.findByText("file is gone")).toBeTruthy();
  });
});
