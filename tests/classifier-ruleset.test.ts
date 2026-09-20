import { describe, expect, it } from 'vitest';
import { collectToolCalls, resolveOptions, type Message } from '../src/index.js';
import { buildLedger } from '../src/core/events.js';
import { RulesetClassifier } from '../src/classifiers/ruleset.js';
import type { ClassifierContext } from '../src/classifiers/types.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

function contextFor(messages: Message[], preserveRecentMessages = 0): ClassifierContext {
  const calls = collectToolCalls(messages, preserveRecentMessages);
  return {
    messages,
    ledger: buildLedger(messages),
    calls,
    options: resolveOptions({ preserveRecentMessages }),
  };
}

/** Mirrors the classifier's own recency scale, for exact expected values. */
function scaleFor(age: number, staleAfter = 20): number {
  const recency = Math.min(1, Math.max(0, 1 - age / staleAfter));
  return 0.5 + 0.5 * recency;
}

describe('RulesetClassifier', () => {
  it('reports the ClassifierRun shape and keeps every score in [0, 1]', async () => {
    const messages = [
      message('user', 'Never edit anything under src/generated. Fix the failing test.'),
      call('a1', 'Read', { file_path: 'src/a.ts' }),
      result('a1', 'x'.repeat(50)),
      call('a2', 'Bash', { command: 'npm test' }),
      result('a2', 'FAIL b.test.ts: expected 2 to be 3', true),
      call('a3', 'WebFetch', { url: 'https://example.com' }),
      result('a3', 'a'.repeat(30_000)),
      message('assistant', 'fixing now'),
    ];
    const ctx = contextFor(messages);
    const classifier = new RulesetClassifier();
    const run = await classifier.score(ctx.calls, ctx);

    expect(run.scores.size).toBe(3);
    for (const score of run.scores.values()) {
      expect(score.keepCall).toBeGreaterThanOrEqual(0);
      expect(score.keepCall).toBeLessThanOrEqual(1);
      expect(score.keepResult).toBeGreaterThanOrEqual(0);
      expect(score.keepResult).toBeLessThanOrEqual(1);
    }
    expect(run.stats).toMatchObject({ requests: 0, stateTokens: 0, stateStage: 'ruleset', unscored: [] });
    expect(run.stats.ms).toBeGreaterThanOrEqual(0);
  });

  it('scores an unresolved error higher than the same error once it is resolved', async () => {
    // Padded so both transcripts put the error result at the same distance
    // from the end, isolating the error-resolution signal from recency.
    const unresolvedMessages = [
      message('user', 'run tests'),
      call('e1', 'Bash', { command: 'npm test' }),
      result('e1', 'FAIL: expected 2 to be 3', true),
      message('assistant', 'looking into it'),
      message('user', 'ok'),
    ];
    const resolvedMessages = [
      message('user', 'run tests'),
      call('e1', 'Bash', { command: 'npm test' }),
      result('e1', 'FAIL: expected 2 to be 3', true),
      call('e2', 'Bash', { command: 'npm test' }),
      result('e2', 'PASS', false),
    ];
    const classifier = new RulesetClassifier();

    const unresolvedCtx = contextFor(unresolvedMessages);
    const unresolvedRun = await classifier.score(unresolvedCtx.calls, unresolvedCtx);

    const resolvedCtx = contextFor(resolvedMessages);
    const resolvedRun = await classifier.score(
      resolvedCtx.calls.filter((c) => c.id === 't1'),
      resolvedCtx,
    );

    const age = 2; // both transcripts: 5 messages total, error result at index 2
    expect(unresolvedRun.scores.get('t1')?.keepResult).toBeCloseTo(0.75 * scaleFor(age), 5);
    // e2 is the identical retry that both resolves the error *and* supersedes
    // e1 (same tool, same normalised input), so the ×0.3 supersede penalty
    // stacks on top of the resolved-error base here.
    expect(resolvedRun.scores.get('t1')?.keepResult).toBeCloseTo(0.2 * scaleFor(age) * 0.3, 5);
    expect(unresolvedRun.scores.get('t1')!.keepResult).toBeGreaterThan(resolvedRun.scores.get('t1')!.keepResult);
  });

  it('scores rerunnable tools (Read/Grep/Glob/LS) with a low keepResult relative to keepCall', async () => {
    const messages = [
      message('user', 'look at files'),
      call('r1', 'Read', { file_path: 'src/a.ts' }),
      result('r1', 'file contents'.repeat(5)),
    ];
    const ctx = contextFor(messages);
    const run = await new RulesetClassifier().score(ctx.calls, ctx);
    const score = run.scores.get('t1')!;
    expect(score.keepResult).toBeCloseTo(0.25, 5);
    expect(score.keepCall).toBeCloseTo(0.4, 5);
    expect(score.keepCall).toBeGreaterThan(score.keepResult);
  });

  it('lowers both scores for a call superseded by an identical later call', async () => {
    const messages = [
      message('user', 'check the file'),
      call('s1', 'Read', { file_path: 'src/a.ts' }),
      result('s1', 'old contents'),
      call('s2', 'Read', { file_path: 'src/a.ts' }),
      result('s2', 'new contents'),
    ];
    const ctx = contextFor(messages);
    const run = await new RulesetClassifier().score(ctx.calls, ctx);
    const first = run.scores.get('t1')!;
    const second = run.scores.get('t2')!;
    expect(first.keepResult).toBeLessThan(second.keepResult);
    expect(first.keepCall).toBeLessThan(second.keepCall);
    // the later, live call is unaffected
    expect(second.keepResult).toBeCloseTo(0.25, 5);
    expect(second.keepCall).toBeCloseTo(0.4, 5);
  });

  it('does not consider two calls with different inputs superseded', async () => {
    const messages = [
      message('user', 'check two files'),
      call('d1', 'Read', { file_path: 'src/a.ts' }),
      result('d1', 'a contents'),
      call('d2', 'Read', { file_path: 'src/b.ts' }),
      result('d2', 'b contents'),
    ];
    const ctx = contextFor(messages);
    const run = await new RulesetClassifier().score(ctx.calls, ctx);
    const first = run.scores.get('t1')!;
    const second = run.scores.get('t2')!;
    // Each call's score is just its plain (recency-scaled) base — neither
    // carries the ×0.3/×0.5 supersede penalty, since the inputs differ.
    expect(first.keepResult).toBeCloseTo(0.25 * scaleFor(2), 5);
    expect(first.keepCall).toBeCloseTo(0.4 * scaleFor(2), 5);
    expect(second.keepResult).toBeCloseTo(0.25 * scaleFor(0), 5);
    expect(second.keepCall).toBeCloseTo(0.4 * scaleFor(0), 5);
  });

  it('boosts keepResult when the result mentions a path also mentioned in the last 6 messages', async () => {
    const messages = [
      message('user', 'look at src/a.ts closely'),
      call('r1', 'Read', { file_path: 'src/a.ts' }),
      result('r1', 'contents referencing src/a.ts again'),
    ];
    const ctx = contextFor(messages);
    const run = await new RulesetClassifier().score(ctx.calls, ctx);
    const score = run.scores.get('t1')!;
    expect(score.keepResult).toBeCloseTo(0.25 + 0.2, 5);
  });

  it('applies the large-result penalty with a floor of 0.05', async () => {
    const messages = [
      message('user', 'fetch a big page'),
      call('w1', 'WebFetch', { url: 'https://example.com' }),
      result('w1', 'x'.repeat(25_000)),
    ];
    const ctx = contextFor(messages);
    const run = await new RulesetClassifier().score(ctx.calls, ctx);
    const score = run.scores.get('t1')!;
    expect(score.keepResult).toBeCloseTo(0.7 - 0.1, 5);
  });

  it('never lets the large-result penalty push keepResult below 0.05', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => [
      call(`c${i}`, 'Read', { file_path: `src/f${i}.ts` }),
      result(`c${i}`, 'x'.repeat(25_000)),
    ]).flat();
    messages.unshift(message('user', 'start'));
    const ctx = contextFor(messages);
    const run = await new RulesetClassifier({ staleAfterMessages: 5 }).score(ctx.calls, ctx);
    // the oldest calls are far past staleAfterMessages, so recency collapses to 0
    const oldest = run.scores.get('t1')!;
    expect(oldest.keepResult).toBeGreaterThanOrEqual(0.05);
  });

  it('scores Bash results higher when they contain failure words, lower when short and not an error', async () => {
    const messages = [
      message('user', 'build'),
      call('b1', 'Bash', { command: 'npm run build' }),
      result('b1', 'Build failed: TypeError in module x'),
      call('b2', 'Bash', { command: 'echo ok' }),
      result('b2', 'ok'),
    ];
    const ctx = contextFor(messages);
    const run = await new RulesetClassifier().score(ctx.calls, ctx);
    expect(run.scores.get('t1')!.keepResult).toBeGreaterThan(run.scores.get('t2')!.keepResult);
    expect(run.scores.get('t2')!.keepResult).toBeCloseTo(0.2, 5);
  });
});
