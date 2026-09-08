import { useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import {
  Crosshair, Grid3x3, Image as ImageIcon, Info, Maximize2, Minus, Pipette, Plus,
  RefreshCcw, Replace, SquareDashed,
} from "lucide-react";
import type { ViewerProps } from "../../types/handlers";
import { readBytes, formatBytes } from "../../utils/file";
import { aspectRatio, histogramOf, readImageMeta, toHex, type Histogram, type ImageMeta } from "../../utils/imageMeta";
import { ConvertPanel } from "./ConvertPanel";

const IMAGE_LIMIT = 80 * 1024 * 1024;
const CHANNELS = ["RGBA", "R", "G", "B", "Alpha"] as const;
type Channel = (typeof CHANNELS)[number];

interface Probe { x: number; y: number; r: number; g: number; b: number; a: number }

export default function ImageViewer({ file, onStatusChange }: ViewerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [bitmap, setBitmap] = useState<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [channel, setChannel] = useState<Channel>("RGBA");
  const [checkerboard, setCheckerboard] = useState(true);
  const [pixelGrid, setPixelGrid] = useState(true);
  const [probing, setProbing] = useState(true);
  const [inspector, setInspector] = useState(true);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [histogram, setHistogram] = useState<Histogram | null>(null);
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pixels = useRef<ImageData | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let disposed = false;
    if (file.size > IMAGE_LIMIT) { setError("Image exceeds the safe in-app preview limit."); return; }
    void readBytes(file.path, IMAGE_LIMIT).then((bytes) => {
      if (disposed) return;
      setMeta(readImageMeta(bytes));
      const blob = file.extension === "svg"
        ? new Blob([DOMPurify.sanitize(new TextDecoder().decode(bytes), { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["script", "foreignObject"], FORBID_ATTR: ["href", "xlink:href", "onload", "onclick"] })], { type: "image/svg+xml" })
        : new Blob([bytes as BlobPart], { type: file.mimeType ?? "application/octet-stream" });
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
      const image = new Image();
      image.onload = () => { if (!disposed) setBitmap(image); };
      image.onerror = () => { if (!disposed) setError("This image could not be decoded for inspection. Use Convert to make a PNG."); };
      image.src = objectUrl;
    }).catch((reason) => setError(String(reason)));
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.path, file.size, file.extension, file.mimeType]);

  /** Draws at natural size once, then reads the pixels back for probing and the histogram. */
  useEffect(() => {
    if (!bitmap || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = bitmap.naturalWidth;
    canvas.height = bitmap.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    try {
      const data = context.getImageData(0, 0, canvas.width, canvas.height);
      pixels.current = data;
      setHistogram(histogramOf(data.data));
      if (channel !== "RGBA") context.putImageData(isolate(data, channel), 0, 0);
    } catch {
      pixels.current = null;
      setHistogram(null);
    }
    onStatusChange(`${bitmap.naturalWidth} × ${bitmap.naturalHeight} · ${formatBytes(file.size)}`);
  }, [bitmap, channel, file.size, onStatusChange]);

  const fit = useCallback(() => {
    const box = viewport.current?.getBoundingClientRect();
    if (!bitmap || !box) return;
    setScale(Math.min((box.width - 48) / bitmap.naturalWidth, (box.height - 48) / bitmap.naturalHeight, 1));
  }, [bitmap]);

  useEffect(() => { if (bitmap) fit(); }, [bitmap, fit]);

  const onMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!probing || !pixels.current || !bitmap) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.floor((event.clientX - bounds.left) / bounds.width * bitmap.naturalWidth);
    const y = Math.floor((event.clientY - bounds.top) / bounds.height * bitmap.naturalHeight);
    if (x < 0 || y < 0 || x >= bitmap.naturalWidth || y >= bitmap.naturalHeight) return;
    const offset = (y * bitmap.naturalWidth + x) * 4;
    const data = pixels.current.data;
    setProbe({ x, y, r: data[offset], g: data[offset + 1], b: data[offset + 2], a: data[offset + 3] });
  };

  const showGrid = pixelGrid && scale >= 4;
  const displayWidth = bitmap ? Math.round(bitmap.naturalWidth * scale) : 0;

  return (
    <div className="viewer image-viewer raster-inspector">
      <div className="viewer-toolbar image-bar">
        <span className="json-file"><ImageIcon size={13} /> {file.name}</span>
        <button className="icon-action" aria-label="Zoom out" title="Zoom out" onClick={() => setScale((value) => Math.max(.05, value / 1.25))}><Minus size={14} /></button>
        <span className="image-zoom">{Math.round(scale * 100)}%{showGrid ? " [Pixel Grid]" : ""}</span>
        <button className="icon-action" aria-label="Zoom in" title="Zoom in" onClick={() => setScale((value) => Math.min(32, value * 1.25))}><Plus size={14} /></button>
        <button className="icon-action labelled" title="Fit to window" onClick={fit}><Maximize2 size={13} /> Fit</button>
        <button className="icon-action labelled" title="Actual size" onClick={() => setScale(1)}>1:1</button>
        <input className="image-slider" type="range" min={5} max={800} value={Math.round(scale * 100)} aria-label="Zoom" onChange={(event) => setScale(Number(event.target.value) / 100)} />
        <span className="toolbar-divider" />
        <button className={`icon-action ${checkerboard ? "selected" : ""}`} aria-label="Transparency checkerboard" aria-pressed={checkerboard} title="Transparency checkerboard" onClick={() => setCheckerboard((value) => !value)}><SquareDashed size={14} /></button>
        <button className={`icon-action ${pixelGrid ? "selected" : ""}`} aria-label="Pixel grid" aria-pressed={pixelGrid} title="Pixel grid (from 400%)" onClick={() => setPixelGrid((value) => !value)}><Grid3x3 size={14} /></button>
        <button className={`icon-action ${probing ? "selected" : ""}`} aria-label="Colour picker" aria-pressed={probing} title="Sample pixel colours" onClick={() => setProbing((value) => !value)}><Pipette size={14} /></button>
        <button className="icon-action" aria-label="Rotate" title="Rotate 90°" onClick={() => setRotation((value) => (value + 90) % 360)}><RefreshCcw size={14} /></button>
        <span className="toolbar-divider" />
        <span className="segmented channel-picker">
          {CHANNELS.map((name) => (
            <button key={name} className={channel === name ? "selected" : ""} aria-pressed={channel === name} title={`Show ${name}`} onClick={() => setChannel(name)}>{name}</button>
          ))}
        </span>
        <span className="spacer" />
        <button className={`icon-action labelled ${converting ? "selected" : ""}`} title="Convert to another format" onClick={() => setConverting((value) => !value)}><Replace size={13} /> Convert</button>
        <button className={`icon-action labelled ${inspector ? "selected" : ""}`} aria-label="Inspector" aria-pressed={inspector} title="Image metadata" onClick={() => setInspector((value) => !value)}><Info size={13} /> Inspector</button>
      </div>

      {converting && <ConvertPanel file={file} onClose={() => setConverting(false)} />}
      {error && <div className="error-state">{error}</div>}

      <div className="image-body">
        <div className={`image-viewport ${checkerboard ? "checkerboard" : ""}`} ref={viewport}>
          {bitmap && (
            <div className="image-stage" style={{ width: displayWidth, transform: `rotate(${rotation}deg)` }}>
              <span className="image-ruler"><Crosshair size={11} /> W: {bitmap.naturalWidth} px [Scaled: {displayWidth}px @ {Math.round(scale * 100)}%]</span>
              <canvas
                ref={canvasRef}
                className={showGrid ? "pixel-grid" : ""}
                style={{ width: displayWidth, height: Math.round(bitmap.naturalHeight * scale), imageRendering: scale >= 2 ? "pixelated" : "auto" }}
                onMouseMove={onMove}
                onMouseLeave={() => setProbe(null)}
              />
              {probe && probing && (
                <>
                  <span className="probe-guide vertical" style={{ left: Math.round(probe.x * scale) }} />
                  <span className="probe-guide horizontal" style={{ top: Math.round(probe.y * scale) }} />
                </>
              )}
              {probe && probing && (
                <div className="pixel-probe">
                  <i style={{ background: toHex(probe.r, probe.g, probe.b) }} />
                  <span>X: {probe.x} | Y: {probe.y}</span>
                  <span>RGBA({probe.r}, {probe.g}, {probe.b}, {(probe.a / 255).toFixed(2)}) {toHex(probe.r, probe.g, probe.b)}</span>
                </div>
              )}
            </div>
          )}
          {!bitmap && !error && <div className="center muted">Decoding image…</div>}
          {url && file.extension === "svg" && !bitmap && <img src={url} alt={file.name} hidden />}
        </div>

        {inspector && (
          <aside className="image-inspector" aria-label="Image metadata">
            <div className="json-details-head"><strong><Info size={13} /> Image Metadata</strong><em className="json-type">{meta?.format ?? "RASTER"}</em></div>

            <section>
              <h3>Properties</h3>
              <dl className="image-facts">
                {bitmap && <Fact label="Dimensions" value={`${bitmap.naturalWidth} × ${bitmap.naturalHeight} px`} />}
                {bitmap && <Fact label="Aspect ratio" value={aspectRatio(bitmap.naturalWidth, bitmap.naturalHeight)} />}
                {meta?.colorSpace && <Fact label="Colour space" value={meta.colorSpace} />}
                {meta?.colorType && <Fact label="Colour type" value={meta.colorType} />}
                {meta?.bitDepth && <Fact label="Bit depth" value={meta.bitDepth} />}
                <Fact label="File size" value={`${formatBytes(file.size)} (${file.size.toLocaleString()} B)`} />
                {meta?.compression && <Fact label="Compression" value={meta.compression} />}
                {meta?.interlace && <Fact label="Interlace" value={meta.interlace} />}
              </dl>
            </section>

            {histogram && (
              <section>
                <h3>Colour histogram</h3>
                <HistogramStrip histogram={histogram} />
                <div className="histogram-scale"><span>0</span><span>128</span><span>255</span></div>
              </section>
            )}

            {meta && meta.extra.length > 0 && (
              <section>
                <h3>Embedded metadata</h3>
                <dl className="image-facts">
                  {meta.extra.map((field) => <Fact key={field.label} label={field.label} value={field.value} />)}
                </dl>
              </section>
            )}

            {meta && meta.extra.length === 0 && <p className="muted small">This file carries no embedded colour or EXIF metadata.</p>}
          </aside>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>;
}

function HistogramStrip({ histogram }: { histogram: Histogram }) {
  const peak = Math.max(1, ...histogram.red, ...histogram.green, ...histogram.blue);
  return (
    <div className="histogram" role="img" aria-label="Distribution of red, green and blue values">
      {Array.from({ length: histogram.buckets }, (_, index) => (
        <span key={index} className="histogram-bucket">
          <i className="red" style={{ height: `${(histogram.red[index] / peak) * 100}%` }} />
          <i className="green" style={{ height: `${(histogram.green[index] / peak) * 100}%` }} />
          <i className="blue" style={{ height: `${(histogram.blue[index] / peak) * 100}%` }} />
        </span>
      ))}
    </div>
  );
}

/** Rebuilds the pixel data showing a single channel as greyscale. */
function isolate(source: ImageData, channel: Channel): ImageData {
  const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  const data = output.data;
  const offset = channel === "R" ? 0 : channel === "G" ? 1 : channel === "B" ? 2 : 3;
  for (let index = 0; index < data.length; index += 4) {
    const value = data[index + offset];
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  return output;
}
