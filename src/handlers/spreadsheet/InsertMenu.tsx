import { useEffect, useRef, useState } from "react";
import { MAX_INSERT_COUNT, PLACEMENTS, type InsertPlacement } from "./placement";

interface DialogProps {
  /** The anchor's A1 name, shown so the user knows where rows will land. */
  anchorLabel: string;
  initial: InsertPlacement;
  onInsert: (placement: InsertPlacement, count: number) => void;
  onClose: () => void;
}

/** Excel's Insert dialog: choose where the new row or column goes, and how many. */
export function InsertDialog({ anchorLabel, initial, onInsert, onClose }: DialogProps) {
  const [placement, setPlacement] = useState<InsertPlacement>(initial);
  const [count, setCount] = useState("1");
  const first = useRef<HTMLInputElement>(null);
  const parsed = Number(count);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_INSERT_COUNT;

  useEffect(() => { first.current?.focus(); }, []);

  const submit = () => { if (valid) onInsert(placement, parsed); };

  return (
    <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        className="workspace-modal sheet-insert-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-insert-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
          if (event.key === "Enter") { event.preventDefault(); submit(); }
        }}
      >
        <header>
          <div><span className="modal-kicker">INSERT AT {anchorLabel}</span><h2 id="sheet-insert-title">Insert</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <fieldset className="sheet-insert-options">
          <legend className="muted small">Where should the new cells go?</legend>
          {PLACEMENTS.map((option, index) => (
            <label key={option.value} className="sheet-insert-option">
              <input
                ref={index === PLACEMENTS.findIndex((item) => item.value === initial) ? first : undefined}
                type="radio"
                name="sheet-insert-placement"
                value={option.value}
                checked={placement === option.value}
                onChange={() => setPlacement(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <label className="field-label sheet-insert-count">
          How many {placement.startsWith("row") ? "rows" : "columns"}
          <input
            type="number"
            min={1}
            max={MAX_INSERT_COUNT}
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </label>
        {!valid && <p className="modal-error">Enter a whole number from 1 to {MAX_INSERT_COUNT.toLocaleString()}.</p>}
        <footer>
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={submit}>Insert</button>
        </footer>
      </section>
    </div>
  );
}

interface MenuProps {
  x: number;
  y: number;
  /** Which quick actions to offer first: a row header shows row actions. */
  target: "cell" | "row" | "column";
  onPick: (placement: InsertPlacement) => void;
  onOpenDialog: () => void;
  onResetHeight?: () => void;
  onClose: () => void;
}

/** The right-click menu on cells and headers. */
export function SheetContextMenu({ x, y, target, onPick, onOpenDialog, onResetHeight, onClose }: MenuProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    // Deferred so the click that opened the menu does not immediately close it.
    const timer = window.setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", onClose);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const rows = PLACEMENTS.filter((option) => option.value.startsWith("row"));
  const columns = PLACEMENTS.filter((option) => option.value.startsWith("column"));
  const ordered = target === "column" ? [...columns, ...rows] : [...rows, ...columns];
  const labels: Record<InsertPlacement, string> = {
    "row-above": "Insert row above",
    "row-below": "Insert row below",
    "column-left": "Insert column left",
    "column-right": "Insert column right",
  };

  // Keep the menu on screen near the bottom and right edges.
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - 250);

  return (
    <div className="sheet-context-menu" role="menu" ref={container} style={{ left, top }} onContextMenu={(event) => event.preventDefault()}>
      <button role="menuitem" onClick={onOpenDialog}>Insert…<span className="muted">Ctrl+Shift++</span></button>
      <div className="sheet-context-separator" />
      {ordered.map((option) => (
        <button key={option.value} role="menuitem" onClick={() => onPick(option.value)}>{labels[option.value]}</button>
      ))}
      {onResetHeight && (
        <>
          <div className="sheet-context-separator" />
          <button role="menuitem" onClick={onResetHeight}>Reset row height</button>
        </>
      )}
    </div>
  );
}
