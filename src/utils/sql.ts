/**
 * SQL analysis for the SQL viewer's inspector and outline.
 *
 * Everything here reads the script as written. Nothing connects to a database,
 * so what the panel reports is exactly what the file says.
 */

/** Keywords the formatter is allowed to change the case of. */
const KEYWORDS = [
  "ADD", "ALL", "ALTER", "AND", "AS", "ASC", "BEFORE", "BEGIN", "BETWEEN", "BY", "CASCADE",
  "CASE", "CHECK", "COLLATE", "COLUMN", "COMMIT", "CONSTRAINT", "CREATE", "CROSS", "DECLARE",
  "DEFAULT", "DELETE", "DESC", "DISTINCT", "DO", "DROP", "EACH", "ELSE", "END", "EXCEPT",
  "EXECUTE", "EXISTS", "EXTENSION", "FOR", "FOREIGN", "FROM", "FULL", "FUNCTION", "GRANT",
  "GROUP", "HAVING", "IF", "IN", "INDEX", "INNER", "INSERT", "INTERSECT", "INTO", "IS", "JOIN",
  "KEY", "LANGUAGE", "LEFT", "LIKE", "LIMIT", "NOT", "NULL", "OFFSET", "ON", "OR", "ORDER",
  "OUTER", "PRIMARY", "PROCEDURE", "REFERENCES", "REPLACE", "RESTRICT", "RETURNING", "RETURN",
  "RETURNS", "REVOKE", "RIGHT", "ROLLBACK", "ROW", "SCHEMA", "SELECT", "SEQUENCE", "SET",
  "TABLE", "TEMPORARY", "THEN", "TRIGGER", "TRUNCATE", "TYPE", "UNION", "UNIQUE", "UPDATE",
  "USING", "VALUES", "VIEW", "WHEN", "WHERE", "WITH",
];
const KEYWORD_SET = new Set(KEYWORDS);

interface MaskOptions {
  comments?: boolean;
  strings?: boolean;
  dollar?: boolean;
  identifiers?: boolean;
}

/**
 * Replaces the contents of the selected constructs with spaces, keeping every
 * offset and newline intact, so a masked copy can be scanned with plain regular
 * expressions and the matches still point at the right place in the original.
 *
 * In SQL only `'…'` is a string. Double quotes, backticks and brackets quote
 * *identifiers*, so they are masked only when a caller asks for it.
 */
function mask(text: string, options: MaskOptions): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== "\n") out[index] = " ";
    }
  };
  const closers: Record<string, string> = { "\"": "\"", "`": "`", "[": "]" };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (options.comments && char === "-" && next === "-") {
      const end = indexOrEnd(text, "\n", index);
      blank(index, end);
      index = end;
      continue;
    }
    if (options.comments && char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (options.dollar && char === "$") {
      // PostgreSQL dollar quoting: $$ … $$ or $tag$ … $tag$.
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(index));
      if (tag) {
        const marker = tag[0];
        const end = text.indexOf(marker, index + marker.length);
        const stop = end === -1 ? text.length : end + marker.length;
        blank(index, stop);
        index = stop;
        continue;
      }
    }
    const quoted = (options.strings && char === "'") || (options.identifiers && char in closers);
    if (quoted) {
      const closer = char === "'" ? "'" : closers[char];
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") { cursor += 2; continue; }
        // A doubled quote inside the run is an escape, not the end of it.
        if (text[cursor] === closer && text[cursor + 1] === closer) { cursor += 2; continue; }
        if (text[cursor] === closer) { cursor += 1; break; }
        cursor += 1;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/** Comments only, so quoting syntax the dialect guess depends on survives. */
export function maskComments(text: string): string {
  return mask(text, { comments: true });
}

/** Comments, string literals and dollar-quoted bodies. Identifiers survive. */
export function maskNoise(text: string): string {
  return mask(text, { comments: true, strings: true, dollar: true });
}

/** Everything a keyword must never be found inside, identifiers included. */
export function maskLiterals(text: string): string {
  return mask(text, { comments: true, strings: true, dollar: true, identifiers: true });
}

function indexOrEnd(text: string, needle: string, from: number): number {
  const found = text.indexOf(needle, from);
  return found === -1 ? text.length : found;
}

export type SqlObjectKind =
  | "table" | "index" | "view" | "trigger" | "function" | "procedure"
  | "type" | "schema" | "sequence" | "extension";

export interface SqlObject {
  kind: SqlObjectKind;
  name: string;
  line: number;
  offset: number;
}

const OBJECT_PATTERN = new RegExp(
  "\\bCREATE\\s+" +
  "(?:OR\\s+REPLACE\\s+)?(?:GLOBAL\\s+|LOCAL\\s+)?(?:TEMP(?:ORARY)?\\s+)?(?:UNLOGGED\\s+)?(?:UNIQUE\\s+)?" +
  "(?:MATERIALIZED\\s+)?" +
  "(TABLE|INDEX|VIEW|TRIGGER|FUNCTION|PROCEDURE|TYPE|SCHEMA|SEQUENCE|EXTENSION)\\s+" +
  "(?:IF\\s+NOT\\s+EXISTS\\s+)?" +
  "([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?|\"[^\"]+\"|`[^`]+`|\\[[^\\]]+\\])",
  "gi",
);

/**
 * The objects a script creates, in file order.
 *
 * The masked copy decides where a match is allowed; the original text supplies
 * the name, so a quoted identifier keeps its real spelling.
 */
export function parseObjects(text: string): SqlObject[] {
  const masked = maskNoise(text);
  const objects: SqlObject[] = [];
  for (const match of masked.matchAll(OBJECT_PATTERN)) {
    const offset = match.index ?? 0;
    const nameOffset = offset + match[0].length - match[2].length;
    objects.push({
      kind: match[1].toLowerCase() as SqlObjectKind,
      name: unquote(text.slice(nameOffset, nameOffset + match[2].length)),
      line: lineAt(masked, offset),
      offset,
    });
  }
  return objects;
}

function unquote(name: string): string {
  const first = name[0];
  if (first === '"' || first === "`") return name.slice(1, -1);
  if (first === "[") return name.slice(1, -1);
  return name;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

/** Statements are counted by the semicolons outside strings and comments. */
export function countStatements(text: string): number {
  const masked = maskNoise(text);
  let count = 0;
  for (const char of masked) if (char === ";") count += 1;
  return count;
}

export interface DialectGuess { name: string; because: string }

/**
 * A best-effort dialect guess from syntax that only one engine accepts. It is
 * labelled as a guess in the UI, and no version is reported: nothing in a
 * script states the server version it was written for.
 */
export function detectDialect(text: string): DialectGuess | null {
  // Comments are removed, but strings are not: `LANGUAGE 'plpgsql'` is a marker.
  const masked = maskComments(text);
  const markers: { name: string; because: string; pattern: RegExp }[] = [
    { name: "PostgreSQL", because: "$$-quoted body", pattern: /\$\$|\$[A-Za-z_]\w*\$/ },
    { name: "PostgreSQL", because: "plpgsql", pattern: /\bLANGUAGE\s+'?plpgsql/i },
    { name: "PostgreSQL", because: "::cast syntax", pattern: /::\s*[A-Za-z_]\w*/ },
    { name: "PostgreSQL", because: "SERIAL column", pattern: /\b(?:BIG|SMALL)?SERIAL\b/i },
    { name: "PostgreSQL", because: "RETURNING clause", pattern: /\bRETURNING\b/i },
    { name: "MySQL", because: "AUTO_INCREMENT", pattern: /\bAUTO_INCREMENT\b/i },
    { name: "MySQL", because: "ENGINE= table option", pattern: /\bENGINE\s*=/i },
    { name: "MySQL", because: "backtick identifiers", pattern: /`[^`\n]+`/ },
    { name: "SQLite", because: "PRAGMA statement", pattern: /\bPRAGMA\b/i },
    { name: "SQLite", because: "AUTOINCREMENT", pattern: /\bAUTOINCREMENT\b/i },
    { name: "SQL Server", because: "bracket identifiers", pattern: /\[[A-Za-z_]\w*\]/ },
    { name: "SQL Server", because: "NVARCHAR column", pattern: /\bNVARCHAR\b/i },
    { name: "SQL Server", because: "GO batch separator", pattern: /^\s*GO\s*$/im },
    { name: "Oracle", because: "VARCHAR2 column", pattern: /\bVARCHAR2\b/i },
    { name: "Oracle", because: "NUMBER column", pattern: /\bNUMBER\s*\(/i },
  ];
  const scores = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const marker of markers) {
    if (!marker.pattern.test(masked)) continue;
    counts.set(marker.name, (counts.get(marker.name) ?? 0) + 1);
    if (!scores.has(marker.name)) scores.set(marker.name, marker.because);
  }
  let best: string | null = null;
  for (const [name, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = name;
  }
  return best ? { name: best, because: scores.get(best)! } : null;
}

export type LineEnding = "LF" | "CRLF" | "CR" | "Mixed" | "None";

export function lineEndingOf(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const used = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (used === 0) return "None";
  if (used > 1) return "Mixed";
  if (crlf) return "CRLF";
  return lf ? "LF" : "CR";
}

export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split(/\r\n|\r|\n/).length;
}

/**
 * A conservative tidy-up, not a re-layout.
 *
 * It upper-cases reserved words, strips trailing whitespace and collapses runs
 * of blank lines. Statements are never re-wrapped or re-indented, so nothing a
 * hand-formatted script relies on is thrown away. Strings, comments and
 * dollar-quoted bodies are left exactly as they are.
 */
export function formatSql(text: string): string {
  const masked = maskLiterals(text);
  const characters = text.split("");
  for (const match of masked.matchAll(/[A-Za-z_]\w*/g)) {
    const word = match[0].toUpperCase();
    if (!KEYWORD_SET.has(word)) continue;
    const offset = match.index ?? 0;
    // A word touching a dot is part of a qualified name, not a keyword.
    if (masked[offset - 1] === "." || masked[offset + match[0].length] === ".") continue;
    for (let index = 0; index < word.length; index += 1) characters[offset + index] = word[index];
  }
  return characters
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
