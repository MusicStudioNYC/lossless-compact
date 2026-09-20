import {
  summaryOf,
  type ArchiveRecord,
  type ArchiveSearchOptions,
  type ArchiveStats,
  type ArchiveStore,
  type ArchiveSummary,
} from './types.js';

const TERM = /[a-z0-9_$][a-z0-9_$.\-/\\]{1,}/g;

/** Lower-cased search terms of some text, deduplicated. */
export function termsOf(text: string): Set<string> {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TERM)) terms.add(match[0]);
  return terms;
}

const STOPWORDS = new Set(
  `
  the a an and or but if then else of to in on at for from by with without into onto over under
  as is are was were be been being am do does did done have has had having can could should
  would will shall may might must not no nor so than that this these those there here it its i
  me my we our you your he she they them their what which who whom whose when where why how all
  any some more most much many few very just also again still yet now new old only own same
  other another each every both either neither because while before after until since about
  above below between through during against out up down off further once please let make get
  got need needs want wants try trying cannot use using used run running ran file files code
  `.split(/\s+/).filter(Boolean),
);

/** A crude stem: `uploads` → `upload`, `failing` → `fail`, `checked` → `check`; identifiers are left alone. */
export function stem(term: string): string {
  if (/[_.\-/\\0-9]/.test(term)) return term;
  if (term.length >= 6 && term.endsWith('ing')) return term.slice(0, -3);
  if (term.length >= 5 && term.endsWith('ed')) return term.slice(0, -2);
  if (term.length >= 5 && term.endsWith('es') && !term.endsWith('ses')) return term.slice(0, -1);
  if (term.length >= 4 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/** Query terms worth matching: stopwords and very short tokens dropped, each with its stem. */
export function queryTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const term of termsOf(text)) {
    if (term.length < 3 || STOPWORDS.has(term)) continue;
    terms.add(term);
    const stemmed = stem(term);
    if (stemmed !== term && stemmed.length >= 3) terms.add(stemmed);
  }
  return terms;
}

interface Indexed {
  record: ArchiveRecord;
  content: Set<string>;
  meta: Set<string>;
}

function index(record: ArchiveRecord): Indexed {
  return {
    record,
    content: termsOf(record.content),
    meta: termsOf(`${record.toolName ?? ''} ${JSON.stringify(record.metadata)}`),
  };
}

const SEPARATORS = /[_.\-/\\]/;

/**
 * How a query term matches a candidate token: the same token; a component of
 * a compound identifier (`postgres` in `postgres_port`, `auth` in
 * `src/auth/middleware.ts`); or a bare substring, which is weak evidence.
 */
function matchWeight(term: string, tokens: Set<string>): { weight: number; kind: 'exact' | 'compound' | 'substring' | 'none' } {
  if (tokens.has(term)) return { weight: 1, kind: 'exact' };
  if (term.length < 4) return { weight: 0, kind: 'none' };
  let best: { weight: number; kind: 'compound' | 'substring' | 'none' } = { weight: 0, kind: 'none' };
  for (const token of tokens) {
    const at = token.indexOf(term);
    if (at < 0) continue;
    const before = at === 0 || SEPARATORS.test(token[at - 1]!);
    const after = at + term.length === token.length || SEPARATORS.test(token[at + term.length]!);
    if (before && after) return { weight: 0.9, kind: 'compound' };
    if (term.length >= 5 && best.weight < 0.4) best = { weight: 0.4, kind: 'substring' };
  }
  return best;
}

/**
 * Ranks records for a query. Each query term is weighted by how rare it is
 * across the candidates (a plain IDF) and matched in the content or the tool
 * metadata; the score is the matched share of the query's total weight. A
 * rare term matched exactly or as a compound component is distinctive
 * evidence on its own — a prompt like "can't reach Postgres" must find
 * `POSTGRES_PORT=54329` even though its other ten words match nothing — so
 * such a record scores at least 0.5. Records with no match are left out;
 * best first.
 */
export function rankRecords(
  query: string,
  records: readonly ArchiveRecord[],
): { record: ArchiveRecord; score: number }[] {
  const terms = queryTerms(query);
  if (terms.size === 0 || records.length === 0) return [];
  // Only words the prompt actually contains can be distinctive; a stem such
  // as `fail` (from "failing") matching a `FAIL` line is not evidence.
  const original = new Set([...termsOf(query)].filter((term) => terms.has(term)));
  const indexed = records.map(index);
  const df = new Map<string, number>();
  for (const term of terms) {
    let n = 0;
    for (const item of indexed) {
      const kind = matchWeight(term, item.content).kind;
      if (kind === 'exact' || kind === 'compound' || item.meta.has(term)) n++;
    }
    df.set(term, n);
  }
  const rareLimit = Math.max(2, Math.floor(records.length * 0.05));
  const weight = (term: string): number => Math.log(1 + records.length / (1 + (df.get(term) ?? 0)));
  let total = 0;
  for (const term of terms) total += weight(term);
  const scored: { record: ArchiveRecord; score: number }[] = [];
  for (const item of indexed) {
    let hits = 0;
    let distinctive = false;
    for (const term of terms) {
      const w = weight(term);
      const inMeta = item.meta.has(term);
      const match = inMeta ? { weight: 1, kind: 'exact' as const } : matchWeight(term, item.content);
      if (match.weight === 0) continue;
      hits += match.weight * w * (inMeta ? 1.2 : 1);
      if (
        original.has(term) &&
        (match.kind === 'exact' || match.kind === 'compound') &&
        (df.get(term) ?? 0) <= rareLimit
      ) {
        distinctive = true;
      }
    }
    if (hits === 0) continue;
    const share = Math.min(1, hits / total);
    scored.push({ record: item.record, score: distinctive ? Math.max(0.5, share) : share });
  }
  return scored.sort((a, b) => b.score - a.score || b.record.seq - a.record.seq);
}

/** Backwards-compatible single-record score against a bare term set (no rarity weighting). */
export function lexicalScore(query: Set<string>, record: ArchiveRecord): number {
  if (query.size === 0) return 0;
  const item = index(record);
  let hits = 0;
  for (const term of query) {
    if (item.meta.has(term) || item.content.has(term)) hits += 1;
    else if (term.length >= 4) {
      for (const candidate of item.content) {
        if (candidate.includes(term)) {
          hits += 0.5;
          break;
        }
      }
    }
  }
  return hits / query.size;
}

export function matchesFilter(record: Pick<ArchiveRecord, 'sessionId' | 'kind' | 'toolName'>, options: ArchiveSearchOptions): boolean {
  if (options.sessionId && record.sessionId !== options.sessionId) return false;
  if (options.kinds && !options.kinds.includes(record.kind)) return false;
  if (options.toolNames && (!record.toolName || !options.toolNames.includes(record.toolName))) return false;
  return true;
}

/** An archive held in memory; the file store and the hook build on it. */
export class MemoryArchive implements ArchiveStore {
  protected readonly records = new Map<string, ArchiveRecord>();

  constructor(initial: readonly ArchiveRecord[] = []) {
    for (const record of initial) this.records.set(record.id, record);
  }

  /** Every record, oldest first by seq then archive time. */
  all(): ArchiveRecord[] {
    return [...this.records.values()].sort(
      (a, b) => a.seq - b.seq || a.archivedAt.localeCompare(b.archivedAt),
    );
  }

  async put(records: readonly ArchiveRecord[]): Promise<void> {
    for (const record of records) {
      const existing = this.records.get(record.id);
      if (existing && existing.contentHash !== record.contentHash) {
        throw new Error(`archive record ${record.id} exists with different content`);
      }
      if (!existing) this.records.set(record.id, record);
    }
  }

  async get(id: string): Promise<ArchiveRecord | undefined> {
    return this.records.get(id);
  }

  async getMany(ids: readonly string[]): Promise<ArchiveRecord[]> {
    const found: ArchiveRecord[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (record) found.push(record);
    }
    return found;
  }

  async list(options: ArchiveSearchOptions = {}): Promise<ArchiveSummary[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    return this.all()
      .filter((record) => matchesFilter(record, options))
      .slice(0, limit)
      .map(summaryOf);
  }

  async search(query: string, options: ArchiveSearchOptions = {}): Promise<ArchiveSummary[]> {
    const limit = options.limit ?? 20;
    return rankRecords(
      query,
      this.all().filter((record) => matchesFilter(record, options)),
    )
      .slice(0, limit)
      .map((entry) => ({ ...summaryOf(entry.record), score: entry.score }));
  }

  async stats(sessionId?: string): Promise<ArchiveStats> {
    const stats: ArchiveStats = { records: 0, tokens: 0, bySession: {} };
    for (const record of this.records.values()) {
      if (sessionId && record.sessionId !== sessionId) continue;
      stats.records++;
      stats.tokens += record.tokenEstimate;
      const session = (stats.bySession[record.sessionId] ??= { records: 0, tokens: 0 });
      session.records++;
      session.tokens += record.tokenEstimate;
    }
    return stats;
  }

  async purge(ids: readonly string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) if (this.records.delete(id)) removed++;
    return removed;
  }
}
