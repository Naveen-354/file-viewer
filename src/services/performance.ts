const enabled = import.meta.env.DEV;

export function mark(name: string): void {
  if (enabled) performance.mark(name);
}

export function measure(name: string, start: string): void {
  if (!enabled) return;
  performance.measure(name, start);
  const entry = performance.getEntriesByName(name).at(-1);
  if (entry) console.debug(`[perf] ${name}: ${entry.duration.toFixed(1)}ms`);
}
