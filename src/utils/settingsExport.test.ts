import { describe, expect, it } from "vitest";
import { toToml } from "./settingsExport";
import { defaults } from "../stores/settings";

describe("settings export", () => {
  it("writes each group as a TOML table", () => {
    const toml = toToml(defaults);
    for (const table of ["[appearance]", "[workspace]", "[typography]", "[editing]"]) {
      expect(toml).toContain(table);
    }
    expect(toml).toContain('theme = "system"');
    expect(toml).toContain("editor_font_size = 13");
    expect(toml).toContain("ligatures = true");
  });

  it("says up front that the file cannot be imported back", () => {
    expect(toToml(defaults)).toContain("cannot import this file back");
  });

  it("escapes a tab delimiter rather than writing a raw control character", () => {
    const toml = toToml({ ...defaults, csvDelimiter: "\t" });
    expect(toml).toContain('csv_delimiter = "\\t"');
    expect(toml).not.toContain("csv_delimiter = \"\t\"");
  });

  it("writes an unset delimiter as an empty string, not as null", () => {
    expect(toToml({ ...defaults, csvDelimiter: null })).toContain('csv_delimiter = ""');
  });

  it("escapes quotes and backslashes so the output stays parseable", () => {
    // Not reachable through the UI, but the writer must not produce broken TOML.
    const toml = toToml({ ...defaults, monoFont: 'we"ird\\name' });
    expect(toml).toContain('mono_font = "we\\"ird\\\\name"');
  });
});
