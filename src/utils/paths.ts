/**
 * Windows canonicalisation returns verbatim paths (`\\?\C:\...`), so the path
 * on an open tab and the path a workspace stored can name the same file with
 * different text. Comparisons go through here rather than `===`.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase();
}

export function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

/** The stored spelling of `path` in `paths`, or null when it is absent. */
export function findPath(paths: { path: string }[], path: string): string | null {
  return paths.find((entry) => samePath(entry.path, path))?.path ?? null;
}
