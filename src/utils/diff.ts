import type { FileDescriptor } from "../types/files";

export type Slot = "a" | "b";

/** Handlers whose files decode to text, so a line-by-line comparison means something. */
const COMPARABLE = new Set(["text", "sql", "structured", "csv"]);

export interface PairCheck {
  ready: boolean;
  /** Why the pair cannot be compared, or null when it can. */
  problem: string | null;
  /** A caution that does not prevent comparing. */
  warning: string | null;
}

/**
 * Decides whether two chosen files can be compared, and says why not when they
 * cannot. Binary formats are refused rather than rendered as mojibake.
 */
export function checkPair(a: FileDescriptor | null, b: FileDescriptor | null): PairCheck {
  if (!a || !b) {
    return { ready: false, problem: null, warning: null };
  }
  const unreadable = [a, b].filter((file) => !COMPARABLE.has(file.handlerId));
  if (unreadable.length > 0) {
    const names = unreadable.map((file) => file.name).join(" and ");
    return {
      ready: false,
      problem: `${names} ${unreadable.length === 1 ? "is" : "are"} not text, so a line comparison would not be meaningful.`,
      warning: null,
    };
  }
  if (samePath(a.path, b.path)) {
    return { ready: false, problem: "Both sides are the same file.", warning: null };
  }
  if (a.extension !== b.extension) {
    return {
      ready: true,
      problem: null,
      warning: `Comparing a .${a.extension ?? "?"} with a .${b.extension ?? "?"}.`,
    };
  }
  return { ready: true, problem: null, warning: null };
}

function samePath(left: string, right: string): boolean {
  const clean = (value: string) => value.replace(/^\\\\\?\\/, "").toLocaleLowerCase();
  return clean(left) === clean(right);
}

export interface SizeDelta { bytes: number; percent: number | null; direction: "grew" | "shrank" | "same" }

/** The size change from the base to the target, before anything is parsed. */
export function sizeDelta(a: FileDescriptor, b: FileDescriptor): SizeDelta {
  const bytes = b.size - a.size;
  const percent = a.size > 0 ? (bytes / a.size) * 100 : null;
  return { bytes, percent, direction: bytes > 0 ? "grew" : bytes < 0 ? "shrank" : "same" };
}

/** Files already open, offered as a one-click source for either side. */
export function openFileChoices(
  files: FileDescriptor[],
  taken: (FileDescriptor | null)[],
): FileDescriptor[] {
  const used = new Set(taken.filter(Boolean).map((file) => file!.path.toLocaleLowerCase()));
  return files.filter((file) => COMPARABLE.has(file.handlerId) && !used.has(file.path.toLocaleLowerCase()));
}
