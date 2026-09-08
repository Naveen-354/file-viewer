import { useEffect, useRef, useState } from "react";
import { useWorkspace, type WorkspaceTab } from "../stores/workspace";
import { useWorkspaces } from "../stores/workspaces";

/**
 * Renames the file behind a tab.
 *
 * The stem is preselected on open, the way a file manager does it, so typing
 * replaces the name and leaves the extension alone.
 */
export function RenameDialog({ tab, close }: { tab: WorkspaceTab | null; close: () => void }) {
  const renameTab = useWorkspace((state) => state.renameTab);
  const reloadWorkspaces = useWorkspaces((state) => state.load);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!tab) return;
    setName(tab.file.name);
    setError("");
    setBusy(false);
    // Select the stem only, so the extension survives a straight retype.
    window.setTimeout(() => {
      const input = field.current;
      if (!input) return;
      input.focus();
      const dot = tab.file.name.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : tab.file.name.length);
    }, 0);
  }, [tab]);

  if (!tab) return null;

  const unchanged = name.trim() === tab.file.name;
  const extensionChanged = extensionOf(name) !== extensionOf(tab.file.name);

  const submit = async () => {
    if (busy || !name.trim() || unchanged) return;
    setBusy(true);
    setError("");
    try {
      await renameTab(tab.id, name);
      // Pins are stored by path, so the sidebar needs the repointed list.
      await reloadWorkspaces();
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="workspace-modal rename-modal" role="dialog" aria-modal="true" aria-labelledby="rename-title">
        <header>
          <div><span className="modal-kicker">RENAME FILE</span><h2 id="rename-title">{tab.file.name}</h2></div>
          <button className="icon-button" onClick={close} aria-label="Close">×</button>
        </header>

        {tab.dirty ? (
          <p className="modal-error">This file has unsaved changes. Save or close them before renaming, so the edit is not written to the old name.</p>
        ) : (
          <>
            <label className="field-label">New name
              <input
                ref={field}
                value={name}
                maxLength={255}
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); void submit(); }
                  if (event.key === "Escape") { event.preventDefault(); close(); }
                }}
              />
            </label>
            <p className="muted small rename-hint">The file stays in {folderOf(tab.file.path)}. Renaming does not move it.</p>
            {extensionChanged && !unchanged && (
              <p className="modal-warning">Changing the extension changes which viewer opens this file.</p>
            )}
          </>
        )}

        {error && <div className="modal-error">{error}</div>}
        <footer>
          <button className="secondary" onClick={close}>Cancel</button>
          <button className="primary" disabled={busy || tab.dirty || unchanged || !name.trim()} onClick={() => void submit()}>
            {busy ? "Renaming…" : "Rename"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : path;
}
