import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryArchive } from '../src/archive/memory-store.js';
import type { ArchiveStore } from '../src/archive/types.js';
import type { ActionDecision, ClassifierScores } from '../src/core/actions.js';
import type { Classifier } from '../src/classifiers/types.js';
import { optimize, type OptimizeOptions, type OptimizeResult } from '../src/engine/optimize.js';
import type { Message, ToolUse, ToolResult } from '../src/types.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string, isError = false): Message {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text, ...(isError ? { isError: true } : {}) }],
  });
}

function narratedCall(
  narration: string,
  id: string,
  tool: string,
  input: Record<string, unknown>,
  text: string,
): Message {
  return message('assistant', narration, { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

const fileA = 'export const a = 1;\n'.repeat(50);
// The dependency graph only indexes anchors found in a tool_result's own text
// (see src/core/dependencies.ts), and only a *strong* reference (a quoted
// line, a repeated error, a tool id, or anything from the user) hard-protects
// via `referenced_later` (src/engine/optimize.ts's splitReferences); a plain
// path/symbol mention from assistant text is merely a soft, score-boosting
// reference. So the later reference here repeats this distinctive line
// (>=40 chars) verbatim, which anchors as a 'quote'.
const DISTINCTIVE_LINE = 'IMPORTANT: this file backs the payment retry queue configuration.';
const fileB = 'export const b = 2;\n'.repeat(50) + `${DISTINCTIVE_LINE}\n`;
const grepResult = 'src/a.ts:1:TODO fix this\nsrc/util.ts:9:TODO cleanup\n';
const bashFailLong = 'FAIL b.test.ts\n' + 'expected 2 to be 3 but received something else entirely\n'.repeat(6);
const lintFail = 'Error: ESLint config invalid, please fix the .eslintrc file before continuing';
const editResult = 'ok';
const webFetchResult = 'Documentation content about the API and how to use it in some detail.';
const passResult = 'PASS b.test.ts';
const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const secretResult = `ANTHROPIC_API_KEY=${secret}\ndone\n`;

/**
 * ~14+ messages: several Reads (one an exact duplicate), a Grep, a failing
 * Bash resolved by a later identical success, a second failing Bash that is
 * never resolved, an Edit of a file read earlier, a WebFetch, and a Bash
 * result carrying a fake secret. Tool call ids are assigned t1..t10 in
 * transcript order by `collectToolCalls`; comments below note which is which.
 */
function transcript(): Message[] {
  return [
    message('user', 'Fix the failing tests in this repo. Never edit anything under src/generated.'), // 0
    call('c1', 'Read', { file_path: 'src/a.ts' }, fileA), // 1 -> t1 (duplicated later)
    result('c1', fileA), // 2
    call('c2', 'Read', { file_path: 'src/b.ts' }, fileB), // 3 -> t2 (referenced later + edited later)
    result('c2', fileB), // 4
    call('c3', 'Grep', { pattern: 'TODO', path: 'src' }, grepResult), // 5 -> t3
    result('c3', grepResult), // 6
    call('c4', 'Bash', { command: 'npm test' }, bashFailLong, true), // 7 -> t4 (resolved later)
    result('c4', bashFailLong, true), // 8
    call('c5', 'Bash', { command: 'npm run lint' }, lintFail, true), // 9 -> t5 (never resolved)
    result('c5', lintFail, true), // 10
    message('assistant', 'The lint config looks broken; checking further.'), // 11
    message('assistant', 'Still investigating the test failure.'), // 12
    message('assistant', `Wait, let me look again.\n${DISTINCTIVE_LINE}\nOK, continuing.`), // 13 (quotes t2's result content verbatim)
    narratedCall(
      'Editing b.ts to fix the off-by-one.',
      'c6',
      'Edit',
      { file_path: 'src/b.ts', old_string: 'b = 2', new_string: 'b = 3' },
      editResult,
    ), // 14 -> t6
    result('c6', editResult), // 15
    call('c7', 'WebFetch', { url: 'https://example.com/docs' }, webFetchResult), // 16 -> t7
    result('c7', webFetchResult), // 17
    call('c8', 'Bash', { command: 'npm test' }, passResult), // 18 -> t8 (resolves t4; left unscored)
    result('c8', passResult), // 19
    call('c9', 'Read', { file_path: 'src/a.ts' }, fileA), // 20 -> t9 (exact duplicate of t1's content)
    result('c9', fileA), // 21
    call('c10', 'Bash', { command: 'printenv | grep ANTHROPIC' }, secretResult), // 22 -> t10 (carries a secret)
    result('c10', secretResult), // 23
    message('assistant', 'Everything looks fine now.'), // 24
    message('user', 'go ahead'), // 25
  ];
}

interface RecordedCall {
  id: string;
  sketch: string | undefined;
  resultText: string | undefined;
}

const SCORES: Record<string, ClassifierScores> = {
  t3: { keepCall: 0.8, keepResult: 0.1 }, // Grep is rerunnable -> RERUN_ON_DEMAND
  t4: { keepCall: 0.8, keepResult: 0.1 }, // Bash is not rerunnable -> KEEP_HEAD_TAIL
  t6: { keepCall: 0.05, keepResult: 0.05 }, // both low -> ARCHIVE_ONLY
  t9: { keepCall: 0.9, keepResult: 0.9 }, // high -> KEEP_VERBATIM
  t10: { keepCall: 0.1, keepResult: 0.1 }, // both low -> ARCHIVE_ONLY
};

/** t8 is deliberately left out of SCORES and reported unscored. */
function makeFakeClassifier(asked: string[], recorded: RecordedCall[]): Classifier {
  return {
    name: 'fake',
    async score(candidates, context) {
      const scores = new Map<string, ClassifierScores>();
      const unscored: string[] = [];
      for (const c of candidates) {
        asked.push(c.id);
        const shownResult = context.messages[c.resultIndex]?.toolResults?.find((r) => r.tool_use_id === c.tool_use_id);
        recorded.push({ id: c.id, sketch: context.sketches?.get(c.id), resultText: shownResult?.text });
        if (c.id === 't8') {
          unscored.push(c.id);
          continue;
        }
        scores.set(c.id, SCORES[c.id] ?? { keepCall: 1, keepResult: 1 });
      }
      return { scores, stats: { requests: 1, stateTokens: 0, stateStage: 'fake', ms: 0, unscored } };
    },
  };
}

async function run(
  messages: readonly Message[],
  options: Partial<OptimizeOptions> = {},
): Promise<{ result: OptimizeResult; asked: string[]; recorded: RecordedCall[]; archive: ArchiveStore }> {
  const asked: string[] = [];
  const recorded: RecordedCall[] = [];
  const classifier = options.classifier ?? makeFakeClassifier(asked, recorded);
  const archive = options.archive ?? new MemoryArchive();
  const result = await optimize(messages, {
    sessionId: 'engine-test',
    compactionId: 'c-main',
    preserveRecentMessages: 2,
    truncateHeadChars: 40,
    ...options,
    archive,
    classifier,
  });
  return { result, asked, recorded, archive };
}

/** decisions/actions are pushed in `calls` order, i.e. t1, t2, ... in order. */
function actionFor(result: OptimizeResult, callId: string): ActionDecision {
  const index = Number(callId.slice(1)) - 1;
  const decision = result.actions[index];
  if (!decision) throw new Error(`no decision at index ${index} for ${callId}`);
  return decision;
}

function findToolUse(messages: readonly Message[], toolUseId: string): ToolUse | undefined {
  for (const m of messages) {
    const found = m.toolUses.find((u) => u.tool_use_id === toolUseId);
    if (found) return found;
  }
  return undefined;
}

function findToolResult(messages: readonly Message[], toolUseId: string): ToolResult | undefined {
  for (const m of messages) {
    const found = (m.toolResults ?? []).find((r) => r.tool_use_id === toolUseId);
    if (found) return found;
  }
  return undefined;
}

describe('optimize: main scenario', () => {
  let messages: Message[];
  let result: OptimizeResult;
  let asked: string[];
  let recorded: RecordedCall[];

  beforeAll(async () => {
    messages = transcript();
    ({ result, asked, recorded } = await run(messages));
  });

  it('never places a tool_result whose tool_use is missing or later in the output', () => {
    const seenUses = new Set<string>();
    for (const m of result.messages) {
      for (const u of m.toolUses) seenUses.add(u.tool_use_id);
      for (const r of m.toolResults ?? []) {
        expect(seenUses.has(r.tool_use_id)).toBe(true);
      }
    }
  });

  it('keeps untouched messages as the exact same objects, in original order', () => {
    const untouchedIndices = [0, 11, 12, 13, 24, 25];
    for (const i of untouchedIndices) {
      expect(result.messages).toContain(messages[i]);
    }
    const positions = untouchedIndices.map((i) => result.messages.indexOf(messages[i]!));
    for (let k = 1; k < positions.length; k++) {
      expect(positions[k]!).toBeGreaterThan(positions[k - 1]!);
    }
  });

  it('carries the user constraint sentence verbatim', () => {
    expect(result.messages[0]?.text).toContain('Never edit anything under src/generated.');
  });

  it('archives every evicted unit with its exact original content, reachable via archive.get, and actions[].archiveIds point at them', async () => {
    const evictedIds = ['t1', 't3', 't4', 't6', 't10'];
    for (const id of evictedIds) {
      const decision = actionFor(result, id);
      expect(decision.archiveIds, `${id} should have archiveIds`).toBeDefined();
      expect(decision.archiveIds!.length).toBeGreaterThan(0);
      for (const archiveId of decision.archiveIds!) {
        const archived = result.archived.find((r) => r.id === archiveId);
        expect(archived, `${archiveId} should be in result.archived`).toBeDefined();
        const viaGet = await result.archive.get(archiveId);
        expect(viaGet).toEqual(archived);
      }
    }
    const t4Decision = actionFor(result, 't4');
    const t4Archived = result.archived.find((r) => r.id === t4Decision.resultId);
    expect(t4Archived?.content).toBe(bashFailLong);

    const t6Decision = actionFor(result, 't6');
    expect(t6Decision.archiveIds).toHaveLength(2); // both the call and its result are dropped
  });

  it('drops the exact duplicate Read as DROP_REDUNDANT without asking the classifier about it', () => {
    const decision = actionFor(result, 't1');
    expect(decision.action).toBe('DROP_REDUNDANT');
    const survivorResultId = actionFor(result, 't9').resultId;
    expect(decision.reasons[0]?.refs?.[0]).toBe(survivorResultId);
    expect(asked).not.toContain('t1');
    expect(asked).toContain('t9');
  });

  it('does not protect a failing Bash call whose command later succeeded', () => {
    const decision = actionFor(result, 't4');
    expect(decision.protectedBy).not.toContain('unresolved_error');
  });

  it('protects a failing Bash call with no later success, even though the fake would score it 0', () => {
    const decision = actionFor(result, 't5');
    expect(decision.protectedBy).toContain('unresolved_error');
    expect(decision.action).toBe('KEEP_VERBATIM');
    expect(asked).not.toContain('t5');
  });

  it('protects the WebFetch result as non_reproducible', () => {
    const decision = actionFor(result, 't7');
    expect(decision.protectedBy).toContain('non_reproducible');
    expect(decision.action).toBe('KEEP_VERBATIM');
    expect(asked).not.toContain('t7');
  });

  it('protects a Read result that a later assistant message references by path, 3+ messages later', () => {
    const decision = actionFor(result, 't2');
    expect(decision.protectedBy).toContain('referenced_later');
    expect(asked).not.toContain('t2');
  });

  it('KEEP_HEAD_TAIL stubs the result to the head of the original plus an archive marker; the tool_use mirror matches', () => {
    const decision = actionFor(result, 't4');
    expect(decision.action).toBe('KEEP_HEAD_TAIL');
    const archiveId = decision.archiveIds![0]!;
    const toolResult = findToolResult(result.messages, 'c4')!;
    expect(toolResult.text.startsWith(bashFailLong.slice(0, 40))).toBe(true);
    expect(toolResult.text).toContain(`lossless-compact archived ${archiveId}`);
    const toolUse = findToolUse(result.messages, 'c4')!;
    expect(toolUse.text).toBe(toolResult.text);
  });

  it('appends an archived-calls marker after the original narration text for an ARCHIVE_ONLY call', () => {
    const decision = actionFor(result, 't6');
    expect(decision.action).toBe('ARCHIVE_ONLY');
    const narrated = result.messages.find((m) => m.text.startsWith('Editing b.ts to fix the off-by-one.'));
    expect(narrated).toBeDefined();
    expect(narrated!.text.startsWith('Editing b.ts to fix the off-by-one.')).toBe(true);
    expect(narrated!.text).toContain('[lossless-compact archived 1 tool call made here: Edit file_path=src/b.ts → ');
    // the call itself is gone from the rebuilt message
    expect(narrated!.toolUses.some((u) => u.tool_use_id === 'c6')).toBe(false);
  });

  it('a text-less message whose only call was dropped becomes a marker alone, and a run of them merges into one', async () => {
    // Claude Code puts every tool call in its own assistant message with no
    // narration; seen live, four dropped Reads vanished without a trace.
    const dropAll: Classifier = {
      name: 'drop-all',
      async score(candidates) {
        const scores = new Map<string, ClassifierScores>();
        for (const c of candidates) scores.set(c.id, { keepCall: 0.05, keepResult: 0.05 });
        return { scores, stats: { requests: 1, stateTokens: 0, stateStage: 'fake', ms: 0, unscored: [] } };
      },
    };
    const big = 'declare const x: number;\n'.repeat(80);
    // `result` is the shared OptimizeResult inside this describe; build results by hand.
    const res = (id: string, text: string): Message => message('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] });
    const messages = [
      message('user', 'Read the typings in chunks, then tell me the answer.'),
      call('r1', 'Read', { file_path: 'types/api.d.ts', offset: 1, limit: 2000 }, big),
      res('r1', big),
      call('r2', 'Read', { file_path: 'types/api.d.ts', offset: 2001, limit: 2000 }, big),
      res('r2', big),
      call('r3', 'Read', { file_path: 'types/api.d.ts', offset: 4001, limit: 2000 }, big),
      res('r3', big),
      message('assistant', 'Chunks read.'),
      call('r4', 'Read', { file_path: 'docs/notes.md' }, big),
      res('r4', big),
      message('assistant', 'The answer is 42.'),
      message('user', 'thanks'),
    ];
    const { result: out } = await run(messages, { classifier: dropAll, preserveRecentMessages: 2 });
    const texts = out.messages.map((m) => m.text);
    // one merged marker for r1..r3, the narration, one marker for r4, then the pinned tail
    expect(out.messages).toHaveLength(6);
    expect(out.messages[0]!.text).toBe(messages[0]!.text);
    const mergedMarker = out.messages[1]!;
    expect(mergedMarker.role).toBe('assistant');
    expect(mergedMarker.toolUses).toEqual([]);
    expect(mergedMarker.text.startsWith('[lossless-compact archived 3 tool calls made here: Read file_path=types/api.d.ts → ')).toBe(true);
    expect(mergedMarker.text).toContain('; Read file_path=types/api.d.ts offset=2001 → ');
    expect(mergedMarker.text).toContain('; Read file_path=types/api.d.ts offset=4001 → ');
    const ids = out.actions.slice(0, 3).map((a) => a.archiveIds![0]);
    for (const id of ids) expect(mergedMarker.text).toContain(id!);
    expect(texts[2]).toBe('Chunks read.');
    expect(texts[3]!.startsWith('[lossless-compact archived 1 tool call made here: Read file_path=docs/notes.md → e_')).toBe(true);
    expect(texts.slice(4)).toEqual(['The answer is 42.', 'thanks']);
    // and nothing of the sort without the option
    const { result: bare } = await run(messages, { classifier: dropAll, preserveRecentMessages: 2, markRemovedCalls: false });
    expect(bare.messages.map((m) => m.text)).toEqual([messages[0]!.text, 'Chunks read.', 'The answer is 42.', 'thanks']);
  });

  it('leaves narration text unchanged when markRemovedCalls is false', async () => {
    const { result: result2 } = await run(transcript(), { markRemovedCalls: false });
    const narrated = result2.messages.find((m) => m.text.startsWith('Editing b.ts to fix the off-by-one.'));
    expect(narrated).toBeDefined();
    expect(narrated!.text).toBe('Editing b.ts to fix the off-by-one.');
  });

  it('keeps a call the classifier reports as unscored, with reason code unscored', () => {
    const decision = actionFor(result, 't8');
    expect(decision.action).toBe('KEEP_VERBATIM');
    expect(decision.reasons.some((r) => r.code === 'unscored')).toBe(true);
  });

  it('redacts secrets before showing the classifier, but keeps the real value in the output archive', async () => {
    const t10Recorded = recorded.find((r) => r.id === 't10');
    expect(t10Recorded?.resultText).toBeDefined();
    expect(t10Recorded!.resultText).not.toContain(secret);
    expect(t10Recorded!.resultText).toContain('<SECRET_1>');

    const decision = actionFor(result, 't10');
    expect(decision.action).toBe('ARCHIVE_ONLY');
    const archived = result.archived.find((r) => r.id === decision.resultId);
    expect(archived?.content).toContain(secret);
    const viaArchive = await result.archive.get(decision.resultId!);
    expect(viaArchive?.content).toContain(secret);

    expect(result.report.redactedSecrets).toBeGreaterThanOrEqual(1);
  });

  it('report counts are internally consistent', () => {
    const actionsSum = Object.values(result.report.actions).reduce((a, b) => a + b, 0);
    expect(actionsSum).toBe(10);
    expect(result.report.candidates).toBe(10);
    expect(result.report.duplicates).toBe(1);
    expect(result.report.unscored).toBe(1);
    expect(result.report.classified).toBe(5); // t3, t4, t6, t9, t10 (t8 unscored; t1/t2/t5/t7 never asked)
    expect(result.report.protections['unresolved_error']).toBe(1);
    expect(result.report.protections['non_reproducible']).toBe(1);
    expect(result.report.protections['referenced_later']).toBe(1);
  });

  it('stats add up: kept + resultsDropped + callsDropped + pinned === calls', () => {
    const { stats } = result;
    expect(stats.calls).toBe(10);
    expect(stats.kept + stats.resultsDropped + stats.callsDropped + stats.pinned).toBe(stats.calls);
  });
});

describe('optimize: keepThreshold default', () => {
  function tinyTranscript(): Message[] {
    return [
      message('user', 'start'),
      call('k1', 'Bash', { command: 'echo hi' }, 'hi output that is long enough to matter here'),
      result('k1', 'hi output that is long enough to matter here'),
      message('assistant', 'done for now'),
    ];
  }

  function scoringClassifier(name: string, defaultThreshold?: number): Classifier {
    const classifier: Classifier = {
      name,
      async score(candidates) {
        const scores = new Map<string, ClassifierScores>();
        for (const c of candidates) scores.set(c.id, { keepCall: 0.25, keepResult: 0.25 });
        return { scores, stats: { requests: 1, stateTokens: 0, stateStage: 'fake', ms: 0, unscored: [] } };
      },
    };
    if (defaultThreshold !== undefined) (classifier as { defaultThreshold?: number }).defaultThreshold = defaultThreshold;
    return classifier;
  }

  it('uses the classifier defaultThreshold (0.2) when none is given, so a 0.25 score keeps', async () => {
    const classifier = scoringClassifier('fake-threshold', 0.2);
    const out = await optimize(tinyTranscript(), { preserveRecentMessages: 0, classifier });
    expect(out.decisions[0]?.action).toBe('keep');
  });

  it('falls back to 0.5 when the classifier declares no defaultThreshold, so a 0.25 score does not keep', async () => {
    const classifier = scoringClassifier('fake-no-threshold');
    const out = await optimize(tinyTranscript(), { preserveRecentMessages: 0, classifier });
    expect(out.decisions[0]?.action).not.toBe('keep');
  });
});

describe('optimize: no classifier and no asker', () => {
  it('falls back to the heuristic classifier and does not throw', async () => {
    const result = await optimize(transcript(), { preserveRecentMessages: 2, truncateHeadChars: 40 });
    expect(result.report.classifier).toBe('heuristic');
  });
});

describe('optimize: idempotent archiving', () => {
  it('running optimize twice over the same archive yields identical archive ids and no conflict error', async () => {
    const archive = new MemoryArchive();
    const first = await run(transcript(), { archive });
    const second = await run(transcript(), { archive });
    const idsFirst = new Set(first.result.archived.map((r) => r.id));
    const idsSecond = new Set(second.result.archived.map((r) => r.id));
    expect(idsFirst.size).toBeGreaterThan(0);
    expect(idsSecond).toEqual(idsFirst);
  });
});
