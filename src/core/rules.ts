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
  /** Keep an error result while no later call of the same tool succeeded. Default true. */
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

/**
 * Whether an error result is still unresolved: no later call of the same tool
 * (for Bash, the same command; for file tools, the same path) succeeded.
 */
function isUnresolvedError(call: ToolCall, calls: readonly ToolCall[]): boolean {
  if (!call.isError) return false;
  const path = inputPath(call.input);
  const command = typeof call.input['command'] === 'string' ? call.input['command'] : undefined;
  for (const later of calls) {
    if (later.callIndex <= call.callIndex || later.tool !== call.tool || later.isError) continue;
    if (command !== undefined) {
      if (later.input['command'] === command) return false;
      continue;
    }
    if (path !== undefined) {
      if (inputPath(later.input) === path) return false;
      continue;
    }
    return false;
  }
  return true;
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
      detail: `${call.tool} failed and no later ${call.tool} call on the same target succeeded`,
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
