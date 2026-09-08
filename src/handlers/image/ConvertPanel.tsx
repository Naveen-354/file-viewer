import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { FileDescriptor, ImageConversion, ImageFormatInfo } from "../../types/files";
import { api } from "../../services/tauri";
import { useWorkspace } from "../../stores/workspace";
import { formatBytes } from "../../utils/file";
import { suggestedName } from "../../utils/image";

export function ConvertPanel({ file, onClose }: { file: FileDescriptor; onClose: () => void }) {
  const [formats, setFormats] = useState<ImageFormatInfo[]>([]);
  const [formatId, setFormatId] = useState("png");
  const [quality, setQuality] = useState(90);
  const [background, setBackground] = useState("#ffffff");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImageConversion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openPaths = useWorkspace((state) => state.openPaths);

  useEffect(() => {
    let cancelled = false;
    api.imageFormats()
      .then((available) => {
        if (cancelled) return;
        setFormats(available);
        // Default to something other than the format the file already is.
        const current = available.find((entry) => entry.extension === file.extension);
        setFormatId(current?.id === "png" ? "jpeg" : "png");
      })
      .catch((reason) => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; };
  }, [file.extension]);

  const target = useMemo(() => formats.find((entry) => entry.id === formatId), [formats, formatId]);

  const convert = async () => {
    if (!target) return;
    setError(null);
    const destination = await save({
      defaultPath: suggestedName(file.name, target.extension),
      filters: [{ name: target.label, extensions: [target.extension] }],
    });
    if (!destination) return;
    setBusy(true);
    try {
      const conversion = await api.convertImage({
        sourcePath: file.path,
        destinationPath: destination,
        format: target.id,
        quality: target.lossy ? quality : null,
        background: target.alpha ? null : background,
      });
      setResult(conversion);
    } catch (reason) {
      setError(message(reason));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="convert-panel">
      <div className="convert-row">
        <label>
          Convert to
          <select value={formatId} disabled={busy} onChange={(event) => setFormatId(event.target.value)}>
            {formats.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
        {target?.lossy && (
          <label>
            Quality {quality}
            <input type="range" min={1} max={100} value={quality} disabled={busy} onChange={(event) => setQuality(Number(event.target.value))} />
          </label>
        )}
        {target && !target.alpha && (
          <label title={`${target.label} has no transparency, so clear pixels are filled with this colour`}>
            Background
            <input type="color" value={background} disabled={busy} onChange={(event) => setBackground(event.target.value)} />
          </label>
        )}
        <span className="spacer" />
        <button className="primary" disabled={busy || !target} onClick={() => void convert()}>
          {busy ? "Converting…" : "Convert and save…"}
        </button>
        <button className="secondary" disabled={busy} onClick={onClose}>Close</button>
      </div>
      {error && <div className="validation-error">{error}</div>}
      {result && (
        <div className="convert-result">
          Saved <strong>{result.file.name}</strong> · {result.width} × {result.height} ·{" "}
          {formatBytes(result.sourceBytes)} → {formatBytes(result.outputBytes)}
          <button className="secondary" onClick={() => void openPaths([result.file.path])}>Open</button>
        </div>
      )}
    </div>
  );
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
