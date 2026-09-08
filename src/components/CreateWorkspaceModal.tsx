import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaces } from "../stores/workspaces";

export function CreateWorkspaceModal({ visible, close }: { visible: boolean; close: () => void }) {
  const createWorkspace = useWorkspaces((state) => state.createWorkspace);
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [restore, setRestore] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  if (!visible) return null;

  const addFolders = async () => {
    const selected = await open({ directory: true, multiple: true });
    if (selected) setFolders((current) => unique([...current, ...(Array.isArray(selected) ? selected : [selected])]));
  };
  const addPins = async () => {
    const selected = await open({ directory: false, multiple: true });
    if (selected) setPins((current) => unique([...current, ...(Array.isArray(selected) ? selected : [selected])]));
  };
  const submit = async () => {
    if (!name.trim() || !folders.length) { setError("Enter a name and add at least one local folder."); return; }
    setSaving(true); setError("");
    try {
      await createWorkspace({ name: name.trim(), folders, pinnedFiles: pins, restoreLastSession: restore });
      setName(""); setFolders([]); setPins([]); setRestore(true); close();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setSaving(false); }
  };

  return (
    <div className="workspace-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="workspace-modal" role="dialog" aria-modal="true" aria-labelledby="create-workspace-title">
        <header><div><span className="modal-kicker">LOCAL WORKSPACE</span><h2 id="create-workspace-title">Create Workspace</h2></div><button className="icon-button" onClick={close} aria-label="Close">×</button></header>
        <label className="field-label">Workspace name<input autoFocus value={name} maxLength={80} placeholder="e.g. Product analytics" onChange={(event) => setName(event.target.value)} /></label>
        <PathPicker title="Local folders" hint="One or more folders; files never leave this device." paths={folders} add={addFolders} remove={(path) => setFolders((items) => items.filter((item) => item !== path))} action="Add folder" />
        <PathPicker title="Pinned files" hint="Optional files shown at the top of this workspace." paths={pins} add={addPins} remove={(path) => setPins((items) => items.filter((item) => item !== path))} action="Add files" />
        <label className="restore-option"><input type="checkbox" checked={restore} onChange={(event) => setRestore(event.target.checked)} /><span><strong>Restore last session</strong><small>Reopen this workspace’s previous tabs when selected.</small></span></label>
        {error && <div className="modal-error">{error}</div>}
        <footer><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={saving} onClick={() => void submit()}>{saving ? "Creating…" : "Create Workspace"}</button></footer>
      </section>
    </div>
  );
}

function PathPicker({ title, hint, paths, add, remove, action }: { title: string; hint: string; paths: string[]; add: () => Promise<void>; remove: (path: string) => void; action: string }) {
  return <div className="path-picker"><div className="path-picker-heading"><span><strong>{title}</strong><small>{hint}</small></span><button className="secondary" onClick={() => void add()}>＋ {action}</button></div>{paths.length > 0 && <div className="selected-paths">{paths.map((path) => <div key={path}><span title={path}>▱ {path}</span><button onClick={() => remove(path)} aria-label={`Remove ${path}`}>×</button></div>)}</div>}</div>;
}

function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
