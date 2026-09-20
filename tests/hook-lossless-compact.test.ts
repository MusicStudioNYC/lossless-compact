import { beforeAll, describe, expect, it } from 'vitest';
import {
  chooseClassifier,
  engineFs,
  reportLines,
  resolvedClassifierName,
  resolveLosslessCompactConfig,
  runContextCommand,
} from '../hooks/lossless-compact.ts';
import { MemoryArchive } from '../src/archive/memory-store.js';
import type { ClassifierScores } from '../src/core/actions.js';
import type { Classifier } from '../src/classifiers/types.js';
import { optimize, type OptimizeResult } from '../src/engine/optimize.js';
import type { Message } from '../src/types.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

describe('resolveLosslessCompactConfig', () => {
  it('applies defaults for an empty options object', () => {
    const config = resolveLosslessCompactConfig({});
    expect(config).toMatchObject({
      classifier: 'auto',
      questionStyle: 'useful',
      archiveDir: '.lossless-compact',
      safetyMargin: 0,
      sketches: true,
      redact: true,
      markRemovedCalls: true,
      compactAtPercent: 0,
      compactAtTokens: 120_000,
      minReductionRatio: 0.25,
      model: 'jev-latest',
    });
    expect('keepThreshold' in config).toBe(false);
  });

  it('validates the classifier enum and falls back to auto for anything else', () => {
    expect(resolveLosslessCompactConfig({ classifier: 'bogus' }).classifier).toBe('auto');
    expect(resolveLosslessCompactConfig({ classifier: 'jev' }).classifier).toBe('jev');
    expect(resolveLosslessCompactConfig({ classifier: 'ruleset' }).classifier).toBe('ruleset');
    expect(resolveLosslessCompactConfig({ classifier: 'heuristic' }).classifier).toBe('ruleset');
    expect(resolveLosslessCompactConfig({ classifier: 'auto' }).classifier).toBe('auto');
  });

  it('validates the questionStyle enum and falls back to useful for anything else', () => {
    expect(resolveLosslessCompactConfig({ questionStyle: 'bogus' }).questionStyle).toBe('useful');
    expect(resolveLosslessCompactConfig({ questionStyle: 'upstream' }).questionStyle).toBe('upstream');
    expect(resolveLosslessCompactConfig({ questionStyle: 'useful' }).questionStyle).toBe('useful');
  });

  it('reads archiveDir, safetyMargin and the boolean toggles when given', () => {
    const config = resolveLosslessCompactConfig({
      archiveDir: 'custom-dir',
      safetyMargin: 0.3,
      sketches: false,
      redact: false,
      markRemovedCalls: false,
    });
    expect(config.archiveDir).toBe('custom-dir');
    expect(config.safetyMargin).toBe(0.3);
    expect(config.sketches).toBe(false);
    expect(config.redact).toBe(false);
    expect(config.markRemovedCalls).toBe(false);
  });

  it('ignores a non-string archiveDir and a non-finite safetyMargin', () => {
    const config = resolveLosslessCompactConfig({ archiveDir: '', safetyMargin: Number.NaN });
    expect(config.archiveDir).toBe('.lossless-compact');
    expect(config.safetyMargin).toBe(0);
  });

  it('leaves keepThreshold absent unless an explicit finite number is given', () => {
    expect('keepThreshold' in resolveLosslessCompactConfig({})).toBe(false);
    expect('keepThreshold' in resolveLosslessCompactConfig({ keepThreshold: 'nope' })).toBe(false);
    expect(resolveLosslessCompactConfig({ keepThreshold: 0.3 }).keepThreshold).toBe(0.3);
  });
});

describe('resolvedClassifierName', () => {
  it('turns auto into the classifier a fresh session will actually use', () => {
    expect(resolvedClassifierName({ classifier: 'auto' }, 'apikey_test')).toBe('jev');
    expect(resolvedClassifierName({ classifier: 'auto' }, undefined)).toBe('ruleset');
  });

  it('preserves an explicit classifier choice', () => {
    expect(resolvedClassifierName({ classifier: 'jev' }, undefined)).toBe('jev');
    expect(resolvedClassifierName({ classifier: 'ruleset' }, 'apikey_test')).toBe('ruleset');
  });
});

describe('engineFs', () => {
  it('maps read/write/exists straight onto $.fs', async () => {
    const files = new Map<string, string>();
    const fs = engineFs({
      fs: {
        read: async (path: string) => {
          const v = files.get(path);
          if (v === undefined) throw new Error('missing');
          return v;
        },
        write: async (path: string, text: string) => {
          files.set(path, text);
        },
        exists: async (path: string) => files.has(path),
        list: async () => [],
      },
    });
    await fs.write('a.json', 'hello');
    expect(await fs.read('a.json')).toBe('hello');
    expect(await fs.exists('a.json')).toBe(true);
    expect(await fs.exists('missing.json')).toBe(false);
  });

  it('list() returns [] when the directory does not exist, without calling $.fs.list', async () => {
    let listCalled = false;
    const fs = engineFs({
      fs: {
        read: async () => {
          throw new Error('nope');
        },
        write: async () => {},
        exists: async () => false,
        list: async () => {
          listCalled = true;
          return [{ name: 'should-not-appear' }];
        },
      },
    });
    expect(await fs.list('missing-dir')).toEqual([]);
    expect(listCalled).toBe(false);
  });

  it('list() maps entries to their names when the directory exists', async () => {
    const fs = engineFs({
      fs: {
        read: async () => '',
        write: async () => {},
        exists: async () => true,
        list: async () => [{ name: 'a.json' }, { name: 'b.json' }],
      },
    });
    expect(await fs.list('dir')).toEqual(['a.json', 'b.json']);
  });
});

/** A MemoryArchive pre-filled by running `optimize` over a small transcript. */
async function buildArchive(): Promise<{ archive: MemoryArchive; optimized: OptimizeResult; messages: Message[] }> {
  const messages: Message[] = [
    message('user', 'Investigate the flaky test in the payments module. Do not touch the migration files.'),
    call('h1', 'Bash', { command: 'grep -R advisory_lock src' }, 'src/payments/lock.ts: acquire advisory_lock here'),
    result('h1', 'src/payments/lock.ts: acquire advisory_lock here'),
    message('assistant', 'Found it, fixing now.'),
    message('user', 'go ahead'),
  ];
  const archive = new MemoryArchive();
  const classifier: Classifier = {
    name: 'fake',
    async score(candidates) {
      const scores = new Map<string, ClassifierScores>();
      for (const c of candidates) scores.set(c.id, { keepCall: 0.05, keepResult: 0.05 });
      return { scores, stats: { requests: 1, stateTokens: 0, stateStage: 'fake', ms: 0, unscored: [] } };
    },
  };
  const optimized = await optimize(messages, {
    sessionId: 'sess-1',
    archive,
    classifier,
    preserveRecentMessages: 0,
  });
  return { archive, optimized, messages };
}

describe('runContextCommand', () => {
  let archive: MemoryArchive;
  let optimized: OptimizeResult;
  let recordId: string;
  let deps: Parameters<typeof runContextCommand>[1];

  beforeAll(async () => {
    const built = await buildArchive();
    archive = built.archive;
    optimized = built.optimized;
    recordId = built.optimized.archived.find((r) => r.kind === 'tool_result')!.id;
    deps = {
      sessionId: 'sess-1',
      messages: async () => built.messages,
      archive,
      last: async () => undefined,
      classifier: 'ruleset',
    };
  });

  it('archived at least the tool result and marks it ARCHIVE_ONLY (sanity check on the fixture)', () => {
    expect(optimized.archived.length).toBeGreaterThan(0);
    const archivedResult = optimized.archived.find((r) => r.id === recordId)!;
    expect(archivedResult.action).toBe('ARCHIVE_ONLY');
    expect(archivedResult.content).toBe('src/payments/lock.ts: acquire advisory_lock here');
  });

  it('status mentions token counts and the constraint count', async () => {
    const { text } = await runContextCommand('', deps);
    expect(text).toMatch(/~[\d,]+ tokens/);
    expect(text).toMatch(/\d+ explicit user constraints? found/);
    expect(text).toContain('1 explicit user constraint found');
  });

  it('list shows archived records ordered oldest-first (newest last)', async () => {
    const { text } = await runContextCommand('list 20', deps);
    const lines = text.split('\n').slice(1);
    const listedIds = lines.map((line) => line.split(/\s+/)[0]);
    const bySeqAscending = archive.all().map((r) => r.id);
    expect(listedIds).toEqual(bySeqAscending);
    expect(listedIds[listedIds.length - 1]).toBe(bySeqAscending[bySeqAscending.length - 1]);
  });

  it('why <id> prints the action and the reasons', async () => {
    const { text } = await runContextCommand(`why ${recordId}`, deps);
    expect(text).toContain('Action: ARCHIVE_ONLY');
    expect(text).toContain('Reasons:');
    expect(text).toContain(`/context restore ${recordId} brings it back`);
  });

  it('show <id> returns the retrieved_context block with the exact content', async () => {
    const { text, context } = await runContextCommand(`show ${recordId}`, deps);
    expect(text).toContain(`<retrieved_context id="${recordId}"`);
    expect(text).toContain('src/payments/lock.ts: acquire advisory_lock here');
    expect(text).toContain('</retrieved_context>');
    expect(context).toBeUndefined();
  });

  it('restore <id> returns a context block plus a confirmation line', async () => {
    const { text, context } = await runContextCommand(`restore ${recordId}`, deps);
    expect(text).toMatch(/^Restored /);
    expect(context).toBeDefined();
    expect(context).toHaveLength(1);
    expect(context![0]).toContain(`<retrieved_context id="${recordId}"`);
    expect(context![0]).toContain('src/payments/lock.ts: acquire advisory_lock here');
  });

  it('retrieve <query> finds a record by a word inside it', async () => {
    const { text } = await runContextCommand('retrieve advisory_lock', deps);
    expect(text).toContain(recordId);
  });

  it('prints usage for an unknown subcommand', async () => {
    const { text } = await runContextCommand('bogus', deps);
    expect(text).toContain('Unknown subcommand "bogus"');
    expect(text).toContain('Usage:');
  });

  it('shows a usage message when an id or query is missing', async () => {
    expect((await runContextCommand('why', deps)).text).toBe('Usage: /context why <id>');
    expect((await runContextCommand('show', deps)).text).toBe('Usage: /context show <id>');
    expect((await runContextCommand('restore', deps)).text).toBe('Usage: /context restore <id>');
    expect((await runContextCommand('retrieve', deps)).text).toBe('Usage: /context retrieve <query>');
  });

  it('shows a not-found message for an unknown id', async () => {
    expect((await runContextCommand('why nope-id', deps)).text).toBe('No archive record nope-id.');
    expect((await runContextCommand('show nope-id', deps)).text).toBe('No archive record nope-id.');
    expect((await runContextCommand('restore nope-id', deps)).text).toBe('No archive record nope-id.');
  });
});

describe('chooseClassifier', () => {
  const baseConfig = resolveLosslessCompactConfig({});
  const fetchFn = async () => ({ status: 200, ok: true, text: '{"answers":{}}' });

  it("'auto' without a key falls back to the ruleset", () => {
    const classifier = chooseClassifier({ ...baseConfig, classifier: 'auto' }, fetchFn, undefined);
    expect(classifier.name).toBe('ruleset');
  });

  it("'auto' with a key uses jev", () => {
    const classifier = chooseClassifier({ ...baseConfig, classifier: 'auto' }, fetchFn, 'key-123');
    expect(classifier.name).toBe('jev');
  });

  it("'jev' without a key throws", () => {
    expect(() => chooseClassifier({ ...baseConfig, classifier: 'jev' }, fetchFn, undefined)).toThrow(
      /TYPESAFE_API_KEY/,
    );
  });

  it("'ruleset' always uses the ruleset classifier, key or not", () => {
    expect(chooseClassifier({ ...baseConfig, classifier: 'ruleset' }, fetchFn, undefined).name).toBe('ruleset');
    expect(chooseClassifier({ ...baseConfig, classifier: 'ruleset' }, fetchFn, 'key-123').name).toBe('ruleset');
  });
});

describe('reportLines', () => {
  it('includes the compaction id', async () => {
    const { optimized } = await buildArchive();
    const lines = reportLines(optimized.report);
    expect(lines.join('\n')).toContain(optimized.report.compactionId);
  });
});
