import { truncate } from '../state.js';
import { pathsIn } from './rules.js';
import type { Ledger, NormalizedEvent } from './events.js';

/**
 * A light dependency graph from a later message to the earlier tool result it
 * relies on. Upstream protects a result only by recency and error state; this
 * lets `protectionsFor`'s `referenced_later` rule (see `rules.ts`) also protect
 * a result that later text explicitly names by path, symbol, error or quote,
 * even when it is old (plan section 11.C).
 */

export interface DependencyEdge {
  /** The later event (assistant_text / user_text / tool_use) that references the earlier one. */
  from: string;
  /** The earlier tool_result event id being referenced. */
  to: string;
  /** What matched. */
  via: 'path' | 'symbol' | 'error' | 'quote' | 'tool_id';
  /** The matched fragment (bounded to ~120 chars). */
  fragment: string;
}

export interface DependencyGraph {
  edges: DependencyEdge[];
  /** result event id → ids of later events that reference it (deduped, in order). */
  referencedBy: Map<string, string[]>;
}

export interface DependencyOptions {
  /**
   * Ignore assistant references from within this many messages after the
   * result (the immediate follow-up always "references" it). A user message
   * that quotes a result counts at any distance. Default 2.
   */
  minMessageGap?: number;
  /** Minimum identifier length to count as a symbol. Default 6. */
  minSymbolLength?: number;
  /** Maximum result events to index (newest first beyond it are skipped) for cost. Default 5000. */
  maxResults?: number;
}

const DEFAULT_MIN_MESSAGE_GAP = 2;
const DEFAULT_MIN_SYMBOL_LENGTH = 6;
const DEFAULT_MAX_RESULTS = 5000;
const MAX_SYMBOLS_PER_TEXT = 200;
const MAX_QUOTES_PER_TEXT = 100;
const MIN_QUOTE_LENGTH = 40;
/** A symbol occurring in more than this many results is too common to be a signal. */
const MAX_RESULTS_PER_SYMBOL = 3;

/** Lines matching this read as an error signature worth anchoring on. */
export const ERROR_LINE_RE =
  /\b(Error|Exception|FAIL|failed|panic|Traceback|errno|ENOENT|EACCES|TypeError|ReferenceError|SyntaxError)\b/;
const ERROR_CLASS_RE = /\b[A-Z][A-Za-z]*Error\b/g;

const SYMBOL_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
/** camelCase, snake_case, PascalCase or anything with a digit: "looks like a code name". */
const LOOKS_LIKE_CODE = /[A-Z]|[_$]|[0-9]/;

/** Identifier-shaped words too common to count as a symbol reference. */
const SYMBOL_STOPLIST = new Set([
  'function', 'return', 'const', 'export', 'import', 'undefined', 'string', 'number',
  'boolean', 'object', 'module', 'default', 'require', 'interface', 'extends',
  'implements', 'typeof', 'instanceof', 'static', 'public', 'private', 'protected',
  'readonly', 'async', 'await', 'class', 'enum', 'type', 'let', 'var', 'new', 'this',
  'super', 'null', 'true', 'false', 'void', 'yield', 'delete', 'throw', 'switch', 'case',
  'break', 'continue', 'while', 'for', 'do', 'if', 'else', 'try', 'catch', 'finally',
  'namespace', 'declare', 'abstract', 'override', 'satisfies', 'keyof', 'infer',
  'unknown', 'never', 'symbol', 'bigint', 'promise', 'array', 'record', 'map', 'set',
  'error', 'console', 'global', 'window', 'document', 'package', 'in', 'of', 'as', 'from',
]);

/** Anchor classes extracted from one piece of text, shared by results and later events. */
export interface Anchors {
  paths: Set<string>;
  symbols: Set<string>;
  errors: Set<string>;
  quotes: Set<string>;
}

export interface AnchorOptions {
  /** Minimum identifier length to count as a symbol. Default 6. */
  minSymbolLength?: number;
}

function symbolsIn(text: string, minLength: number): Set<string> {
  const symbols = new Set<string>();
  for (const match of text.matchAll(SYMBOL_RE)) {
    const word = match[0];
    if (word.length < minLength) continue;
    if (!LOOKS_LIKE_CODE.test(word)) continue;
    if (SYMBOL_STOPLIST.has(word.toLowerCase())) continue;
    symbols.add(word);
    if (symbols.size >= MAX_SYMBOLS_PER_TEXT) break;
  }
  return symbols;
}

function errorsIn(text: string): Set<string> {
  const errors = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (ERROR_LINE_RE.test(line)) errors.add(truncate(line, 120));
    for (const match of line.matchAll(ERROR_CLASS_RE)) errors.add(match[0]);
  }
  return errors;
}

function quotesIn(text: string): Set<string> {
  const quotes = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length < MIN_QUOTE_LENGTH) continue;
    quotes.add(line);
    if (quotes.size >= MAX_QUOTES_PER_TEXT) break;
  }
  return quotes;
}

/** Tokens that could plausibly be a `tool_use_id` mentioned in prose or a Bash command. */
function toolIdTokensIn(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(SYMBOL_RE)) tokens.add(match[0]);
  return tokens;
}

/**
 * Extracts every anchor class from a piece of text: file paths (via
 * `pathsIn`), code-shaped symbols, error signatures and long distinctive
 * lines ("quotes"). Used to index tool results and to scan later events for
 * references to them; exported for tests and for the heuristic classifier.
 */
export function anchorsOf(text: string, options: AnchorOptions = {}): Anchors {
  const minSymbolLength = options.minSymbolLength ?? DEFAULT_MIN_SYMBOL_LENGTH;
  return {
    paths: pathsIn(text),
    symbols: symbolsIn(text, minSymbolLength),
    errors: errorsIn(text),
    quotes: quotesIn(text),
  };
}

function addTo(index: Map<string, string[]>, key: string, id: string): void {
  const list = index.get(key);
  if (list) list.push(id);
  else index.set(key, [id]);
}

/**
 * Builds the "later message → earlier tool result" dependency graph for a
 * ledger. Anchors are indexed once per result and looked up once per later
 * event, so cost is O(total text), not quadratic in the number of events.
 */
export function buildDependencyGraph(ledger: Ledger, options: DependencyOptions = {}): DependencyGraph {
  const minMessageGap = options.minMessageGap ?? DEFAULT_MIN_MESSAGE_GAP;
  const minSymbolLength = options.minSymbolLength ?? DEFAULT_MIN_SYMBOL_LENGTH;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  const allResults = ledger.events.filter((event) => event.kind === 'tool_result');
  const results = allResults.length > maxResults ? allResults.slice(-maxResults) : allResults;

  const resultById = new Map<string, NormalizedEvent>();
  const pathIndex = new Map<string, string[]>();
  const symbolIndex = new Map<string, string[]>();
  const errorIndex = new Map<string, string[]>();
  const quoteIndex = new Map<string, string[]>();
  const toolIdIndex = new Map<string, string>();

  for (const event of results) {
    resultById.set(event.id, event);
    const anchors = anchorsOf(event.content, { minSymbolLength });
    for (const path of anchors.paths) addTo(pathIndex, path, event.id);
    for (const symbol of anchors.symbols) addTo(symbolIndex, symbol, event.id);
    for (const error of anchors.errors) addTo(errorIndex, error, event.id);
    for (const quote of anchors.quotes) addTo(quoteIndex, quote, event.id);
    if (event.toolUseId) toolIdIndex.set(event.toolUseId, event.id);
  }

  const edges: DependencyEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (from: string, to: string, via: DependencyEdge['via'], fragment: string): void => {
    const key = `${from}\u0000${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, via, fragment: truncate(fragment, 120) });
  };

  const eligible = (later: NormalizedEvent, resultId: string): boolean => {
    const result = resultById.get(resultId);
    if (!result) return false;
    if (later.seq <= result.seq) return false;
    if (later.kind === 'user_text') return true;
    return later.messageIndex - result.messageIndex > minMessageGap;
  };

  for (const event of ledger.events) {
    if (event.kind !== 'user_text' && event.kind !== 'assistant_text' && event.kind !== 'tool_use') continue;
    const anchors = anchorsOf(event.content, { minSymbolLength });

    // Order matters for the dedupe below (first via wins): a path or an error
    // signature is a more specific signal than a generic identifier, and an
    // Error class name (e.g. `TypeError`) would otherwise also qualify as a
    // rare symbol and shadow the more informative `error` via.
    for (const path of anchors.paths) {
      for (const resultId of pathIndex.get(path) ?? []) {
        if (eligible(event, resultId)) addEdge(event.id, resultId, 'path', path);
      }
    }
    for (const error of anchors.errors) {
      for (const resultId of errorIndex.get(error) ?? []) {
        if (eligible(event, resultId)) addEdge(event.id, resultId, 'error', error);
      }
    }
    for (const quote of anchors.quotes) {
      for (const resultId of quoteIndex.get(quote) ?? []) {
        if (eligible(event, resultId)) addEdge(event.id, resultId, 'quote', quote);
      }
    }
    for (const symbol of anchors.symbols) {
      const ids = symbolIndex.get(symbol);
      if (!ids || ids.length > MAX_RESULTS_PER_SYMBOL) continue;
      for (const resultId of ids) {
        if (eligible(event, resultId)) addEdge(event.id, resultId, 'symbol', symbol);
      }
    }
    for (const token of toolIdTokensIn(event.content)) {
      const resultId = toolIdIndex.get(token);
      if (resultId && eligible(event, resultId)) addEdge(event.id, resultId, 'tool_id', token);
    }
  }

  const referencedBy = new Map<string, string[]>();
  for (const edge of edges) addTo(referencedBy, edge.to, edge.from);

  return { edges, referencedBy };
}
