import type { On, SessionMessage } from 'claude-code';
import { describe, expect, it } from 'vitest';
import {
  compactedLine,
  describeRecord,
  fallbackLine,
  register,
  resolveLosslessCompactConfig,
  retrievedLine,
  shortCount,
  tooLittleReason,
} from '../hooks/lossless-compact.ts';
import type { OptimizeReport } from '../src/engine/optimize.js';

/** The figures of a real compaction (the one whose 4-page log prompted the quiet default). */
function report(overrides: Partial<OptimizeReport> = {}): OptimizeReport {
  return {
    sessionId: 's',
    compactionId: 'c_muxgx4vr',
    classifier: 'jev',
    messages: { before: 300, after: 250 },
    tokens: { before: 242_363, after: 202_948, archived: 51_278 },
    chars: { before: 0, after: 0 },
    actions: {
      PIN_VERBATIM: 1,
      KEEP_VERBATIM: 94,
      KEEP_HEAD_TAIL: 83,
      EXTRACT_MEMORY_AND_ARCHIVE: 0,
      ARCHIVE_ONLY: 132,
      REPLACE_WITH_REFERENCE: 0,
      RERUN_ON_DEMAND: 0,
      DROP_REDUNDANT: 4,
    },
    protections: { unresolved_error: 7 },
    constraints: 0,
    duplicates: 4,
    candidates: 314,
    classified: 314,
    unscored: 0,
    redactedSecrets: 2,
    classifierStats: { requests: 4, stateTokens: 25_000, stateStage: 'full', ms: 900, unscored: [] },
    ms: 912,
    ...overrides,
  };
}

describe('the one-liners', () => {
  it('reads token counts the way a person does', () => {
    expect(shortCount(850)).toBe('850');
    expect(shortCount(8_400)).toBe('8.4k');
    expect(shortCount(9_000)).toBe('9k');
    expect(shortCount(9_960)).toBe('10k');
    expect(shortCount(242_363)).toBe('242k');
    expect(shortCount(999_600)).toBe('1M');
    expect(shortCount(1_240_000)).toBe('1.2M');
  });

  it('says what a compaction did in one line', () => {
    expect(compactedLine(report())).toBe(
      'lossless-compact: ~242k → 203k tokens (16% smaller); archived 219 old tool results, nothing summarized · /lossless to browse or restore',
    );
    expect(compactedLine(report(), true)).toContain('nothing summarized (reviewed)');
    expect(compactedLine(report({ actions: { ...report().actions, ARCHIVE_ONLY: 1, KEEP_HEAD_TAIL: 0, DROP_REDUNDANT: 0 } }))).toContain(
      'archived 1 old tool result,',
    );
  });

  it('keeps a fallback on one line, however long the error', () => {
    const line = fallbackLine(`Jev 502:\n${'x'.repeat(1000)}`);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(220);
    expect(line).toMatch(/^lossless-compact: used Claude's built-in summary instead \(Jev 502: x+…\)$/);
    expect(fallbackLine('boom', Number.POSITIVE_INFINITY)).toBe("lossless-compact: used Claude's built-in summary instead (boom)");
    expect(tooLittleReason(0.12, 0.25)).toBe('only 12% of the context was removable, the minimum is 25%');
  });

  it('names an archived record by its tool and what it touched', () => {
    expect(describeRecord({ kind: 'tool_result', toolName: 'Read', metadata: { file_path: 'src/a.ts' } })).toBe('Read src/a.ts');
    expect(
      describeRecord({ kind: 'tool_result', toolName: 'Read', metadata: { file_path: '/home/me/projects/app/src/engine/optimize.ts' } }),
    ).toBe('Read …/engine/optimize.ts');
    expect(describeRecord({ kind: 'tool_result', toolName: 'Bash', metadata: { command: 'npm test -- --run\n&& echo done' } })).toBe(
      'Bash "npm test -- --run && echo done"',
    );
    expect(describeRecord({ kind: 'tool_result', toolName: 'Grep', metadata: { pattern: 'advisory_lock' } })).toBe('Grep "advisory_lock"');
    expect(describeRecord({ kind: 'tool_result', toolName: 'TodoWrite', metadata: {} })).toBe('TodoWrite');
    expect(describeRecord({ kind: 'user_text', metadata: {} })).toBe('user message');
  });

  it('says what retrieval brought back, with ids only when verbose', () => {
    const records = [
      { id: 'e_1', kind: 'tool_result' as const, toolName: 'Read', metadata: { file_path: 'src/a.ts' } },
      { id: 'e_2', kind: 'tool_result' as const, toolName: 'Bash', metadata: { command: 'npm test' } },
    ];
    expect(retrievedLine(records, 3_120)).toBe(
      'lossless-compact: recalled 2 archived results into this prompt: Read src/a.ts, Bash "npm test" (~3.1k tokens)',
    );
    expect(retrievedLine(records.slice(0, 1), 400, true)).toBe(
      'lossless-compact: recalled 1 archived result into this prompt: Read src/a.ts [e_1] (~400 tokens)',
    );
  });

  it('is quiet by default and verbose on request', () => {
    expect(resolveLosslessCompactConfig({}).verbose).toBe(false);
    expect(resolveLosslessCompactConfig({ verbose: true }).verbose).toBe(true);
  });
});

/* ----------------------------------------------- the hooks, driven end to end */

type Handler = (...args: unknown[]) => Promise<unknown>;

/** Registers the plugin against a recorder and a fake host; what it logs and toasts is collected. */
function plugin(options: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const on = ((name: string, a: unknown, b?: unknown) => {
    handlers.set(name, (b ?? a) as Handler);
  }) as unknown as On;
  register(on, { classifier: 'ruleset', ...options });
  const files = new Map<string, string>();
  const logs: string[] = [];
  const toasts: string[] = [];
  const $ = {
    session: { id: async () => 'sess-1', cwd: async () => '/proj' },
    env: { get: async () => undefined },
    settings: { read: async () => ({}) },
    http: {
      fetch: async () => {
        throw new Error('no network in tests');
      },
    },
    fs: {
      read: async (path: string) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`ENOENT ${path}`);
        return text;
      },
      write: async (path: string, text: string) => {
        files.set(path, text);
      },
      exists: async (path: string) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      list: async (dir: string) => {
        const names = new Set<string>();
        for (const key of files.keys()) if (key.startsWith(`${dir}/`)) names.add(key.slice(dir.length + 1).split('/')[0]!);
        return [...names].map((name) => ({ name }));
      },
    },
    // Trusted for the session, so a keep-nothing run does not stop to ask.
    store: { get: async (key: string) => key.startsWith('lossless-compact:trust:'), set: async () => {} },
    ui: {
      log: (text: string) => logs.push(text),
      toast: (text: string) => toasts.push(text),
      ask: async () => {
        throw new Error('headless');
      },
    },
    model: {
      fork: async () => null,
      complete: async () => {
        throw new Error('no model');
      },
    },
  };
  const run = (name: string, event: unknown, next: (e: unknown) => Promise<unknown>) => handlers.get(name)!($, event, next);
  return { run, logs, toasts };
}

/** A session that read many big, unrelated files long ago: plenty to archive. */
function transcript(): SessionMessage[] {
  const messages: SessionMessage[] = [{ role: 'user', text: 'Tidy up the docs folder.', toolUses: [] }];
  for (let i = 0; i < 12; i++) {
    const id = `r${i}`;
    messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: `docs/page-${i}.md` } }] });
    messages.push({
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: id, text: `# Page ${i}\n${`lorem ipsum dolor sit amet ${i} `.repeat(400)}`, isError: false }],
    });
  }
  for (let i = 0; i < 4; i++) {
    messages.push({ role: 'user', text: `next step ${i}`, toolUses: [] });
    messages.push({ role: 'assistant', text: `done ${i}`, toolUses: [] });
  }
  return messages;
}

describe('what the hooks leave in the transcript', () => {
  it('a compaction logs one line by default, and the full report with verbose', async () => {
    const builtIn = async () => ({ messages: [] });
    const quiet = plugin({});
    const compacted = (await quiet.run('session.compact', { trigger: 'manual', messages: transcript() }, builtIn)) as {
      messages?: unknown[];
    };
    expect(compacted.messages?.length).toBeGreaterThan(0);
    expect(quiet.logs).toHaveLength(1);
    expect(quiet.logs[0]).toMatch(
      /^lossless-compact: ~[\d.]+k → [\d.]+k? tokens \(\d+% smaller\); archived 12 old tool results, nothing summarized · \/lossless to browse or restore$/,
    );
    expect(quiet.toasts).toEqual(quiet.logs);

    const verbose = plugin({ verbose: true });
    await verbose.run('session.compact', { trigger: 'manual', messages: transcript() }, builtIn);
    expect(verbose.logs.some((line) => line.startsWith('actions: '))).toBe(true);
    expect(verbose.logs.some((line) => line.startsWith('decisions'))).toBe(true);
    expect(verbose.logs.at(-1)).toBe(quiet.logs[0]);
  });

  it('a retrieval logs one line naming what came back', async () => {
    const { run, logs } = plugin({});
    await run('session.compact', { trigger: 'manual', messages: transcript() }, async () => ({ messages: [] }));
    logs.length = 0;
    let handed: { context?: string[] } | undefined;
    await run('prompt.submit', { text: 'what did docs/page-3.md say about lorem ipsum 3?', context: [] }, async (event) => {
      handed = event as { context?: string[] };
      return {};
    });
    expect(handed?.context?.length).toBeGreaterThan(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^lossless-compact: recalled \d archived results? into this prompt: Read docs\/page-\d+\.md/);
    expect(logs[0]).not.toContain('[e_');
  });
});
