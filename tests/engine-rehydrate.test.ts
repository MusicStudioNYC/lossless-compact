import { describe, expect, it } from 'vitest';
import { MemoryArchive, rankRecords } from '../src/archive/memory-store.js';
import type { ArchiveRecord } from '../src/archive/types.js';
import { REHYDRATION_PREFACE, rehydrateForPrompt, retrievedBlock } from '../src/engine/rehydrate.js';

function record(id: string, content: string, extra: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    id,
    sessionId: 's1',
    seq: Number.parseInt(id.replace(/\D/g, ''), 10) || 0,
    role: 'tool',
    kind: 'tool_result',
    toolName: 'Bash',
    content,
    contentHash: id,
    tokenEstimate: Math.ceil(content.length / 4),
    archivedAt: '2026-09-20T00:00:00.000Z',
    compactionId: 'c1',
    action: 'ARCHIVE_ONLY',
    reasons: [],
    related: [],
    metadata: { tool: 'Bash', command: 'cat .env.example' },
    ...extra,
  };
}

const env = record('e_1', 'NODE_ENV=development\nAPI_PORT=3000\nPOSTGRES_HOST=localhost\nPOSTGRES_PORT=54329\n');
const lint = record('e_2', '✔ No ESLint warnings or errors (98 files checked)', { metadata: { tool: 'Bash', command: 'npm run lint' } });
const tests = Array.from({ length: 12 }, (_, i) =>
  record(`e_${10 + i}`, `PASS src/upload.test.ts\n  ✓ upload handles the happy path (${i} ms)\n  ✓ upload rejects empty files`, {
    metadata: { tool: 'Bash', command: 'npx vitest run' },
  }),
);
const all = [env, lint, ...tests];

describe('rankRecords', () => {
  it('finds a record by one rare compound term even in a long natural-language prompt', () => {
    const ranked = rankRecords("The API server can't reach Postgres — health check is timing out. Can you check the connection settings and fix it?", all);
    expect(ranked[0]!.record.id).toBe('e_1');
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(0.5);
    expect(ranked.find((r) => r.record.id === 'e_2')?.score ?? 0).toBeLessThan(0.34);
  });

  it('does not treat a stem-derived match as distinctive', () => {
    const fail = record('e_3', 'FAIL src/hooks/queue-service.ts\n  ✕ retries on transient error');
    const ranked = rankRecords('Uploads are failing in production, please investigate.', [...all, fail]);
    const failScore = ranked.find((r) => r.record.id === 'e_3')?.score ?? 0;
    expect(failScore).toBeLessThan(0.5);
  });

  it('weights common terms down: a word in every record does not pull them all in', () => {
    const ranked = rankRecords('upload something', all);
    for (const entry of ranked) expect(entry.score).toBeLessThan(0.5);
  });
});

describe('rehydrateForPrompt', () => {
  it('returns the relevant record as a retrieved_context block within the budget', async () => {
    const archive = new MemoryArchive(all);
    const found = await rehydrateForPrompt(archive, 's1', "The API server can't reach Postgres — health check is timing out.");
    expect(found.records.map((r) => r.id)).toEqual(['e_1']);
    expect(found.blocks[0]).toBe(retrievedBlock(env, env.content.length));
    expect(found.blocks[0]).toContain('<retrieved_context id="e_1"');
    expect(found.blocks[0]).toContain('POSTGRES_PORT=54329');
    expect(found.chars).toBe(found.blocks[0]!.length);
  });

  it('retrieves nothing for short prompts, slash commands, or unrelated prompts', async () => {
    const archive = new MemoryArchive(all);
    expect((await rehydrateForPrompt(archive, 's1', 'ok go')).blocks).toEqual([]);
    expect((await rehydrateForPrompt(archive, 's1', '/context status please')).blocks).toEqual([]);
    expect((await rehydrateForPrompt(archive, 's1', 'Write a haiku about autumn leaves falling')).blocks).toEqual([]);
  });

  it('truncates a record that does not fit the budget and points at /context show', async () => {
    const big = record('e_99', 'zod '.repeat(2000), { metadata: { tool: 'Bash', command: 'npm ls' } });
    const archive = new MemoryArchive([...all, big]);
    const found = await rehydrateForPrompt(archive, 's1', 'The build fails with a zod type error I do not understand', { budgetChars: 1000 });
    expect(found.records.map((r) => r.id)).toEqual(['e_99']);
    expect(found.blocks[0]).toContain('/context show e_99');
    expect(found.chars).toBeLessThanOrEqual(1000 + 200);
  });

  it('respects the session filter and the record limit', async () => {
    const other = record('e_50', 'POSTGRES_PORT=1111', { sessionId: 's2' });
    const archive = new MemoryArchive([...all, other]);
    const found = await rehydrateForPrompt(archive, 's1', 'Postgres connection refused on the API server', { limit: 1 });
    expect(found.records.map((r) => r.id)).toEqual(['e_1']);
  });

  it('has a preface that says the content was not continuously present', () => {
    expect(REHYDRATION_PREFACE).toMatch(/not continuously present/);
  });
});
