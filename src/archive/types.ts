import type { ContextAction, DecisionReason } from '../core/actions.js';
import type { EventKind, EventRole } from '../core/events.js';

/**
 * One exact unit of context that left the active window. The archive is the
 * slow tier of the memory hierarchy: nothing in it is ever paraphrased, and
 * nothing leaves it unless the user purges it.
 */
export interface ArchiveRecord {
  /** The event id (see `eventId`); the same content archived twice keeps one record. */
  id: string;
  sessionId: string;
  /** Position in the transcript at the time it was archived. */
  seq: number;
  role: EventRole;
  kind: EventKind;
  toolName?: string;
  toolUseId?: string;
  /** The exact original content. */
  content: string;
  contentHash: string;
  tokenEstimate: number;
  isError?: boolean;
  /** ISO-8601 time the record was written. */
  archivedAt: string;
  /** Which compaction wrote it (a counter or timestamp the engine chooses). */
  compactionId: string;
  /** The action that evicted it and why, for `/context why`. */
  action: ContextAction;
  reasons: DecisionReason[];
  /** Ids of related records: the call of a result, the result of a call, a duplicate, a dependant. */
  related: { relation: 'call' | 'result' | 'duplicate_of' | 'referenced_by' | 'supersedes'; id: string }[];
  /** Tool-specific facts that make the record findable or reproducible (path, command, exit code, file hash …). */
  metadata: Record<string, unknown>;
}

export interface ArchiveSummary {
  id: string;
  sessionId: string;
  seq: number;
  kind: EventKind;
  toolName?: string;
  tokenEstimate: number;
  action: ContextAction;
  archivedAt: string;
  /** The first line or so of the content. */
  preview: string;
  /** Relevance in [0, 1] when the summary came from `search`. */
  score?: number;
}

export interface ArchiveSearchOptions {
  sessionId?: string;
  kinds?: EventKind[];
  toolNames?: string[];
  limit?: number;
}

export interface ArchiveStats {
  records: number;
  tokens: number;
  bySession: Record<string, { records: number; tokens: number }>;
}

/**
 * Where evicted context lives. Implementations must be append-only from the
 * engine's point of view: `put` never overwrites a record with different
 * content, and only `purge` removes anything.
 */
export interface ArchiveStore {
  put(records: readonly ArchiveRecord[]): Promise<void>;
  get(id: string): Promise<ArchiveRecord | undefined>;
  getMany(ids: readonly string[]): Promise<ArchiveRecord[]>;
  list(options?: ArchiveSearchOptions): Promise<ArchiveSummary[]>;
  /** Lexical search over content and metadata; ranked, best first. */
  search(query: string, options?: ArchiveSearchOptions): Promise<ArchiveSummary[]>;
  stats(sessionId?: string): Promise<ArchiveStats>;
  /** Removes records for good; the only destructive operation. */
  purge(ids: readonly string[]): Promise<number>;
}

/** The first line of some content, bounded, for listings. */
export function preview(content: string, maxChars = 120): string {
  const line = content.replace(/\s+/g, ' ').trim();
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

export function summaryOf(record: ArchiveRecord): ArchiveSummary {
  const summary: ArchiveSummary = {
    id: record.id,
    sessionId: record.sessionId,
    seq: record.seq,
    kind: record.kind,
    tokenEstimate: record.tokenEstimate,
    action: record.action,
    archivedAt: record.archivedAt,
    preview: preview(record.content),
  };
  if (record.toolName) summary.toolName = record.toolName;
  return summary;
}
