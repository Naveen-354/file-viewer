import type { JsonValue } from "./structured";

export type NodeType = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonNode {
  id: string;
  key: string | null;
  index: number | null;
  value: JsonValue;
  type: NodeType;
  depth: number;
  children: JsonNode[];
  /** Character offsets of this value in the source text; -1 when unknown. */
  start: number;
  end: number;
}

export function typeOf(value: JsonValue): NodeType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const kind = typeof value;
  if (kind === "object") return "object";
  if (kind === "number" || kind === "boolean" || kind === "string") return kind;
  return "null";
}

/**
 * A JSON parser that records where each value sits in the source. `JSON.parse`
 * discards that, and the inspector needs it to report real offsets and to
 * highlight the selection in the raw view.
 */
export function parseWithOffsets(text: string): JsonNode {
  let cursor = 0;

  const fail = (message: string): never => {
    const line = text.slice(0, cursor).split("\n").length;
    throw new SyntaxError(`${message} at line ${line}, position ${cursor}`);
  };

  const skip = () => {
    // U+FEFF covers a byte-order mark that survived decoding.
    while (cursor < text.length && /[\s\uFEFF]/.test(text[cursor])) cursor += 1;
  };

  const literal = (word: string, value: JsonValue): JsonValue => {
    if (text.startsWith(word, cursor)) {
      cursor += word.length;
      return value;
    }
    return fail(`Unexpected token ${JSON.stringify(text[cursor] ?? "end of input")}`);
  };

  const readString = (): string => {
    if (text[cursor] !== '"') fail("Expected a string");
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === "\\") cursor += 2;
      else if (character === '"') {
        cursor += 1;
        return JSON.parse(text.slice(start, cursor)) as string;
      } else cursor += 1;
    }
    return fail("Unterminated string");
  };

  const readNumber = (): number => {
    const start = cursor;
    if (text[cursor] === "-") cursor += 1;
    while (cursor < text.length && /[-0-9eE+.]/.test(text[cursor])) cursor += 1;
    const slice = text.slice(start, cursor);
    const value = Number(slice);
    if (slice === "" || !Number.isFinite(value)) return fail(`Invalid number ${JSON.stringify(slice)}`);
    return value;
  };

  const build = (key: string | null, index: number | null, depth: number, parentId: string): JsonNode => {
    skip();
    const start = cursor;
    const id = parentId === "" ? "$" : index !== null ? `${parentId}[${index}]` : `${parentId}.${key}`;
    const character = text[cursor];

    if (character === "{") {
      cursor += 1;
      const children: JsonNode[] = [];
      const object: Record<string, JsonValue> = {};
      skip();
      if (text[cursor] === "}") cursor += 1;
      else {
        for (;;) {
          skip();
          const name = readString();
          skip();
          if (text[cursor] !== ":") fail("Expected ':'");
          cursor += 1;
          const child = build(name, null, depth + 1, id);
          children.push(child);
          object[name] = child.value;
          skip();
          if (text[cursor] === ",") { cursor += 1; continue; }
          if (text[cursor] === "}") { cursor += 1; break; }
          fail("Expected ',' or '}'");
        }
      }
      return { id, key, index, value: object, type: "object", depth, children, start, end: cursor };
    }

    if (character === "[") {
      cursor += 1;
      const children: JsonNode[] = [];
      const array: JsonValue[] = [];
      skip();
      if (text[cursor] === "]") cursor += 1;
      else {
        for (let position = 0; ; position += 1) {
          const child = build(null, position, depth + 1, id);
          children.push(child);
          array.push(child.value);
          skip();
          if (text[cursor] === ",") { cursor += 1; continue; }
          if (text[cursor] === "]") { cursor += 1; break; }
          fail("Expected ',' or ']'");
        }
      }
      return { id, key, index, value: array, type: "array", depth, children, start, end: cursor };
    }

    let value: JsonValue;
    if (character === '"') value = readString();
    else if (character === "t") value = literal("true", true);
    else if (character === "f") value = literal("false", false);
    else if (character === "n") value = literal("null", null);
    else value = readNumber();
    return { id, key, index, value, type: typeOf(value), depth, children: [], start, end: cursor };
  };

  const root = build(null, null, 0, "");
  skip();
  if (cursor < text.length) fail("Unexpected trailing content");
  return root;
}

/** Wraps an already-parsed value, used for XML where source offsets do not apply. */
export function nodeFromValue(value: JsonValue, key: string | null, index: number | null, depth = 0, parentId = ""): JsonNode {
  const id = parentId === "" ? "$" : index !== null ? `${parentId}[${index}]` : `${parentId}.${key}`;
  const type = typeOf(value);
  let children: JsonNode[] = [];
  if (type === "array") {
    children = (value as JsonValue[]).map((item, position) => nodeFromValue(item, null, position, depth + 1, id));
  } else if (type === "object") {
    children = Object.entries(value as Record<string, JsonValue>).map(([name, item]) => nodeFromValue(item, name, null, depth + 1, id));
  }
  return { id, key, index, value, type, depth, children, start: -1, end: -1 };
}

export interface TreeStats {
  nodes: number;
  maxDepth: number;
  byType: Record<NodeType, number>;
}

export function collectStats(root: JsonNode): TreeStats {
  const byType: Record<NodeType, number> = { object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0 };
  let nodes = 0;
  let maxDepth = 0;
  const walk = (node: JsonNode) => {
    nodes += 1;
    byType[node.type] += 1;
    maxDepth = Math.max(maxDepth, node.depth);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return { nodes, maxDepth, byType };
}

/** The three slices the mockup's composition ring shows. */
export function composition(stats: TreeStats): { label: string; portion: number; tone: string }[] {
  const total = Math.max(1, stats.nodes);
  const groups = [
    { label: "Strings", tone: "green", count: stats.byType.string },
    { label: "Objects/Arrays", tone: "amber", count: stats.byType.object + stats.byType.array },
    { label: "Primitives", tone: "blue", count: stats.byType.number + stats.byType.boolean + stats.byType.null },
  ];
  return groups.map((group) => ({ label: group.label, tone: group.tone, portion: group.count / total }));
}

/** `$.services.cluster_primary.ports[0]`, quoting keys that are not identifiers. */
export function jsonPath(node: JsonNode): string {
  return node.id === "$" ? "$" : node.id;
}

export function pathSegments(node: JsonNode): string[] {
  const segments: string[] = ["root"];
  const raw = node.id.slice(1);
  const matcher = /\.([^.[\]]+)|\[(\d+)\]/g;
  let match = matcher.exec(raw);
  while (match) {
    segments.push(match[1] ?? `[${match[2]}]`);
    match = matcher.exec(raw);
  }
  return segments;
}

export interface FlatRow {
  node: JsonNode;
  expandable: boolean;
  expanded: boolean;
}

/** Depth-first list of the rows currently visible, for virtualised rendering. */
export function flatten(root: JsonNode, expanded: Set<string>, filter?: (node: JsonNode) => boolean): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (node: JsonNode) => {
    const matches = !filter || filter(node) || node.children.some(subtreeMatches(filter));
    if (!matches) return;
    const expandable = node.children.length > 0;
    const isExpanded = expanded.has(node.id);
    rows.push({ node, expandable, expanded: isExpanded });
    if (expandable && isExpanded) for (const child of node.children) walk(child);
  };
  walk(root);
  return rows;
}

function subtreeMatches(filter: (node: JsonNode) => boolean): (node: JsonNode) => boolean {
  const check = (node: JsonNode): boolean => filter(node) || node.children.some(check);
  return check;
}

export function matchingNodes(root: JsonNode, query: string): JsonNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const found: JsonNode[] = [];
  const walk = (node: JsonNode) => {
    const key = node.key ?? (node.index !== null ? `[${node.index}]` : "root");
    const leaf = node.children.length === 0 ? String(node.value) : "";
    if (key.toLowerCase().includes(needle) || leaf.toLowerCase().includes(needle)) found.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return found;
}

/** Every ancestor id of a node, so the tree can reveal a search hit. */
export function ancestorIds(node: JsonNode): string[] {
  const ids: string[] = ["$"];
  const raw = node.id.slice(1);
  const matcher = /\.([^.[\]]+)|\[(\d+)\]/g;
  let current = "$";
  let match = matcher.exec(raw);
  while (match) {
    current += match[0];
    ids.push(current);
    match = matcher.exec(raw);
  }
  return ids.slice(0, -1);
}

export function allExpandableIds(root: JsonNode): string[] {
  const ids: string[] = [];
  const walk = (node: JsonNode) => {
    if (node.children.length) {
      ids.push(node.id);
      for (const child of node.children) walk(child);
    }
  };
  walk(root);
  return ids;
}

export function byteOffset(text: string, characterOffset: number): number {
  if (characterOffset <= 0) return 0;
  return new TextEncoder().encode(text.slice(0, characterOffset)).length;
}

export function previewOf(node: JsonNode): string {
  if (node.type === "string") return JSON.stringify(node.value);
  if (node.type === "object") return `{${node.children.length} ${node.children.length === 1 ? "key" : "keys"}}`;
  if (node.type === "array") return `[${node.children.length} ${node.children.length === 1 ? "item" : "items"}]`;
  return String(node.value);
}

/** Rows for the table view: an array of objects becomes columns plus rows. */
export function tableOf(node: JsonNode): { columns: string[]; rows: (string | undefined)[][] } | null {
  if (node.type !== "array" || node.children.length === 0) return null;
  if (!node.children.every((child) => child.type === "object")) return null;
  const columns: string[] = [];
  for (const child of node.children) {
    for (const grandchild of child.children) {
      if (grandchild.key && !columns.includes(grandchild.key)) columns.push(grandchild.key);
    }
  }
  const rows = node.children.map((child) =>
    columns.map((column) => {
      const cell = child.children.find((grandchild) => grandchild.key === column);
      return cell ? previewOf(cell).replace(/^"|"$/g, "") : undefined;
    }),
  );
  return { columns, rows };
}
