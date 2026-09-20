import { batchCalls, questionsFor as upstreamQuestionsFor } from '../compact.js';
import { noulAnswer } from '../request.js';
import { fitState } from '../state.js';
import type { ClassifierScores } from '../core/actions.js';
import type { JevAsker, JevQuestions, ToolCall } from '../types.js';
import type { Classifier, ClassifierContext, ClassifierRun } from './types.js';

/**
 * How the two questions are worded. `upstream` is the baseline's "must stay
 * verbatim / re-running would not do", which measures irrecoverability and
 * scores nearly every result below 0.3 on real sessions (upstream issues #26,
 * #52). `useful` asks whether keeping is useful for the remaining work and
 * spells out the yes/no criteria (upstream PRs #55, #61).
 */
export type JevQuestionStyle = 'upstream' | 'useful';

/**
 * From the 2026-09-20 cassette sweep against jev-1.13.0 (docs/evals.md): with
 * the `useful` wording and sketches, every labelled must-keep survives up to
 * 0.45 and the first false drop appears at 0.50; on 12 real sessions the
 * score mass sits at 0.3–0.4, so 0.15 (upstream PR #55's suggestion) removes
 * only 5 % there. 0.35 keeps 0.15 of headroom below the cliff and removes
 * ~52 % of real-session tokens.
 */
export const JEV_DEFAULT_THRESHOLD = 0.35;

/** The two `noul` questions about one call in the `useful` wording. */
export function usefulQuestionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Keeping tool call ${call.id} (${call.tool}) in the history is useful for the assistant's remaining work on the goal: knowing this call was made, with its input, still matters`,
      criteria: {
        true: 'The call records something the assistant may need again: a file it changed, a command whose effect matters, a search it should not repeat, a step of the current task.',
        false: 'The call was exploratory or has been superseded; nothing later depends on knowing it happened.',
      },
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `Keeping the full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) verbatim in the history is useful for the assistant's remaining work on the goal`,
      criteria: {
        true: 'The output holds details the assistant may still need exactly — an error, file contents it is still working with, a fact the current task depends on — that would be lost or costly to reproduce.',
        false: 'The output has served its purpose, is reproducible by re-running the tool, or is superseded by a later result.',
      },
    },
  };
}

/** A `noul` answer that is a probability; anything outside [0, 1] is malformed (upstream #29). */
function probability(answers: Parameters<typeof noulAnswer>[0], name: string): number {
  const value = noulAnswer(answers, name);
  if (value < 0 || value > 1) throw new Error(`Invalid Jev answer for ${name}: ${value} is not a probability`);
  return value;
}

export interface JevClassifierOptions {
  /** Question wording. Default `useful`. */
  questionStyle?: JevQuestionStyle;
  /**
   * When a batch fails, score the others and report the failed calls as
   * unscored (the policy keeps them) instead of failing the whole run.
   * Default true.
   */
  salvagePartialBatches?: boolean;
  /** Retries per failed batch before giving it up. Default 1. */
  retries?: number;
  /** Batches in flight at once (upstream #33: everything at once trips rate limits). Default 4. */
  concurrency?: number;
}

/** Runs `task` over `items` with at most `limit` in flight, preserving order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * The baseline classifier: the upstream two-question Jev protocol (keep the
 * call? keep the result verbatim?) over the fitted whole-conversation state,
 * plus result sketches and partial-batch salvage.
 */
export class JevClassifier implements Classifier {
  readonly name: string;
  readonly defaultThreshold = JEV_DEFAULT_THRESHOLD;
  private readonly salvage: boolean;
  private readonly retries: number;
  private readonly concurrency: number;
  private readonly questionsFor: (call: ToolCall) => JevQuestions;

  constructor(
    private readonly asker: JevAsker,
    options: JevClassifierOptions = {},
  ) {
    const style = options.questionStyle ?? 'useful';
    this.name = style === 'upstream' ? 'jev-upstream' : 'jev';
    this.questionsFor = style === 'upstream' ? upstreamQuestionsFor : usefulQuestionsFor;
    this.salvage = options.salvagePartialBatches ?? true;
    this.retries = Math.max(0, options.retries ?? 1);
    this.concurrency = Math.max(1, options.concurrency ?? 4);
  }

  async score(candidates: readonly ToolCall[], context: ClassifierContext): Promise<ClassifierRun> {
    const started = Date.now();
    const scores = new Map<string, ClassifierScores>();
    const unscored: string[] = [];
    if (candidates.length === 0) {
      return { scores, stats: { requests: 0, stateTokens: 0, stateStage: '', ms: 0, unscored } };
    }
    const fitted = fitState(context.messages, context.calls, context.options, context.sketches);
    const batches = batchCalls(candidates, fitted.tokens, context.options, this.questionsFor);
    let requests = 0;
    const outcomes = await mapConcurrent(batches, this.concurrency, async (batch) => {
        let lastError: unknown;
        for (let attempt = 0; attempt <= this.retries; attempt++) {
          requests++;
          try {
            return { batch, answers: await this.askBatch(fitted.state, batch) };
          } catch (error) {
            lastError = error;
          }
        }
        if (!this.salvage) throw lastError;
        return { batch, answers: undefined, error: lastError };
      });
    for (const outcome of outcomes) {
      if (!outcome.answers) {
        for (const call of outcome.batch) unscored.push(call.id);
        continue;
      }
      for (const [id, answer] of outcome.answers) scores.set(id, answer);
    }
    if (scores.size === 0 && unscored.length > 0) {
      const first = outcomes.find((outcome) => 'error' in outcome && outcome.error)?.error;
      throw first instanceof Error ? first : new Error('every Jev batch failed');
    }
    return {
      scores,
      stats: {
        requests,
        stateTokens: fitted.tokens,
        stateStage: fitted.stage,
        ms: Date.now() - started,
        unscored,
      },
    };
  }

  private async askBatch(
    state: Parameters<JevAsker['ask']>[0],
    batch: readonly ToolCall[],
  ): Promise<Map<string, ClassifierScores>> {
    const questions: JevQuestions = Object.assign({}, ...batch.map(this.questionsFor));
    const { answers } = await this.asker.ask(state, questions);
    return new Map(
      batch.map((call) => [
        call.id,
        {
          keepCall: probability(answers, `call_${call.id}`),
          keepResult: probability(answers, `result_${call.id}`),
        },
      ]),
    );
  }
}
