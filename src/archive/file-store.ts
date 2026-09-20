import { MemoryArchive, matchesFilter, rankRecords } from './memory-store.js';
import {
  summaryOf,
  type ArchiveRecord,
  type ArchiveSearchOptions,
  type ArchiveStats,
  type ArchiveStore,
  type ArchiveSummary,
} from './types.js';

/**
 * The little of a file system the archive needs, so one store runs on Node
 * (`src/node/fs.ts`) and inside the Claude Code hook (`$.fs`, whole-file
 * reads and writes of at most 4 MiB, no append, no delete).
 */
export interface TextFs {
  /** Rejects with an error whose `code` is `ENOENT` when the file is missing. */
  read(path: string): Promise<string>;
  /** Creates parent directories as needed. */
  write(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Entry names of a directory; `[]` when it does not exist. */
  list(dir: string): Promise<string[]>;
}

export interface FileArchiveOptions {
  /** Directory the archive lives under; `.context-os` by default (relative to the project). */
  root?: string;
  /** Largest shard file, in characters of JSON. Default 3.5 MiB, under the hook's 4 MiB cap. */
  maxShardChars?: number;
}

interface IndexEntry extends ArchiveSummary {
  shard: string;
  contentHash: string;
}

interface IndexFile {
  version: 1;
  sessionId: string;
  entries: IndexEntry[];
}

interface ShardFile {
  version: 1;
  records: ArchiveRecord[];
}

const INDEX = 'index.json';

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

/**
 * Records sharded into JSON files per session and compaction, with one index
 * per session listing every record's summary and shard:
 *
 * ```
 * <root>/archive/<sessionId>/index.json
 * <root>/archive/<sessionId>/<compactionId>[-<n>].json
 * ```
 *
 * Append-only: a shard is written once and never rewritten; `purge` rewrites
 * the affected shards and the index. Search loads shards lazily and caches
 * them for the life of the store.
 */
export class FileArchive implements ArchiveStore {
  private readonly root: string;
  private readonly maxShardChars: number;
  private readonly indexes = new Map<string, IndexFile>();
  private readonly shards = new Map<string, ShardFile>();

  constructor(
    private readonly fs: TextFs,
    options: FileArchiveOptions = {},
  ) {
    this.root = (options.root ?? '.context-os').replace(/[\\/]+$/, '');
    this.maxShardChars = options.maxShardChars ?? 3.5 * 1024 * 1024;
  }

  private dir(sessionId: string): string {
    return `${this.root}/archive/${encodeURIComponent(sessionId)}`;
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await this.fs.read(path)) as T;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async index(sessionId: string): Promise<IndexFile> {
    const cached = this.indexes.get(sessionId);
    if (cached) return cached;
    const loaded = (await this.readJson<IndexFile>(`${this.dir(sessionId)}/${INDEX}`)) ?? {
      version: 1,
      sessionId,
      entries: [],
    };
    this.indexes.set(sessionId, loaded);
    return loaded;
  }

  private async shard(sessionId: string, name: string): Promise<ShardFile> {
    const path = `${this.dir(sessionId)}/${name}`;
    const cached = this.shards.get(path);
    if (cached) return cached;
    const loaded = (await this.readJson<ShardFile>(path)) ?? { version: 1, records: [] };
    this.shards.set(path, loaded);
    return loaded;
  }

  /** Sessions with an archive directory. */
  async sessions(): Promise<string[]> {
    return (await this.fs.list(`${this.root}/archive`)).map((name) => {
      try {
        return decodeURIComponent(name);
      } catch {
        return name;
      }
    });
  }

  async put(records: readonly ArchiveRecord[]): Promise<void> {
    const bySession = new Map<string, ArchiveRecord[]>();
    for (const record of records) {
      const list = bySession.get(record.sessionId) ?? [];
      list.push(record);
      bySession.set(record.sessionId, list);
    }
    for (const [sessionId, list] of bySession) {
      const index = await this.index(sessionId);
      const known = new Map(index.entries.map((entry) => [entry.id, entry]));
      const fresh: ArchiveRecord[] = [];
      for (const record of list) {
        const existing = known.get(record.id);
        if (existing) {
          if (existing.contentHash !== record.contentHash) {
            throw new Error(`archive record ${record.id} exists with different content`);
          }
          continue;
        }
        known.set(record.id, { ...summaryOf(record), shard: '', contentHash: record.contentHash });
        fresh.push(record);
      }
      if (fresh.length === 0) continue;
      const compactionId = fresh[0]!.compactionId.replace(/[^\w.-]+/g, '_');
      const taken = new Set(index.entries.map((entry) => entry.shard));
      let part = 0;
      let batch: ArchiveRecord[] = [];
      let chars = 0;
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        let name = part === 0 ? `${compactionId}.json` : `${compactionId}-${part}.json`;
        while (taken.has(name)) {
          part++;
          name = `${compactionId}-${part}.json`;
        }
        taken.add(name);
        part++;
        const file: ShardFile = { version: 1, records: batch };
        await this.fs.write(`${this.dir(sessionId)}/${name}`, JSON.stringify(file));
        this.shards.set(`${this.dir(sessionId)}/${name}`, file);
        for (const record of batch) {
          index.entries.push({ ...summaryOf(record), shard: name, contentHash: record.contentHash });
        }
        batch = [];
        chars = 0;
      };
      for (const record of fresh) {
        const size = JSON.stringify(record).length + 2;
        if (batch.length > 0 && chars + size > this.maxShardChars) await flush();
        batch.push(record);
        chars += size;
      }
      await flush();
      await this.fs.write(`${this.dir(sessionId)}/${INDEX}`, JSON.stringify(index));
    }
  }

  private async locate(id: string): Promise<{ sessionId: string; entry: IndexEntry } | undefined> {
    for (const [sessionId, index] of this.indexes) {
      const entry = index.entries.find((e) => e.id === id);
      if (entry) return { sessionId, entry };
    }
    for (const sessionId of await this.sessions()) {
      if (this.indexes.has(sessionId)) continue;
      const index = await this.index(sessionId);
      const entry = index.entries.find((e) => e.id === id);
      if (entry) return { sessionId, entry };
    }
    return undefined;
  }

  async get(id: string): Promise<ArchiveRecord | undefined> {
    const located = await this.locate(id);
    if (!located) return undefined;
    const shard = await this.shard(located.sessionId, located.entry.shard);
    return shard.records.find((record) => record.id === id);
  }

  async getMany(ids: readonly string[]): Promise<ArchiveRecord[]> {
    const found: ArchiveRecord[] = [];
    for (const id of ids) {
      const record = await this.get(id);
      if (record) found.push(record);
    }
    return found;
  }

  private async entries(options: ArchiveSearchOptions): Promise<{ sessionId: string; entry: IndexEntry }[]> {
    const sessions = options.sessionId ? [options.sessionId] : await this.sessions();
    const all: { sessionId: string; entry: IndexEntry }[] = [];
    for (const sessionId of sessions) {
      const index = await this.index(sessionId);
      for (const entry of index.entries) {
        if (matchesFilter({ sessionId, kind: entry.kind, toolName: entry.toolName }, options)) {
          all.push({ sessionId, entry });
        }
      }
    }
    return all.sort((a, b) => a.entry.seq - b.entry.seq || a.entry.archivedAt.localeCompare(b.entry.archivedAt));
  }

  async list(options: ArchiveSearchOptions = {}): Promise<ArchiveSummary[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    return (await this.entries(options)).slice(0, limit).map(({ entry }) => {
      const { shard: _shard, contentHash: _hash, ...summary } = entry;
      return summary;
    });
  }

  async search(query: string, options: ArchiveSearchOptions = {}): Promise<ArchiveSummary[]> {
    const limit = options.limit ?? 20;
    const records: ArchiveRecord[] = [];
    for (const { sessionId, entry } of await this.entries(options)) {
      const shard = await this.shard(sessionId, entry.shard);
      const record = shard.records.find((r) => r.id === entry.id);
      if (record) records.push(record);
    }
    return rankRecords(query, records)
      .slice(0, limit)
      .map((entry) => ({ ...summaryOf(entry.record), score: entry.score }));
  }

  async stats(sessionId?: string): Promise<ArchiveStats> {
    const stats: ArchiveStats = { records: 0, tokens: 0, bySession: {} };
    for (const { sessionId: id, entry } of await this.entries(sessionId ? { sessionId } : {})) {
      stats.records++;
      stats.tokens += entry.tokenEstimate;
      const session = (stats.bySession[id] ??= { records: 0, tokens: 0 });
      session.records++;
      session.tokens += entry.tokenEstimate;
    }
    return stats;
  }

  async purge(ids: readonly string[]): Promise<number> {
    let removed = 0;
    const touched = new Map<string, Set<string>>();
    for (const id of ids) {
      const located = await this.locate(id);
      if (!located) continue;
      const shards = touched.get(located.sessionId) ?? new Set<string>();
      shards.add(located.entry.shard);
      touched.set(located.sessionId, shards);
    }
    const gone = new Set(ids);
    for (const [sessionId, shards] of touched) {
      for (const name of shards) {
        const shard = await this.shard(sessionId, name);
        const before = shard.records.length;
        shard.records = shard.records.filter((record) => !gone.has(record.id));
        removed += before - shard.records.length;
        await this.fs.write(`${this.dir(sessionId)}/${name}`, JSON.stringify(shard));
      }
      const index = await this.index(sessionId);
      index.entries = index.entries.filter((entry) => !gone.has(entry.id));
      await this.fs.write(`${this.dir(sessionId)}/${INDEX}`, JSON.stringify(index));
    }
    return removed;
  }

  /** Everything in one session, loaded into memory (for tests and inspection). */
  async toMemory(sessionId: string): Promise<MemoryArchive> {
    const records: ArchiveRecord[] = [];
    for (const { entry } of await this.entries({ sessionId })) {
      const shard = await this.shard(sessionId, entry.shard);
      const record = shard.records.find((r) => r.id === entry.id);
      if (record) records.push(record);
    }
    return new MemoryArchive(records);
  }
}
