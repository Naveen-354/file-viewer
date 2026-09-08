import type { EditorState } from "@codemirror/state";
import type { EditorView, Panel } from "@codemirror/view";
import {
  closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext,
  SearchQuery, setSearchQuery,
} from "@codemirror/search";

/**
 * Counting stops here on a huge file. The exact total past this point is not
 * worth a full scan on every keystroke, so the counter shows `1000+` instead.
 */
const MAX_MATCHES = 1000;

export interface MatchCount { index: number; total: number; capped: boolean }

/**
 * How many matches the query has, and which one the selection is sitting on.
 *
 * CodeMirror's own panel shows no count, so this walks the query's cursor —
 * the same cursor the search commands use, so the numbers always agree with
 * what `findNext` does.
 */
export function countMatches(state: EditorState, query: SearchQuery): MatchCount {
  if (!query.valid) return { index: 0, total: 0, capped: false };
  const cursor = query.getCursor(state);
  const selection = state.selection.main;
  let total = 0;
  let index = 0;
  for (;;) {
    const next = cursor.next();
    if (next.done) break;
    total += 1;
    if (next.value.from === selection.from && next.value.to === selection.to) index = total;
    if (total >= MAX_MATCHES) return { index, total, capped: true };
  }
  return { index, total, capped: false };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function iconButton(className: string, label: string, glyph: string): HTMLButtonElement {
  const button = element("button", className, { type: "button", "aria-label": label, title: label });
  button.textContent = glyph;
  return button;
}

/**
 * A find bar that replaces CodeMirror's stock panel.
 *
 * It is still a real search panel rather than a floating React overlay: the
 * search extension only paints match highlights while a panel is registered, so
 * a hand-rolled overlay would silently lose them.
 */
export function createFindPanel(view: EditorView): Panel {
  const dom = element("div", "cm-search find-bar");
  const row = element("div", "find-row");
  const replaceRow = element("div", "find-row find-replace-row");
  replaceRow.hidden = true;

  const field = element("input", "find-input", {
    type: "text",
    placeholder: "Find in script",
    "main-field": "true",
    "aria-label": "Find",
  });
  const counter = element("span", "find-count");
  const caseToggle = iconButton("find-toggle", "Match case", "Aa");
  const wordToggle = iconButton("find-toggle", "Whole word", "ab|");
  const regexToggle = iconButton("find-toggle", "Regular expression", ".*");
  const previous = iconButton("find-step", "Previous match", "↑");
  const next = iconButton("find-step", "Next match", "↓");
  const toggleReplace = iconButton("find-step find-expand", "Show replace", "⇅");
  const close = iconButton("find-step", "Close find", "✕");

  const replaceField = element("input", "find-input", {
    type: "text",
    placeholder: "Replace with",
    "aria-label": "Replace with",
  });
  const replaceOne = element("button", "find-action", { type: "button" });
  replaceOne.textContent = "Replace";
  const replaceEvery = element("button", "find-action", { type: "button" });
  replaceEvery.textContent = "Replace all";

  row.append(field, counter, caseToggle, wordToggle, regexToggle, previous, next, toggleReplace, close);
  replaceRow.append(replaceField, replaceOne, replaceEvery);
  dom.append(row, replaceRow);

  let query = getSearchQuery(view.state);

  const paint = () => {
    field.value = query.search;
    replaceField.value = query.replace;
    caseToggle.classList.toggle("on", query.caseSensitive);
    caseToggle.setAttribute("aria-pressed", String(query.caseSensitive));
    wordToggle.classList.toggle("on", query.wholeWord);
    wordToggle.setAttribute("aria-pressed", String(query.wholeWord));
    regexToggle.classList.toggle("on", query.regexp);
    regexToggle.setAttribute("aria-pressed", String(query.regexp));
    field.classList.toggle("invalid", query.search !== "" && !query.valid);

    if (query.search === "") {
      counter.textContent = "";
    } else if (!query.valid) {
      // A half-typed regular expression is not an error worth shouting about.
      counter.textContent = "Invalid pattern";
    } else {
      const { index, total, capped } = countMatches(view.state, query);
      const suffix = capped ? "+" : "";
      // Until the cursor is actually on a match there is no "current" one, so
      // the bar reports the total rather than implying it is sitting on the first.
      counter.textContent = total === 0
        ? "No results"
        : index
          ? `${index} of ${total}${suffix}`
          : `${total}${suffix} found`;
    }
  };

  const commit = (changes: Partial<{
    search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean;
  }>) => {
    query = new SearchQuery({
      search: changes.search ?? query.search,
      replace: changes.replace ?? query.replace,
      caseSensitive: changes.caseSensitive ?? query.caseSensitive,
      regexp: changes.regexp ?? query.regexp,
      wholeWord: changes.wholeWord ?? query.wholeWord,
      literal: query.literal,
    });
    view.dispatch({ effects: setSearchQuery.of(query) });
    paint();
  };

  field.addEventListener("input", () => commit({ search: field.value }));
  replaceField.addEventListener("input", () => commit({ replace: replaceField.value }));
  caseToggle.addEventListener("click", () => commit({ caseSensitive: !query.caseSensitive }));
  wordToggle.addEventListener("click", () => commit({ wholeWord: !query.wholeWord }));
  regexToggle.addEventListener("click", () => commit({ regexp: !query.regexp }));
  next.addEventListener("click", () => findNext(view));
  previous.addEventListener("click", () => findPrevious(view));
  replaceOne.addEventListener("click", () => replaceNext(view));
  replaceEvery.addEventListener("click", () => replaceAll(view));
  close.addEventListener("click", () => closeSearchPanel(view));
  toggleReplace.addEventListener("click", () => {
    replaceRow.hidden = !replaceRow.hidden;
    toggleReplace.classList.toggle("on", !replaceRow.hidden);
    toggleReplace.setAttribute("aria-label", replaceRow.hidden ? "Show replace" : "Hide replace");
    if (!replaceRow.hidden) replaceField.focus();
  });

  dom.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) findPrevious(view); else findNext(view);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
    }
  });

  return {
    dom,
    top: true,
    mount: paint,
    update: (update) => {
      const latest = getSearchQuery(update.state);
      const changed = !latest.eq(query);
      if (changed) query = latest;
      if (changed || update.docChanged || update.selectionSet) paint();
    },
  };
}
