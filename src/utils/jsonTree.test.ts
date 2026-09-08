import { describe, expect, it } from "vitest";
import {
  allExpandableIds, ancestorIds, byteOffset, collectStats, composition, flatten,
  matchingNodes, nodeFromValue, parseWithOffsets, pathSegments, previewOf, tableOf,
} from "./jsonTree";

const SAMPLE = `{
  "version": 3.2,
  "telemetry_active": false,
  "metadata": { "region_id": 104, "immutable": true },
  "services": { "cluster_primary": { "networking": { "ingress": { "ports": [8080, 8443, 9090] } } } },
  "policies": ["app-armor", "rbac"]
}`;

describe("parsing with source offsets", () => {
  it("produces the same value JSON.parse does", () => {
    expect(parseWithOffsets(SAMPLE).value).toEqual(JSON.parse(SAMPLE));
  });

  it("records offsets that slice the exact source text back out", () => {
    const root = parseWithOffsets(SAMPLE);
    const version = root.children.find((child) => child.key === "version")!;
    expect(SAMPLE.slice(version.start, version.end)).toBe("3.2");

    const policies = root.children.find((child) => child.key === "policies")!;
    expect(SAMPLE.slice(policies.start, policies.end)).toBe('["app-armor", "rbac"]');

    const ports = root.children
      .find((child) => child.key === "services")!.children[0].children[0].children[0].children[0];
    expect(ports.id).toBe("$.services.cluster_primary.networking.ingress.ports");
    expect(SAMPLE.slice(ports.children[1].start, ports.children[1].end)).toBe("8443");
  });

  it("keeps offsets correct after escaped quotes and unicode", () => {
    const text = '{"a":"say \\"hi\\" \\u00e9","b":7}';
    const root = parseWithOffsets(text);
    expect(root.children[0].value).toBe('say "hi" é');
    expect(text.slice(root.children[1].start, root.children[1].end)).toBe("7");
  });

  it("builds ids that are valid JSONPath", () => {
    const root = parseWithOffsets(SAMPLE);
    const ports = root.children.find((child) => child.key === "services")!
      .children[0].children[0].children[0].children[0];
    expect(ports.children[0].id).toBe("$.services.cluster_primary.networking.ingress.ports[0]");
    expect(pathSegments(ports.children[0])).toEqual([
      "root", "services", "cluster_primary", "networking", "ingress", "ports", "[0]",
    ]);
  });

  it("reports depth from the root", () => {
    const root = parseWithOffsets(SAMPLE);
    expect(root.depth).toBe(0);
    const ports = root.children.find((child) => child.key === "services")!
      .children[0].children[0].children[0].children[0];
    expect(ports.children[0].depth).toBe(6);
  });

  it("rejects malformed documents with a located message", () => {
    expect(() => parseWithOffsets('{"a": }')).toThrow(/line 1/);
    expect(() => parseWithOffsets('{"a": 1')).toThrow();
    expect(() => parseWithOffsets("{} trailing")).toThrow(/trailing/i);
    expect(() => parseWithOffsets('{"a": 01x}')).toThrow();
  });

  it("handles empty containers and nesting", () => {
    const root = parseWithOffsets('{"a":{},"b":[],"c":[[1]]}');
    expect(root.children.map((child) => child.type)).toEqual(["object", "array", "array"]);
    expect(root.children[2].children[0].children[0].value).toBe(1);
  });
});

describe("tree statistics", () => {
  it("counts every node and the deepest level", () => {
    const stats = collectStats(parseWithOffsets(SAMPLE));
    expect(stats.nodes).toBeGreaterThan(10);
    expect(stats.maxDepth).toBe(6);
    expect(stats.byType.number).toBe(5);
    expect(stats.byType.boolean).toBe(2);
  });

  it("splits composition into portions that sum to one", () => {
    const parts = composition(collectStats(parseWithOffsets(SAMPLE)));
    const total = parts.reduce((sum, part) => sum + part.portion, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(parts.map((part) => part.label)).toEqual(["Strings", "Objects/Arrays", "Primitives"]);
  });
});

describe("tree flattening and search", () => {
  const root = parseWithOffsets(SAMPLE);

  it("shows only expanded branches", () => {
    expect(flatten(root, new Set()).length).toBe(1);
    expect(flatten(root, new Set(["$"])).length).toBe(1 + root.children.length);
  });

  it("expands every branch when asked", () => {
    const ids = allExpandableIds(root);
    expect(ids).toContain("$");
    expect(flatten(root, new Set(ids)).length).toBe(collectStats(root).nodes);
  });

  it("finds matches by key and by value", () => {
    expect(matchingNodes(root, "region_id").map((node) => node.id)).toEqual(["$.metadata.region_id"]);
    expect(matchingNodes(root, "8443")[0].id).toBe("$.services.cluster_primary.networking.ingress.ports[1]");
    expect(matchingNodes(root, "")).toEqual([]);
  });

  it("lists the ancestors needed to reveal a match", () => {
    const match = matchingNodes(root, "8443")[0];
    expect(ancestorIds(match)).toEqual([
      "$", "$.services", "$.services.cluster_primary", "$.services.cluster_primary.networking",
      "$.services.cluster_primary.networking.ingress",
      "$.services.cluster_primary.networking.ingress.ports",
    ]);
  });

  it("keeps a filtered branch when a descendant matches", () => {
    const rows = flatten(root, new Set(allExpandableIds(root)), (node) => node.key === "region_id");
    const ids = rows.map((row) => row.node.id);
    expect(ids).toContain("$.metadata.region_id");
    expect(ids).toContain("$.metadata");
    expect(ids).not.toContain("$.policies");
  });
});

describe("presentation helpers", () => {
  it("summarises containers and quotes strings", () => {
    const root = parseWithOffsets(SAMPLE);
    expect(previewOf(root)).toBe("{5 keys}");
    expect(previewOf(root.children.find((child) => child.key === "policies")!)).toBe("[2 items]");
    expect(previewOf(root.children.find((child) => child.key === "version")!)).toBe("3.2");
  });

  it("converts an array of objects into table columns", () => {
    const root = parseWithOffsets('{"rows":[{"a":1,"b":"x"},{"a":2,"c":true}]}');
    const table = tableOf(root.children[0])!;
    expect(table.columns).toEqual(["a", "b", "c"]);
    expect(table.rows).toEqual([["1", "x", undefined], ["2", undefined, "true"]]);
  });

  it("refuses a table for anything that is not an array of objects", () => {
    const root = parseWithOffsets('{"a":[1,2],"b":{},"c":[]}');
    expect(tableOf(root.children[0])).toBeNull();
    expect(tableOf(root.children[1])).toBeNull();
    expect(tableOf(root.children[2])).toBeNull();
  });

  it("measures byte offsets, not character offsets", () => {
    const text = '{"é":1}';
    expect(byteOffset(text, 0)).toBe(0);
    expect(byteOffset(text, 5)).toBe(6);
  });

  it("wraps a plain value when offsets are unavailable", () => {
    const node = nodeFromValue({ a: [1] }, null, null);
    expect(node.start).toBe(-1);
    expect(node.children[0].children[0].id).toBe("$.a[0]");
  });
});
