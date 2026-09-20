import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { nodeFs, joinPath } from '../src/node/fs.js';
import {
  claudeProjectsRoot,
  listSessions,
  loadTranscript,
  parseTranscriptLines,
  type LoadOptions,
} from '../src/node/transcripts.js';

/**
 * A small synthetic session, built the way Claude Code actually writes one
 * (one JSON object per line, a `uuid`/`parentUuid` tree threading through
 * every record type, not just `user`/`assistant`):
 *
 *   u1  user   (isCompactSummary, parentUuid: null) — the chain's root
 *   a1  attachment (a rendered system-reminder)      — excluded by default
 *   t1  assistant  thinking block  ─┐
 *   t2  assistant  text block       ├─ message.id "m1", one API call
 *   t3  assistant  tool_use block  ─┘
 *   u2  user   tool_result for call1
 *   s1  assistant (isSidechain)                       — excluded by default
 *   t4  assistant  text block, message.id "m2"
 *   u3  user   plain string content (the leaf)
 *
 * plus one malformed line mixed in, to prove `parseErrors` counts it and the
 * parse doesn't throw.
 */
function buildFixtureLines(): string[] {
  const usageM1 = { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 1 };
  const usageM2 = { input_tokens: 20, cache_read_input_tokens: 8, cache_creation_input_tokens: 0, output_tokens: 4 };

  const records = [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      isSidechain: false,
      isCompactSummary: true,
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 'fixture-session',
      cwd: '/repo',
      gitBranch: 'main',
      version: '2.1.0',
      message: { role: 'user', content: [{ type: 'text', text: 'Continuing from summary: fix the failing test.' }] },
    },
    {
      type: 'attachment',
      uuid: 'a1',
      parentUuid: 'u1',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:00.100Z',
      attachment: { type: 'environment' },
      rendered: [{ content: '<system-reminder>\nEnvironment info\n</system-reminder>' }],
    },
    {
      type: 'assistant',
      uuid: 't1',
      parentUuid: 'a1',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { id: 'm1', model: 'claude-x', role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me look at the file.' }], usage: usageM1 },
    },
    {
      type: 'assistant',
      uuid: 't2',
      parentUuid: 't1',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { id: 'm1', model: 'claude-x', role: 'assistant', content: [{ type: 'text', text: "I'll check the file." }], usage: usageM1 },
    },
    {
      type: 'assistant',
      uuid: 't3',
      parentUuid: 't2',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        id: 'm1',
        model: 'claude-x',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call1', name: 'Read', input: { file_path: 'a.ts' } }],
        usage: usageM1,
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 't3',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:04.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'export const a = 1;', is_error: false }] },
    },
    {
      type: 'assistant',
      uuid: 's1',
      parentUuid: 'u2',
      isSidechain: true,
      timestamp: '2026-01-01T00:00:05.000Z',
      message: { id: 'sm1', model: 'claude-x', role: 'assistant', content: [{ type: 'text', text: 'internal subagent chatter' }] },
    },
    {
      type: 'assistant',
      uuid: 't4',
      parentUuid: 's1',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:06.000Z',
      message: { id: 'm2', model: 'claude-x', role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }], usage: usageM2 },
    },
    '{not valid json',
    {
      type: 'user',
      uuid: 'u3',
      parentUuid: 't4',
      isSidechain: false,
      timestamp: '2026-01-01T00:00:07.000Z',
      message: { role: 'user', content: 'Great, thanks!' },
    },
  ] as const;

  return records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
}

describe('parseTranscriptLines: main chain', () => {
  const lines = buildFixtureLines();
  const result = parseTranscriptLines(lines);

  it('parses the whole file and counts the malformed line', () => {
    expect(result.stats.parseErrors).toBe(1);
    expect(result.stats.records).toBe(9);
  });

  it('groups consecutive assistant blocks sharing message.id into one Message', () => {
    expect(result.messages).toHaveLength(5);
    const [m0, m1, m2, m3, m4] = result.messages;
    expect(m0).toMatchObject({ role: 'user', text: 'Continuing from summary: fix the failing test.' });
    expect(m1).toMatchObject({ role: 'assistant', text: "I'll check the file." });
    expect(m1?.toolUses).toHaveLength(1);
    expect(m2).toMatchObject({ role: 'user', text: '' });
    expect(m3).toMatchObject({ role: 'assistant', text: 'Fixed it.' });
    expect(m4).toMatchObject({ role: 'user', text: 'Great, thanks!' });
  });

  it('fills a tool_use\'s text/isError from its later tool_result', () => {
    const toolUse = result.messages[1]?.toolUses[0];
    expect(toolUse).toMatchObject({ tool_use_id: 'call1', tool: 'Read', text: 'export const a = 1;', isError: false });
    expect(toolUse?.input).toEqual({ file_path: 'a.ts' });
  });

  it('carries the tool_result on the user message (text-only-tool-results message has text "")', () => {
    expect(result.messages[2]?.toolResults).toEqual([{ tool_use_id: 'call1', text: 'export const a = 1;', isError: false }]);
  });

  it('handles both string and array user content', () => {
    expect(result.messages[0]?.text).toBe('Continuing from summary: fix the failing test.');
    expect(result.messages[4]?.text).toBe('Great, thanks!');
  });

  it('excludes sidechains and attachments by default, and counts them in skipped', () => {
    const allText = result.messages.map((m) => m.text).join('\n');
    expect(allText).not.toContain('internal subagent chatter');
    expect(allText).not.toContain('Environment info');
    expect(result.skipped['sidechain']).toBe(1);
    expect(result.skipped['attachment']).toBe(1);
  });

  it('still walks through an excluded sidechain node to keep the chain connected', () => {
    // t4 ("Fixed it.") is only reachable by walking through s1 (the excluded
    // sidechain); if the walk had stopped there, message 3 would be missing.
    expect(result.messages[3]).toMatchObject({ role: 'assistant', text: 'Fixed it.' });
  });

  it('records the compaction-summary index', () => {
    expect(result.compactionIndices).toEqual([0]);
  });

  it('extracts one usage entry per assistant API call, not per content block', () => {
    expect(result.usage).toHaveLength(2);
    expect(result.usage[0]).toEqual({
      timestamp: '2026-01-01T00:00:03.000Z',
      model: 'claude-x',
      input: 10,
      cacheRead: 5,
      cacheWrite: 2,
      output: 1,
    });
    expect(result.usage[1]).toMatchObject({ input: 20, output: 4 });
  });

  it('carries session metadata from the records', () => {
    expect(result.sessionId).toBe('fixture-session');
    expect(result.cwd).toBe('/repo');
    expect(result.gitBranch).toBe('main');
    expect(result.version).toBe('2.1.0');
    expect(result.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.endedAt).toBe('2026-01-01T00:00:07.000Z');
  });

  it('reports overall stats', () => {
    expect(result.stats.messages).toBe(5);
    expect(result.stats.toolUses).toBe(1);
    expect(result.stats.toolResults).toBe(1);
    expect(result.stats.chars).toBeGreaterThan(0);
  });
});

describe('parseTranscriptLines: options', () => {
  const lines = buildFixtureLines();

  it('includes sidechains when asked', () => {
    const result = parseTranscriptLines(lines, { includeSidechains: true });
    const allText = result.messages.map((m) => m.text).join('\n');
    expect(allText).toContain('internal subagent chatter');
    expect(result.skipped['sidechain']).toBeUndefined();
  });

  it('includes attachments as their own user message when asked, verbatim by default', () => {
    const result = parseTranscriptLines(lines, { includeAttachments: true });
    const attachmentMessage = result.messages.find((m) => m.text.includes('Environment info'));
    expect(attachmentMessage).toMatchObject({ role: 'user' });
    expect(attachmentMessage?.text).toContain('<system-reminder>');
  });

  it('strips <system-reminder> blocks from an included attachment (and drops it if that leaves it empty)', () => {
    const result = parseTranscriptLines(lines, { includeAttachments: true, stripSystemReminders: true });
    const allText = result.messages.map((m) => m.text).join('\n');
    expect(allText).not.toContain('Environment info');
    expect(allText).not.toContain('<system-reminder>');
    // the attachment's only content was the reminder, so once stripped it is empty and dropped
    expect(result.skipped['empty']).toBeGreaterThanOrEqual(1);
  });

  it('prepends [thinking] to the assistant text when includeThinking is set', () => {
    const result = parseTranscriptLines(lines, { includeThinking: true });
    expect(result.messages[1]?.text).toBe("[thinking] Let me look at the file.\nI'll check the file.");
  });

  it('omits thinking text by default', () => {
    const result = parseTranscriptLines(lines);
    expect(result.messages[1]?.text).not.toContain('[thinking]');
  });

  it('applies redact to text, tool input string values and tool results', () => {
    const redact: LoadOptions['redact'] = (text) => text.replace(/a\.ts/g, '[FILE]').replace(/export const a = 1;/g, '[RESULT]');
    const result = parseTranscriptLines(lines, { redact });
    expect(result.messages[1]?.toolUses[0]?.input).toEqual({ file_path: '[FILE]' });
    expect(result.messages[1]?.toolUses[0]?.text).toBe('[RESULT]');
    expect(result.messages[2]?.toolResults?.[0]?.text).toBe('[RESULT]');
  });
});

describe('parseTranscriptLines: broken parentUuid chain', () => {
  it('falls back to file order and counts orphan_chain', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'x1',
        parentUuid: null,
        message: { role: 'user', content: 'first' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'x2',
        // Points at a uuid that does not exist anywhere in this file.
        parentUuid: 'missing-ancestor',
        message: { id: 'mx', model: 'claude-x', role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      }),
    ];
    const result = parseTranscriptLines(lines);
    expect(result.skipped['orphan_chain']).toBe(1);
    expect(result.messages.map((m) => m.text)).toEqual(['first', 'second']);
  });
});

describe('loadTranscript', () => {
  it('streams a file and fills sessionId/path from it', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-jev-transcripts-'));
    try {
      const file = joinPath(dir.replace(/\\/g, '/'), 'a-session.jsonl');
      await nodeFs.write(file, buildFixtureLines().join('\n'));
      const loaded = await loadTranscript(file);
      expect(loaded.path).toBe(file);
      expect(loaded.sessionId).toBe('fixture-session'); // taken from the records, not the filename
      expect(loaded.messages).toHaveLength(5);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the filename for sessionId when no record carries one', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-jev-transcripts-'));
    try {
      const file = path.join(dir, 'no-session-id.jsonl');
      await nodeFs.write(file, JSON.stringify({ type: 'user', uuid: 'a', parentUuid: null, message: { role: 'user', content: 'hi' } }));
      const loaded = await loadTranscript(file);
      expect(loaded.sessionId).toBe('no-session-id');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('src/node/fs.ts', () => {
  it('nodeFs reads, writes (creating directories), lists and checks existence', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-jev-fs-'));
    try {
      const nested = path.join(dir, 'a', 'b', 'file.txt');
      await nodeFs.write(nested, 'hello');
      expect(await nodeFs.read(nested)).toBe('hello');
      expect(await nodeFs.exists(nested)).toBe(true);
      expect(await nodeFs.exists(path.join(dir, 'nope'))).toBe(false);
      expect(await nodeFs.list(path.join(dir, 'a', 'b'))).toEqual(['file.txt']);
      expect(await nodeFs.list(path.join(dir, 'does-not-exist'))).toEqual([]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('read rejects with ENOENT when the file is missing', async () => {
    await expect(nodeFs.read(path.join(os.tmpdir(), 'fast-jev-does-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('joinPath joins with forward slashes without collapsing intentional structure', () => {
    expect(joinPath('a', 'b', 'c')).toBe('a/b/c');
    expect(joinPath('a/', '/b')).toBe('a/b');
    expect(joinPath('a', '', 'b')).toBe('a/b');
  });
});

describe('claudeProjectsRoot', () => {
  it('is a "projects" folder under ~/.claude', () => {
    const root = claudeProjectsRoot();
    expect(root).toContain('.claude');
    expect(path.basename(root)).toBe('projects');
  });
});

describe('listSessions', () => {
  it('returns [] for a root that does not exist', async () => {
    expect(await listSessions(path.join(os.tmpdir(), 'fast-jev-no-such-root'))).toEqual([]);
  });

  it('lists sessions across project folders, largest first', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fast-jev-sessions-'));
    try {
      await nodeFs.write(path.join(root, 'proj-a', 'small.jsonl'), 'x'.repeat(10));
      await nodeFs.write(path.join(root, 'proj-b', 'big.jsonl'), 'x'.repeat(1000));
      await nodeFs.write(path.join(root, 'proj-a', 'not-a-session.txt'), 'ignored');
      const sessions = await listSessions(root);
      expect(sessions.map((s) => s.sessionId)).toEqual(['big', 'small']);
      expect(sessions[0]).toMatchObject({ project: 'proj-b', sessionId: 'big', bytes: 1000 });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

// Only if this machine actually has real Claude Code sessions: load the
// smallest one (fastest to parse) and check invariants that must hold no
// matter what a real transcript looks like.
const realSessions = await listSessions().catch(() => []);
const smallestReal = realSessions.length > 0 ? realSessions[realSessions.length - 1] : undefined;

describe('a real session', () => {
  it.skipIf(!smallestReal)('loads without throwing and holds basic invariants', async () => {
    const loaded = await loadTranscript(smallestReal!.path);

    for (const message of loaded.messages) {
      const isEmpty = message.text === '' && message.toolUses.length === 0 && !(message.toolResults && message.toolResults.length > 0);
      expect(isEmpty).toBe(false);
    }

    const seenToolUseIds = new Set<string>();
    for (const message of loaded.messages) {
      for (const toolUse of message.toolUses) seenToolUseIds.add(toolUse.tool_use_id);
      for (const toolResult of message.toolResults ?? []) {
        expect(seenToolUseIds.has(toolResult.tool_use_id)).toBe(true);
      }
    }

    if (loaded.messages.length > 1) {
      const sameRoleRuns = loaded.messages.filter((m, i) => i > 0 && m.role === loaded.messages[i - 1]?.role).length;
      expect(sameRoleRuns).toBeLessThan(loaded.messages.length);
    }
  });
});
