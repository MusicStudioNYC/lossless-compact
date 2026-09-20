import type { ActionDecision, ClassifierScores, ContextAction, DecisionReason } from './actions.js';
import type { NormalizedEvent } from './events.js';
import type { Protection } from './rules.js';
import type { ToolCall } from '../types.js';

/**
 * Turns everything known about one tool interaction — where it sits, what
 * the rules say, what the classifier scored, whether it duplicates retained
 * content — into one explainable action. The order of precedence is the
 * plan's candidate hierarchy: deterministic pins, deterministic protections,
 * deterministic redundancy, then the classifier, and "keep" whenever in doubt.
 */
export interface PolicyOptions {
  /** Minimum keep probability for a result or call to stay. */
  keepThreshold: number;
  /**
   * Scores this far below the threshold still keep: the classifier's own
   * uncertainty band. 0 reproduces the baseline; evals choose the default.
   */
  safetyMargin: number;
  /** Tools whose result can be reproduced by re-running the same call. */
  rerunnableTools: readonly string[];
  /** Remove interactions whose exact result is retained elsewhere, without asking the classifier. */
  dropRedundant: boolean;
  /** Added to `keepResult` when a later message mentions a path or symbol from the result. */
  softReferenceBoost: number;
}

export const DEFAULT_POLICY_OPTIONS: PolicyOptions = {
  keepThreshold: 0.5,
  safetyMargin: 0,
  rerunnableTools: ['Read', 'Grep', 'Glob', 'LS'],
  dropRedundant: true,
  softReferenceBoost: 0.2,
};

export interface PolicyInput {
  call: ToolCall;
  use: NormalizedEvent;
  result?: NormalizedEvent;
  protections: readonly Protection[];
  /** Id of a retained result event with the same content, when this one duplicates it. */
  duplicateOf?: string;
  scores?: ClassifierScores;
  /** True when the classifier was asked and could not answer. */
  unscored: boolean;
  /** Whether the tool's target (a file) is known to be unchanged since the call. */
  targetUnchanged?: boolean;
  /** Ids of later events that mention this result weakly (a path or symbol in assistant text). */
  softReferences?: readonly string[];
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Threshold outside [0, 1] would make every decision a drop or a keep; clamp it. */
export function resolvePolicyOptions(options: Partial<PolicyOptions> = {}): PolicyOptions {
  const merged = { ...DEFAULT_POLICY_OPTIONS, ...options };
  return {
    ...merged,
    keepThreshold: clamp01(merged.keepThreshold),
    safetyMargin: clamp01(merged.safetyMargin),
  };
}

function decision(
  input: PolicyInput,
  action: ContextAction,
  reasons: DecisionReason[],
  confidence: number,
  protectedBy: string[] = [],
): ActionDecision {
  const out: ActionDecision = {
    eventId: input.use.id,
    unit: 'tool_interaction',
    toolName: input.call.tool,
    action,
    reasons,
    protectedBy,
    confidence: clamp01(confidence),
  };
  if (input.result) out.resultId = input.result.id;
  if (input.scores) out.scores = input.scores;
  return out;
}

export function decideInteraction(input: PolicyInput, options: PolicyOptions): ActionDecision {
  const { call, protections, scores } = input;

  if (call.pinned) {
    return decision(
      input,
      'PIN_VERBATIM',
      [{ code: 'pinned_window', detail: 'in the first message or the newest preserved messages' }],
      1,
    );
  }

  if (protections.length > 0) {
    return decision(
      input,
      'KEEP_VERBATIM',
      protections.map((p) => {
        const reason: DecisionReason = { code: p.rule, detail: p.detail };
        if (p.refs) reason.refs = p.refs;
        return reason;
      }),
      1,
      protections.map((p) => p.rule),
    );
  }

  if (options.dropRedundant && input.duplicateOf) {
    return decision(
      input,
      'DROP_REDUNDANT',
      [
        {
          code: 'duplicate',
          detail: 'the exact same result is retained elsewhere in the active window',
          refs: [input.duplicateOf],
        },
      ],
      1,
    );
  }

  if (!scores) {
    return decision(
      input,
      'KEEP_VERBATIM',
      [
        {
          code: input.unscored ? 'unscored' : 'no_classifier',
          detail: input.unscored
            ? 'the classifier did not answer for this call; kept to be safe'
            : 'no classifier ran; kept to be safe',
        },
      ],
      0,
    );
  }

  const boosted = input.softReferences && input.softReferences.length > 0 ? options.softReferenceBoost : 0;
  const keepResult = clamp01(scores.keepResult + boosted);
  const keepCall = clamp01(scores.keepCall);
  const threshold = options.keepThreshold;
  const boostReason: DecisionReason[] = boosted
    ? [
        {
          code: 'referenced_weakly',
          detail: `a later message mentions a path or symbol from this result; keep probability raised by ${boosted.toFixed(2)}`,
          refs: [...input.softReferences!],
        },
      ]
    : [];
  const floor = Math.max(0, threshold - options.safetyMargin);
  const scored = (what: string, value: number): DecisionReason => ({
    code: `classifier_${what}`,
    detail: `${what} keep probability ${value.toFixed(2)} (threshold ${threshold.toFixed(2)}${
      options.safetyMargin > 0 ? `, margin ${options.safetyMargin.toFixed(2)}` : ''
    })`,
  });

  if (keepResult >= threshold) {
    return decision(input, 'KEEP_VERBATIM', [scored('result', keepResult), ...boostReason], keepResult);
  }
  if (keepResult >= floor) {
    return decision(
      input,
      'KEEP_VERBATIM',
      [scored('result', keepResult), ...boostReason, { code: 'safety_margin', detail: 'within the uncertainty band; kept' }],
      threshold - keepResult,
    );
  }

  const resultConfidence = 1 - keepResult;
  if (keepCall >= floor) {
    const reasons = [scored('result', keepResult), ...boostReason, scored('call', keepCall)];
    if (options.rerunnableTools.includes(call.tool) && input.targetUnchanged !== false) {
      reasons.push({
        code: 'rerunnable',
        detail: `${call.tool} can be re-run with the same input to reproduce the result`,
      });
      return decision(input, 'RERUN_ON_DEMAND', reasons, resultConfidence);
    }
    return decision(input, 'KEEP_HEAD_TAIL', reasons, resultConfidence);
  }

  return decision(
    input,
    'ARCHIVE_ONLY',
    [scored('result', keepResult), ...boostReason, scored('call', keepCall)],
    Math.min(resultConfidence, 1 - keepCall),
  );
}
