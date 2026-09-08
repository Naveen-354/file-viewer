import { useEffect, useMemo, useRef, useState } from "react";
import type { SpreadsheetCell } from "../../types/files";
import { distinctValues, type ColumnFilter, type Edits } from "../../utils/spreadsheet";

interface Props {
  rows: SpreadsheetCell[][];
  edits: Edits;
  filters: Map<number, ColumnFilter>;
  column: number;
  onApply: (filter: ColumnFilter | null) => void;
  onClose: () => void;
}

export function FilterMenu({ rows, edits, filters, column, onApply, onClose }: Props) {
  const existing = filters.get(column);
  const [query, setQuery] = useState(existing?.query ?? "");
  const [excluded, setExcluded] = useState<Set<string>>(new Set(existing?.excluded ?? []));
  const [search, setSearch] = useState("");
  const container = useRef<HTMLDivElement>(null);

  const { values, truncated } = useMemo(
    () => distinctValues(rows, edits, filters, column),
    [rows, edits, filters, column],
  );
  const listed = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? values.filter((value) => value.toLowerCase().includes(needle)) : values;
  }, [values, search]);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    // Deferred so the click that opened the menu does not immediately close it.
    const timer = window.setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
    document.addEventListener("keydown", escape);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  const toggle = (value: string) => {
    setExcluded((prior) => {
      const next = new Set(prior);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const allShown = listed.every((value) => !excluded.has(value));
  const apply = () => {
    const filter: ColumnFilter = { query, excluded };
    onApply(query.trim() === "" && excluded.size === 0 ? null : filter);
  };

  return (
    <div className="filter-menu" ref={container} onClick={(event) => event.stopPropagation()}>
      <input
        className="filter-query"
        placeholder="Contains…"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") apply(); }}
      />
      <input
        className="filter-query"
        placeholder="Search values"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <label className="filter-all">
        <input
          type="checkbox"
          checked={allShown}
          onChange={() => {
            setExcluded((prior) => {
              const next = new Set(prior);
              for (const value of listed) {
                if (allShown) next.add(value);
                else next.delete(value);
              }
              return next;
            });
          }}
        />
        {allShown ? "Deselect all" : "Select all"} ({listed.length.toLocaleString()})
      </label>
      <div className="filter-values">
        {listed.map((value) => (
          <label key={value || "(blank)"} className="filter-value">
            <input type="checkbox" checked={!excluded.has(value)} onChange={() => toggle(value)} />
            <span>{value === "" ? "(blank)" : value}</span>
          </label>
        ))}
        {listed.length === 0 && <span className="muted small">No matching values</span>}
      </div>
      {truncated && <div className="muted small">Only the first 1,000 distinct values are listed.</div>}
      <div className="filter-actions">
        <button className="secondary" onClick={() => { setQuery(""); setExcluded(new Set()); onApply(null); }}>
          Clear
        </button>
        <span className="spacer" />
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary" onClick={apply}>Apply</button>
      </div>
    </div>
  );
}
