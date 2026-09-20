import { describe, expect, it } from 'vitest';
import { MemoryArchive, codeTerms, rankRecords } from '../src/archive/memory-store.js';
import type { ArchiveRecord } from '../src/archive/types.js';
import { REHYDRATION_PREFACE, bestWindow, rehydrateForPrompt, retrievedBlock } from '../src/engine/rehydrate.js';

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

  // The live smoke test: a prompt naming `FsEntry` retrieved docs/plan.md,
  // because prose words were rarer than the symbol in a code-heavy archive,
  // and the same chunk archived by two compactions took two of three slots.
  const dts = (id: string, seq: number, body: string, hash = id) =>
    record(id, body, { seq, contentHash: hash, toolName: 'Read', metadata: { tool: 'Read', file_path: 'types/claude-code.d.ts' } });
  const prose = record('e_plan', 'Say what fields the plan needs; the information came from earlier context and the type of memory involved.', {
    seq: 1,
    toolName: 'Read',
    metadata: { tool: 'Read', file_path: 'docs/plan.md' },
  });
  const chunk1 = dts('e_c1', 2, 'list: (path?: string) => Promise<FsEntry[]>;\nexport type Other = { a: 1 };\n'.repeat(3));
  const chunk2 = dts('e_c2', 3, 'export type FsEntry = { name: string; kind: "file" | "dir"; size: number };\nstat: (path: string) => Promise<FsStat>;\n');
  const chunk2Again = dts('e_c2b', 9, chunk2.content, 'e_c2');
  const chunk3 = dts('e_c3', 4, 'declare const unrelated: number;\n'.repeat(5));

  it('lets a code-cased term outrank prose words that happen to be rare', () => {
    const ranked = rankRecords('Without using any tools: what fields does the FsEntry type have? Say where that information came from.', [
      prose,
      chunk1,
      chunk2,
      chunk3,
    ]);
    expect(ranked[0]!.record.id).toBe('e_c2');
    expect(ranked.map((r) => r.record.id)).not.toContain('e_plan');
    expect(ranked.map((r) => r.record.id)).not.toContain('e_c3');
  });

  it('collapses records with the same contentHash to the newest one', () => {
    const ranked = rankRecords('what fields does the FsEntry type have?', [chunk1, chunk2, chunk2Again]);
    expect(ranked.map((r) => r.record.id)).toEqual(['e_c2b', 'e_c1']);
  });

  it('retrieves nothing for a prompt made of prose alone', () => {
    expect(rankRecords('Say where in your context the information about the fields came from', [prose, chunk1, chunk2, chunk3])).toEqual([]);
  });

  it('codeTerms picks camelCase, ALL_CAPS, dotted members, paths and numbers, with their components', () => {
    const { code, components } = codeTerms('Check FsEntry and MAX_UPLOAD_MB, then $.fs.stat on src/a.ts; port 54329, not the word upload.');
    expect([...code]).toEqual(['fsentry', 'max_upload_mb', '$.fs.stat', 'src/a.ts', '54329']);
    expect(components).toContain('upload');
    expect(components).toContain('stat');
    expect(components).not.toContain('max');
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
    expect((await rehydrateForPrompt(archive, 's1', '/lossless status please')).blocks).toEqual([]);
    expect((await rehydrateForPrompt(archive, 's1', 'Write a haiku about autumn leaves falling')).blocks).toEqual([]);
  });

  it('truncates a record that does not fit the budget and points at /lossless show', async () => {
    const big = record('e_99', 'zod '.repeat(2000), { metadata: { tool: 'Bash', command: 'npm ls' } });
    const archive = new MemoryArchive([...all, big]);
    const found = await rehydrateForPrompt(archive, 's1', 'The build fails with a zod type error I do not understand', { budgetChars: 1000 });
    expect(found.records.map((r) => r.id)).toEqual(['e_99']);
    expect(found.blocks[0]).toContain('/lossless show e_99');
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

describe('bestWindow / excerpting', () => {
  const filler = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag} line ${i}: export declare const v${i}: number;`).join('\n');
  const deep = record(
    'e_big',
    [filler(300, 'head'), 'export type FsEntry = { name: string; kind: "file" | "dir"; size: number };', filler(300, 'tail')].join('\n'),
    { toolName: 'Read', metadata: { tool: 'Read', file_path: 'types/claude-code.d.ts' } },
  );

  it('picks the line-aligned window around the query terms, not the head', () => {
    const { start, end } = bestWindow(deep.content, new Set(['fsentry', 'kind', 'size']), 1500);
    const slice = deep.content.slice(start, end);
    expect(slice).toContain('export type FsEntry');
    expect(start).toBeGreaterThan(0);
    expect(end - start).toBeLessThanOrEqual(1500);
    expect(deep.content[start - 1]).toBe('\n');
    expect(deep.content[end]).toBe('\n');
  });

  it('falls back to the head without terms or hits', () => {
    expect(bestWindow(deep.content, new Set(), 1500).start).toBe(0);
    expect(bestWindow(deep.content, new Set(['nowhere']), 1500).start).toBe(0);
    expect(bestWindow('short', new Set(['short']), 1500)).toEqual({ start: 0, end: 5 });
  });

  it('retrievedBlock marks what was cut on both sides and rehydrateForPrompt hands the model the excerpt', async () => {
    const block = retrievedBlock(deep, 1500, new Set(['fsentry']));
    expect(block).toContain('export type FsEntry');
    expect(block).toMatch(/\[… \d+ chars before this excerpt; \/lossless show e_big for all of it\]/);
    expect(block).toMatch(/\[… \d+ more chars; \/lossless show e_big for all of it\]/);

    const archive = new MemoryArchive();
    await archive.put([deep]);
    const found = await rehydrateForPrompt(archive, 's1', 'what fields does the FsEntry type have?', { budgetChars: 2000 });
    expect(found.records.map((r) => r.id)).toEqual(['e_big']);
    expect(found.blocks[0]).toContain('export type FsEntry');
    expect(found.chars).toBeLessThanOrEqual(2000);
  });
});
