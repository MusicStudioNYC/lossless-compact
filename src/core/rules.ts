import type { Ledger, NormalizedEvent } from './events.js';
import type { Message, ToolCall } from '../types.js';

/**
 * Deterministic rules run before and around the classifier. They never evict;
 * they only forbid eviction (a protection) or flag content the rest of the
 * system must treat as durable (a constraint). Rules are cheap, local and
 * explainable, and they are what keeps the product safe when the classifier
 * is wrong, slow, or absent.
 */

export interface Protection {
  /** Rule name, e.g. `unresolved_error`, `referenced_later`, `non_reproducible`, `current_file`. */
  rule: string;
  detail: string;
  refs?: string[];
}

export interface ConstraintHit {
  /** The user text event holding the constraint. */
  eventId: string;
  messageIndex: number;
  /** The sentence (bounded) that carries it, verbatim. */
  text: string;
  /** Which cue matched: `never`, `must not`, `do not`, `always`, `must`, `required`, `only` … */
  cue: string;
}

export interface RuleOptions {
  /** Keep an error result until a later call fixes it (`errorResolvedLater`). Default true. */
  protectUnresolvedErrors: boolean;
  /** Keep a result a later message references by path, symbol or error string. Default true. */
  protectReferenced: boolean;
  /** Keep results of tools whose output cannot be reproduced by re-running. */
  nonReproducibleTools: readonly string[];
  /** Keep results that mention a file edited in the recent window. Default true. */
  protectCurrentFiles: boolean;
  /** How many newest messages count as "current" for file protection. Default 12. */
  currentWindow: number;
}

export const DEFAULT_RULE_OPTIONS: RuleOptions = {
  protectUnresolvedErrors: true,
  protectReferenced: true,
  nonReproducibleTools: ['WebFetch', 'WebSearch', 'AskUserQuestion'],
  protectCurrentFiles: true,
  currentWindow: 12,
};

export function resolveRuleOptions(options: Partial<RuleOptions> = {}): RuleOptions {
  return { ...DEFAULT_RULE_OPTIONS, ...options };
}

/* ---------------------------------------------------------------- constraints */

const CONSTRAINT_CUES = [
  'never',
  'must not',
  'mustn\'t',
  'do not',
  'don\'t',
  'not allowed',
  'forbidden',
  'prohibited',
  'always',
  'must ',
  'required',
  'only ',
  'make sure',
  'be careful',
  'under no circumstances',
] as const;

const SENTENCE_SPLIT = /(?<=[.!?\n])\s+/;

/**
 * Sentences of user text that read as explicit instructions or constraints.
 * Lexical cues only: the classifier and memory extractor refine them, but a
 * sentence flagged here is never evicted by any policy in this build.
 */
export function findConstraints(messages: readonly Message[], ledger?: Ledger): ConstraintHit[] {
  const hits: ConstraintHit[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user' || message.text.trim().length === 0) return;
    if ((message.toolResults ?? []).length > 0 && message.text.trim().length === 0) return;
    const event = ledger?.events.find(
      (e) => e.messageIndex === messageIndex && e.kind === 'user_text',
    );
    for (const sentence of message.text.split(SENTENCE_SPLIT)) {
      const lower = sentence.toLowerCase();
      const cue = CONSTRAINT_CUES.find((c) => lower.includes(c));
      if (!cue) continue;
      // Skip sentences that are clearly quoting a tool result or code.
      if (sentence.trim().startsWith('```') || sentence.trim().startsWith('>')) continue;
      hits.push({
        eventId: event?.id ?? `msg_${messageIndex}`,
        messageIndex,
        text: sentence.trim().slice(0, 500),
        cue: cue.trim(),
      });
    }
  });
  return hits;
}

/* ---------------------------------------------------------------- helpers */

const PATH_LIKE = /(?:[A-Za-z]:)?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,8}/g;

/** File paths mentioned in some text (relative or absolute, with an extension). */
export function pathsIn(text: string): Set<string> {
  const paths = new Set<string>();
  for (const match of text.matchAll(PATH_LIKE)) paths.add(normalisePath(match[0]));
  return paths;
}

export function normalisePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function inputPath(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return normalisePath(value);
  }
  return undefined;
}

/* ---------------------------------------------------------------- protections */

const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Files touched by an editing tool in the newest `window` messages: the
 * "current files" of the task.
 */
export function currentFiles(messages: readonly Message[], window: number): Set<string> {
  const files = new Set<string>();
  const from = Math.max(0, messages.length - window);
  for (let i = from; i < messages.length; i++) {
    for (const tool of messages[i]!.toolUses) {
      if (!EDITING_TOOLS.has(tool.tool)) continue;
      const path = inputPath(tool.input);
      if (path) files.add(path);
    }
  }
  return files;
}

/**
 * Paths edited by a later call than `call`: a read of one of these shows
 * content that re-running would not reproduce (plan §16).
 */
export function targetChangedLater(call: ToolCall, calls: readonly ToolCall[]): boolean {
  const path = inputPath(call.input);
  if (!path) return false;
  return calls.some(
    (later) =>
      later.callIndex > call.callIndex && EDITING_TOOLS.has(later.tool) && inputPath(later.input) === path,
  );
}

/* ---------------------------------------------------------------- file reads */

/** Tools whose result is the content of the file they name. */
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
/** Shell commands that only print (part of) the files they are given. */
const SHELL_READERS = new Set(['cat', 'head', 'tail', 'sed', 'less', 'more', 'nl', 'bat']);
/** Shell words that can sit around a reader without making the command do anything else. */
const SHELL_GLUE = new Set(['for', 'done', 'fi', 'echo', 'printf', 'ls', 'cd', 'test', '[', '[[', 'true']);
/** Keywords that open a segment and are followed by the command proper. */
const SHELL_PREFIXES = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!']);
/** A file name with an extension (`docker-compose.yml`, `a.test.ts`) or a dotfile (`.env`, `.env.example`). */
const FILE_NAME = /^\.?(?:[\w-][\w.-]*)?\.[A-Za-z][\w-]*$/;

function basename(path: string): string {
  const parts = normalisePath(path).split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Lower-cased basenames of the files a Bash command prints, when printing
 * files is all it does: every segment is a reader (`cat`, `head`, `sed`
 * without `-i` …) or harmless glue (`for … in`, `echo`, `cd`), and nothing is
 * redirected into a file. Anything else (`npm test src/a.test.ts`, `cat a > b`)
 * is not a read, so a later read of a file it names fixes nothing.
 */
export function shellReads(command: string): Set<string> | undefined {
  const stripped = command.replace(/\d*>&\d+/g, ' ').replace(/(?:\d|&)?>\s*\/dev\/null/g, ' ');
  if (stripped.includes('>')) return undefined;
  const files = new Set<string>();
  let readers = 0;
  for (const segment of stripped.split(/\|\||&&|[;|&\n()`]/)) {
    const words = segment
      .replace(/</g, ' ')
      .split(/\s+/)
      .map((word) => word.replace(/^['"]+|['"]+$/g, ''))
      .filter((word) => word.length > 0);
    while (words.length > 0 && SHELL_PREFIXES.has(words[0]!)) words.shift();
    if (words.length === 0) continue;
    const name = words[0]!.split('/').pop()!;
    if (SHELL_READERS.has(name)) {
      if (name === 'sed' && words.some((word) => /^-[a-zA-Z]*i|^--in-place/.test(word))) return undefined;
      readers++;
    } else if (!SHELL_GLUE.has(name)) {
      return undefined;
    }
    for (const word of words.slice(1)) {
      if (word.startsWith('-') || /[$*?[\]{}]|:\/\//.test(word)) continue;
      const file = basename(word);
      if (FILE_NAME.test(file)) files.add(file);
    }
  }
  return readers > 0 ? files : undefined;
}

/**
 * Basenames of the files a call shows the model the content of: a Read, or a
 * Bash command that only prints files. A Grep or a Glob does not count: either
 * succeeds having matched nothing, and neither shows the file.
 */
export function fileReads(call: Pick<ToolCall, 'tool' | 'input'>): Set<string> {
  if (READ_TOOLS.has(call.tool)) {
    const path = inputPath(call.input);
    return new Set(path ? [basename(path)] : []);
  }
  const command = call.input['command'];
  if (call.tool === 'Bash' && typeof command === 'string') return shellReads(command) ?? new Set();
  return new Set();
}

/** Basenames of the files a call was trying to read or search: its reads, plus a Grep's path. */
function attemptedReads(call: ToolCall): Set<string> {
  const path = typeof call.input['path'] === 'string' ? call.input['path'] : undefined;
  if (call.tool === 'Grep' && path && !/[*?[\]{}]/.test(path)) return new Set([basename(path)]);
  return fileReads(call);
}

/**
 * Later successful calls that redo what a failed `call` attempted: the same
 * tool on the same target (for Bash, the same command; for file tools, the
 * same path), or a read showing a file it was trying to read, at any path
 * (a retry with the right path, or with Read after a refused `cat`).
 */
export function laterSuccesses(call: ToolCall, calls: readonly ToolCall[]): ToolCall[] {
  const path = inputPath(call.input);
  const command = typeof call.input['command'] === 'string' ? call.input['command'] : undefined;
  const wanted = attemptedReads(call);
  return calls.filter((later) => {
    if (later.callIndex <= call.callIndex || later.isError) return false;
    if (later.tool === call.tool) {
      if (command !== undefined && later.input['command'] === command) return true;
      if (command === undefined && path !== undefined && inputPath(later.input) === path) return true;
    }
    if (wanted.size === 0) return false;
    for (const name of fileReads(later)) if (wanted.has(name)) return true;
    return false;
  });
}

/**
 * Whether a failed call was fixed later: a later call of the same tool on the
 * same target succeeded (any later success of the tool, when the call names no
 * target), or every file it was trying to read was later read successfully. A
 * command that names files but does more than print them (`npm test a.ts`) is
 * fixed only by a later success of the same command.
 */
export function errorResolvedLater(call: ToolCall, calls: readonly ToolCall[]): boolean {
  const path = inputPath(call.input);
  const command = typeof call.input['command'] === 'string' ? call.input['command'] : undefined;
  const later = calls.filter((other) => other.callIndex > call.callIndex && !other.isError);
  const sameTarget = (other: ToolCall): boolean =>
    command !== undefined ? other.input['command'] === command : path === undefined || inputPath(other.input) === path;
  if (later.some((other) => other.tool === call.tool && sameTarget(other))) return true;
  const wanted = attemptedReads(call);
  if (wanted.size === 0) return false;
  const read = new Set<string>();
  for (const other of later) for (const name of fileReads(other)) read.add(name);
  return [...wanted].every((name) => read.has(name));
}

/** Whether an error result is still unresolved: see `errorResolvedLater`. */
function isUnresolvedError(call: ToolCall, calls: readonly ToolCall[]): boolean {
  return call.isError && !errorResolvedLater(call, calls);
}

export interface ProtectionContext {
  messages: readonly Message[];
  ledger: Ledger;
  calls: readonly ToolCall[];
  options: RuleOptions;
  /** result event id → ids of later events that reference it (from the dependency graph). */
  referencedBy?: ReadonlyMap<string, readonly string[]>;
}

function resultEvent(call: ToolCall, ledger: Ledger): NormalizedEvent | undefined {
  return ledger.interactions.get(call.tool_use_id)?.result;
}

/** Every reason this call's result must stay verbatim; empty when the classifier may decide. */
export function protectionsFor(call: ToolCall, context: ProtectionContext): Protection[] {
  const { options } = context;
  const found: Protection[] = [];
  const result = resultEvent(call, context.ledger);

  if (options.protectUnresolvedErrors && isUnresolvedError(call, context.calls)) {
    found.push({
      rule: 'unresolved_error',
      detail: `${call.tool} failed and no later call on the same target, or read of the same file, succeeded`,
    });
  }

  if (
    options.nonReproducibleTools.some(
      (name) => name === call.tool || (name.endsWith('*') && call.tool.startsWith(name.slice(0, -1))),
    )
  ) {
    found.push({
      rule: 'non_reproducible',
      detail: `${call.tool} output cannot be reproduced by re-running the tool`,
    });
  }

  if (options.protectReferenced && result) {
    const refs = context.referencedBy?.get(result.id);
    if (refs && refs.length > 0) {
      found.push({
        rule: 'referenced_later',
        detail: `a later message refers to this result (${refs.length} reference${refs.length === 1 ? '' : 's'})`,
        refs: [...refs],
      });
    }
  }

  if (options.protectCurrentFiles) {
    const files = currentFiles(context.messages, options.currentWindow);
    const path = inputPath(call.input);
    if (path && files.has(path) && !EDITING_TOOLS.has(call.tool)) {
      found.push({
        rule: 'current_file',
        detail: `${path} was edited in the newest ${options.currentWindow} messages`,
      });
    }
  }

  return found;
}
