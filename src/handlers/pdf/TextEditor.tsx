import { useEffect, useRef, useState } from "react";
import { DEFAULT_STYLE, type FontFamily, type TextRun, type TextStyle } from "./editing";
import { CSS_FAMILY, cssFor, htmlFromRuns, runsFromElement } from "./richText";
import { Bold, Check, Italic, Strikethrough, Underline, X } from "lucide-react";

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];
const FAMILIES: { id: FontFamily; label: string }[] = [
  { id: "helvetica", label: "Helvetica" },
  { id: "times", label: "Times" },
  { id: "courier", label: "Courier" },
];

interface Props {
  initial: TextRun[];
  left: number;
  top: number;
  scale: number;
  onCommit: (runs: TextRun[]) => void;
  onCancel: () => void;
}

export function TextEditor({ initial, left, top, scale, onCommit, onCancel }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<TextStyle>(initial[0] ?? DEFAULT_STYLE);
  const committed = useRef(false);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.innerHTML = htmlFromRuns(initial);
    editor.focus();
    const selection = window.getSelection();
    const range = window.document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [initial]);

  const commit = () => {
    if (committed.current || !editorRef.current) return;
    committed.current = true;
    onCommit(runsFromElement(editorRef.current, style));
  };

  const cancel = () => {
    committed.current = true;
    onCancel();
  };

  /**
   * Applies formatting by wrapping the selection in a styled span rather than
   * using the deprecated execCommand, so the markup stays predictable.
   */
  const applyToSelection = (declarations: Partial<CSSStyleDeclaration>): boolean => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !editor.contains(range.commonAncestorContainer)) return false;
    const span = window.document.createElement("span");
    Object.assign(span.style, declarations);
    span.appendChild(range.extractContents());
    range.insertNode(span);
    selection.removeAllRanges();
    const next = window.document.createRange();
    next.selectNodeContents(span);
    selection.addRange(next);
    editor.focus();
    return true;
  };

  /**
   * With a selection, only that text changes. Without one, the box default
   * changes — styling text that carries no explicit formatting of its own.
   */
  const applyOrDefault = (declarations: Partial<CSSStyleDeclaration>, update: (current: TextStyle) => TextStyle) => {
    if (!applyToSelection(declarations)) setStyle(update);
  };

  const toggle = (key: "bold" | "italic" | "underline" | "strike") => {
    const value = !style[key];
    const decorations = [
      (key === "underline" ? value : style.underline) && "underline",
      (key === "strike" ? value : style.strike) && "line-through",
    ]
      .filter(Boolean)
      .join(" ");
    const declarations: Partial<CSSStyleDeclaration> =
      key === "bold"
        ? { fontWeight: value ? "700" : "400" }
        : key === "italic"
          ? { fontStyle: value ? "italic" : "normal" }
          : { textDecoration: decorations || "none" };
    applyOrDefault(declarations, (current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="pdf-text-editor" style={{ left, top }} onClick={(event) => event.stopPropagation()}>
      <div className="pdf-text-toolbar" onMouseDown={(event) => event.preventDefault()}>
        <button className={style.bold ? "selected" : ""} title="Bold" aria-label="Bold" aria-pressed={style.bold} onClick={() => toggle("bold")}><Bold size={14} /></button>
        <button className={style.italic ? "selected" : ""} title="Italic" aria-label="Italic" aria-pressed={style.italic} onClick={() => toggle("italic")}><Italic size={14} /></button>
        <button className={style.underline ? "selected" : ""} title="Underline" aria-label="Underline" aria-pressed={style.underline} onClick={() => toggle("underline")}><Underline size={14} /></button>
        <button className={style.strike ? "selected" : ""} title="Strikethrough" aria-label="Strikethrough" aria-pressed={style.strike} onClick={() => toggle("strike")}><Strikethrough size={14} /></button>
        <select
          aria-label="Font"
          value={style.font}
          onChange={(event) => {
            const font = event.target.value as FontFamily;
            applyOrDefault({ fontFamily: CSS_FAMILY[font] }, (current) => ({ ...current, font }));
          }}
        >
          {FAMILIES.map((family) => <option key={family.id} value={family.id}>{family.label}</option>)}
        </select>
        <select
          aria-label="Font size"
          value={style.size}
          onChange={(event) => {
            const size = Number(event.target.value);
            applyOrDefault({ fontSize: `${size}px` }, (current) => ({ ...current, size }));
          }}
        >
          {SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
        <input
          type="color"
          aria-label="Text colour"
          value={style.color}
          onChange={(event) => {
            const color = event.target.value;
            applyOrDefault({ color }, (current) => ({ ...current, color }));
          }}
        />
        <span className="spacer" />
        <button className="primary" title="Add this text" aria-label="Add" onClick={commit}><Check size={14} /></button>
        <button className="secondary" title="Discard" aria-label="Cancel" onClick={cancel}><X size={14} /></button>
      </div>
      <div
        ref={editorRef}
        className="pdf-text-surface"
        role="textbox"
        aria-label="Annotation text"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        style={{ ...styleToCss(style), transform: `scale(${scale})`, transformOrigin: "top left" }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); cancel(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); }
        }}
      />
    </div>
  );
}

function styleToCss(style: TextStyle): React.CSSProperties {
  const declarations = cssFor(style).split(";");
  const result: Record<string, string> = {};
  for (const declaration of declarations) {
    const [property, value] = declaration.split(":");
    if (!property || !value) continue;
    const camel = property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    result[camel] = value;
  }
  return result as React.CSSProperties;
}
