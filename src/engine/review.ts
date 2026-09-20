import type { Classifier, ClassifierRun } from '../classifiers/types.js';
import type { ClassifierScores } from '../core/actions.js';
import { sketchResult } from '../core/sketch.js';
import { collectToolCalls, estimateTokens } from '../state.js';
import type { CallDecision, Message } from '../types.js';

/**
 * The second opinion behind upstream #53. When a classifier keeps none of
 * the results it scored, that is either a miscalibrated classifier (wrong
 * wording, wrong threshold) or a stretch of the conversation whose tool
 * output really was all disposable. Nothing in the scores tells the two
 * apart, so the hook asks a model that can see the conversation — and, when
 * no model can answer, the user. This module builds what gets asked, parses
 * the answer, and turns "keep these" into a classifier the optimizer can be
 * re-run with, without another network round.
 */

export interface ReviewCandidate {
  /** The classifier's call id (`t3`). */
  id: string;
  tool: string;
  /** `inputSummary`-style one-liner of the call's input. */
  about: string;
  tokens: number;
  keepCall: number;
  keepResult: number;
  sketch: string;
}

export type ReviewVerdict = {
  verdict: 'drop_all' | 'keep_some' | 'unsure';
  /** Candidate ids to keep verbatim; only meaningful with `keep_some`. */
  keep: string[];
  reason: string;
};

function about(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      const flat = value.replace(/\s+/g, ' ');
      const head = `${key}=${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
      const offset = input['offset'];
      return typeof offset === 'number' && offset > 1 ? `${head} offset=${offset}` : head;
    }
  }
  return '';
}

/** The scored interactions a run decided to drop, as the reviewer sees them, in transcript order. */
export function reviewCandidates(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  preserveRecentMessages: number,
): ReviewCandidate[] {
  const calls = new Map(collectToolCalls(messages, preserveRecentMessages).map((call) => [call.id, call]));
  const out: ReviewCandidate[] = [];
  for (const decision of decisions) {
    if (decision.action === 'keep') continue;
    const call = calls.get(decision.id);
    if (!call) continue;
    const result = messages[call.resultIndex]?.toolResults?.find((r) => r.tool_use_id === call.tool_use_id);
    const text = result?.text ?? '';
    out.push({
      id: call.id,
      tool: call.tool,
      about: about(call.input),
      tokens: estimateTokens(text),
      keepCall: decision.keepCall,
      keepResult: decision.keepResult,
      sketch: sketchResult(call.tool, call.input, text, call.isError, { maxChars: 240 }).replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

function candidateLines(candidates: readonly ReviewCandidate[]): string {
  return candidates
    .map(
      (c) =>
        `- ${c.id} · ${c.tool}${c.about ? ` ${c.about}` : ''} · ~${c.tokens.toLocaleString('en-US')} tokens · result score ${c.keepResult.toFixed(2)}${
          c.sketch ? ` · ${c.sketch}` : ''
        }`,
    )
    .join('\n');
}

const ANSWER_FORMAT =
  'Reply with JSON only, no prose: {"verdict":"drop_all"|"keep_some"|"unsure","keep":["t3"],"reason":"<one sentence>"}';

/**
 * The question for a model that can see the conversation (`$.model.fork`):
 * the candidates and the rule for keeping one.
 */
export function reviewQuestion(candidates: readonly ReviewCandidate[], threshold: number): string {
  return [
    `context-os, the compaction plugin, is about to remove every tool result it scored in this conversation: each of the ${candidates.length} below scored under the keep threshold (${threshold}) and nothing later referred to them. Before it does, judge that against what this conversation is doing and what is likely to come next.`,
    'Everything removed stays in an exact archive the assistant can search and restore by id, so keep only a result whose exact content — a value, an error line, a file\'s current text — the next turns will need at hand. "drop_all" when none does; "keep_some" with the ids when a few do; "unsure" only if the list is unreadable.',
    '',
    'Candidates (id · tool · input · size · classifier score · sketch):',
    candidateLines(candidates),
    '',
    ANSWER_FORMAT,
  ].join('\n');
}

/**
 * The same question for a model with no history (`$.model.complete`): the
 * user's side of the conversation, newest last, is quoted first.
 */
export function reviewQuestionWithContext(
  messages: readonly Message[],
  candidates: readonly ReviewCandidate[],
  threshold: number,
  maxContextChars = 6000,
): string {
  const turns: string[] = [];
  for (let i = messages.length - 1; i >= 0 && turns.join('\n').length < maxContextChars; i--) {
    const message = messages[i]!;
    if (message.role !== 'user' || message.text.trim().length === 0) continue;
    const text = message.text.replace(/\s+/g, ' ').trim();
    turns.unshift(`- ${text.length > 600 ? `${text.slice(0, 599)}…` : text}`);
  }
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.text.trim().length > 0);
  return [
    'The user\'s messages in a coding-agent conversation, oldest first (tool output left out):',
    turns.join('\n') || '- (none)',
    lastAssistant ? `\nThe assistant's latest reply: ${lastAssistant.text.replace(/\s+/g, ' ').trim().slice(0, 600)}` : '',
    '',
    reviewQuestion(candidates, threshold),
  ].join('\n');
}

/** Parses a reviewer's reply leniently; `undefined` when it holds no usable verdict. */
export function parseReview(text: string, knownIds: ReadonlySet<string>): ReviewVerdict | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { verdict, keep, reason } = parsed as { verdict?: unknown; keep?: unknown; reason?: unknown };
  if (verdict !== 'drop_all' && verdict !== 'keep_some' && verdict !== 'unsure') return undefined;
  const ids = Array.isArray(keep) ? keep.filter((id): id is string => typeof id === 'string' && knownIds.has(id)) : [];
  const why = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (verdict === 'keep_some' && ids.length === 0) return { verdict: 'unsure', keep: [], reason: why || 'asked to keep some but named none' };
  return { verdict, keep: verdict === 'keep_some' ? ids : [], reason: why };
}

/**
 * A classifier that replays a run's scores from its decisions, with the
 * reviewer's keeps forced to 1: re-running the optimizer with it costs no
 * network and changes nothing but those interactions.
 */
export function classifierWithKeeps(
  decisions: readonly CallDecision[],
  keep: ReadonlySet<string>,
  name = 'reviewed',
): Classifier {
  const scores = new Map<string, ClassifierScores>();
  for (const decision of decisions) {
    if (decision.reason === 'pinned') continue;
    scores.set(decision.id, { keepCall: decision.keepCall, keepResult: decision.keepResult });
  }
  return {
    name,
    async score(candidates): Promise<ClassifierRun> {
      const out = new Map<string, ClassifierScores>();
      const unscored: string[] = [];
      for (const call of candidates) {
        if (keep.has(call.id)) out.set(call.id, { keepCall: 1, keepResult: 1 });
        else {
          const known = scores.get(call.id);
          if (known) out.set(call.id, known);
          else unscored.push(call.id);
        }
      }
      return { scores: out, stats: { requests: 0, stateTokens: 0, stateStage: 'replayed', ms: 0, unscored } };
    },
  };
}
