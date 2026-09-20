import { queryTerms } from '../archive/memory-store.js';
import type { ArchiveRecord, ArchiveStore } from '../archive/types.js';

/**
 * Automatic retrieval: before a turn, the archive is searched with the
 * prompt and the best exact records are handed to the model as
 * `<retrieved_context>` blocks. Nothing pretends the content was there all
 * along; every block names its archive id and when it was archived.
 */
export interface RehydrateOptions {
  /** Characters of retrieved content per turn. Default 6000. */
  budgetChars?: number;
  /** Least lexical relevance to consider (share of query terms found). Default 0.34. */
  minScore?: number;
  /** Most records per turn. Default 3. */
  limit?: number;
  /** Prompts shorter than this (in characters) are not searched. Default 12. */
  minPromptChars?: number;
}

export interface Rehydration {
  records: ArchiveRecord[];
  blocks: string[];
  chars: number;
}

/**
 * The `maxChars` slice of `content` with the most query-term hits, aligned to
 * line boundaries: a 40k-char file read whose relevant type sits 12k in must
 * not be handed over as its first 6k chars. Distinct terms count more than
 * repeats of one term. Without terms, or when it all fits, the head.
 */
export function bestWindow(
  content: string,
  terms: ReadonlySet<string>,
  maxChars: number,
): { start: number; end: number } {
  if (content.length <= maxChars) return { start: 0, end: content.length };
  const lower = content.toLowerCase();
  const hits: { at: number; term: string }[] = [];
  for (const term of terms) {
    if (term.length < 3) continue;
    let at = lower.indexOf(term);
    for (let n = 0; at !== -1 && n < 200; n++) {
      hits.push({ at, term });
      at = lower.indexOf(term, at + term.length);
    }
  }
  if (hits.length === 0) return alignToLines(content, 0, maxChars);
  hits.sort((a, b) => a.at - b.at);
  const lead = Math.floor(maxChars * 0.25);
  let best = { start: 0, score: -1 };
  for (const hit of hits) {
    const start = Math.max(0, Math.min(hit.at - lead, content.length - maxChars));
    const end = start + maxChars;
    const seen = new Set<string>();
    let count = 0;
    for (const other of hits) {
      if (other.at < start) continue;
      if (other.at >= end) break;
      seen.add(other.term);
      count++;
    }
    const score = seen.size * 10 + Math.min(count, 50);
    if (score > best.score) best = { start, score };
  }
  return alignToLines(content, best.start, best.start + maxChars);
}

function alignToLines(content: string, start: number, end: number): { start: number; end: number } {
  // Both edges move inward, so the window never grows past what was asked.
  let from = start;
  if (from > 0 && content[from - 1] !== '\n') {
    const newline = content.indexOf('\n', from);
    if (newline !== -1 && newline - from < 200) from = newline + 1;
  }
  let to = Math.min(end, content.length);
  if (to < content.length) {
    const newline = content.lastIndexOf('\n', to);
    if (newline > from && to - newline < 200) to = newline;
  }
  return { start: from, end: to };
}

export function retrievedBlock(record: ArchiveRecord, maxChars?: number, terms?: ReadonlySet<string>): string {
  let content = record.content;
  if (maxChars !== undefined && record.content.length > maxChars) {
    const { start, end } = bestWindow(record.content, terms ?? new Set(), maxChars);
    const before = start > 0 ? `[… ${start} chars before this excerpt; /context show ${record.id} for all of it]\n` : '';
    const after =
      end < record.content.length
        ? `\n[… ${record.content.length - end} more chars; /context show ${record.id} for all of it]`
        : '';
    content = `${before}${record.content.slice(start, end)}${after}`;
  }
  const attrs = [
    `id="${record.id}"`,
    `kind="${record.kind}"`,
    record.toolName ? `tool="${record.toolName}"` : '',
    `seq="${record.seq}"`,
    `archived="${record.archivedAt}"`,
  ]
    .filter(Boolean)
    .join(' ');
  return `<retrieved_context ${attrs}>\n${content}\n</retrieved_context>`;
}

export const REHYDRATION_PREFACE =
  'context-os retrieved the following exact archived content because it looks relevant to this prompt. It was removed from the active context earlier and was not continuously present; /context why <id> explains why, /context restore <id> brings back the whole record.';

/** Picks archived records for a prompt within the budget; empty when nothing is relevant enough. */
export async function rehydrateForPrompt(
  archive: ArchiveStore,
  sessionId: string,
  prompt: string,
  options: RehydrateOptions = {},
): Promise<Rehydration> {
  const budget = options.budgetChars ?? 6000;
  const minScore = options.minScore ?? 0.34;
  const limit = options.limit ?? 3;
  const text = prompt.trim();
  if (text.length < (options.minPromptChars ?? 12) || text.startsWith('/')) {
    return { records: [], blocks: [], chars: 0 };
  }
  const found = await archive.search(text, { sessionId, limit: limit * 3 });
  const terms = queryTerms(text);
  const chosen: ArchiveRecord[] = [];
  const blocks: string[] = [];
  let chars = 0;
  for (const summary of found) {
    if ((summary.score ?? 0) < minScore) continue;
    if (chosen.length >= limit) break;
    const record = await archive.get(summary.id);
    if (!record) continue;
    const room = budget - chars;
    if (room < 200) break;
    // The wrapper and the excerpt markers are not content; leave them room.
    const block = retrievedBlock(record, Math.min(Math.max(100, room - 320), record.content.length), terms);
    chosen.push(record);
    blocks.push(block);
    chars += block.length;
  }
  return { records: chosen, blocks, chars };
}
