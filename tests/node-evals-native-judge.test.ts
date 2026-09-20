import { describe, expect, it } from 'vitest';

import { judgeItemsFor, judgeRetention, type JudgeItem } from '../src/node/evals/judge.js';
import type { ModelCall } from '../src/node/evals/model.js';
import { nativeCompaction, renderTranscript } from '../src/node/evals/native.js';
import { aggregate, evaluateCase, markdownReport, type EvalReport } from '../src/node/evals/run.js';
import { listCases, type CallLabel, type DatasetCase, type Probe } from '../src/node/evals/dataset.js';
import { structureValid } from '../src/node/evals/scorers.js';
import type { Message } from '../src/types.js';

/** A `ModelCall` that never touches a process or the network: it just replays canned text. */
function fakeModel(text: string): ModelCall {
  return async () => ({ text, ms: 1 });
}

function toolMessage(role: 'assistant' | 'user', message: Partial<Message>): Message {
  return { role, text: '', toolUses: [], ...message };
}

describe('renderTranscript', () => {
  it('caps a single tool_result at 20000 chars with an omission marker', () => {
    const big = 'x'.repeat(25_000);
    const transcript: Message[] = [
      toolMessage('assistant', { toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { path: 'a.txt' } }] }),
      toolMessage('user', { toolResults: [{ tool_use_id: 't1', text: big }] }),
    ];
    const rendered = renderTranscript(transcript);
    expect(rendered.text).toContain('[tool_use Read {"path":"a.txt"}]');
    expect(rendered.text).toContain('[tool_result t1]');
    expect(rendered.text).toContain('[… 5000 chars omitted …]');
    expect(rendered.text).toContain('x'.repeat(20_000));
    expect(rendered.text).not.toContain('x'.repeat(20_001));
  });

  it('abridges the oldest turns first when the whole rendering exceeds the total cap, keeping the newest verbatim', () => {
    const transcript: Message[] = [];
    for (let i = 0; i < 40; i++) {
      transcript.push(toolMessage('assistant', { text: `turn ${i}: ${'y'.repeat(20_000)}` }));
    }
    const rawLength = transcript.reduce((sum, m) => sum + m.text.length, 0);
    const rendered = renderTranscript(transcript);
    expect(rendered.truncated).toBe(true);
    expect(rendered.omittedChars).toBeGreaterThan(0);
    expect(rendered.text.length).toBeLessThan(rawLength);
    // The newest turn must survive untouched; the oldest must have been abridged away.
    expect(rendered.text).toContain(`turn 39: ${'y'.repeat(20_000)}`);
    expect(rendered.text).not.toContain(`turn 0: ${'y'.repeat(20_000)}`);
    expect(rendered.text).toMatch(/message 0 abridged/);
  });

  it('does not touch a rendering that already fits', () => {
    const transcript: Message[] = [toolMessage('user', { text: 'hello' })];
    const rendered = renderTranscript(transcript);
    expect(rendered.truncated).toBe(false);
    expect(rendered.omittedChars).toBe(0);
    expect(rendered.text).toBe('user:\nhello');
  });
});

describe('nativeCompaction', () => {
  function transcriptWithOrphanBoundary(): Message[] {
    return [
      toolMessage('assistant', { toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { path: 'a.txt' } }] }),
      toolMessage('user', { toolResults: [{ tool_use_id: 'a', text: 'contents of a' }] }),
      toolMessage('assistant', { toolUses: [{ tool_use_id: 'b', tool: 'Read', input: { path: 'b.txt' } }] }),
      toolMessage('user', { toolResults: [{ tool_use_id: 'b', text: 'contents of b' }] }),
      toolMessage('assistant', { text: 'final assistant message' }),
    ];
  }

  it('replaces the whole history with the summary by default (keepRecent 0)', async () => {
    const transcript = transcriptWithOrphanBoundary();
    const result = await nativeCompaction(transcript, fakeModel('SUMMARY TEXT'));
    expect(result.output).toEqual([{ role: 'user', text: 'SUMMARY TEXT', toolUses: [] }]);
    expect(result.summary).toBe('SUMMARY TEXT');
    expect(result.abridged).toBe(false);
  });

  it('puts the summary first, then the kept tail, dropping a tool_result whose tool_use fell outside the tail', async () => {
    const transcript = transcriptWithOrphanBoundary();
    // Last 2 messages: [tool_result b] (its tool_use 'b' is message index 2, NOT in the tail), [final assistant message].
    const result = await nativeCompaction(transcript, fakeModel('SUMMARY TEXT'), { keepRecent: 2 });
    expect(result.output).toHaveLength(3);
    expect(result.output[0]).toEqual({ role: 'user', text: 'SUMMARY TEXT', toolUses: [] });
    // The orphaned tool_result for 'b' must have been dropped, not just left dangling.
    expect(result.output[1]!.toolResults ?? []).toHaveLength(0);
    expect(result.output[2]!.text).toBe('final assistant message');
    expect(structureValid(result.output)).toBe(true);
  });

  it('keeps a paired tool_use/tool_result together when both fall inside the tail', async () => {
    const transcript = transcriptWithOrphanBoundary();
    // Last 3 messages: [tool_use b], [tool_result b], [final assistant message] — 'b' is fully inside the tail.
    const result = await nativeCompaction(transcript, fakeModel('SUMMARY TEXT'), { keepRecent: 3 });
    expect(result.output).toHaveLength(4);
    expect(result.output[2]!.toolResults).toEqual([{ tool_use_id: 'b', text: 'contents of b' }]);
    expect(structureValid(result.output)).toBe(true);
  });
});

function makeSyntheticCase(): DatasetCase {
  const transcript: Message[] = [];
  const calls: Record<string, CallLabel> = {};
  for (let i = 0; i < 5; i++) {
    const id = `mk${i}`;
    transcript.push(toolMessage('assistant', { toolUses: [{ tool_use_id: id, tool: 'Read', input: { path: `f${i}.txt` } }] }));
    transcript.push(toolMessage('user', { toolResults: [{ tool_use_id: id, text: `must-keep result ${i}` }] }));
    calls[id] = 'must_keep';
  }
  for (let i = 0; i < 60; i++) {
    const id = `sd${i}`;
    transcript.push(toolMessage('assistant', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { cmd: `echo ${i}` } }] }));
    transcript.push(toolMessage('user', { toolResults: [{ tool_use_id: id, text: `droppable output ${i}` }] }));
    calls[id] = 'safe_to_drop';
  }
  const probes: Probe[] = Array.from({ length: 3 }, (_, i) => ({
    id: `p${i}`,
    kind: 'fact',
    text: `fact number ${i}`,
    where: 'active',
    note: 'a probe',
  }));
  return {
    dir: 'synthetic',
    name: 'synthetic',
    transcript,
    labels: { version: 1, calls, probes },
    cassettePath: 'synthetic/cassette.json',
  };
}

describe('judgeItemsFor', () => {
  it('always includes every probe and every must_keep call, then fills the rest with safe_to_drop up to the 40 cap', () => {
    const item = makeSyntheticCase();
    const items = judgeItemsFor(item);
    expect(items.length).toBe(40);
    const probeIds = items.filter((i) => i.id.startsWith('p')).map((i) => i.id);
    expect(probeIds.sort()).toEqual(['p0', 'p1', 'p2']);
    const mustKeepIds = items.filter((i) => i.expected === 'kept' && i.id.startsWith('call:mk'));
    expect(mustKeepIds).toHaveLength(5);
    const dropIds = items.filter((i) => i.expected === 'removed');
    expect(dropIds).toHaveLength(40 - 3 - 5);
    for (const dropped of dropIds) {
      expect(dropped.id.startsWith('call:sd')).toBe(true);
      expect(dropped.text).toContain('tool Bash');
    }
  });

  it('is well under the cap, and includes everything, on a small case', () => {
    const item: DatasetCase = {
      dir: 'small',
      name: 'small',
      transcript: [
        toolMessage('assistant', { toolUses: [{ tool_use_id: 'x1', tool: 'Read', input: {} }] }),
        toolMessage('user', { toolResults: [{ tool_use_id: 'x1', text: 'result' }] }),
      ],
      labels: {
        version: 1,
        calls: { x1: 'must_keep' },
        probes: [{ id: 'p1', kind: 'fact', text: 'a fact', where: 'active', note: '' }],
      },
      cassettePath: 'small/cassette.json',
    };
    const items = judgeItemsFor(item);
    expect(items).toHaveLength(2);
  });
});

describe('judgeRetention', () => {
  const items: JudgeItem[] = [
    { id: 'a', kind: 'fact', text: 'fact A', expected: 'kept' },
    { id: 'b', kind: 'fact', text: 'fact B', expected: 'kept' },
  ];

  it('parses a fenced JSON reply and scores an omitted id as absent, counting it in missingVerdicts', async () => {
    const model = fakeModel('```json\n{"verdicts":[{"id":"a","present":"verbatim","evidence":"fact A"}]}\n```');
    const result = await judgeRetention([], items, model);
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts.find((v) => v.id === 'a')).toEqual({ id: 'a', present: 'verbatim', evidence: 'fact A' });
    expect(result.verdicts.find((v) => v.id === 'b')).toEqual({ id: 'b', present: 'absent' });
    expect(result.missingVerdicts).toBe(1);
  });

  it('finds the JSON object even with leading prose and trailing chatter around it', async () => {
    const model = fakeModel(
      'Sure, here is my analysis:\n{"verdicts":[{"id":"a","present":"paraphrased"},{"id":"b","present":"absent"}]}\nLet me know if that helps!',
    );
    const result = await judgeRetention([], items, model);
    expect(result.verdicts.find((v) => v.id === 'a')?.present).toBe('paraphrased');
    expect(result.verdicts.find((v) => v.id === 'b')?.present).toBe('absent');
    expect(result.missingVerdicts).toBe(0);
  });

  it('treats totally unparsable output as every item absent', async () => {
    const model = fakeModel('I refuse to answer in JSON.');
    const result = await judgeRetention([], items, model);
    expect(result.verdicts).toEqual([
      { id: 'a', present: 'absent' },
      { id: 'b', present: 'absent' },
    ]);
    expect(result.missingVerdicts).toBe(2);
  });
});

describe('run integration: CLAUDE_NATIVE_COMPACTION + judge', () => {
  it('evaluateCase produces judged counts, and the markdown report grows the judge columns', async () => {
    const cases = await listCases('datasets/v1/adversarial/late-constraint');
    expect(cases).toHaveLength(1);
    const item = cases[0]!;

    const model: ModelCall = async (prompt) => {
      if (prompt.includes('Respond with STRICT JSON only')) {
        const expectedItems = judgeItemsFor(item);
        const verdicts = expectedItems.map((i) => ({
          id: i.id,
          present: i.expected === 'kept' ? 'verbatim' : 'absent',
        }));
        return { text: JSON.stringify({ verdicts }), ms: 1 };
      }
      return {
        text: '1. Primary Request and Intent\nDo the thing.\n2. Key Technical Concepts\n...\n',
        ms: 1,
      };
    };

    const results = await evaluateCase(item, ['CLAUDE_NATIVE_COMPACTION'], {
      dataset: item.dir,
      model,
      judge: 'native',
    });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.error).toBeUndefined();
    expect(result.available).toBe(true);
    expect(result.summaryChars).toBeGreaterThan(0);
    expect(result.abridged).toBe(false);
    expect(result.judged).toBeDefined();
    expect(result.judged!.mustKeepTotal).toBeGreaterThan(0);
    expect(result.judged!.mustKeepAbsent).toBe(0);
    expect(result.judged!.probesTotal).toBeGreaterThan(0);
    expect(result.judged!.probesAbsent).toBe(0);
    expect(result.judged!.safeToDropTotal).toBeGreaterThan(0);
    expect(result.judged!.safeToDropPresent).toBe(0);
    expect(result.judged!.missingVerdicts).toBe(0);
    // The exact-substring fidelity is still computed alongside the judge, and — as
    // expected for a real paraphrasing summary — looks bad: everything not in the
    // kept tail is gone verbatim.
    expect(result.fidelity.mustKeepFalseDrop).toBe(result.fidelity.mustKeepTotal);

    const report: EvalReport = {
      dataset: 'datasets/v1/adversarial/late-constraint',
      ranAt: new Date().toISOString(),
      options: { dataset: item.dir },
      results,
      aggregates: aggregate(results),
    };
    const md = markdownReport(report);
    expect(md).toContain('safe_to_drop kept (exact)');
    expect(md).toContain('must_keep lost (judge)');
    expect(md).toContain('probes lost (judge)');
    expect(md).toContain('safe_to_drop still present (judge)');
    expect(md).toContain('CLAUDE_NATIVE_COMPACTION');
    expect(md).toContain('summary=');
  });

  it('reports CLAUDE_NATIVE_COMPACTION as unavailable when no model is configured', async () => {
    const cases = await listCases('datasets/v1/adversarial/late-constraint');
    const item = cases[0]!;
    const results = await evaluateCase(item, ['CLAUDE_NATIVE_COMPACTION'], { dataset: item.dir });
    expect(results).toHaveLength(1);
    expect(results[0]!.available).toBe(false);
    expect(results[0]!.reason).toMatch(/no model configured/);
  });
});
