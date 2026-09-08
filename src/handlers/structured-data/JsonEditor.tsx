import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";

interface Props {
  initial: string;
  readonly: boolean;
  language: "json" | "xml";
  onChange: (text: string) => void;
  onCursor: (line: number, column: number) => void;
}

/**
 * The raw-code editor. It is mounted fresh whenever the buffer is reset, so the
 * parent can hold the text and this only reports changes upward.
 */
export function JsonEditor({ initial, readonly, language, onChange, onCursor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const emitChange = useRef(onChange);
  const emitCursor = useRef(onCursor);
  emitChange.current = onChange;
  emitCursor.current = onCursor;

  useEffect(() => {
    let disposed = false;
    const load = language === "json"
      ? import("@codemirror/lang-json").then((module) => module.json())
      : import("@codemirror/lang-xml").then((module) => module.xml());
    void load.then((support) => {
      if (disposed || !host.current) return;
      const extensions: Extension[] = [
        lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), history(),
        bracketMatching(), syntaxHighlighting(defaultHighlightStyle), search(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        support,
        EditorView.editable.of(!readonly),
        EditorState.readOnly.of(readonly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emitChange.current(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const line = update.state.doc.lineAt(update.state.selection.main.head);
            emitCursor.current(line.number, update.state.selection.main.head - line.from + 1);
          }
        }),
      ];
      view.current = new EditorView({
        state: EditorState.create({ doc: initial, extensions }),
        parent: host.current,
      });
    });
    return () => {
      disposed = true;
      view.current?.destroy();
      view.current = null;
    };
    // `initial` is intentionally excluded: the parent remounts with a new key to reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readonly]);

  return <div className="json-editor-host" ref={host} />;
}
