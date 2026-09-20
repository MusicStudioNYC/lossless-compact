import { describe, expect, it } from 'vitest';
import { MemoryArchive } from '../src/archive/memory-store.js';
import type { ClassifierScores } from '../src/core/actions.js';
import type { Classifier } from '../src/classifiers/types.js';
import { optimize } from '../src/engine/optimize.js';
import {
  classifierWithKeeps,
  parseReview,
  reviewCandidates,
  reviewQuestion,
  reviewQuestionWithContext,
} from '../src/engine/review.js';
import type { Message } from '../src/types.js';

const message = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({ role, text, toolUses: [], ...extra });
const call = (id: string, tool: string, input: Record<string, unknown>, text: string): Message =>
  message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
const res = (id: string, text: string): Message => message('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] });

const config = 'ORCHARD_DB_PORT=61873\nORCHARD_REGION=eu-north-7\n';
const big = 'declare const x: number;\n'.repeat(120);
const transcript: Message[] = [
  message('user', 'Read the config and the typings; I will ask about the port later.'),
  call('c1', 'Read', { file_path: 'scratch/smoke-config.env' }, config),
  res('c1', config),
  call('c2', 'Read', { file_path: 'types/api.d.ts', offset: 1, limit: 2000 }, big),
  res('c2', big),
  call('c3', 'Read', { file_path: 'types/api.d.ts', offset: 2001, limit: 2000 }, big),
  res('c3', big),
  call('c4', 'Read', { file_path: 'docs/plan.md' }, big),
  res('c4', big),
  call('c5', 'Read', { file_path: 'src/engine/optimize.ts' }, big),
  res('c5', big),
  call('c6', 'Read', { file_path: 'src/node/transcripts.ts' }, big),
  res('c6', big),
  message('assistant', 'done: 6 files read'),
  message('user', 'thanks'),
];

const dropAll: Classifier = {
  name: 'drop-all',
  async score(candidates) {
    const scores = new Map<string, ClassifierScores>();
    for (const c of candidates) scores.set(c.id, { keepCall: 0.2, keepResult: 0.1 });
    return { scores, stats: { requests: 1, stateTokens: 0, stateStage: 'fake', ms: 0, unscored: [] } };
  },
};

async function run(classifier: Classifier) {
  return optimize(transcript, {
    classifier,
    archive: new MemoryArchive(),
    sessionId: 's',
    compactionId: 'c',
    preserveRecentMessages: 2,
  });
}

describe('reviewCandidates / reviewQuestion', () => {
  it('lists every dropped, scored interaction with its input, size, score and sketch, in order', async () => {
    const result = await run(dropAll);
    const candidates = reviewCandidates(transcript, result.decisions, 2);
    expect(candidates.map((c) => c.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    expect(candidates[0]).toMatchObject({ tool: 'Read', about: 'file_path=scratch/smoke-config.env', keepResult: 0.1 });
    expect(candidates[0]!.sketch).toContain('ORCHARD_DB_PORT');
    expect(candidates[2]!.about).toBe('file_path=types/api.d.ts offset=2001');
    expect(candidates[1]!.tokens).toBeGreaterThan(500);

    const question = reviewQuestion(candidates, 0.35);
    expect(question).toContain('each of the 6 below scored under the keep threshold (0.35)');
    expect(question).toContain('- t1 · Read file_path=scratch/smoke-config.env');
    expect(question).toContain('"verdict":"drop_all"|"keep_some"|"unsure"');

    const cold = reviewQuestionWithContext(transcript, candidates, 0.35);
    expect(cold).toContain('I will ask about the port later');
    expect(cold).toContain("The assistant's latest reply: done: 6 files read");
    expect(cold).toContain(question);
  });
});

describe('parseReview', () => {
  const ids = new Set(['t1', 't2', 't3']);

  it('reads a fenced or chatty reply and keeps only known ids', () => {
    expect(parseReview('Sure.\n```json\n{"verdict":"keep_some","keep":["t1","t9"],"reason":"the port is needed"}\n```', ids)).toEqual({
      verdict: 'keep_some',
      keep: ['t1'],
      reason: 'the port is needed',
    });
    expect(parseReview('{"verdict":"drop_all","keep":[],"reason":"reference reads only"}', ids)).toEqual({
      verdict: 'drop_all',
      keep: [],
      reason: 'reference reads only',
    });
  });

  it('turns keep_some with no usable id into unsure, and rejects anything else', () => {
    expect(parseReview('{"verdict":"keep_some","keep":["t9"]}', ids)).toMatchObject({ verdict: 'unsure', keep: [] });
    expect(parseReview('{"verdict":"maybe"}', ids)).toBeUndefined();
    expect(parseReview('no json here', ids)).toBeUndefined();
    expect(parseReview('{"verdict":"drop_all"', ids)).toBeUndefined();
  });
});

describe('classifierWithKeeps', () => {
  it('replays the first run and keeps only what the reviewer named, with no network', async () => {
    const first = await run(dropAll);
    expect(first.actions.filter((a) => a.scores && a.action === 'KEEP_VERBATIM')).toHaveLength(0);
    const second = await run(classifierWithKeeps(first.decisions, new Set(['t1']), 'drop-all+review'));
    const kept = second.actions.filter((a) => a.scores && a.action === 'KEEP_VERBATIM');
    expect(kept).toHaveLength(1);
    expect(second.report.classifier).toBe('drop-all+review');
    expect(second.stats.requests).toBe(0);
    const text = second.messages.map((m) => [m.text, ...(m.toolResults ?? []).map((r) => r.text)].join('\n')).join('\n');
    expect(text).toContain('ORCHARD_DB_PORT=61873');
    expect(text).not.toContain(big);
    // every other decision is unchanged
    expect(second.decisions.filter((d) => d.id !== 't1').map((d) => [d.id, d.action])).toEqual(
      first.decisions.filter((d) => d.id !== 't1').map((d) => [d.id, d.action]),
    );
  });

  it('reports calls it has no score for as unscored', async () => {
    const replay = classifierWithKeeps([], new Set());
    const run1 = await replay.score([{ id: 't1' } as never], {} as never);
    expect(run1.stats.unscored).toEqual(['t1']);
  });
});
