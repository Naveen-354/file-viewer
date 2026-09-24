import type { Insert } from "../../utils/formula";

/** Where new cells go relative to the cell, row or column the user picked. */
export type InsertPlacement = "row-above" | "row-below" | "column-left" | "column-right";

export const PLACEMENTS: { value: InsertPlacement; label: string }[] = [
  { value: "row-above", label: "Entire row above" },
  { value: "row-below", label: "Entire row below" },
  { value: "column-left", label: "Entire column to the left" },
  { value: "column-right", label: "Entire column to the right" },
];

export const MAX_INSERT_COUNT = 1000;

/** Turns a placement around the anchor cell into a grid-relative insert. */
export function insertFor(placement: InsertPlacement, anchor: { row: number; column: number }, count: number): Insert {
  switch (placement) {
    case "row-above": return { axis: "row", index: anchor.row, count };
    case "row-below": return { axis: "row", index: anchor.row + 1, count };
    case "column-left": return { axis: "column", index: anchor.column, count };
    case "column-right": return { axis: "column", index: anchor.column + 1, count };
  }
}
