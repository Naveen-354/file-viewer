/**
 * A small spreadsheet formula engine: enough of Excel's grammar and function
 * library to calculate the everyday number and text formulas people type.
 *
 * Unsupported functions evaluate to `#NAME?`. For formulas read from a file,
 * the viewer checks `canEvaluate` first and keeps the saved value instead.
 */

export interface ErrorValue { error: string }
/** `null` is a blank cell. */
export type Scalar = number | string | boolean | null | ErrorValue;

interface RangeValue { range: Scalar[][] }
type Value = Scalar | RangeValue;

/** Reads a cell by absolute zero-based coordinates. */
export type CellLookup = (row: number, column: number) => Scalar;

export interface Bounds { rows: number; columns: number }

const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;
const MAX_RANGE_CELLS = 1_000_000;

export const ERRORS = {
  div0: "#DIV/0!",
  value: "#VALUE!",
  ref: "#REF!",
  name: "#NAME?",
  num: "#NUM!",
  na: "#N/A",
  circular: "#CIRC!",
} as const;

export function isError(value: unknown): value is ErrorValue {
  return typeof value === "object" && value !== null && "error" in value;
}

const error = (code: string): ErrorValue => ({ error: code });

/** Thrown inside evaluation so an error short-circuits like it does in Excel. */
class Failure {
  constructor(public readonly code: string) {}
}

// ---------------------------------------------------------------------------
// Tokens

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "word"; value: string; qualifier: string | null }
  | { type: "function"; value: string }
  | { type: "error"; value: string }
  | { type: "op"; value: string }
  | { type: "paren"; value: "(" | ")" }
  | { type: "comma" };

const ERROR_LITERAL = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)/i;

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let qualifier: string | null = null;
  while (index < formula.length) {
    const character = formula[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === '"') {
      const end = closingQuote(formula, index, '"');
      tokens.push({ type: "string", value: formula.slice(index + 1, end - 1).replace(/""/g, '"') });
      index = end;
      continue;
    }
    if (character === "'") {
      const end = closingQuote(formula, index, "'");
      if (formula[end] !== "!") throw new Failure(ERRORS.name);
      qualifier = formula.slice(index + 1, end - 1).replace(/''/g, "'");
      index = end + 1;
      continue;
    }
    if (character === "#") {
      const match = ERROR_LITERAL.exec(formula.slice(index));
      if (!match) throw new Failure(ERRORS.name);
      tokens.push({ type: "error", value: match[0].toUpperCase() });
      index += match[0].length;
      continue;
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(formula.slice(index));
    // A run of digits followed by `:` is a row range such as `2:5`.
    if (number && !(formula[index + number[0].length] === ":" && /^\d+$/.test(number[0]))) {
      tokens.push({ type: "number", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    if (isWord(character)) {
      let end = index;
      while (end < formula.length && isWord(formula[end])) end += 1;
      const word = formula.slice(index, end);
      if (formula[end] === "!") { qualifier = word; index = end + 1; continue; }
      if (formula[end] === "(" && qualifier === null) {
        tokens.push({ type: "function", value: word.toUpperCase().replace(/^_XLFN\.(?:_XLWS\.)?/, "") });
      } else {
        tokens.push({ type: "word", value: word, qualifier });
      }
      qualifier = null;
      index = end;
      continue;
    }
    const pair = formula.slice(index, index + 2);
    if (pair === "<=" || pair === ">=" || pair === "<>") {
      tokens.push({ type: "op", value: pair });
      index += 2;
      continue;
    }
    if ("+-*/^&=<>%:".includes(character)) {
      tokens.push({ type: "op", value: character });
      index += 1;
      continue;
    }
    if (character === "(" || character === ")") {
      tokens.push({ type: "paren", value: character });
      index += 1;
      continue;
    }
    if (character === ",") {
      tokens.push({ type: "comma" });
      index += 1;
      continue;
    }
    throw new Failure(ERRORS.name);
  }
  return tokens;
}

function isWord(character: string): boolean {
  return /[\p{L}\p{N}_.$\\]/u.test(character);
}

function closingQuote(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === quote) {
      if (text[index + 1] === quote) { index += 2; continue; }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

// ---------------------------------------------------------------------------
// References

interface CellReference { row: number; column: number }

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;

/** `A` is 0; returns -1 for anything past the last column. */
export function columnIndex(letters: string): number {
  let column = 0;
  for (const character of letters.toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  return column >= 1 && column <= MAX_COLUMN ? column - 1 : -1;
}

function parseCell(word: string): CellReference | null {
  const match = CELL.exec(word);
  if (!match) return null;
  const column = columnIndex(match[2]);
  const row = Number(match[4]);
  if (column < 0 || row < 1 || row > MAX_ROW) return null;
  return { row: row - 1, column };
}

// ---------------------------------------------------------------------------
// Syntax tree

type Node =
  | { kind: "literal"; value: Scalar }
  | { kind: "cell"; row: number; column: number; foreign: boolean }
  | { kind: "range"; top: number; left: number; bottom: number; right: number; foreign: boolean }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "unary"; op: string; operand: Node }
  | { kind: "percent"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node };

class Parser {
  private position = 0;
  constructor(private readonly tokens: Token[], private readonly sheet: string | null) {}

  parse(): Node {
    const node = this.comparison();
    if (this.position < this.tokens.length) throw new Failure(ERRORS.name);
    return node;
  }

  private peek(): Token | undefined { return this.tokens[this.position]; }

  private isOp(...values: string[]): string | null {
    const token = this.peek();
    return token?.type === "op" && values.includes(token.value) ? token.value : null;
  }

  private comparison(): Node {
    let node = this.concat();
    for (let op = this.isOp("=", "<>", "<", ">", "<=", ">="); op; op = this.isOp("=", "<>", "<", ">", "<=", ">=")) {
      this.position += 1;
      node = { kind: "binary", op, left: node, right: this.concat() };
    }
    return node;
  }

  private concat(): Node {
    let node = this.additive();
    while (this.isOp("&")) {
      this.position += 1;
      node = { kind: "binary", op: "&", left: node, right: this.additive() };
    }
    return node;
  }

  private additive(): Node {
    let node = this.multiplicative();
    for (let op = this.isOp("+", "-"); op; op = this.isOp("+", "-")) {
      this.position += 1;
      node = { kind: "binary", op, left: node, right: this.multiplicative() };
    }
    return node;
  }

  private multiplicative(): Node {
    let node = this.power();
    for (let op = this.isOp("*", "/"); op; op = this.isOp("*", "/")) {
      this.position += 1;
      node = { kind: "binary", op, left: node, right: this.power() };
    }
    return node;
  }

  // Excel binds negation tighter than `^`, so -2^2 is 4.
  private power(): Node {
    let node = this.unary();
    while (this.isOp("^")) {
      this.position += 1;
      node = { kind: "binary", op: "^", left: node, right: this.unary() };
    }
    return node;
  }

  private unary(): Node {
    const op = this.isOp("-", "+");
    if (op) {
      this.position += 1;
      return { kind: "unary", op, operand: this.unary() };
    }
    let node = this.primary();
    while (this.isOp("%")) {
      this.position += 1;
      node = { kind: "percent", operand: node };
    }
    return node;
  }

  private primary(): Node {
    const token = this.peek();
    if (!token) throw new Failure(ERRORS.name);
    this.position += 1;
    switch (token.type) {
      case "number": return { kind: "literal", value: token.value };
      case "string": return { kind: "literal", value: token.value };
      case "error": return { kind: "literal", value: error(token.value) };
      case "paren": {
        if (token.value !== "(") throw new Failure(ERRORS.name);
        const node = this.comparison();
        this.expect(")");
        return node;
      }
      case "function": return this.call(token.value);
      case "word": return this.reference(token);
      default: break;
    }
    throw new Failure(ERRORS.name);
  }

  private call(name: string): Node {
    this.expect("(");
    const args: Node[] = [];
    const first = this.peek();
    if (first?.type === "paren" && first.value === ")") {
      this.position += 1;
      return { kind: "call", name, args };
    }
    for (;;) {
      // An empty argument such as IF(A1,,1) is a blank.
      const next = this.peek();
      if (next?.type === "comma" || (next?.type === "paren" && next.value === ")")) args.push({ kind: "literal", value: null });
      else args.push(this.comparison());
      const separator = this.peek();
      this.position += 1;
      if (separator?.type === "comma") continue;
      if (separator?.type === "paren" && separator.value === ")") return { kind: "call", name, args };
      throw new Failure(ERRORS.name);
    }
  }

  private reference(token: Extract<Token, { type: "word" }>): Node {
    const foreign = token.qualifier !== null
      && (this.sheet === null || token.qualifier.toLowerCase() !== this.sheet.toLowerCase());
    const upper = token.value.toUpperCase();
    if (token.qualifier === null && (upper === "TRUE" || upper === "FALSE")) {
      return { kind: "literal", value: upper === "TRUE" };
    }
    if (this.isOp(":")) {
      const second = this.tokens[this.position + 1];
      const secondWord = second?.type === "word" ? second.value : second?.type === "number" ? String(second.value) : null;
      if (secondWord !== null) {
        const range = lineOrCellRange(token.value, secondWord);
        if (range) {
          this.position += 2;
          return { kind: "range", ...range, foreign };
        }
      }
    }
    const cell = parseCell(token.value);
    if (cell) return { kind: "cell", ...cell, foreign };
    if (/^\d+$/.test(token.value)) return { kind: "literal", value: Number(token.value) };
    throw new Failure(ERRORS.name);
  }

  private expect(value: "(" | ")") {
    const token = this.peek();
    if (token?.type !== "paren" || token.value !== value) throw new Failure(ERRORS.name);
    this.position += 1;
  }
}

/** `A1:C3`, `A:C` or `2:5`, normalised so top-left comes first. */
function lineOrCellRange(first: string, second: string) {
  const start = parseCell(first);
  const end = parseCell(second);
  if (start && end) {
    return {
      top: Math.min(start.row, end.row), bottom: Math.max(start.row, end.row),
      left: Math.min(start.column, end.column), right: Math.max(start.column, end.column),
    };
  }
  const strip = (word: string) => word.replace(/^\$/, "");
  const [a, b] = [strip(first), strip(second)];
  if (/^[A-Za-z]{1,3}$/.test(a) && /^[A-Za-z]{1,3}$/.test(b)) {
    const [left, right] = [columnIndex(a), columnIndex(b)];
    if (left < 0 || right < 0) return null;
    return { top: 0, bottom: MAX_ROW - 1, left: Math.min(left, right), right: Math.max(left, right) };
  }
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const [top, bottom] = [Number(a) - 1, Number(b) - 1];
    if (top < 0 || bottom < 0) return null;
    return { top: Math.min(top, bottom), bottom: Math.max(top, bottom), left: 0, right: MAX_COLUMN - 1 };
  }
  return null;
}

const parsed = new Map<string, Node | Failure>();

function parseFormula(formula: string, sheet: string | null): Node {
  const key = `${sheet ?? ""}\u0000${formula}`;
  let node = parsed.get(key);
  if (!node) {
    try {
      node = new Parser(tokenize(formula.replace(/^=/, "")), sheet).parse();
    } catch (reason) {
      if (!(reason instanceof Failure)) throw reason;
      node = reason;
    }
    if (parsed.size > 5000) parsed.clear();
    parsed.set(key, node);
  }
  if (node instanceof Failure) throw node;
  return node;
}

/**
 * Whether the engine can compute `formula` at all: it parses, every function
 * is one the engine knows, and it only reads the sheet it lives on. When it
 * cannot, the value stored in the file is the better answer.
 */
export function canEvaluate(formula: string, sheet: string | null): boolean {
  let node: Node;
  try {
    node = parseFormula(formula, sheet);
  } catch (reason) {
    if (reason instanceof Failure) return false;
    throw reason;
  }
  const known = new Set(FUNCTIONS);
  const visit = (current: Node): boolean => {
    switch (current.kind) {
      case "cell":
      case "range": return !current.foreign;
      case "call": return known.has(current.name) && current.args.every(visit);
      case "unary":
      case "percent": return visit(current.operand);
      case "binary": return visit(current.left) && visit(current.right);
      default: return true;
    }
  };
  return visit(node);
}

// ---------------------------------------------------------------------------
// Evaluation

interface Context { lookup: CellLookup; bounds: Bounds }

/**
 * Evaluates `formula` (with or without its leading `=`). `sheet` is the name
 * of the sheet the formula lives on; references to other sheets are `#REF!`
 * because only one sheet is loaded at a time.
 */
export function evaluate(formula: string, lookup: CellLookup, bounds: Bounds, sheet: string | null = null): Scalar {
  try {
    const result = evaluateNode(parseFormula(formula, sheet), { lookup, bounds });
    const scalar = single(result);
    if (typeof scalar === "number" && !Number.isFinite(scalar)) return error(ERRORS.num);
    // A formula pointing at an empty cell shows 0, as in Excel.
    return scalar === null ? 0 : scalar;
  } catch (reason) {
    if (reason instanceof Failure) return error(reason.code);
    if (reason instanceof RangeError) return error(ERRORS.circular);
    throw reason;
  }
}

function evaluateNode(node: Node, context: Context): Value {
  switch (node.kind) {
    case "literal": return node.value;
    case "cell":
      if (node.foreign) throw new Failure(ERRORS.ref);
      return context.lookup(node.row, node.column);
    case "range": {
      if (node.foreign) throw new Failure(ERRORS.ref);
      // Whole rows and columns only reach as far as the loaded data.
      const bottom = Math.min(node.bottom, context.bounds.rows - 1);
      const right = Math.min(node.right, context.bounds.columns - 1);
      if ((bottom - node.top + 1) * (right - node.left + 1) > MAX_RANGE_CELLS) throw new Failure(ERRORS.num);
      const range: Scalar[][] = [];
      for (let row = node.top; row <= bottom; row += 1) {
        const values: Scalar[] = [];
        for (let column = node.left; column <= right; column += 1) values.push(context.lookup(row, column));
        range.push(values);
      }
      return { range };
    }
    case "unary": {
      const value = toNumber(single(evaluateNode(node.operand, context)));
      return node.op === "-" ? -value : value;
    }
    case "percent": return toNumber(single(evaluateNode(node.operand, context))) / 100;
    case "binary": return binary(node.op, single(evaluateNode(node.left, context)), single(evaluateNode(node.right, context)));
    case "call": return call(node.name, node.args, context);
  }
}

function binary(op: string, left: Scalar, right: Scalar): Scalar {
  if (op === "&") return toText(left) + toText(right);
  if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
    raise(left);
    raise(right);
    const order = compare(left, right);
    switch (op) {
      case "=": return order === 0;
      case "<>": return order !== 0;
      case "<": return order < 0;
      case ">": return order > 0;
      case "<=": return order <= 0;
      default: return order >= 0;
    }
  }
  const a = toNumber(left);
  const b = toNumber(right);
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/":
      if (b === 0) throw new Failure(ERRORS.div0);
      return a / b;
    case "^": {
      const result = a ** b;
      if (!Number.isFinite(result)) throw new Failure(ERRORS.num);
      return result;
    }
  }
  throw new Failure(ERRORS.name);
}

/** Excel orders numbers before text before booleans; text ignores case. */
function compare(left: Scalar, right: Scalar): number {
  const rank = (value: Scalar) => (typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2);
  const blankLike = (value: Scalar, other: Scalar): Scalar =>
    value !== null ? value : typeof other === "string" ? "" : typeof other === "boolean" ? false : 0;
  const a = blankLike(left, right);
  const b = blankLike(right, left);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return Number(a) - Number(b);
}

function single(value: Value): Scalar {
  if (value !== null && typeof value === "object" && "range" in value) {
    if (value.range.length === 1 && value.range[0].length === 1) return value.range[0][0];
    throw new Failure(ERRORS.value);
  }
  return value;
}

function raise(value: Scalar): asserts value is Exclude<Scalar, ErrorValue> {
  if (isError(value)) throw new Failure(value.error);
}

export function toNumber(value: Scalar): number {
  raise(value);
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsedNumber = parseNumber(value);
  if (parsedNumber === null) throw new Failure(ERRORS.value);
  return parsedNumber;
}

/** Numbers typed as text: `12`, ` 1.5e3 `, `50%`, `1,234`. */
function parseNumber(text: string): number | null {
  let trimmed = text.trim().replace(/,(?=\d{3}(?:\D|$))/g, "");
  let scale = 1;
  if (trimmed.endsWith("%")) { trimmed = trimmed.slice(0, -1); scale = 0.01; }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null;
  return Number(trimmed) * scale;
}

export function toText(value: Scalar): string {
  raise(value);
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return formatNumber(value);
  return value;
}

function toBoolean(value: Scalar): boolean {
  raise(value);
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const upper = value.trim().toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  throw new Failure(ERRORS.value);
}

/** Matches the backend: no binary noise, 15 significant digits. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return String(Number(value.toPrecision(15)));
}

// ---------------------------------------------------------------------------
// Functions

type Evaluated = Value[];

function cellsOf(values: Evaluated): { value: Scalar; direct: boolean }[] {
  const cells: { value: Scalar; direct: boolean }[] = [];
  for (const value of values) {
    if (value !== null && typeof value === "object" && "range" in value) {
      for (const row of value.range) for (const cell of row) cells.push({ value: cell, direct: false });
    } else {
      cells.push({ value, direct: true });
    }
  }
  return cells;
}

/**
 * Numbers for SUM and friends: values typed straight into the call are
 * coerced, while text and booleans inside ranges are skipped.
 */
function numbers(values: Evaluated): number[] {
  const result: number[] = [];
  for (const { value, direct } of cellsOf(values)) {
    raise(value);
    if (typeof value === "number") result.push(value);
    else if (direct && value !== null) result.push(toNumber(value));
  }
  return result;
}

function arity(args: unknown[], min: number, max = min) {
  if (args.length < min || args.length > max) throw new Failure(ERRORS.value);
}

function integer(value: Scalar): number {
  return Math.trunc(toNumber(value));
}

function roundTo(value: number, digits: number, mode: "half" | "up" | "down"): number {
  const factor = 10 ** digits;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const rounded = mode === "half" ? Math.round(scaled) : mode === "up" ? Math.ceil(scaled) : Math.floor(scaled);
  return (Math.sign(value) * rounded) / factor;
}

/** SUMIF/COUNTIF criteria: `">5"`, `"<>x"`, `"ab*"`, `10` or a blank. */
function criterion(value: Scalar): (cell: Scalar) => boolean {
  raise(value);
  if (typeof value === "number" || typeof value === "boolean") return (cell) => cell === value;
  const text = value ?? "";
  const match = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(text)!;
  const op = match[1] ?? "=";
  const operand = match[2];
  const target = parseNumber(operand);
  if (target !== null && operand.trim() !== "") {
    return (cell) => {
      if (typeof cell !== "number") return op === "<>";
      switch (op) {
        case "<": return cell < target;
        case ">": return cell > target;
        case "<=": return cell <= target;
        case ">=": return cell >= target;
        case "<>": return cell !== target;
        default: return cell === target;
      }
    };
  }
  if (op === "=" || op === "<>") {
    const pattern = new RegExp(
      `^${operand.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/~?\*/g, (m) => (m === "*" ? ".*" : "\\*")).replace(/~?\?/g, (m) => (m === "?" ? "." : "\\?"))}$`,
      "is",
    );
    const test = (cell: Scalar) => (operand === "" ? cell === null || cell === "" : typeof cell === "string" && pattern.test(cell));
    return op === "=" ? test : (cell) => !test(cell);
  }
  return (cell) => {
    if (typeof cell !== "string") return false;
    const order = compare(cell, operand);
    return op === "<" ? order < 0 : op === ">" ? order > 0 : op === "<=" ? order <= 0 : order >= 0;
  };
}

function rangeCells(value: Value): Scalar[] {
  if (value !== null && typeof value === "object" && "range" in value) return value.range.flat();
  return [value];
}

function conditional(args: Evaluated, mode: "sum" | "count" | "average"): number {
  arity(args, 2, mode === "count" ? 2 : 3);
  const test = criterion(single(args[1]));
  const tested = rangeCells(args[0]);
  const summed = args[2] === undefined ? tested : rangeCells(args[2]);
  let total = 0;
  let count = 0;
  tested.forEach((cell, index) => {
    if (!test(cell)) return;
    count += 1;
    const value = summed[index];
    if (typeof value === "number") total += value;
  });
  if (mode === "count") return count;
  if (mode === "sum") return total;
  if (count === 0) throw new Failure(ERRORS.div0);
  return total / count;
}

/** Excel's TEXT for the common number formats; anything else is left as is. */
function textFormat(value: Scalar, format: string): string {
  const number = toNumber(value);
  const percent = format.endsWith("%");
  const body = percent ? format.slice(0, -1) : format;
  const match = /^(#,##)?0(?:\.(0+))?$/.exec(body);
  if (!match) return toText(value);
  const decimals = match[2]?.length ?? 0;
  const scaled = percent ? number * 100 : number;
  const text = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: !!match[1],
  }).format(roundTo(scaled, decimals, "half"));
  return percent ? `${text}%` : text;
}

const LAZY = new Set(["IF", "IFERROR", "IFNA", "IFS", "AND", "OR", "SWITCH"]);

function call(name: string, nodes: Node[], context: Context): Value {
  if (LAZY.has(name)) return lazyCall(name, nodes, context);
  const args = nodes.map((node) => evaluateNode(node, context));
  const at = (index: number) => single(args[index] ?? null);
  const text = (index: number) => toText(at(index));
  switch (name) {
    // Numbers
    case "SUM": return numbers(args).reduce((sum, value) => sum + value, 0);
    case "PRODUCT": return numbers(args).reduce((product, value) => product * value, 1);
    case "AVERAGE": {
      const values = numbers(args);
      if (!values.length) throw new Failure(ERRORS.div0);
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    }
    case "MIN": { const values = numbers(args); return values.length ? Math.min(...values) : 0; }
    case "MAX": { const values = numbers(args); return values.length ? Math.max(...values) : 0; }
    case "MEDIAN": {
      const values = numbers(args).sort((a, b) => a - b);
      if (!values.length) throw new Failure(ERRORS.num);
      const middle = Math.floor(values.length / 2);
      return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    }
    case "COUNT": return cellsOf(args).filter(({ value, direct }) => typeof value === "number" || (direct && typeof value === "string" && parseNumber(value) !== null)).length;
    case "COUNTA": return cellsOf(args).filter(({ value }) => value !== null).length;
    case "COUNTBLANK": return cellsOf(args).filter(({ value }) => value === null || value === "").length;
    case "SUMIF": return conditional(args, "sum");
    case "COUNTIF": return conditional(args, "count");
    case "AVERAGEIF": return conditional(args, "average");
    case "ROUND": arity(args, 1, 2); return roundTo(toNumber(at(0)), integer(at(1)), "half");
    case "ROUNDUP": arity(args, 1, 2); return roundTo(toNumber(at(0)), integer(at(1)), "up");
    case "ROUNDDOWN": arity(args, 1, 2); return roundTo(toNumber(at(0)), integer(at(1)), "down");
    case "INT": arity(args, 1); return Math.floor(toNumber(at(0)));
    case "ABS": arity(args, 1); return Math.abs(toNumber(at(0)));
    case "SQRT": {
      arity(args, 1);
      const value = toNumber(at(0));
      if (value < 0) throw new Failure(ERRORS.num);
      return Math.sqrt(value);
    }
    case "POWER": arity(args, 2); return binary("^", at(0), at(1));
    case "MOD": {
      arity(args, 2);
      const divisor = toNumber(at(1));
      if (divisor === 0) throw new Failure(ERRORS.div0);
      const dividend = toNumber(at(0));
      return dividend - divisor * Math.floor(dividend / divisor);
    }
    case "PI": arity(args, 0); return Math.PI;
    // Logic
    case "NOT": arity(args, 1); return !toBoolean(at(0));
    case "TRUE": arity(args, 0); return true;
    case "FALSE": arity(args, 0); return false;
    // Text
    case "CONCAT":
    case "CONCATENATE": return cellsOf(args).map(({ value }) => toText(value)).join("");
    case "TEXTJOIN": {
      if (args.length < 3) throw new Failure(ERRORS.value);
      const delimiter = text(0);
      const skipEmpty = toBoolean(at(1));
      return cellsOf(args.slice(2)).map(({ value }) => toText(value)).filter((value) => !skipEmpty || value !== "").join(delimiter);
    }
    case "LEN": arity(args, 1); return [...text(0)].length;
    case "UPPER": arity(args, 1); return text(0).toUpperCase();
    case "LOWER": arity(args, 1); return text(0).toLowerCase();
    case "PROPER": arity(args, 1); return text(0).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
    case "TRIM": arity(args, 1); return text(0).trim().replace(/ {2,}/g, " ");
    case "LEFT": {
      arity(args, 1, 2);
      const count = args.length > 1 ? integer(at(1)) : 1;
      if (count < 0) throw new Failure(ERRORS.value);
      return [...text(0)].slice(0, count).join("");
    }
    case "RIGHT": {
      arity(args, 1, 2);
      const count = args.length > 1 ? integer(at(1)) : 1;
      if (count < 0) throw new Failure(ERRORS.value);
      const characters = [...text(0)];
      return count === 0 ? "" : characters.slice(-count).join("");
    }
    case "MID": {
      arity(args, 3);
      const start = integer(at(1));
      const count = integer(at(2));
      if (start < 1 || count < 0) throw new Failure(ERRORS.value);
      return [...text(0)].slice(start - 1, start - 1 + count).join("");
    }
    case "SUBSTITUTE": {
      arity(args, 3, 4);
      const source = text(0);
      const from = text(1);
      const to = text(2);
      if (!from) return source;
      if (args.length < 4) return source.split(from).join(to);
      const nth = integer(at(3));
      if (nth < 1) throw new Failure(ERRORS.value);
      let index = -1;
      for (let seen = 0; seen < nth; seen += 1) {
        index = source.indexOf(from, index + 1);
        if (index < 0) return source;
      }
      return source.slice(0, index) + to + source.slice(index + from.length);
    }
    case "REPLACE": {
      arity(args, 4);
      const characters = [...text(0)];
      const start = integer(at(1));
      const count = integer(at(2));
      if (start < 1 || count < 0) throw new Failure(ERRORS.value);
      characters.splice(start - 1, count, text(3));
      return characters.join("");
    }
    case "FIND":
    case "SEARCH": {
      arity(args, 2, 3);
      const needle = name === "FIND" ? text(0) : text(0).toLowerCase();
      const haystack = name === "FIND" ? text(1) : text(1).toLowerCase();
      const start = args.length > 2 ? integer(at(2)) : 1;
      if (start < 1 || start > haystack.length + 1) throw new Failure(ERRORS.value);
      const found = haystack.indexOf(needle, start - 1);
      if (found < 0) throw new Failure(ERRORS.value);
      return found + 1;
    }
    case "REPT": {
      arity(args, 2);
      const times = integer(at(1));
      if (times < 0 || text(0).length * times > 32_767) throw new Failure(ERRORS.value);
      return text(0).repeat(times);
    }
    case "EXACT": arity(args, 2); return text(0) === text(1);
    case "VALUE": arity(args, 1); return toNumber(at(0));
    case "TEXT": arity(args, 2); return textFormat(at(0), text(1));
    // Information
    case "ISBLANK": arity(args, 1); return at(0) === null;
    case "ISNUMBER": arity(args, 1); return typeof at(0) === "number";
    case "ISTEXT": arity(args, 1); return typeof at(0) === "string";
    case "ISERROR": arity(args, 1); return isError(at(0));
    default: throw new Failure(ERRORS.name);
  }
}

function lazyCall(name: string, nodes: Node[], context: Context): Value {
  const evaluateAt = (index: number) => single(evaluateNode(nodes[index], context));
  const attempt = (index: number): Scalar => {
    try {
      return evaluateAt(index);
    } catch (reason) {
      if (reason instanceof Failure) return error(reason.code);
      throw reason;
    }
  };
  switch (name) {
    case "IF": {
      arity(nodes, 2, 3);
      if (toBoolean(evaluateAt(0))) return evaluateAt(1);
      return nodes.length > 2 ? evaluateAt(2) : false;
    }
    case "IFERROR":
    case "IFNA": {
      arity(nodes, 2);
      const value = attempt(0);
      const caught = isError(value) && (name === "IFERROR" || value.error === ERRORS.na);
      return caught ? evaluateAt(1) : value;
    }
    case "IFS": {
      if (nodes.length < 2 || nodes.length % 2) throw new Failure(ERRORS.value);
      for (let index = 0; index < nodes.length; index += 2) {
        if (toBoolean(evaluateAt(index))) return evaluateAt(index + 1);
      }
      throw new Failure(ERRORS.na);
    }
    case "SWITCH": {
      if (nodes.length < 3) throw new Failure(ERRORS.value);
      const subject = evaluateAt(0);
      raise(subject);
      let index = 1;
      for (; index + 1 < nodes.length; index += 2) {
        if (compare(subject, evaluateAt(index)) === 0) return evaluateAt(index + 1);
      }
      if (index < nodes.length) return evaluateAt(index);
      throw new Failure(ERRORS.na);
    }
    case "AND":
    case "OR": {
      if (!nodes.length) throw new Failure(ERRORS.value);
      const flags: boolean[] = [];
      for (const { value, direct } of cellsOf(nodes.map((node) => evaluateNode(node, context)))) {
        raise(value);
        if (typeof value === "boolean" || typeof value === "number") flags.push(toBoolean(value));
        else if (direct && value !== null) flags.push(toBoolean(value));
      }
      if (!flags.length) throw new Failure(ERRORS.value);
      return name === "AND" ? flags.every(Boolean) : flags.some(Boolean);
    }
  }
  throw new Failure(ERRORS.name);
}

/** Every function the engine knows, for the formula bar's hint. */
export const FUNCTIONS = [
  "SUM", "AVERAGE", "MIN", "MAX", "MEDIAN", "COUNT", "COUNTA", "COUNTBLANK", "PRODUCT",
  "SUMIF", "COUNTIF", "AVERAGEIF", "ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "ABS", "SQRT",
  "POWER", "MOD", "PI", "TRUE", "FALSE", "IF", "IFS", "IFERROR", "IFNA", "SWITCH", "AND", "OR", "NOT",
  "CONCAT", "CONCATENATE", "TEXTJOIN", "LEN", "UPPER", "LOWER", "PROPER", "TRIM", "LEFT",
  "RIGHT", "MID", "SUBSTITUTE", "REPLACE", "FIND", "SEARCH", "REPT", "EXACT", "VALUE",
  "TEXT", "ISBLANK", "ISNUMBER", "ISTEXT", "ISERROR",
];

// ---------------------------------------------------------------------------
// Typed input

/** Mirrors how the backend stores typed input, so the preview matches the file. */
export function classifyInput(raw: string): Scalar {
  if (raw.startsWith("'")) return raw.slice(1);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  return raw;
}

export function isFormula(raw: string): boolean {
  return raw.startsWith("=") && raw.trim().length > 1;
}

// ---------------------------------------------------------------------------
// Structural shifts

export interface Insert { axis: "row" | "column"; index: number; count: number }

/**
 * Moves references at or after an inserted row or column, the same way the
 * backend rewrites the file. Unqualified references and ones naming `sheet`
 * move; strings, functions and other sheets are left alone. References that
 * would fall off the sheet become `#REF!`.
 */
export function shiftFormula(formula: string, insert: Insert, sheet: string | null): string {
  let output = "";
  let index = 0;
  let qualifier: string | null = null;
  let external = false;
  const applies = () => !external && (qualifier === null || (sheet !== null && qualifier.toLowerCase() === sheet.toLowerCase()));
  while (index < formula.length) {
    const character = formula[index];
    if (character === '"') {
      const end = closingQuote(formula, index, '"');
      output += formula.slice(index, end);
      index = end;
      qualifier = null;
      external = false;
      continue;
    }
    if (character === "'") {
      const end = closingQuote(formula, index, "'");
      output += formula.slice(index, end);
      if (formula[end] === "!") {
        qualifier = formula.slice(index + 1, end - 1).replace(/''/g, "'");
        external = qualifier.startsWith("[");
        output += "!";
        index = end + 1;
      } else {
        index = end;
      }
      continue;
    }
    if (character === "[") {
      const start = index;
      let depth = 0;
      while (index < formula.length) {
        if (formula[index] === "[") depth += 1;
        if (formula[index] === "]") {
          depth -= 1;
          if (depth === 0) { index += 1; break; }
        }
        index += 1;
      }
      output += formula.slice(start, index);
      external = true;
      qualifier = null;
      continue;
    }
    if (character === ":") { output += ":"; index += 1; continue; }
    if (isWord(character)) {
      let end = index;
      while (end < formula.length && isWord(formula[end])) end += 1;
      const word = formula.slice(index, end);
      index = end;
      if (formula[index] === "!") {
        qualifier = word;
        output += `${word}!`;
        index += 1;
        continue;
      }
      if (formula[index] === "(") {
        output += word;
        qualifier = null;
        external = false;
        continue;
      }
      if (formula[index] === ":") {
        let secondEnd = index + 1;
        while (secondEnd < formula.length && isWord(formula[secondEnd])) secondEnd += 1;
        const line = shiftLineRange(word, formula.slice(index + 1, secondEnd), insert, applies());
        if (line !== null) {
          output += line;
          index = secondEnd;
          qualifier = null;
          external = false;
          continue;
        }
      }
      output += applies() ? shiftCell(word, insert) : word;
      if (formula[index] !== ":") { qualifier = null; external = false; }
      continue;
    }
    output += character;
    index += 1;
    qualifier = null;
    external = false;
  }
  return output;
}

function shiftCell(word: string, insert: Insert): string {
  const match = CELL.exec(word);
  const cell = parseCell(word);
  if (!match || !cell) return word;
  let { row, column } = cell;
  if (insert.axis === "row" && row >= insert.index) row += insert.count;
  if (insert.axis === "column" && column >= insert.index) column += insert.count;
  if (row >= MAX_ROW || column >= MAX_COLUMN) return ERRORS.ref;
  return `${match[1]}${columnLetters(column)}${match[3]}${row + 1}`;
}

function shiftLineRange(first: string, second: string, insert: Insert, shift: boolean): string | null {
  const split = (word: string) => (word.startsWith("$") ? ["$", word.slice(1)] : ["", word]);
  const [firstMarker, firstBody] = split(first);
  const [secondMarker, secondBody] = split(second);
  const letters = (body: string) => /^[A-Za-z]{1,3}$/.test(body) && columnIndex(body) >= 0;
  const digits = (body: string) => /^\d+$/.test(body) && Number(body) >= 1;
  if (letters(firstBody) && letters(secondBody)) {
    const move = (body: string) => {
      const column = columnIndex(body);
      const moved = shift && insert.axis === "column" && column >= insert.index ? column + insert.count : column;
      return moved >= MAX_COLUMN ? null : columnLetters(moved);
    };
    const [a, b] = [move(firstBody), move(secondBody)];
    return a === null || b === null ? ERRORS.ref : `${firstMarker}${a}:${secondMarker}${b}`;
  }
  if (digits(firstBody) && digits(secondBody)) {
    const move = (body: string) => {
      const row = Number(body);
      const moved = shift && insert.axis === "row" && row - 1 >= insert.index ? row + insert.count : row;
      return moved > MAX_ROW ? null : moved;
    };
    const [a, b] = [move(firstBody), move(secondBody)];
    return a === null || b === null ? ERRORS.ref : `${firstMarker}${a}:${secondMarker}${b}`;
  }
  return null;
}

function columnLetters(index: number): string {
  let name = "";
  for (let value = index; value >= 0; value = Math.floor(value / 26) - 1) {
    name = String.fromCharCode(65 + (value % 26)) + name;
  }
  return name;
}
