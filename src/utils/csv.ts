export function detectDelimiter(sample: string): string {
  const candidates = [",", "\t", ";", "|"];
  const lines = sample.split(/\r?\n/).slice(0, 12).filter(Boolean);
  let best = ",";
  let score = -1;
  for (const candidate of candidates) {
    const counts = lines.map((line) => countOutsideQuotes(line, candidate));
    if (!counts.length) continue;
    const common = counts.filter((count) => count === counts[0]).length;
    const candidateScore = counts[0] > 0 ? common * 100 + counts[0] : 0;
    if (candidateScore > score) { score = candidateScore; best = candidate; }
  }
  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false, count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (!quoted && line[i] === delimiter) count++;
  }
  return count;
}
