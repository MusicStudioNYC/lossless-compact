import type { ArchiveRecord } from '../../archive/types.js';
import type { Message } from '../../types.js';
import type { CallLabel, Labels } from './dataset.js';

/**
 * Fidelity and safety scores for one compaction: did every labelled
 * must-keep survive, is every probe still findable, is the transcript still
 * well-formed. These are the numbers the product lives or dies by; token
 * reduction is reported beside them, never alone.
 */
export interface FidelityScores {
  mustKeepTotal: number;
  /** must_keep calls whose tool_use was removed: the dangerous error. */
  mustKeepFalseDrop: number;
  /** must_keep calls whose result was truncated to a stub. */
  mustKeepTruncated: number;
  niceToKeepTotal: number;
  niceToKeepDropped: number;
  safeToDropTotal: number;
  safeToDropKept: number;
  probes: {
    total: number;
    activeRequired: number;
    activeRetained: number;
    recoverableRequired: number;
    recoverable: number;
    missing: string[];
  };
  /** Every tool_result has its tool_use in the same or an earlier message. */
  structureValid: boolean;
  /** Surviving messages appear in their original order. */
  orderPreserved: boolean;
  /** Untouched messages are the same objects; rebuilt ones only gained a marker or a stub. */
  keptVerbatim: boolean;
  /** Ids of labelled calls by outcome, for the report's drill-down. */
  outcomes: Record<string, 'verbatim' | 'truncated' | 'dropped'>;
}

function messageBlob(message: Message): string {
  const inputs = message.toolUses.map((tool) => {
    try {
      return JSON.stringify(tool.input);
    } catch {
      return '';
    }
  });
  const results = (message.toolResults ?? []).map((result) => result.text);
  return [message.text, ...inputs, ...results].join('\n');
}

export function activeText(messages: readonly Message[]): string {
  return messages.map(messageBlob).join('\n');
}

/** How a labelled call came out: its full result still there, a stub, or gone. */
export function callOutcome(
  toolUseId: string,
  input: readonly Message[],
  output: readonly Message[],
): 'verbatim' | 'truncated' | 'dropped' {
  const original = input.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === toolUseId);
  const use = output.flatMap((m) => m.toolUses).find((t) => t.tool_use_id === toolUseId);
  if (!use) return 'dropped';
  const result = output.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === toolUseId);
  if (!original) return 'verbatim';
  if (result && result.text === original.text) return 'verbatim';
  return 'truncated';
}

export function structureValid(output: readonly Message[]): boolean {
  const seen = new Set<string>();
  for (const message of output) {
    for (const tool of message.toolUses) seen.add(tool.tool_use_id);
    for (const result of message.toolResults ?? []) if (!seen.has(result.tool_use_id)) return false;
  }
  return true;
}

/** Maps each output message to the input index it came from, by identity or by its tool ids / text. */
function sourceIndex(
  message: Message,
  input: readonly Message[],
  byIdentity: Map<Message, number>,
  from = 0,
): number {
  const own = byIdentity.get(message);
  if (own !== undefined) return own;
  const ids = [...message.toolUses.map((t) => t.tool_use_id), ...(message.toolResults ?? []).map((r) => r.tool_use_id)];
  for (let i = Math.max(0, from); i < input.length; i++) {
    const candidate = input[i]!;
    const candidateIds = new Set([
      ...candidate.toolUses.map((t) => t.tool_use_id),
      ...(candidate.toolResults ?? []).map((r) => r.tool_use_id),
    ]);
    if (ids.length > 0 && ids.every((id) => candidateIds.has(id))) return i;
    if (ids.length === 0 && candidate.role === message.role && message.text.startsWith(candidate.text) && candidate.text.length > 0) {
      return i;
    }
  }
  return -1;
}

export function orderAndVerbatim(input: readonly Message[], output: readonly Message[]): { orderPreserved: boolean; keptVerbatim: boolean } {
  const byIdentity = new Map(input.map((message, index) => [message, index]));
  let last = -1;
  let orderPreserved = true;
  let keptVerbatim = true;
  for (const message of output) {
    const index = sourceIndex(message, input, byIdentity, last + 1);
    if (index < 0) {
      keptVerbatim = false;
      continue;
    }
    if (index < last) orderPreserved = false;
    last = index;
    if (byIdentity.has(message)) continue;
    const original = input[index]!;
    if (message.role !== original.role || !message.text.startsWith(original.text)) keptVerbatim = false;
    for (const result of message.toolResults ?? []) {
      const before = original.toolResults?.find((r) => r.tool_use_id === result.tool_use_id);
      if (!before) {
        keptVerbatim = false;
        continue;
      }
      // A stub keeps a head of the original; anything else is a rewrite.
      const head = result.text.split('\n[context-os')[0]!.split('\n[fast-jev-compaction')[0]!;
      if (!before.text.startsWith(head.replace(/\n$/, ''))) keptVerbatim = false;
    }
  }
  return { orderPreserved, keptVerbatim };
}

export function scoreFidelity(
  input: readonly Message[],
  output: readonly Message[],
  labels: Labels | undefined,
  archived: readonly ArchiveRecord[],
): FidelityScores {
  const scores: FidelityScores = {
    mustKeepTotal: 0,
    mustKeepFalseDrop: 0,
    mustKeepTruncated: 0,
    niceToKeepTotal: 0,
    niceToKeepDropped: 0,
    safeToDropTotal: 0,
    safeToDropKept: 0,
    probes: { total: 0, activeRequired: 0, activeRetained: 0, recoverableRequired: 0, recoverable: 0, missing: [] },
    structureValid: structureValid(output),
    ...orderAndVerbatim(input, output),
    outcomes: {},
  };
  if (!labels) return scores;
  for (const [id, label] of Object.entries(labels.calls) as [string, CallLabel][]) {
    const outcome = callOutcome(id, input, output);
    scores.outcomes[id] = outcome;
    if (label === 'must_keep') {
      scores.mustKeepTotal++;
      if (outcome === 'dropped') scores.mustKeepFalseDrop++;
      else if (outcome === 'truncated') scores.mustKeepTruncated++;
    } else if (label === 'nice_to_keep') {
      scores.niceToKeepTotal++;
      if (outcome === 'dropped') scores.niceToKeepDropped++;
    } else if (label === 'safe_to_drop') {
      scores.safeToDropTotal++;
      if (outcome === 'verbatim') scores.safeToDropKept++;
    }
  }
  const active = activeText(output);
  const archive = archived.map((record) => record.content).join('\n');
  for (const probe of labels.probes) {
    scores.probes.total++;
    const inActive = active.includes(probe.text);
    if (probe.where === 'active') {
      scores.probes.activeRequired++;
      if (inActive) scores.probes.activeRetained++;
      else scores.probes.missing.push(probe.id);
    } else {
      scores.probes.recoverableRequired++;
      if (inActive || archive.includes(probe.text)) scores.probes.recoverable++;
      else scores.probes.missing.push(probe.id);
    }
  }
  return scores;
}
