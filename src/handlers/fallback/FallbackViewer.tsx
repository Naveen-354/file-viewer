import { useEffect, useState } from "react";
import type { ViewerProps } from "../../types/handlers";
import { api } from "../../services/tauri";
import { formatBytes } from "../../utils/file";

export default function FallbackViewer({ file, onStatusChange }: ViewerProps) {
  const [hex, setHex] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.readChunk(file.path, 0, 256).then((chunk) => { setHex(formatHex(Uint8Array.from(chunk.bytes))); onStatusChange("256-byte hex preview"); }).catch((reason) => setError(String(reason))); }, [file.path, onStatusChange]);
  const fields = [
    ["Name", file.name], ["Detected type", file.detectedType], ["MIME type", file.mimeType ?? "Unknown"], ["Extension", file.extension ?? "None"],
    ["Size", formatBytes(file.size)], ["Created", formatDate(file.createdMs)], ["Modified", formatDate(file.modifiedMs)], ["Path", file.path],
  ];
  return (
    <div className="viewer fallback-viewer">
      <div className="fallback-card">
        <div className="file-glyph">{(file.extension ?? "?").slice(0, 4).toUpperCase()}</div>
        <div><h1>{file.name}</h1><p className="muted">No specialized viewer is available.</p></div>
        <div className="fallback-actions"><button className="primary" onClick={() => void api.openSystem(file.path).catch((reason) => setError(String(reason)))}>Open with system application</button><button className="secondary" onClick={() => void api.showInFolder(file.path).catch((reason) => setError(String(reason)))}>Show in folder</button></div>
        {error && <div className="error-state">{error}</div>}
        <dl>{fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd title={value}>{value}</dd></div>)}</dl>
        <h2>Hex preview</h2><pre className="hex-view">{hex}</pre>
      </div>
    </div>
  );
}

function formatDate(value: number | null): string { return value === null ? "Unavailable" : new Date(value).toLocaleString(); }
function formatHex(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.slice(offset, offset + 16);
    const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47);
    const ascii = [...chunk].map((byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}
