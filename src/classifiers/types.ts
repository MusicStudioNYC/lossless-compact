import type { ClassifierScores } from '../core/actions.js';
import type { Ledger } from '../core/events.js';
import type { Message, ResolvedCompactOptions, ToolCall } from '../types.js';

/** What a classifier is shown besides the candidates. */
export interface ClassifierContext {
  messages: readonly Message[];
  ledger: Ledger;
  /** Every paired tool call, pinned ones included, in transcript order. */
  calls: readonly ToolCall[];
  options: ResolvedCompactOptions;
  /** Per call id (`t1`, …): a short sketch of the result to show instead of a bare size note. */
  sketches?: ReadonlyMap<string, string>;
}

export interface ClassifierRun {
  /** Scores per call id (`t1`, …) for the candidates it was asked about. */
  scores: Map<string, ClassifierScores>;
  /** Diagnostics for the report. */
  stats: {
    requests: number;
    stateTokens: number;
    stateStage: string;
    ms: number;
    /** Calls the classifier could not score (a failed batch); the policy keeps them. */
    unscored: string[];
  };
}

/**
 * Scores the non-pinned tool interactions. A classifier may be remote (Jev),
 * local (heuristics), or a recording of an earlier run (replay). It must not
 * throw for a partial failure; it reports what it could not score instead and
 * throws only when it cannot run at all.
 */
export interface Classifier {
  readonly name: string;
  /**
   * The keep threshold this classifier's scores are calibrated for, used when
   * the caller sets none. Jev's `noul` puts "unsure" at 0.5, so its threshold
   * sits well below that; the heuristic centres on 0.5.
   */
  readonly defaultThreshold?: number;
  score(candidates: readonly ToolCall[], context: ClassifierContext): Promise<ClassifierRun>;
}
