// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { mapCommandError } from "./tauri";

describe("Tauri error mapping", () => {
  beforeEach(() => invoke.mockReset());

  it("maps structured Rust errors", async () => {
    const mapped = mapCommandError({ code: "permission_denied", message: "Access denied", details: "readonly" });
    expect({ code: mapped.code, message: mapped.message, details: mapped.details }).toEqual({ code: "permission_denied", message: "Access denied", details: "readonly" });
  });
});
