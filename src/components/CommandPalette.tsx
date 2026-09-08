import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettings } from "../stores/settings";
import { useWorkspace } from "../stores/workspace";

interface Command { id: string; label: string; run: () => void }

export function CommandPalette({ visible, close }: { visible: boolean; close: () => void }) {
  const [query, setQuery] = useState("");
  const openPaths = useWorkspace((state) => state.openPaths);
  const reopen = useWorkspace((state) => state.reopenTab);
  const settings = useSettings();
  const commands = useMemo<Command[]>(() => [
    { id: "open", label: "Open file…", run: () => void open({ multiple: true, directory: false }).then((paths) => paths && openPaths(Array.isArray(paths) ? paths : [paths])) },
    { id: "reopen", label: "Reopen closed tab", run: reopen },
    { id: "theme-light", label: "Theme: Light", run: () => void settings.update({ theme: "light" }) },
    { id: "theme-dark", label: "Theme: Dark", run: () => void settings.update({ theme: "dark" }) },
    { id: "theme-system", label: "Theme: System", run: () => void settings.update({ theme: "system" }) },
  ], [openPaths, reopen, settings]);
  const filtered = commands.filter((command) => command.label.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => { if (visible) setQuery(""); }, [visible]);
  if (!visible) return null;

  const run = (command: Command) => { close(); command.run(); };
  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") close(); if (event.key === "Enter" && filtered[0]) run(filtered[0]); }} placeholder="Type a command…" />
        {filtered.map((command) => <button key={command.id} onClick={() => run(command)}>{command.label}</button>)}
      </div>
    </div>
  );
}
