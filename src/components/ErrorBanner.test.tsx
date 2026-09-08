import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "../stores/workspace";
import { ErrorBanner } from "./ErrorBanner";

describe("ErrorBanner", () => {
  beforeEach(() => useWorkspace.setState({ error: "Cannot open file" }));
  it("shows and dismisses a recoverable error", () => {
    render(<ErrorBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot open file");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
