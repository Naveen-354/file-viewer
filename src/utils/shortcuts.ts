/**
 * OneOpen's keyboard shortcuts.
 *
 * The global ones are the single source of truth: `App.tsx` matches incoming
 * events against `GLOBAL_SHORTCUTS`, and the settings page lists the same
 * array, so the documentation cannot drift from the behaviour.
 *
 * The rest are handled inside individual viewers or by CodeMirror. Those are
 * described here rather than dispatched here, so each entry names the module
 * that implements it and can be checked against it.
 */

/** Ids of the shortcuts the shell dispatches. A literal union so the handler
 *  map in `App.tsx` must cover every one of them or the build fails. */
export type ShortcutId = "open" | "palette" | "reopen" | "close" | "rename" | "settings";

export interface GlobalShortcut {
  id: ShortcutId;
  keys: string[];
  label: string;
  detail: string;
  /** True when this event should fire this shortcut. */
  matches: (event: KeyboardEvent) => boolean;
  /** Some shortcuts only mean something with a file open. */
  needsActiveTab: boolean;
}

const mod = (event: KeyboardEvent) => event.ctrlKey || event.metaKey;
const letter = (event: KeyboardEvent, value: string) => event.key.toLowerCase() === value;

export const GLOBAL_SHORTCUTS: GlobalShortcut[] = [
  {
    id: "open",
    keys: ["Ctrl", "O"],
    label: "Open file",
    detail: "Opens the system file picker. Several files can be chosen at once.",
    matches: (event) => mod(event) && !event.shiftKey && letter(event, "o"),
    needsActiveTab: false,
  },
  {
    id: "palette",
    keys: ["Ctrl", "P"],
    label: "Command palette",
    detail: "Opens the command list: open a file, reopen a closed tab, switch theme.",
    matches: (event) => mod(event) && !event.shiftKey && letter(event, "p"),
    needsActiveTab: false,
  },
  {
    id: "reopen",
    keys: ["Ctrl", "Shift", "T"],
    label: "Reopen closed tab",
    detail: "Reopens the most recently closed tab. The last ten are remembered.",
    matches: (event) => mod(event) && event.shiftKey && letter(event, "t"),
    needsActiveTab: false,
  },
  {
    id: "close",
    keys: ["Ctrl", "W"],
    label: "Close tab",
    detail: "Closes the active tab, asking first when it has unsaved changes.",
    matches: (event) => mod(event) && !event.shiftKey && letter(event, "w"),
    needsActiveTab: true,
  },
  {
    id: "rename",
    keys: ["F2"],
    label: "Rename file",
    detail: "Renames the open file on disk. Refused while the tab has unsaved changes.",
    matches: (event) => event.key === "F2",
    needsActiveTab: true,
  },
  {
    id: "settings",
    keys: ["Ctrl", ","],
    label: "Settings",
    detail: "Opens this settings page.",
    matches: (event) => mod(event) && event.key === ",",
    needsActiveTab: false,
  },
];

export interface ShortcutRow {
  keys: string[][];
  label: string;
  detail: string;
  where: string;
}

export interface ShortcutGroup {
  scope: string;
  note: string;
  rows: ShortcutRow[];
}

const single = (...keys: string[]) => [keys];

/**
 * Shortcuts owned by a viewer or by CodeMirror. Each row names the module that
 * implements it so the claim can be re-checked against the code.
 */
export const SCOPED_SHORTCUTS: ShortcutGroup[] = [
  {
    scope: "Editors",
    note: "Text, SQL and JSON editing surfaces.",
    rows: [
      { keys: single("Ctrl", "S"), label: "Save", detail: "Writes the file, refusing if it changed on disk since it was opened.", where: "TextViewer, SqlViewer" },
      { keys: single("Ctrl", "F"), label: "Find", detail: "Opens the search panel, with case, whole-word and regex toggles.", where: "@codemirror/search" },
      { keys: single("Ctrl", "Z"), label: "Undo", detail: "Steps back through the edit history.", where: "@codemirror/commands" },
      { keys: [["Ctrl", "Y"], ["Ctrl", "Shift", "Z"]], label: "Redo", detail: "Steps forward again.", where: "@codemirror/commands" },
      { keys: single("Tab"), label: "Indent", detail: "Indents the selection rather than moving focus out of the editor.", where: "indentWithTab" },
    ],
  },
  {
    scope: "Spreadsheet",
    note: "The grid must have focus.",
    rows: [
      { keys: single("↑", "↓", "←", "→"), label: "Move selection", detail: "Moves the selected cell.", where: "SpreadsheetViewer" },
      { keys: [["Enter"], ["F2"]], label: "Edit cell", detail: "Starts editing the selected cell.", where: "SpreadsheetViewer" },
      { keys: [["Delete"], ["Backspace"]], label: "Clear cell", detail: "Empties the selected cell.", where: "SpreadsheetViewer" },
      { keys: single("Enter"), label: "Commit and move down", detail: "While editing, saves the cell and selects the one below.", where: "SpreadsheetViewer" },
      { keys: single("Tab"), label: "Commit and move right", detail: "While editing, saves the cell and selects the one to the right.", where: "SpreadsheetViewer" },
      { keys: single("Esc"), label: "Cancel edit", detail: "Discards the cell edit in progress.", where: "SpreadsheetViewer" },
      { keys: single("Ctrl", "S"), label: "Save workbook", detail: "Writes pending cell edits back into the .xlsx.", where: "SpreadsheetViewer" },
    ],
  },
  {
    scope: "PDF",
    note: "Available while the PDF viewer has focus.",
    rows: [
      { keys: single("Ctrl", "S"), label: "Save annotations", detail: "Only while edit mode is on.", where: "PdfViewer" },
      { keys: single("Enter"), label: "Run search", detail: "Searches from the PDF search box.", where: "PdfViewer" },
      { keys: single("Ctrl", "Enter"), label: "Commit text box", detail: "Finishes the annotation being typed.", where: "pdf/TextEditor" },
      { keys: single("Esc"), label: "Cancel text box", detail: "Abandons the annotation being typed.", where: "pdf/TextEditor" },
    ],
  },
  {
    scope: "Dialogs",
    note: "Rename, command palette, column filters.",
    rows: [
      { keys: single("Enter"), label: "Confirm", detail: "Applies the dialog's action.", where: "RenameDialog, CommandPalette, FilterMenu" },
      { keys: single("Esc"), label: "Dismiss", detail: "Closes without applying.", where: "RenameDialog, CommandPalette, FilterMenu" },
    ],
  },
];

/** Total number of documented bindings, counting each alternative once. */
export function shortcutCount(): number {
  const scoped = SCOPED_SHORTCUTS.reduce((sum, group) => sum + group.rows.length, 0);
  return GLOBAL_SHORTCUTS.length + scoped;
}

/** Case-insensitive match over the label, detail and printed keys. */
export function matchesQuery(query: string, label: string, detail: string, keys: string[][]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const printed = keys.map((combo) => combo.join("+")).join(" ").toLowerCase();
  return label.toLowerCase().includes(needle)
    || detail.toLowerCase().includes(needle)
    || printed.includes(needle);
}
