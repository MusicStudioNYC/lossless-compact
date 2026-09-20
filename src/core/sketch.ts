import { truncate } from '../state.js';
import { ERROR_LINE_RE } from './dependencies.js';
import { pathsIn } from './rules.js';

/**
 * A short, information-dense sketch of a tool result, shown to the classifier
 * next to the "ok, N chars (omitted)" note (plan section 11.B). Upstream
 * showed Jev nothing about result content; a plain 300-char preview measured
 * ranking AUC 0.61→0.71. This is tool-aware: what is worth a few dozen
 * characters differs for a file read, a search, a shell command and an error.
 */

export interface SketchOptions {
  /** Total character budget for one sketch. Default 240. */
  maxChars?: number;
  /** Characters of head/tail included for generic results. Default 100 / 60. */
  headChars?: number;
  tailChars?: number;
}

const DEFAULT_MAX_CHARS = 240;
const DEFAULT_HEAD_CHARS = 100;
const DEFAULT_TAIL_CHARS = 60;
const MAX_DEFINED_SYMBOLS = 8;
const MAX_SEARCH_FILES = 6;
const MAX_BASH_FILES = 4;

const LINE_NUMBER_PREFIX = /^\s*\d+[\t→]/; // `cat -n` style: "  12\t..." or "  12→..."

const DEFINITION_RES: readonly RegExp[] = [
  /export (?:default )?(?:async )?(?:function|class|const|let|var|interface|type|enum) (\w+)/gm,
  /^(?:async )?def (\w+)/gm,
  /^class (\w+)/gm,
  /^func (\w+)/gm,
  /^(?:pub )?fn (\w+)/gm,
];
const IMPORT_RE = /^\s*(?:import\s|from\s+\S+\s+import\s|#include\s|using\s)/gm;
const REQUIRE_RE = /\brequire\(/g;
const EXIT_CODE_RE = /exit(?:ed with)?\s+code:?\s*(\d+)/i;

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function headOf(text: string, chars: number): string {
  return collapseWs(text.slice(0, chars));
}

function tailOf(text: string, chars: number): string {
  return collapseWs(text.length <= chars ? text : text.slice(-chars));
}

function firstLine(text: string, maxLen: number): string {
  return truncate(collapseWs(text.split('\n', 1)[0] ?? ''), maxLen);
}

function firstNonEmptyLine(text: string, maxLen: number): string {
  for (const raw of text.split('\n')) {
    const line = collapseWs(raw);
    if (line.length > 0) return truncate(line, maxLen);
  }
  return '';
}

/** The first line that reads as an error, or the first line at all when none does. */
function firstErrorLine(text: string, maxLen: number): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length > 0 && ERROR_LINE_RE.test(line)) return truncate(collapseWs(line), maxLen);
  }
  return firstLine(text, maxLen);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Strips Claude Code's `cat -n` style line-number prefixes before symbol extraction. */
function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(LINE_NUMBER_PREFIX, ''))
    .join('\n');
}

function definedSymbols(text: string, cap: number): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const re of DEFINITION_RES) {
    for (const match of text.matchAll(re)) {
      const name = match[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      found.push(name);
      if (found.length >= cap) return found;
    }
  }
  return found;
}

function countImports(text: string): number {
  return [...text.matchAll(IMPORT_RE)].length + [...text.matchAll(REQUIRE_RE)].length;
}

function shortPath(path: string, max = 40): string {
  if (path.length <= max) return path;
  const base = path.split('/').pop();
  return base && base.length > 0 ? base : path.slice(-max);
}

function filesIn(text: string, cap: number): string[] {
  return [...pathsIn(text)].slice(0, cap).map((path) => shortPath(path));
}

function exitCode(text: string): string | undefined {
  return EXIT_CODE_RE.exec(text)?.[1];
}

function inputString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Joins non-empty `key=value` parts and fits the whole line into `maxChars`. */
function assemble(parts: readonly string[], maxChars: number): string {
  const joined = collapseWs(parts.filter((part) => part.length > 0).join('; '));
  return truncate(joined, maxChars);
}

function sketchRead(input: Record<string, unknown>, result: string, maxChars: number): string {
  const stripped = stripLineNumbers(result);
  const path = inputString(input, 'file_path', 'notebook_path', 'path');
  const symbols = definedSymbols(stripped, MAX_DEFINED_SYMBOLS);
  const parts: string[] = [];
  if (path) parts.push(`path=${path}`);
  parts.push(`lines=${countLines(result)}`);
  if (symbols.length > 0) parts.push(`symbols=${symbols.join(',')}`);
  parts.push(`imports=${countImports(stripped)}`);
  const head = firstNonEmptyLine(stripped, 80);
  if (head.length > 0) parts.push(`head=${head}`);
  return assemble(parts, maxChars);
}

function sketchSearch(input: Record<string, unknown>, result: string, maxChars: number): string {
  const parts: string[] = [`matches=${countLines(result)}`];
  const files = filesIn(result, MAX_SEARCH_FILES);
  if (files.length > 0) parts.push(`files=${files.join(',')}`);
  const pattern = inputString(input, 'pattern');
  if (pattern) parts.push(`pattern=${truncate(collapseWs(pattern), 60)}`);
  return assemble(parts, maxChars);
}

function sketchBash(input: Record<string, unknown>, result: string, maxChars: number): string {
  const parts: string[] = [];
  const command = inputString(input, 'command');
  if (command) parts.push(`cmd=${truncate(collapseWs(command), 80)}`);
  const exit = exitCode(result);
  if (exit !== undefined) parts.push(`exit=${exit}`);
  parts.push(`lines=${countLines(result)}`);
  const files = filesIn(result, MAX_BASH_FILES);
  if (files.length > 0) parts.push(`files=${files.join(',')}`);
  const head = headOf(result, DEFAULT_HEAD_CHARS);
  if (head.length > 0) parts.push(`head=${head}`);
  const tail = tailOf(result, DEFAULT_TAIL_CHARS);
  if (tail.length > 0) parts.push(`tail=${tail}`);
  return assemble(parts, maxChars);
}

function sketchEdit(input: Record<string, unknown>, result: string, maxChars: number): string {
  const parts: string[] = [];
  const path = inputString(input, 'file_path', 'notebook_path', 'path');
  if (path) parts.push(`path=${path}`);
  const line = firstLine(result, 100);
  if (line.length > 0) parts.push(`result=${line}`);
  return assemble(parts, maxChars);
}

function sketchWeb(input: Record<string, unknown>, result: string, maxChars: number): string {
  const target = inputString(input, 'url', 'query', 'prompt');
  const parts: string[] = [];
  if (target) parts.push(`url=${truncate(collapseWs(target), 100)}`);
  const head = headOf(result, 120);
  if (head.length > 0) parts.push(`head=${head}`);
  return assemble(parts, maxChars);
}

function sketchAgent(result: string, maxChars: number): string {
  const parts: string[] = [];
  const head = headOf(result, 120);
  if (head.length > 0) parts.push(`head=${head}`);
  const tail = tailOf(result, 60);
  if (tail.length > 0) parts.push(`tail=${tail}`);
  return assemble(parts, maxChars);
}

function sketchGeneric(result: string, headChars: number, tailChars: number, maxChars: number): string {
  const parts: string[] = [];
  const head = headOf(result, headChars);
  if (head.length > 0) parts.push(`head=${head}`);
  const tail = tailOf(result, tailChars);
  if (tail.length > 0) parts.push(`tail=${tail}`);
  return assemble(parts, maxChars);
}

/**
 * A bounded one-line sketch of a tool result. Never includes newlines
 * (whitespace runs are collapsed to one space). An error result always leads
 * with `ERR: <line>` regardless of tool; otherwise the shape is chosen by
 * `tool` (matched case-insensitively), falling back to a generic head/tail
 * preview for anything else.
 */
export function sketchResult(
  tool: string,
  input: Record<string, unknown>,
  result: string,
  isError: boolean,
  options: SketchOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const headChars = options.headChars ?? DEFAULT_HEAD_CHARS;
  const tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;

  const firstRaw = (result.split('\n')[0] ?? '').trim();
  if (isError || ERROR_LINE_RE.test(firstRaw)) {
    const parts = [`ERR: ${firstErrorLine(result, 120)}`];
    const tail = tailOf(result, DEFAULT_TAIL_CHARS);
    if (tail.length > 0) parts.push(`tail=${tail}`);
    return assemble(parts, maxChars);
  }

  const name = tool.toLowerCase();
  if (name === 'read' || name === 'notebookread') return sketchRead(input, result, maxChars);
  if (name === 'grep' || name === 'glob' || name === 'ls') return sketchSearch(input, result, maxChars);
  if (name === 'bash') return sketchBash(input, result, maxChars);
  if (name === 'edit' || name === 'write' || name === 'multiedit') return sketchEdit(input, result, maxChars);
  if (name === 'webfetch' || name === 'websearch') return sketchWeb(input, result, maxChars);
  if (name === 'agent' || name === 'task') return sketchAgent(result, maxChars);
  return sketchGeneric(result, headChars, tailChars, maxChars);
}
