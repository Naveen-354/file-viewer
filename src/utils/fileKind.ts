import type { RecentFile } from "../types/files";

export type KindId = "code" | "structured" | "data" | "documents" | "images" | "media" | "other";

interface Kind {
  id: KindId;
  label: string;
  tone: "blue" | "green" | "red" | "cyan" | "amber";
}

const KINDS: Record<KindId, Kind> = {
  code: { id: "code", label: "Code", tone: "blue" },
  structured: { id: "structured", label: "Structured", tone: "amber" },
  data: { id: "data", label: "Data", tone: "green" },
  documents: { id: "documents", label: "Documents", tone: "red" },
  images: { id: "images", label: "Images", tone: "cyan" },
  media: { id: "media", label: "Media", tone: "cyan" },
  other: { id: "other", label: "Other", tone: "blue" },
};

const BY_HANDLER: Record<string, KindId> = {
  text: "code",
  sql: "code",
  structured: "structured",
  csv: "data",
  spreadsheet: "data",
  document: "documents",
  pdf: "documents",
  image: "images",
  media: "media",
  archive: "other",
  fallback: "other",
};

export function kindOf(handlerId: string): Kind {
  return KINDS[BY_HANDLER[handlerId] ?? "other"];
}

/** The sidebar's file-type tally, ordered by how many files each kind holds. */
export function countByKind(files: RecentFile[]): { kind: Kind; count: number }[] {
  const totals = new Map<KindId, number>();
  for (const file of files) {
    const kind = kindOf(file.handlerId);
    totals.set(kind.id, (totals.get(kind.id) ?? 0) + 1);
  }
  return [...totals.entries()]
    .map(([id, count]) => ({ kind: KINDS[id], count }))
    .sort((left, right) => right.count - left.count || left.kind.label.localeCompare(right.kind.label));
}

/** `transactions.csv` becomes the `CSV` badge shown in the recent-files table. */
export function formatLabel(name: string, handlerId: string): string {
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  return extension ? extension.toUpperCase().slice(0, 6) : kindOf(handlerId).label.toUpperCase();
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

export function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

/** Shortens a path to its last few segments for the breadcrumb. */
export function breadcrumbSegments(path: string, keep = 3): string[] {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.slice(Math.max(0, parts.length - keep));
}
