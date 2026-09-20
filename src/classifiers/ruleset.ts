import { pathsIn } from '../core/rules.js';
import type { ClassifierScores } from '../core/actions.js';
import type { Message, ToolCall } from '../types.js';
import type { Classifier, ClassifierContext, ClassifierRun } from './types.js';

export interface RulesetOptions {
  /** Messages after which a result is considered stale. Default 20. */
  staleAfterMessages?: number;
  /** Tools whose results are cheap to re-run. Default ['Read','Grep','Glob','LS']. */
  rerunnableTools?: string[];
}

const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const NON_REPRODUCIBLE_TOOLS = new Set(['WebFetch', 'WebSearch', 'Agent', 'Task']);
const FAILURE_WORDS = /\b(?:fail(?:ed|ure|ing)?|error|exception|traceback|panic)\b/i;
const LARGE_RESULT_CHARS = 20_000;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Base keepCall/keepResult before recency scaling and per-call adjustments. */
function categoryDefaults(
  tool: string,
  rerunnableTools: readonly string[],
): { keepCall: number; keepResult: number } {
  if (rerunnableTools.includes(tool)) return { keepCall: 0.4, keepResult: 0.25 };
  if (EDITING_TOOLS.has(tool)) return { keepCall: 0.7, keepResult: 0.3 };
  if (tool === 'Bash') return { keepCall: 0.5, keepResult: 0.45 };
  if (NON_REPRODUCIBLE_TOOLS.has(tool)) return { keepCall: 0.5, keepResult: 0.7 };
  // No signal for this tool; a neutral middle ground rather than a guess.
  return { keepCall: 0.5, keepResult: 0.4 };
}

function inputPathOf(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Whether a later call of the same tool on the same target already succeeded. */
function laterSuccessResolved(call: ToolCall, calls: readonly ToolCall[]): boolean {
  const path = inputPathOf(call.input);
  const command = typeof call.input['command'] === 'string' ? call.input['command'] : undefined;
  for (const later of calls) {
    if (later.callIndex <= call.callIndex || later.tool !== call.tool || later.isError) continue;
    if (command !== undefined) {
      if (later.input['command'] === command) return true;
      continue;
    }
    if (path !== undefined) {
      if (inputPathOf(later.input) === path) return true;
      continue;
    }
    return true;
  }
  return false;
}

/** Recursively sorted-key JSON, so input order never affects the comparison. */
function canonicalInput(input: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sort((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  try {
    return JSON.stringify(sort(input));
  } catch {
    return '[unserializable]';
  }
}

/** An identical later call (same tool, same normalised input) makes this one's copy stale. */
function isSuperseded(call: ToolCall, calls: readonly ToolCall[]): boolean {
  const key = canonicalInput(call.input);
  return calls.some((later) => later.callIndex > call.callIndex && later.tool === call.tool && canonicalInput(later.input) === key);
}

function resultTextFor(call: ToolCall, messages: readonly Message[]): string {
  const message = messages[call.resultIndex];
  const result = message?.toolResults?.find((r) => r.tool_use_id === call.tool_use_id);
  return result?.text ?? '';
}

/** Bound on the text handed to the path-scanning regex: a mention worth a
 * bonus is almost always near the top of a result, and `pathsIn`'s pattern
 * degrades badly on long separator-free text (this classifier must stay
 * fast even on a huge, pathological tool result). */
const PATH_SCAN_CHARS = 4000;

/** Whether the result mentions a file path also mentioned in the last 6 messages. */
function mentionsRecentPath(resultText: string, messages: readonly Message[]): boolean {
  if (resultText.length === 0) return false;
  const resultPaths = pathsIn(resultText.slice(0, PATH_SCAN_CHARS));
  if (resultPaths.size === 0) return false;
  const recentText = messages
    .slice(-6)
    .map((m) => m.text.slice(0, PATH_SCAN_CHARS))
    .join('\n');
  const recentPaths = pathsIn(recentText);
  for (const path of resultPaths) if (recentPaths.has(path)) return true;
  return false;
}

/**
 * The no-network degraded-mode classifier, a hand-written ruleset: deterministic signals only (age,
 * tool type, error status, duplication, size), so it stays available when
 * Jev is unavailable or when a sensitive repo's local policy mode forbids
 * sending anything off the machine. Fast and O(n) — no state is built and no
 * request is made.
 */
export const RULESET_DEFAULT_THRESHOLD = 0.4;

export class RulesetClassifier implements Classifier {
  readonly name = 'ruleset';
  /**
   * From the 2026-09-20 sweep (docs/evals.md): on 12 real sessions 0.3 → 19 %
   * reduction, 0.4 → 49 %, 0.5 → 67 %; labelled false drops did not move with
   * the threshold. The middle setting keeps more in degraded mode.
   */
  readonly defaultThreshold = RULESET_DEFAULT_THRESHOLD;
  private readonly staleAfterMessages: number;
  private readonly rerunnableTools: readonly string[];

  constructor(options: RulesetOptions = {}) {
    this.staleAfterMessages = Math.max(1, options.staleAfterMessages ?? 20);
    this.rerunnableTools = options.rerunnableTools ?? ['Read', 'Grep', 'Glob', 'LS'];
  }

  async score(candidates: readonly ToolCall[], context: ClassifierContext): Promise<ClassifierRun> {
    const started = Date.now();
    const scores = new Map<string, ClassifierScores>();
    const total = context.messages.length;

    for (const call of candidates) {
      let { keepCall, keepResult } = categoryDefaults(call.tool, this.rerunnableTools);

      if (call.tool === 'Bash') {
        const resultText = resultTextFor(call, context.messages);
        if (FAILURE_WORDS.test(resultText)) keepResult = 0.7;
        else if (call.resultChars < 200 && !call.isError) keepResult = 0.2;
      }

      if (call.isError) {
        keepResult = laterSuccessResolved(call, context.calls) ? 0.2 : 0.75;
      }

      const age = Math.max(0, total - 1 - call.resultIndex);
      const recency = clamp01(1 - age / this.staleAfterMessages);
      const scale = 0.5 + 0.5 * recency;
      keepCall = keepCall * scale;
      keepResult = keepResult * scale;

      if (isSuperseded(call, context.calls)) {
        keepResult *= 0.3;
        keepCall *= 0.5;
      }

      const resultText = resultTextFor(call, context.messages);
      if (mentionsRecentPath(resultText, context.messages)) {
        keepResult += 0.2;
      }

      if (call.resultChars > LARGE_RESULT_CHARS) {
        keepResult = Math.max(0.05, keepResult - 0.1);
      }

      scores.set(call.id, { keepCall: clamp01(keepCall), keepResult: clamp01(keepResult) });
    }

    return {
      scores,
      stats: {
        requests: 0,
        stateTokens: 0,
        stateStage: 'ruleset',
        ms: Date.now() - started,
        unscored: [],
      },
    };
  }
}
