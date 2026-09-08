import { useMemo } from "react";
import { FileCode2, RotateCcw, Shield, Workflow } from "lucide-react";
import { useSettings } from "../stores/settings";
import { OVERRIDABLE, handlerRows } from "../utils/handlers";

export function FormatHandlersPanel({ matches }: { matches: (...text: string[]) => boolean }) {
  const overrides = useSettings((state) => state.handlerOverrides);
  const update = useSettings((state) => state.update);
  const rows = useMemo(() => handlerRows(), []);

  const choose = (extension: string, handler: string, isDefault: boolean) => {
    const next = { ...overrides };
    if (isDefault) delete next[extension];
    else next[extension] = handler;
    void update({ handlerOverrides: next });
  };

  const changed = Object.keys(overrides).length;

  return (
    <>
      {matches("handler", "viewer", "registry", "format", "extension", "mime") && (
        <section className="settings-card">
          <header>
            <Workflow size={14} />
            <div>
              <strong>Registered viewers</strong>
              <small>Every viewer compiled into this build, with the extensions it claims. Loaded on first use, so opening one file does not pull in the rest.</small>
            </div>
          </header>
          <div className="engine-table-wrap">
            <table className="engine-table wrap-cells">
              <thead>
                <tr><th>Viewer</th><th>Id</th><th>Decodes in</th><th>Extensions</th><th>MIME</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.label}</td>
                    <td className="engine-module">{row.id}</td>
                    <td><span className={`engine-runtime ${row.runtime === "Rust core" ? "core" : "webview"}`}>{row.runtime}</span></td>
                    <td className="engine-formats" title={row.extensions.join(", ") || "Anything not claimed above"}>
                      {row.extensions.length ? row.extensions.map((value) => `.${value}`).join(" · ") : "—"}
                    </td>
                    <td className="engine-formats" title={row.mimeTypes.join(", ")}>
                      {row.mimeTypes.length ? row.mimeTypes.join(" · ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="engine-note">
            The libraries behind these viewers, with the versions this build resolved, are listed
            under Native Engine. "Decodes in" is where the parsing happens — it is not a sandbox
            boundary: every viewer runs in the same process with the same privileges.
          </p>
        </section>
      )}

      {matches("default", "override", "conflict", "priority", "open with", "association") && (
        <section className="settings-card">
          <header>
            <FileCode2 size={14} />
            <div>
              <strong>Default viewer</strong>
              <small>For the few formats more than one viewer can open. Everything else is decided by content, and cannot be reassigned here.</small>
            </div>
          </header>

          {OVERRIDABLE.map((choice) => {
            const current = overrides[choice.extension] ?? choice.fallback;
            return (
              <div className="setting-row" key={choice.extension}>
                <span>
                  <strong>.{choice.extension}</strong>
                  <small>
                    {overrides[choice.extension]
                      ? `Overridden. The detected default is ${labelOf(choice.options, choice.fallback)}.`
                      : "Using the detected default."}
                  </small>
                </span>
                <span className="segmented" role="group" aria-label={`Default viewer for .${choice.extension}`}>
                  {choice.options.map((option) => (
                    <button
                      key={option.id}
                      className={current === option.id ? "selected" : ""}
                      aria-pressed={current === option.id}
                      onClick={() => choose(choice.extension, option.id, option.id === choice.fallback)}
                    >{option.label}</button>
                  ))}
                </span>
              </div>
            );
          })}

          <div className="setting-row">
            <span>
              <strong>Reset to detected defaults</strong>
              <small>{changed === 0 ? "Nothing is overridden." : `${changed} extension${changed === 1 ? "" : "s"} overridden.`}</small>
            </span>
            <button className="icon-action labelled" disabled={changed === 0} onClick={() => void update({ handlerOverrides: {} })}>
              <RotateCcw size={12} /> Clear overrides
            </button>
          </div>

          <p className="engine-note">
            A change applies to files opened from now on. Tabs already open keep the viewer they
            were opened with — close and reopen a file to move it.
          </p>
        </section>
      )}

      {matches("plugin", "wasm", "extension", "sandbox", "isolation", "custom parser") && (
        <section className="settings-card muted-card">
          <header><Shield size={14} /><div><strong>Custom parsers and plugins</strong><small>Not offered here.</small></div></header>
          <p className="muted">
            OneOpen has no plugin system. It cannot load a WebAssembly module, a user-supplied
            parser or a native extension, and there is no per-handler sandbox to isolate one if it
            could — every viewer runs in the same process. A switch here would imply an isolation
            boundary that does not exist, so there is not one.
          </p>
        </section>
      )}
    </>
  );
}

function labelOf(options: { id: string; label: string }[], id: string): string {
  return options.find((option) => option.id === id)?.label ?? id;
}
