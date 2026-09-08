import { api } from "../services/tauri";

export async function readBytes(path: string, maximum: number): Promise<Uint8Array> {
  const chunkSize = 1024 * 1024;
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset < maximum) {
    const result = await api.readChunk(path, offset, Math.min(chunkSize, maximum - offset));
    const part = Uint8Array.from(result.bytes);
    parts.push(part);
    offset += part.byteLength;
    if (result.eof || !part.byteLength) break;
  }
  const output = new Uint8Array(offset);
  let cursor = 0;
  for (const part of parts) { output.set(part, cursor); cursor += part.byteLength; }
  return output;
}

export function decodeBytes(bytes: Uint8Array): { text: string; encoding: string } {
  let encoding = "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  try { return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding }; }
  catch { return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" }; }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
