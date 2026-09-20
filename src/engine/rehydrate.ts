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

export function retrievedBlock(record: ArchiveRecord, maxChars?: number): string {
  const content =
    maxChars !== undefined && record.content.length > maxChars
      ? `${record.content.slice(0, maxChars)}\n[… ${record.content.length - maxChars} more chars; /context show ${record.id} for all of it]`
      : record.content;
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
    const block = retrievedBlock(record, Math.min(room, record.content.length));
    chosen.push(record);
    blocks.push(block);
    chars += block.length;
  }
  return { records: chosen, blocks, chars };
}
