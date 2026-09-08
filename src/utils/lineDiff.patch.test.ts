import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffLines, endsWithNewline, toPatch } from "./lineDiff";

/**
 * Asserting a patch "contains -old" only checks the shape. These tests hand the
 * output to git, which is the tool that has to accept it, and check it applies
 * cleanly and produces exactly the target file.
 */
const plain = { ignoreWhitespace: false, ignoreCase: false };
let dir = "";

const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/**
 * Decided at collection time, because `it.runIf` is evaluated then — checking
 * this inside `beforeAll` would leave the flag true and the tests would fail
 * rather than skip on a machine with no git.
 */
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => {
  if (!hasGit) return;
  dir = mkdtempSync(join(tmpdir(), "oneopen-patch-"));
  git(["init", "-q", "."]);
  // Windows checkout conversion would rewrite the endings under assertion.
  git(["config", "core.autocrlf", "false"]);
  git(["config", "core.eol", "lf"]);
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function roundTrip(before: string, after: string): string {
  writeFileSync(join(dir, "file.txt"), before);
  const patch = toPatch(diffLines(before, after, plain).rows, "file.txt", "file.txt",
    { left: endsWithNewline(before), right: endsWithNewline(after) });
  writeFileSync(join(dir, "change.patch"), patch);
  git(["apply", "--verbose", "change.patch"]);
  return readFileSync(join(dir, "file.txt"), "utf8");
}

describe("patch output is what git accepts", () => {
  it.runIf(hasGit)("applies a single-line change and yields the target exactly", () => {
    const before = "a\nb\nold\nd\ne\n";
    const after = "a\nb\nnew\nd\ne\n";
    expect(roundTrip(before, after)).toBe(after);
  });

  it.runIf(hasGit)("applies an insertion", () => {
    const before = "one\ntwo\nthree\nfour\nfive\n";
    const after = "one\ntwo\ninserted\nthree\nfour\nfive\n";
    expect(roundTrip(before, after)).toBe(after);
  });

  it.runIf(hasGit)("applies a deletion", () => {
    const before = "one\ntwo\ngone\nthree\nfour\n";
    const after = "one\ntwo\nthree\nfour\n";
    expect(roundTrip(before, after)).toBe(after);
  });

  it.runIf(hasGit)("applies two hunks far apart in one patch", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const changed = [...lines];
    changed[3] = "top change";
    changed[36] = "bottom change";
    const before = `${lines.join("\n")}\n`;
    const after = `${changed.join("\n")}\n`;
    expect(roundTrip(before, after)).toBe(after);
  });

  it.runIf(hasGit)("applies a change on the very first line", () => {
    const before = "first\nsecond\nthird\n";
    const after = "CHANGED\nsecond\nthird\n";
    expect(roundTrip(before, after)).toBe(after);
  });
});
