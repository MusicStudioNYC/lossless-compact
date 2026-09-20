/**
 * What can happen to one unit of context. Replaces the baseline's
 * keep / drop_result / drop_call trichotomy with an explicit taxonomy; every
 * action except the first two moves the exact original into the archive, so
 * nothing is unrecoverable.
 */
export type ContextAction =
  /** Verbatim, and no policy may evict it (constraints, current request, pinned by user). */
  | 'PIN_VERBATIM'
  /** Verbatim for now; a later pass may reconsider. */
  | 'KEEP_VERBATIM'
  /** Head (and tail) kept in place, the full text archived. */
  | 'KEEP_HEAD_TAIL'
  /** Durable facts extracted into memory, the full text archived. */
  | 'EXTRACT_MEMORY_AND_ARCHIVE'
  /** Removed from the active window, retrievable from the archive. */
  | 'ARCHIVE_ONLY'
  /** Replaced in place by a one-line stub naming the archive record. */
  | 'REPLACE_WITH_REFERENCE'
  /** Archived together with a recipe to reproduce it (tool + input + freshness). */
  | 'RERUN_ON_DEMAND'
  /** Duplicate of something retained; archived for provenance, no stub. */
  | 'DROP_REDUNDANT';

export const CONTEXT_ACTIONS: readonly ContextAction[] = [
  'PIN_VERBATIM',
  'KEEP_VERBATIM',
  'KEEP_HEAD_TAIL',
  'EXTRACT_MEMORY_AND_ARCHIVE',
  'ARCHIVE_ONLY',
  'REPLACE_WITH_REFERENCE',
  'RERUN_ON_DEMAND',
  'DROP_REDUNDANT',
];

/** Actions that leave the unit verbatim in the active window. */
export function keepsVerbatim(action: ContextAction): boolean {
  return action === 'PIN_VERBATIM' || action === 'KEEP_VERBATIM';
}

/** Actions that remove some or all of the unit from the active window. */
export function evicts(action: ContextAction): boolean {
  return !keepsVerbatim(action);
}

/**
 * The classifier's view of one unit. Not every classifier fills every field;
 * `keepCall` / `keepResult` are the baseline Jev questions and always present
 * when a classifier ran. Values are probabilities in [0, 1].
 */
export interface ClassifierScores {
  keepCall: number;
  keepResult: number;
  currentRelevance?: number;
  futureRelevance?: number;
  constraintImportance?: number;
  exactnessRequired?: number;
  superseded?: number;
  redundant?: number;
  /** The classifier's own confidence in this row, when it reports one. */
  confidence?: number;
}

/**
 * Why a decision came out the way it did, one entry per contributing rule or
 * signal; shown verbatim by `/lossless why`.
 */
export interface DecisionReason {
  /** Machine-readable, e.g. `explicit_constraint`, `recent`, `dependency`, `jev_result`. */
  code: string;
  /** Human-readable sentence. */
  detail: string;
  /** Ids of other events this reason refers to (the duplicate, the dependant …). */
  refs?: string[];
}

/** The unit a decision is about: a paired tool interaction or a single text event. */
export type DecisionUnit = 'tool_interaction' | 'text';

export interface ActionDecision {
  /** For a tool interaction, the tool_use event id; for text, the text event id. */
  eventId: string;
  /** For a tool interaction, the tool_result event id (when the result exists). */
  resultId?: string;
  unit: DecisionUnit;
  toolName?: string;
  action: ContextAction;
  scores?: ClassifierScores;
  reasons: DecisionReason[];
  /** Names of rules that forbade eviction, when any did. */
  protectedBy: string[];
  /** Overall confidence in the action in [0, 1]; low confidence keeps. */
  confidence: number;
  /** Where the evicted content went, filled in once it is archived. */
  archiveIds?: string[];
}

/** Maps the baseline's per-call action onto the taxonomy. */
export function fromBaselineAction(action: 'keep' | 'drop_result' | 'drop_call', pinned: boolean): ContextAction {
  if (action === 'keep') return pinned ? 'PIN_VERBATIM' : 'KEEP_VERBATIM';
  if (action === 'drop_result') return 'KEEP_HEAD_TAIL';
  return 'ARCHIVE_ONLY';
}

/** Maps a taxonomy action onto the baseline's rebuild behaviour. */
export function toBaselineAction(action: ContextAction): 'keep' | 'drop_result' | 'drop_call' {
  switch (action) {
    case 'PIN_VERBATIM':
    case 'KEEP_VERBATIM':
      return 'keep';
    case 'KEEP_HEAD_TAIL':
    case 'REPLACE_WITH_REFERENCE':
    case 'RERUN_ON_DEMAND':
      return 'drop_result';
    case 'EXTRACT_MEMORY_AND_ARCHIVE':
    case 'ARCHIVE_ONLY':
    case 'DROP_REDUNDANT':
      return 'drop_call';
  }
}
