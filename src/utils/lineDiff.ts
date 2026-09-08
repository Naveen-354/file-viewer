/**
 * Line-level comparison of two texts.
 *
 * Uses Myers' greedy algorithm, which is fast when the two sides are mostly
 * alike — the usual case for two versions of one file. Work is bounded so a
 * pathological pair cannot lock the window up; when a bound is hit the result
 * says so rather than quietly showing a partial answer.
 */

export interface DiffOptions {
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
}

export type RowKind = "same" | "added" | "removed" | "modified";

export interface DiffRow {
  kind: RowKind;
  /** 1-based line number on each side, or null where that side has no line. */
  leftNumber: number | null;
  rightNumber: number | null;
  left: string | null;
  right: string | null;
}

export interface DiffResult {
  rows: DiffRow[];
  additions: number;
  deletions: number;
  modifications: number;
  /** Row index where each run of changes begins, for prev/next navigation. */
  hunks: number[];
  identical: boolean;
  truncated: boolean;
  milliseconds: number;
}

/** Above this many lines on a side, only the first are compared. */
export const MAX_LINES = 20_000;

/**
 * A final newline terminates the last line rather than starting a new one, so
 * "a\n" is one line. Keeping the phantom empty line would put a context line
 * into every exported patch that the file does not actually have, and
 * `git apply` rejects the result.
 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Whether a text ends with a newline, which a patch has to state. */
export function endsWithNewline(text: string): boolean {
  return text === "" || /\n$/.test(text.replace(/\r\n?/g, "\n"));
}

/** The form a line is compared in; display always uses the original. */
export function normalise(line: string, options: DiffOptions): string {
  let value = line;
  if (options.ignoreWhitespace) value = value.replace(/\s+/g, " ").trim();
  if (options.ignoreCase) value = value.toLowerCase();
  return value;
}

type Edit = { kind: "same" | "remove" | "insert"; left?: number; right?: number };

/**
 * Myers' O(ND) diff. `D` is the number of edits, so this stays cheap while the
 * files remain similar and degrades gracefully when they do not.
 */
function myers(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) x = v[k + 1 + offset];
      else x = v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return backtrack(trace, a, b, max, offset);
}

function backtrack(trace: Int32Array[], a: string[], b: string[], d: number, offset: number): Edit[] {
  const edits: Edit[] = [];
  let x = a.length;
  let y = b.length;
  for (let depth = Math.min(d, trace.length - 1); depth >= 0; depth -= 1) {
    const v = trace[depth];
    const k = x - y;
    let previousK: number;
    if (k === -depth || (k !== depth && v[k - 1 + offset] < v[k + 1 + offset])) previousK = k + 1;
    else previousK = k - 1;
    const previousX = v[previousK + offset];
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      x -= 1; y -= 1;
      edits.push({ kind: "same", left: x, right: y });
    }
    if (depth === 0) break;
    if (x > previousX) { x -= 1; edits.push({ kind: "remove", left: x }); }
    else { y -= 1; edits.push({ kind: "insert", right: y }); }
  }
  return edits.reverse();
}

/**
 * Pairs a run of removed lines with the run of added lines that follows it, so
 * a changed line shows side by side instead of as a delete far from its insert.
 */
function toRows(edits: Edit[], a: string[], b: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < edits.length) {
    const edit = edits[index];
    if (edit.kind === "same") {
      rows.push({
        kind: "same",
        leftNumber: edit.left! + 1,
        rightNumber: edit.right! + 1,
        left: a[edit.left!],
        right: b[edit.right!],
      });
      index += 1;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (index < edits.length && edits[index].kind === "remove") { removed.push(edits[index].left!); index += 1; }
    while (index < edits.length && edits[index].kind === "insert") { added.push(edits[index].right!); index += 1; }

    const paired = Math.min(removed.length, added.length);
    for (let step = 0; step < paired; step += 1) {
      rows.push({
        kind: "modified",
        leftNumber: removed[step] + 1,
        rightNumber: added[step] + 1,
        left: a[removed[step]],
        right: b[added[step]],
      });
    }
    for (let step = paired; step < removed.length; step += 1) {
      rows.push({ kind: "removed", leftNumber: removed[step] + 1, rightNumber: null, left: a[removed[step]], right: null });
    }
    for (let step = paired; step < added.length; step += 1) {
      rows.push({ kind: "added", leftNumber: null, rightNumber: added[step] + 1, left: null, right: b[added[step]] });
    }
  }
  return rows;
}

export function diffLines(leftText: string, rightText: string, options: DiffOptions): DiffResult {
  const started = performance.now();
  const allLeft = splitLines(leftText);
  const allRight = splitLines(rightText);
  const truncated = allLeft.length > MAX_LINES || allRight.length > MAX_LINES;
  const a = truncated ? allLeft.slice(0, MAX_LINES) : allLeft;
  const b = truncated ? allRight.slice(0, MAX_LINES) : allRight;

  const keyA = a.map((line) => normalise(line, options));
  const keyB = b.map((line) => normalise(line, options));
  const rows = toRows(myers(keyA, keyB), a, b);

  let additions = 0;
  let deletions = 0;
  let modifications = 0;
  const hunks: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "added") additions += 1;
    else if (row.kind === "removed") deletions += 1;
    else if (row.kind === "modified") modifications += 1;
    if (row.kind !== "same" && (index === 0 || rows[index - 1].kind === "same")) hunks.push(index);
  });

  return {
    rows,
    additions,
    deletions,
    modifications,
    hunks,
    identical: additions === 0 && deletions === 0 && modifications === 0,
    truncated,
    milliseconds: performance.now() - started,
  };
}

/** Rows collapsed into a single column, the way a unified diff reads. */
export interface UnifiedRow { kind: RowKind; number: number | null; other: number | null; text: string }

export function toUnified(rows: DiffRow[]): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  for (const row of rows) {
    if (row.kind === "same") {
      out.push({ kind: "same", number: row.leftNumber, other: row.rightNumber, text: row.left ?? "" });
    } else if (row.kind === "removed") {
      out.push({ kind: "removed", number: row.leftNumber, other: null, text: row.left ?? "" });
    } else if (row.kind === "added") {
      out.push({ kind: "added", number: null, other: row.rightNumber, text: row.right ?? "" });
    } else {
      out.push({ kind: "removed", number: row.leftNumber, other: null, text: row.left ?? "" });
      out.push({ kind: "added", number: null, other: row.rightNumber, text: row.right ?? "" });
    }
  }
  return out;
}

/**
 * A unified patch, in the format `patch` and `git apply` expect.
 *
 * Context is fixed at three lines, which is the conventional default.
 */
export interface PatchEnds { left: boolean; right: boolean }

export function toPatch(
  rows: DiffRow[],
  leftName: string,
  rightName: string,
  ends: PatchEnds = { left: true, right: true },
  context = 3,
): string {
  const unified = toUnified(rows);
  const changed = unified
    .map((row, index) => (row.kind === "same" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return "";

  const groups: number[][] = [];
  for (const index of changed) {
    const last = groups[groups.length - 1];
    if (last && index - last[last.length - 1] <= context * 2) last.push(index);
    else groups.push([index]);
  }

  const lines = [`--- a/${leftName}`, `+++ b/${rightName}`];
  for (const group of groups) {
    const from = Math.max(0, group[0] - context);
    const to = Math.min(unified.length - 1, group[group.length - 1] + context);
    const slice = unified.slice(from, to + 1);

    const leftStart = firstNumber(slice, "left") ?? 0;
    const rightStart = firstNumber(slice, "right") ?? 0;
    const leftCount = slice.filter((row) => row.kind !== "added").length;
    const rightCount = slice.filter((row) => row.kind !== "removed").length;
    lines.push(`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`);
    for (let step = 0; step < slice.length; step += 1) {
      const row = slice[step];
      const marker = row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
      lines.push(`${marker}${row.text}`);
      // A side that does not end with a newline has to say so, or applying the
      // patch would silently add one.
      const isLastLine = from + step === unified.length - 1;
      const missing = (row.kind !== "added" && !ends.left) || (row.kind !== "removed" && !ends.right);
      if (isLastLine && missing) lines.push("\\ No newline at end of file");
    }
  }
  return `${lines.join("\n")}\n`;
}

function firstNumber(rows: UnifiedRow[], side: "left" | "right"): number | null {
  for (const row of rows) {
    if (side === "left" && row.kind !== "added") return row.number;
    if (side === "right" && row.kind !== "removed") return row.kind === "added" ? row.other : row.other;
  }
  return null;
}
