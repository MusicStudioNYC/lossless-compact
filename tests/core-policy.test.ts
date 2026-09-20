import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY_OPTIONS,
  decideInteraction,
  resolvePolicyOptions,
  type PolicyInput,
} from '../src/core/policy.js';
import type { NormalizedEvent } from '../src/core/events.js';
import type { Protection } from '../src/core/rules.js';
import type { ToolCall } from '../src/types.js';

function event(id: string, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id,
    seq: 0,
    role: 'assistant',
    kind: 'tool_use',
    content: '',
    messageIndex: 0,
    contentHash: `hash-${id}`,
    tokenEstimate: 1,
    metadata: {},
    ...overrides,
  };
}

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1',
    tool_use_id: 'tool-1',
    tool: 'Bash',
    input: {},
    callIndex: 1,
    resultIndex: 2,
    resultChars: 10,
    isError: false,
    pinned: false,
    ...overrides,
  };
}

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    call: toolCall(),
    use: event('use-1'),
    result: event('result-1', { kind: 'tool_result', role: 'tool' }),
    protections: [],
    unscored: false,
    ...overrides,
  };
}

describe('resolvePolicyOptions', () => {
  it('fills in defaults', () => {
    expect(resolvePolicyOptions()).toEqual(DEFAULT_POLICY_OPTIONS);
  });

  it('clamps keepThreshold and safetyMargin above 1 down to 1', () => {
    const resolved = resolvePolicyOptions({ keepThreshold: 1.5, safetyMargin: 3 });
    expect(resolved.keepThreshold).toBe(1);
    expect(resolved.safetyMargin).toBe(1);
  });

  it('clamps keepThreshold and safetyMargin below 0 up to 0', () => {
    const resolved = resolvePolicyOptions({ keepThreshold: -2, safetyMargin: -0.1 });
    expect(resolved.keepThreshold).toBe(0);
    expect(resolved.safetyMargin).toBe(0);
  });

  it('clamps non-finite thresholds to 0 instead of crashing (Infinity is not finite either)', () => {
    const resolved = resolvePolicyOptions({ keepThreshold: Number.NaN, safetyMargin: Number.POSITIVE_INFINITY });
    expect(resolved.keepThreshold).toBe(0);
    expect(resolved.safetyMargin).toBe(0);
  });
});

describe('decideInteraction precedence', () => {
  const options = resolvePolicyOptions();

  it('1. pinned wins over everything else -> PIN_VERBATIM', () => {
    const decision = decideInteraction(
      input({ call: toolCall({ pinned: true }), protections: [{ rule: 'non_reproducible', detail: 'x' }] }),
      options,
    );
    expect(decision.action).toBe('PIN_VERBATIM');
    expect(decision.confidence).toBe(1);
  });

  it('2. any protection -> KEEP_VERBATIM, protectedBy lists the rules, refs preserved', () => {
    const protections: Protection[] = [
      { rule: 'unresolved_error', detail: 'Bash failed and nothing later succeeded' },
      { rule: 'referenced_later', detail: 'mentioned again', refs: ['e_abc'] },
    ];
    const decision = decideInteraction(input({ protections }), options);
    expect(decision.action).toBe('KEEP_VERBATIM');
    expect(decision.protectedBy).toEqual(['unresolved_error', 'referenced_later']);
    expect(decision.reasons).toEqual([
      { code: 'unresolved_error', detail: 'Bash failed and nothing later succeeded' },
      { code: 'referenced_later', detail: 'mentioned again', refs: ['e_abc'] },
    ]);
    expect(decision.confidence).toBe(1);
  });

  it('3. an exact duplicate retained elsewhere -> DROP_REDUNDANT with refs to the survivor', () => {
    const decision = decideInteraction(input({ duplicateOf: 'e_survivor' }), options);
    expect(decision.action).toBe('DROP_REDUNDANT');
    expect(decision.reasons[0]).toMatchObject({ code: 'duplicate', refs: ['e_survivor'] });
    expect(decision.confidence).toBe(1);
  });

  it('dropRedundant: false falls through past the duplicate check', () => {
    const decision = decideInteraction(
      input({ duplicateOf: 'e_survivor' }),
      resolvePolicyOptions({ dropRedundant: false }),
    );
    expect(decision.action).not.toBe('DROP_REDUNDANT');
  });

  it('4a. no scores and unscored -> KEEP_VERBATIM, confidence 0, code unscored', () => {
    const decision = decideInteraction(input({ unscored: true }), options);
    expect(decision.action).toBe('KEEP_VERBATIM');
    expect(decision.confidence).toBe(0);
    expect(decision.reasons[0]?.code).toBe('unscored');
  });

  it('4b. no scores and no classifier ran -> KEEP_VERBATIM, code no_classifier', () => {
    const decision = decideInteraction(input({ unscored: false }), options);
    expect(decision.action).toBe('KEEP_VERBATIM');
    expect(decision.confidence).toBe(0);
    expect(decision.reasons[0]?.code).toBe('no_classifier');
  });

  it('5a. keepResult >= threshold -> KEEP_VERBATIM', () => {
    const decision = decideInteraction(
      input({ scores: { keepCall: 0.9, keepResult: 0.6 } }),
      resolvePolicyOptions({ keepThreshold: 0.5 }),
    );
    expect(decision.action).toBe('KEEP_VERBATIM');
    expect(decision.confidence).toBe(0.6);
  });

  it('5b. keepResult within safetyMargin below threshold -> KEEP_VERBATIM with safety_margin reason', () => {
    const decision = decideInteraction(
      input({ scores: { keepCall: 0.9, keepResult: 0.35 } }),
      resolvePolicyOptions({ keepThreshold: 0.5, safetyMargin: 0.2 }),
    );
    expect(decision.action).toBe('KEEP_VERBATIM');
    expect(decision.reasons.some((r) => r.code === 'safety_margin')).toBe(true);
    expect(decision.confidence).toBeCloseTo(0.15, 10);
  });

  it('6a. keepCall >= threshold and a rerunnable tool with an unchanged target -> RERUN_ON_DEMAND', () => {
    const decision = decideInteraction(
      input({ call: toolCall({ tool: 'Read' }), scores: { keepCall: 0.6, keepResult: 0.1 }, targetUnchanged: true }),
      resolvePolicyOptions({ keepThreshold: 0.5, rerunnableTools: ['Read'] }),
    );
    expect(decision.action).toBe('RERUN_ON_DEMAND');
  });

  it('6a bis. targetUnchanged defaults to eligible when omitted (only false disqualifies)', () => {
    const decision = decideInteraction(
      input({ call: toolCall({ tool: 'Read' }), scores: { keepCall: 0.6, keepResult: 0.1 } }),
      resolvePolicyOptions({ keepThreshold: 0.5, rerunnableTools: ['Read'] }),
    );
    expect(decision.action).toBe('RERUN_ON_DEMAND');
  });

  it('6b. rerunnable tool but the target changed later -> KEEP_HEAD_TAIL', () => {
    const decision = decideInteraction(
      input({ call: toolCall({ tool: 'Read' }), scores: { keepCall: 0.6, keepResult: 0.1 }, targetUnchanged: false }),
      resolvePolicyOptions({ keepThreshold: 0.5, rerunnableTools: ['Read'] }),
    );
    expect(decision.action).toBe('KEEP_HEAD_TAIL');
  });

  it('6c. non-rerunnable tool with keepCall >= threshold -> KEEP_HEAD_TAIL', () => {
    const decision = decideInteraction(
      input({ call: toolCall({ tool: 'Bash' }), scores: { keepCall: 0.6, keepResult: 0.1 } }),
      resolvePolicyOptions({ keepThreshold: 0.5 }),
    );
    expect(decision.action).toBe('KEEP_HEAD_TAIL');
  });

  it('7. both keepCall and keepResult low -> ARCHIVE_ONLY', () => {
    const decision = decideInteraction(
      input({ scores: { keepCall: 0.1, keepResult: 0.1 } }),
      resolvePolicyOptions({ keepThreshold: 0.5 }),
    );
    expect(decision.action).toBe('ARCHIVE_ONLY');
    expect(decision.confidence).toBeCloseTo(0.9, 10);
  });

  it('clamps scores outside [0, 1] instead of crashing', () => {
    expect(() =>
      decideInteraction(input({ scores: { keepCall: 5, keepResult: -3 } }), resolvePolicyOptions({ keepThreshold: 0.5 })),
    ).not.toThrow();
    const decision = decideInteraction(
      input({ call: toolCall({ tool: 'Bash' }), scores: { keepCall: 5, keepResult: -3 } }),
      resolvePolicyOptions({ keepThreshold: 0.5 }),
    );
    // keepResult clamps to 0 (< threshold), keepCall clamps to 1 (>= floor) on a
    // non-rerunnable tool -> KEEP_HEAD_TAIL, not a crash and not out-of-range confidence.
    expect(decision.action).toBe('KEEP_HEAD_TAIL');
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
  });

  it('produces sensible output when keepThreshold and safetyMargin are themselves out of range', () => {
    const wild = resolvePolicyOptions({ keepThreshold: 7, safetyMargin: -9 });
    expect(() =>
      decideInteraction(input({ scores: { keepCall: 0.5, keepResult: 0.5 } }), wild),
    ).not.toThrow();
  });
});

describe('decideInteraction result shape', () => {
  it('carries the resultId and scores through when present', () => {
    const decision = decideInteraction(
      input({ scores: { keepCall: 0.9, keepResult: 0.9 } }),
      resolvePolicyOptions({ keepThreshold: 0.5 }),
    );
    expect(decision.eventId).toBe('use-1');
    expect(decision.resultId).toBe('result-1');
    expect(decision.scores).toEqual({ keepCall: 0.9, keepResult: 0.9 });
    expect(decision.unit).toBe('tool_interaction');
  });

  it('omits resultId when there is no paired result', () => {
    const noResult = input();
    delete (noResult as { result?: unknown }).result;
    const decision = decideInteraction(noResult, resolvePolicyOptions());
    expect(decision.resultId).toBeUndefined();
  });
});
