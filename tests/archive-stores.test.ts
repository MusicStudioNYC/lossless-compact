import { describe, expect, it } from 'vitest';
import { MemoryArchive } from '../src/archive/memory-store.js';
import { FileArchive, type TextFs } from '../src/archive/file-store.js';
import type { ArchiveRecord } from '../src/archive/types.js';

function record(id: string, overrides: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    id,
    sessionId: 'session-a',
    seq: 0,
    role: 'tool',
    kind: 'tool_result',
    toolName: 'Read',
    content: `content for ${id}`,
    contentHash: `hash-${id}`,
    tokenEstimate: 3,
    archivedAt: '2024-01-01T00:00:00.000Z',
    compactionId: 'c1',
    action: 'ARCHIVE_ONLY',
    reasons: [],
    related: [],
    metadata: {},
    ...overrides,
  };
}

/** A Map-backed fake of the 4-method TextFs the archive needs. */
function fakeFs(): TextFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path: string) {
      const content = files.get(path);
      if (content === undefined) {
        const error = new Error(`ENOENT: no such file, ${path}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    },
    async write(path: string, text: string) {
      files.set(path, text);
    },
    async exists(path: string) {
      return files.has(path);
    },
    async list(dir: string) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const name = rest.split('/')[0];
        if (name) names.add(name);
      }
      return [...names];
    },
  };
}

describe('MemoryArchive', () => {
  it('put/get/getMany round-trip records', async () => {
    const archive = new MemoryArchive();
    const r1 = record('a');
    const r2 = record('b');
    await archive.put([r1, r2]);
    expect(await archive.get('a')).toEqual(r1);
    expect(await archive.get('missing')).toBeUndefined();
    expect(await archive.getMany(['a', 'missing', 'b'])).toEqual([r1, r2]);
  });

  it('list filters by session, kind and toolName, and honours limit', async () => {
    const archive = new MemoryArchive();
    await archive.put([
      record('a', { sessionId: 's1', kind: 'tool_result', toolName: 'Read', seq: 0 }),
      record('b', { sessionId: 's1', kind: 'tool_use', toolName: 'Bash', seq: 1 }),
      record('c', { sessionId: 's2', kind: 'tool_result', toolName: 'Read', seq: 2 }),
    ]);
    expect((await archive.list({ sessionId: 's1' })).map((s) => s.id)).toEqual(['a', 'b']);
    expect((await archive.list({ kinds: ['tool_use'] })).map((s) => s.id)).toEqual(['b']);
    expect((await archive.list({ toolNames: ['Bash'] })).map((s) => s.id)).toEqual(['b']);
    expect((await archive.list({ limit: 1 })).map((s) => s.id)).toEqual(['a']);
    expect((await archive.list()).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('search ranks a record containing the query terms first', async () => {
    const archive = new MemoryArchive();
    await archive.put([
      record('unrelated', { seq: 0, content: 'nothing to do with the query at all' }),
      record('match', { seq: 1, content: 'acquiring the advisory lock before the migration runs' }),
    ]);
    const found = await archive.search('advisory lock');
    expect(found[0]?.id).toBe('match');
    expect(found.map((s) => s.id)).not.toContain('unrelated');
  });

  it('stats aggregates records and tokens per session and overall', async () => {
    const archive = new MemoryArchive();
    await archive.put([
      record('a', { sessionId: 's1', tokenEstimate: 10 }),
      record('b', { sessionId: 's1', tokenEstimate: 5 }),
      record('c', { sessionId: 's2', tokenEstimate: 7 }),
    ]);
    const all = await archive.stats();
    expect(all).toEqual({
      records: 3,
      tokens: 22,
      bySession: { s1: { records: 2, tokens: 15 }, s2: { records: 1, tokens: 7 } },
    });
    const s1Only = await archive.stats('s1');
    expect(s1Only.records).toBe(2);
    expect(s1Only.tokens).toBe(15);
  });

  it('purge removes records for good', async () => {
    const archive = new MemoryArchive();
    await archive.put([record('a'), record('b')]);
    expect(await archive.purge(['a', 'missing'])).toBe(1);
    expect(await archive.get('a')).toBeUndefined();
    expect(await archive.get('b')).toBeDefined();
  });

  it('put throws when the same id arrives with a different contentHash', async () => {
    const archive = new MemoryArchive();
    await archive.put([record('a', { contentHash: 'h1' })]);
    await expect(archive.put([record('a', { contentHash: 'h2' })])).rejects.toThrow(/exists with different content/);
  });

  it('put silently ignores an identical re-put (same id, same contentHash)', async () => {
    const archive = new MemoryArchive();
    const original = record('a', { contentHash: 'h1', content: 'first version' });
    await archive.put([original]);
    const rePut = record('a', { contentHash: 'h1', content: 'first version', seq: 99 });
    await expect(archive.put([rePut])).resolves.toBeUndefined();
    expect(await archive.get('a')).toEqual(original);
  });
});

describe('FileArchive', () => {
  it('put/get/getMany round-trip records', async () => {
    const archive = new FileArchive(fakeFs(), { root: '.ctx' });
    const r1 = record('a');
    const r2 = record('b');
    await archive.put([r1, r2]);
    expect(await archive.get('a')).toEqual(r1);
    expect(await archive.get('missing')).toBeUndefined();
    expect(await archive.getMany(['a', 'missing', 'b'])).toEqual([r1, r2]);
  });

  it('list filters by session, kind and toolName, and honours limit', async () => {
    const archive = new FileArchive(fakeFs(), { root: '.ctx' });
    await archive.put([
      record('a', { sessionId: 's1', kind: 'tool_result', toolName: 'Read', seq: 0 }),
      record('b', { sessionId: 's1', kind: 'tool_use', toolName: 'Bash', seq: 1 }),
      record('c', { sessionId: 's2', kind: 'tool_result', toolName: 'Read', seq: 2 }),
    ]);
    expect((await archive.list({ sessionId: 's1' })).map((s) => s.id)).toEqual(['a', 'b']);
    expect((await archive.list({ kinds: ['tool_use'] })).map((s) => s.id)).toEqual(['b']);
    expect((await archive.list({ toolNames: ['Bash'] })).map((s) => s.id)).toEqual(['b']);
    expect((await archive.list({ limit: 1 })).map((s) => s.id)).toEqual(['a']);
  });

  it('search ranks a record containing the query terms first', async () => {
    const archive = new FileArchive(fakeFs(), { root: '.ctx' });
    await archive.put([
      record('unrelated', { seq: 0, content: 'nothing to do with the query at all' }),
      record('match', { seq: 1, content: 'acquiring the advisory lock before the migration runs' }),
    ]);
    const found = await archive.search('advisory lock');
    expect(found[0]?.id).toBe('match');
  });

  it('stats aggregates records and tokens per session and overall', async () => {
    const archive = new FileArchive(fakeFs(), { root: '.ctx' });
    await archive.put([
      record('a', { sessionId: 's1', tokenEstimate: 10 }),
      record('b', { sessionId: 's1', tokenEstimate: 5 }),
      record('c', { sessionId: 's2', tokenEstimate: 7 }),
    ]);
    expect(await archive.stats()).toEqual({
      records: 3,
      tokens: 22,
      bySession: { s1: { records: 2, tokens: 15 }, s2: { records: 1, tokens: 7 } },
    });
    expect((await archive.stats('s1')).records).toBe(2);
  });

  it('put throws when the same id arrives with a different contentHash, and ignores an identical re-put', async () => {
    const archive = new FileArchive(fakeFs(), { root: '.ctx' });
    const original = record('a', { contentHash: 'h1' });
    await archive.put([original]);
    await expect(archive.put([record('a', { contentHash: 'h1', seq: 42 })])).resolves.toBeUndefined();
    expect(await archive.get('a')).toEqual(original);
    await expect(archive.put([record('a', { contentHash: 'h2' })])).rejects.toThrow(/exists with different content/);
  });

  it('shards records once maxShardChars is small, and the index lists every shard', async () => {
    const fs = fakeFs();
    const archive = new FileArchive(fs, { root: '.ctx', maxShardChars: 200 });
    const records = Array.from({ length: 5 }, (_, i) => record(`r${i}`, { compactionId: 'batch1', seq: i }));
    await archive.put(records);

    const shardFiles = [...fs.files.keys()].filter(
      (path) => path.startsWith('.ctx/archive/session-a/') && !path.endsWith('index.json'),
    );
    expect(shardFiles.length).toBeGreaterThan(1);

    const index = JSON.parse(fs.files.get('.ctx/archive/session-a/index.json')!) as {
      entries: { id: string; shard: string }[];
    };
    expect(index.entries).toHaveLength(5);
    expect(new Set(index.entries.map((e) => e.shard)).size).toBeGreaterThan(1);
    for (const entry of index.entries) expect(shardFiles).toContain(`.ctx/archive/session-a/${entry.shard}`);
  });

  it('a second, cold instance over the same fs can get/list/search/stats everything', async () => {
    const fs = fakeFs();
    const hot = new FileArchive(fs, { root: '.ctx', maxShardChars: 200 });
    await hot.put(Array.from({ length: 5 }, (_, i) => record(`r${i}`, { compactionId: 'batch1', seq: i })));

    const cold = new FileArchive(fs, { root: '.ctx', maxShardChars: 200 });
    expect(await cold.get('r3')).toEqual(await hot.get('r3'));
    expect((await cold.list({ sessionId: 'session-a' })).map((s) => s.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(await cold.search('nonexistentterm')).toEqual([]);
    const searched = await cold.search('content');
    expect(searched.length).toBe(5);
    expect(await cold.stats('session-a')).toEqual({
      records: 5,
      tokens: 15,
      bySession: { 'session-a': { records: 5, tokens: 15 } },
    });
  });

  it('sessions() decodes encoded session ids', async () => {
    const fs = fakeFs();
    const archive = new FileArchive(fs, { root: '.ctx' });
    await archive.put([record('r1', { sessionId: 'a session/with spaces' })]);
    expect(await archive.sessions()).toEqual(['a session/with spaces']);
  });

  it('toMemory() loads one session into a MemoryArchive', async () => {
    const fs = fakeFs();
    const archive = new FileArchive(fs, { root: '.ctx' });
    await archive.put([
      record('r1', { sessionId: 's1' }),
      record('r2', { sessionId: 's1' }),
      record('r3', { sessionId: 's2' }),
    ]);
    const mem = await archive.toMemory('s1');
    expect(mem).toBeInstanceOf(MemoryArchive);
    const summaries = await mem.list();
    expect(summaries.map((s) => s.id).sort()).toEqual(['r1', 'r2']);
    expect(await mem.get('r3')).toBeUndefined();
  });

  it('purge rewrites shards and the index so a cold instance no longer sees the record', async () => {
    const fs = fakeFs();
    const a = new FileArchive(fs, { root: '.ctx' });
    await a.put([record('p1', { sessionId: 's1' }), record('p2', { sessionId: 's1' })]);
    expect(await a.purge(['p1'])).toBe(1);

    const cold = new FileArchive(fs, { root: '.ctx' });
    expect(await cold.get('p1')).toBeUndefined();
    expect(await cold.get('p2')).toBeDefined();
    expect((await cold.list({ sessionId: 's1' })).map((s) => s.id)).toEqual(['p2']);
  });

  it('locate() scans uncached sessions to find an id from a different session', async () => {
    const fs = fakeFs();
    const writer = new FileArchive(fs, { root: '.ctx' });
    await writer.put([record('x1', { sessionId: 'session-x' })]);
    await writer.put([record('y1', { sessionId: 'session-y' })]);

    const cold = new FileArchive(fs, { root: '.ctx' });
    // Nothing is cached yet in `cold`; get() must fall back to scanning sessions().
    const found = await cold.get('y1');
    expect(found?.id).toBe('y1');
    expect(found?.sessionId).toBe('session-y');
  });

  it('treats a missing index as empty without reading it, even when the host reports ENOENT only in the message', async () => {
    // The plugin host forwards fs errors across a worker hop as plain Errors:
    // no `code`, just "… failed: ENOENT". Seen live on 2.1.278 (the first
    // compaction of a session fell back to the built-in summary).
    const base = fakeFs();
    const reads: string[] = [];
    const hostLike: TextFs = {
      ...base,
      async read(path: string) {
        reads.push(path);
        if (!base.files.has(path)) throw new Error(`context-os: $.fs.read(${path}) failed: ENOENT`);
        return base.files.get(path)!;
      },
    };
    const archive = new FileArchive(hostLike, { root: '.ctx' });
    expect(await archive.stats('fresh-session')).toMatchObject({ records: 0 });
    expect(await archive.search('anything', { sessionId: 'fresh-session' })).toEqual([]);
    expect(reads).toEqual([]);

    // And when a read still races a missing file, the message form is enough.
    const racy: TextFs = { ...hostLike, exists: async () => true };
    const archive2 = new FileArchive(racy, { root: '.ctx' });
    expect(await archive2.stats('fresh-session')).toMatchObject({ records: 0 });
  });
});
