import { describe, expect, it } from 'vitest';
import { MemoryArchive } from '../src/archive/memory-store.js';
import type { ClassifierScores } from '../src/core/actions.js';
import type { Classifier } from '../src/classifiers/types.js';
import { optimize, type OptimizeResult } from '../src/engine/optimize.js';
import type { Message } from '../src/types.js';
import { REVIEW_ANSWERS, reviewKeepNothing, suspectCalibration, trustedForSession } from '../hooks/context-os.js';

const message = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({ role, text, toolUses: [], ...extra });
const call = (id: string, tool: string, input: Record<string, unknown>, text: string): Message =>
  message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
const res = (id: string, text: string): Message => message('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] });

const big = 'declare const x: number;\n'.repeat(60);
const transcript: Message[] = [
  message('user', 'Read these files, I will ask about the port later.'),
  call('c1', 'Read', { file_path: 'scratch/smoke-config.env' }, 'ORCHARD_DB_PORT=61873\n'),
  res('c1', 'ORCHARD_DB_PORT=61873\n'),
  ...[2, 3, 4, 5, 6].flatMap((i) => [call(`c${i}`, 'Read', { file_path: `f${i}.ts` }, big), res(`c${i}`, big)]),
  message('assistant', 'done'),
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

async function firstRun(): Promise<OptimizeResult> {
  return optimize(transcript, { classifier: dropAll, archive: new MemoryArchive(), sessionId: 's', compactionId: 'c', preserveRecentMessages: 2 });
}

type Fake = {
  fork?: (prompt: string) => Promise<{ text: string } | null>;
  complete?: (prompt: string) => Promise<string>;
  ask?: (question: string, options: readonly string[]) => Promise<string>;
};

function host(fake: Fake) {
  const store = new Map<string, unknown>();
  const logs: string[] = [];
  const asked: string[] = [];
  const $ = {
    model: {
      fork: async ({ prompt }: { prompt: string }) => {
        if (!fake.fork) throw new Error('fork: no snapshot');
        const reply = await fake.fork(prompt);
        return reply ? { text: reply.text, usage: { input_tokens: 1000, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } : null;
      },
      complete: async ({ prompt }: { model: string; prompt: string }) => {
        if (!fake.complete) throw new Error('complete: unavailable');
        return fake.complete(prompt);
      },
    },
    ui: {
      ask: async (question: string, options?: { options?: readonly string[] }) => {
        asked.push(question);
        if (!fake.ask) throw new Error('no one to ask');
        return fake.ask(question, options?.options ?? []);
      },
      log: (text: string) => {
        logs.push(text);
      },
    },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  };
  return { $, store, logs, asked };
}

describe('reviewKeepNothing', () => {
  it('trips only when five or more scored results were all dropped', async () => {
    const result = await firstRun();
    expect(suspectCalibration(result.actions, result.report.classified)).toEqual({ suspect: true, best: 0.1 });
  });

  it('proceeds when the session model, reading the conversation, says drop_all', async () => {
    const result = await firstRun();
    let seen = '';
    const { $, asked } = host({
      fork: async (prompt) => {
        seen = prompt;
        return { text: '{"verdict":"drop_all","keep":[],"reason":"reference reads the user finished with"}' };
      },
    });
    const review = await reviewKeepNothing($, 's', transcript, { preserveRecentMessages: 2 }, result, 0.35, 0.1);
    expect(review.decision).toBe('proceed');
    expect(review.why).toContain('kept none of the 6 results it scored (best 0.10, threshold 0.35)');
    expect(review.why).toContain("the session's model (1040 tokens) read the conversation and agreed");
    expect(seen).toContain('- t1 · Read file_path=scratch/smoke-config.env');
    expect(asked).toEqual([]);
  });

  it('re-runs with the reviewer\'s keeps when the cold-snapshot fallback (haiku) says keep_some', async () => {
    const result = await firstRun();
    let cold = '';
    const { $, asked, logs } = host({
      fork: async () => null,
      complete: async (prompt) => {
        cold = prompt;
        return 'Looking at it: {"verdict":"keep_some","keep":["t1"],"reason":"the port will be asked about"}';
      },
    });
    const review = await reviewKeepNothing($, 's', transcript, { preserveRecentMessages: 2 }, result, 0.35, 0.1);
    expect(review).toMatchObject({ decision: 'keep', keep: ['t1'] });
    expect(review.why).toContain('haiku (user turns only) asked to keep t1');
    expect(cold).toContain('I will ask about the port later');
    expect(asked).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('asks the user when no model can confirm, and honours each answer', async () => {
    const result = await firstRun();
    const answers = [REVIEW_ANSWERS.remove, REVIEW_ANSWERS.trust, REVIEW_ANSWERS.summary, 'something typed under Other'];
    const decisions: string[] = [];
    for (const answer of answers) {
      const { $, store, asked } = host({
        fork: async () => ({ text: 'I cannot tell.' }),
        complete: async () => '{"verdict":"unsure","keep":[],"reason":"not enough context"}',
        ask: async () => answer,
      });
      const review = await reviewKeepNothing($, 's', transcript, { preserveRecentMessages: 2 }, result, 0.35, 0.1);
      decisions.push(review.decision);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('kept none of the 6 results it scored');
      expect(asked[0]).toContain('could not confirm that is right (not enough context)');
      expect(await trustedForSession($, 's')).toBe(answer === REVIEW_ANSWERS.trust);
      expect(store.has('context-os:trust:s')).toBe(answer === REVIEW_ANSWERS.trust);
    }
    expect(decisions).toEqual(['proceed', 'proceed', 'fallback', 'fallback']);
  });

  it('falls back to the built-in summary when there is no model and no one to ask (headless)', async () => {
    const result = await firstRun();
    const { $, logs } = host({});
    const review = await reviewKeepNothing($, 's', transcript, { preserveRecentMessages: 2 }, result, 0.35, 0.1);
    expect(review.decision).toBe('fallback');
    expect(review.why).toContain('no model could review it');
    expect(review.why).toContain('no one to ask (headless)');
    expect(logs.some((l) => l.includes('fork unavailable'))).toBe(true);
    expect(logs.some((l) => l.includes('completion unavailable'))).toBe(true);
  });
});
