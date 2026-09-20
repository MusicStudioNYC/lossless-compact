import { hashText } from '../core/hash.js';
import type { JevAnswer, JevAsker, JevQuestions, JevResponse, JevState } from '../types.js';

export interface CassetteEntry {
  key: string;
  model?: string;
  questionNames: string[];
  answers: Record<string, JevAnswer>;
  usage?: JevResponse['usage'];
  recordedAt: string;
  ms: number;
}

export interface Cassette {
  version: 1;
  entries: Record<string, CassetteEntry>;
}

// replay: cassette only, throw on miss ("cassette miss: <key>"); record: always
// call inner asker and store; auto: replay on hit, record on miss.
export type ReplayMode = 'replay' | 'record' | 'auto';

export interface ReplayStats {
  hits: number;
  misses: number;
  recorded: number;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Recursively sorted-key JSON, so two objects that differ only in key order hash the same. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON of a value: object keys sorted recursively, so it is stable
 * under key-order changes rather than tied to one JS engine's iteration order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** The fingerprint a cassette entry is keyed by: the exact (state, questions) pair asked. */
export function cassetteKey(state: JevState, questions: JevQuestions): string {
  return hashText(canonicalJson({ state, questions }));
}

export function emptyCassette(): Cassette {
  return { version: 1, entries: {} };
}

export function serialiseCassette(cassette: Cassette): string {
  return JSON.stringify(cassette, null, 2);
}

function isValidEntry(entry: unknown): entry is CassetteEntry {
  if (entry === null || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e['key'] === 'string' &&
    Array.isArray(e['questionNames']) &&
    e['answers'] !== null &&
    typeof e['answers'] === 'object' &&
    typeof e['recordedAt'] === 'string' &&
    typeof e['ms'] === 'number'
  );
}

/** Validates a cassette's shape; throws on anything that is not one. */
export function parseCassette(json: string): Cassette {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('cassette is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('cassette has an invalid shape');
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate['version'] !== 1 || candidate['entries'] === null || typeof candidate['entries'] !== 'object') {
    throw new Error('cassette has an invalid shape');
  }
  for (const [key, entry] of Object.entries(candidate['entries'] as Record<string, unknown>)) {
    if (!isValidEntry(entry)) throw new Error(`cassette entry ${key} has an invalid shape`);
  }
  return candidate as unknown as Cassette;
}

function replayResponse(entry: CassetteEntry): JevResponse {
  const response: JevResponse = { answers: deepCopy(entry.answers) };
  if (entry.model !== undefined) response.model = entry.model;
  if (entry.usage !== undefined) response.usage = deepCopy(entry.usage);
  return response;
}

/**
 * A `JevAsker` that records every (state, questions) → response into a
 * cassette keyed by a fingerprint of the request, and replays from the
 * cassette when present, so a benchmark run is reproducible and costs
 * nothing after the first pass (plan Phase 0: deterministic replay support).
 */
export class ReplayAsker implements JevAsker {
  readonly stats: ReplayStats = { hits: 0, misses: 0, recorded: 0 };

  constructor(
    readonly cassette: Cassette,
    private readonly inner?: JevAsker,
    private readonly mode: ReplayMode = inner ? 'auto' : 'replay',
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const key = cassetteKey(state, questions);
    const questionNames = Object.keys(questions);

    if (this.mode !== 'record') {
      const existing = this.cassette.entries[key];
      if (existing) {
        this.stats.hits += 1;
        return replayResponse(existing);
      }
      this.stats.misses += 1;
      if (this.mode === 'replay') {
        throw new Error(`cassette miss: ${questionNames.join(', ')}`);
      }
    }

    const inner = this.inner;
    if (!inner) {
      throw new Error('ReplayAsker: cannot record without an inner asker');
    }
    return this.record(inner, key, questionNames, state, questions);
  }

  private async record(
    inner: JevAsker,
    key: string,
    questionNames: string[],
    state: JevState,
    questions: JevQuestions,
  ): Promise<JevResponse> {
    const startedAt = this.now();
    const response = await inner.ask(state, questions);
    const entry: CassetteEntry = {
      key,
      questionNames,
      answers: deepCopy(response.answers),
      recordedAt: startedAt.toISOString(),
      ms: this.now().getTime() - startedAt.getTime(),
    };
    if (response.model !== undefined) entry.model = response.model;
    if (response.usage !== undefined) entry.usage = deepCopy(response.usage);
    this.cassette.entries[key] = entry;
    this.stats.recorded += 1;
    return deepCopy(response);
  }
}
