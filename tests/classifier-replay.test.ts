import { describe, expect, it } from 'vitest';
import {
  cassetteKey,
  canonicalJson,
  emptyCassette,
  parseCassette,
  ReplayAsker,
  serialiseCassette,
} from '../src/classifiers/replay.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../src/index.js';

function fakeAsker(handler: (state: JevState, questions: JevQuestions) => JevResponse): JevAsker {
  return {
    async ask(state, questions) {
      return handler(state, questions);
    },
  };
}

describe('canonicalJson', () => {
  it('produces the same string for values that differ only in key order', () => {
    const a = { z: 1, a: { y: 2, x: 3 }, list: [{ b: 1, a: 2 }] };
    const b = { a: { x: 3, y: 2 }, z: 1, list: [{ a: 2, b: 1 }] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('still distinguishes genuinely different values', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('cassetteKey', () => {
  const state: JevState = { context: 'ctx', goal: 'fix it', history: [] };

  it('is stable under key order changes in the questions map', () => {
    const q1: JevQuestions = {
      call_t1: { type: 'noul', instructions: 'keep the call?' },
      call_t2: { type: 'noul', instructions: 'keep the other call?' },
    };
    const q2: JevQuestions = {
      call_t2: { type: 'noul', instructions: 'keep the other call?' },
      call_t1: { type: 'noul', instructions: 'keep the call?' },
    };
    expect(cassetteKey(state, q1)).toBe(cassetteKey(state, q2));
  });

  it('differs when the state or the questions differ', () => {
    const q: JevQuestions = { call_t1: { type: 'noul', instructions: 'keep the call?' } };
    const otherState: JevState = { context: 'ctx', goal: 'a different goal', history: [] };
    expect(cassetteKey(state, q)).not.toBe(cassetteKey(otherState, q));
  });
});

describe('ReplayAsker', () => {
  const state: JevState = { context: 'c', goal: 'g', history: [] };
  const questions: JevQuestions = { call_t1: { type: 'noul', instructions: 'keep?' } };

  it('records via the inner asker on a miss, then replays the identical answer without calling it again', async () => {
    let calls = 0;
    const inner = fakeAsker(() => {
      calls += 1;
      return { answers: { call_t1: { type: 'noul', noul: 0.42 } }, model: 'jev-test' };
    });
    const cassette = emptyCassette();
    const recorder = new ReplayAsker(cassette, inner);

    const first = await recorder.ask(state, questions);
    expect(first.answers['call_t1']).toEqual({ type: 'noul', noul: 0.42 });
    expect(first.model).toBe('jev-test');
    expect(calls).toBe(1);
    expect(recorder.stats).toEqual({ hits: 0, misses: 1, recorded: 1 });

    // A fresh player over the same (now populated) cassette, no inner asker at all.
    const player = new ReplayAsker(cassette);
    const second = await player.ask(state, questions);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(player.stats).toEqual({ hits: 1, misses: 0, recorded: 0 });
  });

  it('throws a "cassette miss" error naming the questions when replay mode has no match', async () => {
    const player = new ReplayAsker(emptyCassette());
    await expect(player.ask(state, questions)).rejects.toThrow(/^cassette miss: call_t1/);
    expect(player.stats).toEqual({ hits: 0, misses: 1, recorded: 0 });
  });

  it('records unconditionally in "record" mode, even on a cassette that already has an entry', async () => {
    const cassette = emptyCassette();
    cassette.entries[cassetteKey(state, questions)] = {
      key: cassetteKey(state, questions),
      questionNames: ['call_t1'],
      answers: { call_t1: { type: 'noul', noul: 0.1 } },
      recordedAt: new Date(0).toISOString(),
      ms: 0,
    };
    let calls = 0;
    const inner = fakeAsker(() => {
      calls += 1;
      return { answers: { call_t1: { type: 'noul', noul: 0.99 } } };
    });
    const recorder = new ReplayAsker(cassette, inner, 'record');
    const response = await recorder.ask(state, questions);
    expect(calls).toBe(1);
    expect(response.answers['call_t1']).toEqual({ type: 'noul', noul: 0.99 });
    expect(recorder.stats).toEqual({ hits: 0, misses: 0, recorded: 1 });
  });

  it('deep-copies responses so mutating one call\'s result cannot affect another', async () => {
    const inner = fakeAsker(() => ({ answers: { call_t1: { type: 'noul', noul: 0.9 } } }));
    const asker = new ReplayAsker(emptyCassette(), inner);

    const first = await asker.ask(state, questions);
    (first.answers['call_t1'] as { noul: number }).noul = 999;

    const second = await asker.ask(state, questions);
    expect(second.answers['call_t1']).toEqual({ type: 'noul', noul: 0.9 });
    expect(second.answers).not.toBe(first.answers);
    expect(second.answers['call_t1']).not.toBe(first.answers['call_t1']);
  });
});

describe('cassette serialisation', () => {
  const state: JevState = { context: 'c', goal: 'g', history: [] };
  const questions: JevQuestions = { call_t1: { type: 'noul', instructions: 'keep?' } };

  it('round-trips through serialiseCassette / parseCassette and stays replayable', async () => {
    const inner = fakeAsker(() => ({
      answers: { call_t1: { type: 'noul', noul: 0.5 } },
      model: 'jev-test',
    }));
    const cassette = emptyCassette();
    await new ReplayAsker(cassette, inner).ask(state, questions);

    const json = serialiseCassette(cassette);
    const parsed = parseCassette(json);
    expect(parsed).toEqual(cassette);

    const player = new ReplayAsker(parsed);
    const replayed = await player.ask(state, questions);
    expect(replayed.answers['call_t1']).toEqual({ type: 'noul', noul: 0.5 });
  });

  it('round-trips an empty cassette', () => {
    expect(parseCassette(serialiseCassette(emptyCassette()))).toEqual(emptyCassette());
  });

  it('rejects malformed cassette JSON and shapes', () => {
    expect(() => parseCassette('not json')).toThrow();
    expect(() => parseCassette('{}')).toThrow(/invalid shape/);
    expect(() => parseCassette(JSON.stringify({ version: 2, entries: {} }))).toThrow(/invalid shape/);
    expect(() =>
      parseCassette(JSON.stringify({ version: 1, entries: { a: { bad: true } } })),
    ).toThrow(/invalid shape/);
  });
});
