import type { On, PluginOptions, Register, SessionCompactResult, SessionMessage, TurnCompleteInput } from 'claude-code';

import { FileArchive, type TextFs } from '../src/archive/file-store.js';
import type { ArchiveRecord, ArchiveStore } from '../src/archive/types.js';
import type { ActionDecision } from '../src/core/actions.js';
import { RulesetClassifier } from '../src/classifiers/ruleset.js';
import { JevClassifier, type JevQuestionStyle } from '../src/classifiers/jev.js';
import type { Classifier } from '../src/classifiers/types.js';
import { reductionRatio } from '../src/compact.js';
import { buildLedger, eventTokens } from '../src/core/events.js';
import { findConstraints } from '../src/core/rules.js';
import { optimize, type OptimizeReport, type OptimizeResult } from '../src/engine/optimize.js';
import { REHYDRATION_PREFACE, rehydrateForPrompt } from '../src/engine/rehydrate.js';
import {
  classifierWithKeeps,
  parseReview,
  reviewCandidates,
  reviewQuestion,
  reviewQuestionWithContext,
  type ReviewVerdict,
} from '../src/engine/review.js';
import type { Message } from '../src/types.js';
import {
  decisionLogLines,
  jevAsker,
  resolveHookConfig,
  summarize,
  toSessionMessages,
  type HookConfig,
  type HookFetch,
} from './fast-jev.js';

/**
 * The Claude Code adapter for the context optimizer. Compaction goes through
 * `optimize` (rules, classifier, archive); the archive lives under the
 * project in `.lossless-compact/`; `/lossless` inspects and restores it.
 */

export type ClassifierChoice = 'auto' | 'jev' | 'ruleset';

export type LosslessCompactConfig = HookConfig & {
  classifier: ClassifierChoice;
  questionStyle: JevQuestionStyle;
  archiveDir: string;
  safetyMargin: number;
  sketches: boolean;
  redact: boolean;
  markRemovedCalls: boolean;
  /** Retrieve relevant archived content into each prompt automatically. */
  autoRetrieve: boolean;
  /** Characters of retrieved content per prompt. */
  retrieveBudgetChars: number;
  /**
   * Compact once the live context holds this many tokens (0 = off). A count,
   * not a share of the model's window: "big" does not change when the window
   * does. Default 120000.
   */
  compactAtTokens: number;
  /** Write the exact pre-compaction transcript under `.lossless-compact/snapshots/`. */
  snapshot: boolean;
  /** Insert a note into the compacted transcript saying where the full history is. */
  noteRemoved: boolean;
};

const DEFAULTS = {
  classifier: 'auto' as ClassifierChoice,
  questionStyle: 'useful' as JevQuestionStyle,
  archiveDir: '.lossless-compact',
  safetyMargin: 0,
  sketches: true,
  redact: true,
  markRemovedCalls: true,
  autoRetrieve: true,
  retrieveBudgetChars: 6000,
  compactAtTokens: 120_000,
  /** The percent trigger is off unless set; `compactAtTokens` is the default trigger. */
  compactAtPercent: 0,
  snapshot: true,
  noteRemoved: true,
};

function optionBoolean(options: PluginOptions, key: string, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function resolveLosslessCompactConfig(options: PluginOptions): LosslessCompactConfig {
  const base = resolveHookConfig(options);
  const classifier = options['classifier'];
  const style = options['questionStyle'];
  const dir = options['archiveDir'];
  const margin = options['safetyMargin'];
  const config: LosslessCompactConfig = {
    ...base,
    classifier:
      classifier === 'jev' || classifier === 'ruleset' || classifier === 'auto'
        ? classifier
        : classifier === 'heuristic' // the ruleset's name up to 0.5.0
          ? 'ruleset'
          : DEFAULTS.classifier,
    questionStyle: style === 'upstream' || style === 'useful' ? style : DEFAULTS.questionStyle,
    archiveDir: typeof dir === 'string' && dir.length > 0 ? dir : DEFAULTS.archiveDir,
    safetyMargin: typeof margin === 'number' && Number.isFinite(margin) ? margin : DEFAULTS.safetyMargin,
    sketches: optionBoolean(options, 'sketches', DEFAULTS.sketches),
    redact: optionBoolean(options, 'redact', DEFAULTS.redact),
    markRemovedCalls: optionBoolean(options, 'markRemovedCalls', DEFAULTS.markRemovedCalls),
    autoRetrieve: optionBoolean(options, 'autoRetrieve', DEFAULTS.autoRetrieve),
    retrieveBudgetChars:
      typeof options['retrieveBudgetChars'] === 'number' && Number.isFinite(options['retrieveBudgetChars'])
        ? Math.max(0, Math.min(30_000, options['retrieveBudgetChars']))
        : DEFAULTS.retrieveBudgetChars,
    snapshot: optionBoolean(options, 'snapshot', DEFAULTS.snapshot),
    noteRemoved: optionBoolean(options, 'noteRemoved', DEFAULTS.noteRemoved),
    compactAtTokens:
      typeof options['compactAtTokens'] === 'number' && Number.isFinite(options['compactAtTokens'])
        ? Math.max(0, options['compactAtTokens'])
        : DEFAULTS.compactAtTokens,
    compactAtPercent:
      typeof options['compactAtPercent'] === 'number' && Number.isFinite(options['compactAtPercent'])
        ? Math.max(0, options['compactAtPercent'])
        : DEFAULTS.compactAtPercent,
  };
  // Only an explicit threshold overrides the classifier's own calibration.
  if (typeof options['keepThreshold'] !== 'number') delete config.keepThreshold;
  return config;
}

/**
 * Whether the live context is big enough to compact: by token count (the
 * default trigger) or, when enabled, by share of the window. When the host
 * reports no absolute count, it is derived from the percent and the window.
 */
export function shouldCompact(
  context: { tokens?: number; percent?: number; window?: number },
  config: Pick<LosslessCompactConfig, 'compactAtTokens' | 'compactAtPercent'>,
): boolean {
  const percent = context.percent ?? 0;
  const tokens = contextTokens(context);
  if (config.compactAtTokens > 0 && tokens !== undefined && tokens >= config.compactAtTokens) return true;
  if (config.compactAtPercent > 0 && percent >= config.compactAtPercent) return true;
  return false;
}

/** The live context in tokens: the host's count, or its percent of the window. */
export function contextTokens(context: { tokens?: number; percent?: number; window?: number }): number | undefined {
  return context.tokens ?? (context.window && context.percent !== undefined ? (context.percent / 100) * context.window : undefined);
}

/**
 * When the auto-compaction fires. A crossing of the threshold fires once: a
 * compaction that was skipped or fell back leaves the context where it was,
 * and firing again after every turn would loop. Re-armed once the context has
 * dropped below the threshold (the compaction worked) or grown by a quarter
 * since the attempt (there is new material to remove).
 */
export class AutoCompactTrigger {
  private attemptedAt: number | undefined;

  constructor(private readonly config: Pick<LosslessCompactConfig, 'compactAtTokens' | 'compactAtPercent'>) {}

  due(context: { tokens?: number; percent?: number; window?: number }): boolean {
    if (!shouldCompact(context, this.config)) {
      this.attemptedAt = undefined;
      return false;
    }
    const tokens = contextTokens(context) ?? 0;
    if (this.attemptedAt !== undefined && tokens < this.attemptedAt * 1.25) return false;
    this.attemptedAt = tokens;
    return true;
  }
}

/** The engine's `$.fs` as the archive's file system. */
export function engineFs($: {
  fs: {
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
    list: (path?: string) => Promise<readonly { name: string }[]>;
  };
}): TextFs {
  return {
    read: (path) => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: (path) => $.fs.exists(path),
    async list(dir) {
      if (!(await $.fs.exists(dir))) return [];
      return (await $.fs.list(dir)).map((entry) => entry.name);
    },
  };
}

/** Resolves `auto` to the classifier this session can actually use. */
export function resolvedClassifierName(
  config: Pick<LosslessCompactConfig, 'classifier'>,
  apiKey: string | undefined,
): 'jev' | 'ruleset' {
  return config.classifier === 'auto' ? (apiKey ? 'jev' : 'ruleset') : config.classifier;
}

/**
 * One line for a compaction that ran on the ruleset only because no TypeSafe
 * key was found (`classifier: auto`); a chosen `ruleset` gets none. The
 * figures are docs/evals.md's: must-keep results left in place verbatim, 3 of
 * 6 against Jev's 6 of 6, every probe recoverable either way.
 */
export function noKeyNotice(
  config: Pick<LosslessCompactConfig, 'classifier'>,
  apiKey: string | undefined,
): string | undefined {
  if (config.classifier !== 'auto' || apiKey) return undefined;
  return (
    'No TypeSafe key found (TYPESAFE_API_KEY, or the plugin\'s apiKey option), so compaction runs the local ruleset: ' +
    'same archive, everything restorable, about half as good as Jev at keeping must-keep results in place verbatim ' +
    '(3 of 6 vs 6 of 6 on the eval). Add a key to switch.'
  );
}

/** Picks the classifier from the config and whether a key is at hand. */
export function chooseClassifier(
  config: LosslessCompactConfig,
  fetchFn: HookFetch,
  apiKey: string | undefined,
): Classifier {
  if (resolvedClassifierName(config, apiKey) === 'jev') {
    if (!apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    return new JevClassifier(jevAsker(fetchFn, apiKey, config.model), {
      questionStyle: config.questionStyle,
    });
  }
  return new RulesetClassifier();
}

export interface SessionOptimization {
  result: OptimizeResult;
  messages: SessionMessage[];
}

/** Runs the optimizer over a session transcript; throws when the classifier cannot run. */
export async function optimizeSession(
  messages: readonly SessionMessage[],
  config: LosslessCompactConfig,
  classifier: Classifier,
  archive: ArchiveStore,
  sessionId: string,
): Promise<SessionOptimization> {
  const result = await optimize(messages, {
    ...config,
    sessionId,
    archive,
    classifier,
    policy: { safetyMargin: config.safetyMargin },
    sketches: config.sketches,
    redact: config.redact,
    markRemovedCalls: config.markRemovedCalls,
  });
  return { result, messages: toSessionMessages(messages, result.messages) };
}

/** One line per non-trivial protection or action count, for the log. */
export function reportLines(report: OptimizeReport): string[] {
  const actions = Object.entries(report.actions)
    .filter(([, n]) => n > 0)
    .map(([action, n]) => `${action}=${n}`)
    .join(' ');
  const protections = Object.entries(report.protections)
    .map(([rule, n]) => `${rule}=${n}`)
    .join(' ');
  return [
    `lossless-compact ${report.compactionId}: ${report.classifier}; ~${report.tokens.before}→${report.tokens.after} tokens; archived ${report.tokens.archived} tokens in ${report.actions.ARCHIVE_ONLY + report.actions.KEEP_HEAD_TAIL + report.actions.RERUN_ON_DEMAND + report.actions.DROP_REDUNDANT} units`,
    `actions: ${actions || '(none)'}`,
    `protected: ${protections || '(none)'}; constraints ${report.constraints}; duplicates ${report.duplicates}; unscored ${report.unscored}; secrets redacted ${report.redactedSecrets}`,
  ];
}

/* ------------------------------------------------------------- snapshot & note */

const SNAPSHOT_MAX_CHARS = 3.5 * 1024 * 1024;

/** A session message without its engine handle, as plain library data. */
function plainMessage(message: SessionMessage): Message {
  const copy: Message = {
    role: message.role,
    text: message.text,
    toolUses: message.toolUses.map((tool) => {
      const use: Message['toolUses'][number] = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input };
      if (tool.text !== undefined) use.text = tool.text;
      if (tool.isError) use.isError = true;
      return use;
    }),
  };
  if (message.toolResults && message.toolResults.length > 0) {
    copy.toolResults = message.toolResults.map((result) => ({
      tool_use_id: result.tool_use_id,
      text: result.text,
      isError: result.isError,
    }));
  }
  return copy;
}

/**
 * Writes the exact transcript that was about to be compacted:
 * `<root>/snapshots/<session>/<compaction>.json`, split into
 * `<compaction>-<n>.json` parts when it would exceed the host's 4 MiB write
 * cap. Returns the paths written, the manifest first.
 */
export async function writeSnapshot(
  fs: TextFs,
  root: string,
  sessionId: string,
  compactionId: string,
  messages: readonly SessionMessage[],
  at: string,
): Promise<string[]> {
  const dir = `${root.replace(/[\\/]+$/, '')}/snapshots/${encodeURIComponent(sessionId)}`;
  const serialised = messages.map((message) => JSON.stringify(plainMessage(message)));
  const parts: string[][] = [[]];
  let chars = 0;
  for (const item of serialised) {
    if (parts[parts.length - 1]!.length > 0 && chars + item.length + 2 > SNAPSHOT_MAX_CHARS) {
      parts.push([]);
      chars = 0;
    }
    parts[parts.length - 1]!.push(item);
    chars += item.length + 2;
  }
  const manifest = `${dir}/${compactionId}.json`;
  if (parts.length === 1) {
    await fs.write(
      manifest,
      `{"version":1,"sessionId":${JSON.stringify(sessionId)},"compactionId":${JSON.stringify(compactionId)},"at":${JSON.stringify(at)},"messages":[${parts[0]!.join(',')}]}`,
    );
    return [manifest];
  }
  const written: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const path = `${dir}/${compactionId}-${i + 1}.json`;
    await fs.write(path, `{"version":1,"part":${i + 1},"of":${parts.length},"messages":[${parts[i]!.join(',')}]}`);
    written.push(path);
  }
  await fs.write(
    manifest,
    JSON.stringify({
      version: 1,
      sessionId,
      compactionId,
      at,
      messages: messages.length,
      parts: written.map((p) => p.slice(dir.length + 1)),
    }),
  );
  return [manifest, ...written];
}

/** Where Claude Code keeps this session's raw log, if it can be found from the sandbox. */
export async function rawSessionLogPath(
  fs: Pick<TextFs, 'exists'>,
  home: string | undefined,
  cwd: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!home) return undefined;
  const base = `${home.replace(/[\\/]+$/, '')}/.claude/projects`;
  const encoded = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, '-');
  const candidates = new Set(
    [cwd, cwd.toLowerCase(), cwd.replace(/^([A-Za-z]):/, (m) => m.toLowerCase())].map(encoded),
  );
  for (const name of candidates) {
    const path = `${base}/${name}/${sessionId}.jsonl`;
    try {
      if (await fs.exists(path)) return path;
    } catch {
      // not findable from here
    }
  }
  return undefined;
}

/**
 * The one message inserted into a compacted transcript: what was removed and
 * exactly where the full history is. Nothing in it claims the removed
 * content is still present.
 */
export function compactionNote(details: {
  at: string;
  compactionId: string;
  report: OptimizeReport;
  snapshotPath?: string;
  archiveDir: string;
  rawLogPath?: string;
  /** True when Claude Code's built-in summary replaced the transcript after all (a fallback). */
  summarized?: boolean;
  /** `noKeyNotice`: why the ruleset ran, when it ran for want of a key. */
  classifierNote?: string;
}): string {
  const { actions, tokens, messages, classifier, ms } = details.report;
  const removed = actions.ARCHIVE_ONLY + actions.KEEP_HEAD_TAIL + actions.RERUN_ON_DEMAND + actions.DROP_REDUNDANT;
  const units = `${removed} tool interaction${removed === 1 ? '' : 's'} (~${tokens.archived.toLocaleString('en-US')} tokens)`;
  // The toast never renders in the VS Code extension (the host runs it as a headless
  // session), so the note is the one place the user can see what ran and how it went.
  const fewer = tokens.before > 0 ? Math.round((1 - tokens.after / tokens.before) * 100) : 0;
  const outcome = details.summarized
    ? `Classifier: ${classifier} · ${ms} ms (its ~${tokens.before.toLocaleString('en-US')}→${tokens.after.toLocaleString('en-US')} token result was replaced by the summary).`
    : `Classifier: ${classifier} · ~${tokens.before.toLocaleString('en-US')}→${tokens.after.toLocaleString('en-US')} tokens (${fewer}% fewer) · ${messages.before}→${messages.after} messages · ${ms} ms.`;
  const lines = [
    details.summarized
      ? `[lossless-compact] This conversation was compacted at ${details.at} by Claude Code's built-in summary; the message above is a paraphrase, not the original text. Before the summary was written, lossless-compact (compaction ${details.compactionId}) archived ${units} verbatim${
          details.snapshotPath ? ' and saved the exact pre-compaction transcript' : ''
        }. If you need anything the summary lost, the full history is on disk:`
      : `[lossless-compact] This conversation was compacted at ${details.at} (compaction ${details.compactionId}): ${units} were removed from the active context and archived verbatim. Nothing was summarized or paraphrased; user and assistant messages are untouched. If you need any removed message, the full history is on disk:`,
    outcome,
  ];
  if (details.classifierNote) lines.push(details.classifierNote);
  if (details.snapshotPath) {
    lines.push(`- Exact pre-compaction transcript (JSON array of messages): ${details.snapshotPath} — grep it, or read a slice.`);
  }
  lines.push(
    details.summarized
      ? `- Every archived item, with the reason it was removed: ${details.archiveDir}/archive/ — grep for a file path, an error line or a value there to find the record and its id (e_…).`
      : `- Every archived item, with the reason it was removed: ${details.archiveDir}/archive/ — a stub in this transcript names its id (e_…); grep for that id under ${details.archiveDir}/archive to find the record.`,
  );
  if (details.rawLogPath) {
    lines.push(`- Raw Claude Code session log, never modified by compaction: ${details.rawLogPath}`);
  }
  lines.push('The user can also run /lossless why <id>, /lossless show <id> or /lossless restore <id>.');
  return lines.join('\n');
}

/** The compacted transcript with the note inserted after the pinned first message. */
export function withCompactionNote(messages: readonly Message[], note: string): Message[] {
  const noteMessage: Message = { role: 'user', text: note, toolUses: [] };
  if (messages.length === 0) return [noteMessage];
  return [messages[0]!, noteMessage, ...messages.slice(1)];
}

/**
 * The compacted transcript with every engine handle removed. A message handed
 * back with its handle "stands as the engine has it" — its own record, with
 * its original parent link — and on `--resume` Claude Code 2.1.278 rebuilds
 * the conversation by walking those links from the newest message: the first
 * kept message after an evicted one leads straight back into the pre-boundary
 * log, and the whole compaction is undone (seen live: the second /compact of
 * a resumed session saw every archived read again, twice). Handle-less
 * messages are built afresh by the host and chained after the boundary. The
 * price is the kept assistant messages' thinking blocks, which a summary loses
 * too.
 */
export function rechain(messages: readonly SessionMessage[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const message of messages) {
    const { handle: _handle, ...rest } = message;
    // A thinking-only assistant message is nothing without its handle; the
    // host would store it as "(no content)".
    if (rest.text.trim().length === 0 && rest.toolUses.length === 0 && (rest.toolResults ?? []).length === 0) continue;
    out.push(rest);
  }
  return out;
}

/** The same insertion over the host's own compacted transcript (its summary comes first). */
export function withCompactionNoteSession(messages: readonly SessionMessage[], note: string): SessionMessage[] {
  const noteMessage: SessionMessage = { role: 'user', text: note, toolUses: [] };
  if (messages.length === 0) return [noteMessage];
  return [messages[0]!, noteMessage, ...messages.slice(1)];
}

/**
 * Upstream #53: a classifier that keeps none of the results it scored is
 * either miscalibrated (that issue: everything under 0.3 with a 0.5
 * threshold, on 16 real sessions) or right about a stretch whose tool output
 * was all disposable (a session that only read files nobody referred to
 * again). The scores cannot tell the two apart; `reviewKeepNothing` asks a
 * model that can see the conversation, and failing that the user. Fewer than
 * five scored results is too few to judge. The best result score comes back
 * so the log can say how far off it was.
 */
export function suspectCalibration(
  actions: readonly ActionDecision[],
  classified: number,
): { suspect: boolean; best: number } {
  let best = 0;
  let kept = 0;
  for (const decision of actions) {
    if (!decision.scores) continue;
    if (decision.action === 'KEEP_VERBATIM') kept += 1;
    best = Math.max(best, decision.scores.keepResult);
  }
  return { suspect: classified >= 5 && kept === 0, best };
}

export type KeepNothingReview = {
  decision: 'proceed' | 'keep' | 'fallback';
  /** Classifier call ids (`t3`) to keep verbatim on the re-run; only with `keep`. */
  keep: string[];
  /** One sentence for the log and the toast: what was found, who reviewed it, what was decided. */
  why: string;
};

const trustKey = (sessionId: string): string => `lossless-compact:trust:${sessionId}`;

/** Whether the user already said "remove and don't ask again" this session. */
export async function trustedForSession(
  $: { store: { get: (key: string) => Promise<unknown> } },
  sessionId: string,
): Promise<boolean> {
  try {
    return (await $.store.get(trustKey(sessionId))) === true;
  } catch {
    return false;
  }
}

export const REVIEW_ANSWERS = {
  remove: 'Remove them (archived, restorable)',
  trust: "Remove, and don't ask again this session",
  summary: "Use Claude's summary instead",
} as const;

type ReviewHost = {
  model: {
    fork: (request: { prompt: string }) => Promise<{ text: string; usage: { input_tokens: number; output_tokens: number } } | null>;
    complete: (request: { model: string; prompt: string; maxTokens?: number }) => Promise<string>;
  };
  ui: {
    ask: (question: string, options?: { options?: readonly string[]; header?: string }) => Promise<string>;
    log: (text: string) => void;
  };
  store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> };
};

/**
 * The second opinion when a classifier kept nothing. In order: the session's
 * own model over its own transcript (`$.model.fork`, cache-shared, so it has
 * read the conversation), then a small model with the user's turns quoted
 * (`$.model.complete`), then the user (`$.ui.ask`). Only a "drop_all" from a
 * model proceeds without asking; "keep_some" re-runs with those kept; anything
 * else asks. With no one to ask (headless) the built-in summary — with the
 * note — is the safe answer.
 */
export async function reviewKeepNothing(
  $: ReviewHost,
  sessionId: string,
  messages: readonly Message[],
  config: Pick<LosslessCompactConfig, 'preserveRecentMessages'>,
  result: OptimizeResult,
  threshold: number,
  best: number,
): Promise<KeepNothingReview> {
  const candidates = reviewCandidates(messages, result.decisions, config.preserveRecentMessages ?? 6);
  const ids = new Set(candidates.map((c) => c.id));
  const facts = `the classifier kept none of the ${candidates.length} results it scored (best ${best.toFixed(2)}, threshold ${threshold})`;
  let verdict: ReviewVerdict | undefined;
  let reviewer = '';
  try {
    const forked = await $.model.fork({ prompt: reviewQuestion(candidates, threshold) });
    if (forked) {
      verdict = parseReview(forked.text, ids);
      reviewer = `the session's model (${forked.usage.input_tokens + forked.usage.output_tokens} tokens)`;
    }
  } catch (error) {
    $.ui.log(`lossless-compact review: fork unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!verdict) {
    try {
      const text = await $.model.complete({
        model: 'haiku',
        prompt: reviewQuestionWithContext(messages, candidates, threshold),
        maxTokens: 400,
      });
      verdict = parseReview(text, ids);
      reviewer = 'haiku (user turns only)';
    } catch (error) {
      $.ui.log(`lossless-compact review: completion unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (verdict?.verdict === 'drop_all') {
    return { decision: 'proceed', keep: [], why: `${facts}; ${reviewer} read the conversation and agreed they are disposable${verdict.reason ? `: ${verdict.reason}` : ''}` };
  }
  if (verdict?.verdict === 'keep_some') {
    return { decision: 'keep', keep: verdict.keep, why: `${facts}; ${reviewer} asked to keep ${verdict.keep.join(', ')}${verdict.reason ? `: ${verdict.reason}` : ''}` };
  }
  const doubt = verdict ? `${reviewer} could not confirm that is right${verdict.reason ? ` (${verdict.reason})` : ''}` : 'no model could review it';
  try {
    const answer = await $.ui.ask(
      `lossless-compact: ${facts}, and ${doubt}. Every removed result stays in the archive and can be restored by id. Remove them, or use Claude's summary instead?`,
      { header: 'lossless-compact', options: [REVIEW_ANSWERS.remove, REVIEW_ANSWERS.trust, REVIEW_ANSWERS.summary] },
    );
    if (answer === REVIEW_ANSWERS.trust) {
      try {
        await $.store.set(trustKey(sessionId), true);
      } catch {
        // then it asks again next time; harmless
      }
      return { decision: 'proceed', keep: [], why: `${facts}; ${doubt}; the user chose to remove them and not be asked again this session` };
    }
    if (answer === REVIEW_ANSWERS.remove) return { decision: 'proceed', keep: [], why: `${facts}; ${doubt}; the user chose to remove them` };
    return { decision: 'fallback', keep: [], why: `${facts}; ${doubt}; the user chose the built-in summary` };
  } catch {
    return { decision: 'fallback', keep: [], why: `${facts}; ${doubt}; no one to ask (headless), so the built-in summary with the note` };
  }
}

/* ------------------------------------------------------------ /lossless */

/** The plugin's slash command; every subcommand hangs off it. */
export const COMMAND = 'lossless';

export interface LastCompaction {
  at: string;
  report: OptimizeReport;
  summary: string;
}

function lastKey(sessionId: string): string {
  return `lossless-compact:last:${sessionId}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

export async function statusText(
  sessionId: string,
  messages: readonly Message[],
  archive: ArchiveStore,
  last: LastCompaction | undefined,
  classifier: string,
  classifierNote?: string,
): Promise<string> {
  const ledger = buildLedger(messages);
  const active = eventTokens(ledger.events);
  const stats = await archive.stats(sessionId);
  const constraints = findConstraints(messages, ledger);
  const lines = [
    `lossless-compact — session ${sessionId}`,
    `Active context:        ~${formatTokens(active)} tokens (est.), ${messages.length} messages, ${ledger.interactions.size} tool interactions`,
    `Archived this session: ~${formatTokens(stats.tokens)} tokens in ${stats.records} records`,
    `Classifier:            ${last?.report.classifier ?? classifier}${last ? '' : ' (configured)'}`,
    ...(classifierNote ? [`                       ${classifierNote}`] : []),
    last
      ? `Last compaction:       ${last.at} — ${last.summary}`
      : 'Last compaction:       none yet',
    '',
    'Protection:',
    `  ${constraints.length > 0 ? '✓' : '·'} ${constraints.length} explicit user constraint${constraints.length === 1 ? '' : 's'} found (never evicted)`,
  ];
  if (last) {
    for (const [rule, n] of Object.entries(last.report.protections)) {
      lines.push(`  ✓ ${n} result${n === 1 ? '' : 's'} kept by rule ${rule}`);
    }
  }
  lines.push('', 'Commands: /lossless list [n] · /lossless why <id> · /lossless show <id> · /lossless restore <id> · /lossless retrieve <query>');
  return lines.join('\n');
}

export async function whyText(archive: ArchiveStore, id: string): Promise<string> {
  const record = await archive.get(id);
  if (!record) return `No archive record ${id}.`;
  const lines = [
    `${record.id} — ${record.kind}${record.toolName ? ` (${record.toolName})` : ''}, seq ${record.seq}, ~${record.tokenEstimate} tokens`,
    `Action: ${record.action} (compaction ${record.compactionId}, ${record.archivedAt})`,
    '',
    'Reasons:',
    ...record.reasons.map((reason) => `- ${reason.detail}${reason.refs?.length ? ` [${reason.refs.join(', ')}]` : ''}`),
  ];
  if (record.related.length > 0) {
    lines.push('', 'Related:', ...record.related.map((rel) => `- ${rel.relation}: ${rel.id}`));
  }
  lines.push('', 'The original content is still stored; /lossless restore ' + record.id + ' brings it back.');
  return lines.join('\n');
}

export function restoreBlock(record: ArchiveRecord): string {
  const head = `<retrieved_context id="${record.id}" kind="${record.kind}"${
    record.toolName ? ` tool="${record.toolName}"` : ''
  } seq="${record.seq}" archived="${record.archivedAt}">`;
  return `${head}\n${record.content}\n</retrieved_context>`;
}

export async function listText(archive: ArchiveStore, sessionId: string, limit: number): Promise<string> {
  const summaries = await archive.list({ sessionId });
  if (summaries.length === 0) return 'Nothing archived in this session yet.';
  const shown = summaries.slice(-limit);
  return [
    `${summaries.length} archived record${summaries.length === 1 ? '' : 's'}${
      shown.length < summaries.length ? ` (newest ${shown.length})` : ''
    }:`,
    ...shown.map(
      (s) =>
        `${s.id}  ${s.kind}${s.toolName ? `/${s.toolName}` : ''}  ~${s.tokenEstimate}t  ${s.action}  ${s.preview}`,
    ),
  ].join('\n');
}

export async function retrieveText(archive: ArchiveStore, sessionId: string, query: string): Promise<string> {
  const found = await archive.search(query, { sessionId, limit: 10 });
  if (found.length === 0) return `Nothing in the archive matches "${query}".`;
  return [
    `Best matches for "${query}":`,
    ...found.map(
      (s) =>
        `${s.id}  ${s.kind}${s.toolName ? `/${s.toolName}` : ''}  ~${s.tokenEstimate}t  ${s.preview}`,
    ),
    '',
    '/lossless restore <id> to bring one back verbatim.',
  ].join('\n');
}

/** Dispatches `/lossless <sub> ...`; `context` carries what the model should read. */
export async function runContextCommand(
  args: string,
  deps: {
    sessionId: string;
    messages: () => Promise<readonly Message[]>;
    archive: ArchiveStore;
    last: () => Promise<LastCompaction | undefined>;
    classifier: string;
    classifierNote?: string;
  },
): Promise<{ text: string; context?: string[] }> {
  const [sub = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(' ');
  switch (sub) {
    case 'status':
      return {
        text: await statusText(deps.sessionId, await deps.messages(), deps.archive, await deps.last(), deps.classifier, deps.classifierNote),
      };
    case 'list':
      return { text: await listText(deps.archive, deps.sessionId, Math.max(1, Number.parseInt(arg, 10) || 20)) };
    case 'why':
      if (!arg) return { text: 'Usage: /lossless why <id>' };
      return { text: await whyText(deps.archive, arg) };
    case 'show':
    case 'restore': {
      if (!arg) return { text: `Usage: /lossless ${sub} <id>` };
      const record = await deps.archive.get(arg);
      if (!record) return { text: `No archive record ${arg}.` };
      const block = restoreBlock(record);
      if (sub === 'show') return { text: block };
      return {
        text: `Restored ${record.id} (${record.kind}${record.toolName ? `/${record.toolName}` : ''}, ~${record.tokenEstimate} tokens) into the model's context for this turn.`,
        context: [block],
      };
    }
    case 'retrieve':
    case 'search':
      if (!arg) return { text: `Usage: /lossless ${sub} <query>` };
      return { text: await retrieveText(deps.archive, deps.sessionId, arg) };
    default:
      return {
        text: [
          `Unknown subcommand "${sub}".`,
          'Usage: /lossless [status] · list [n] · why <id> · show <id> · restore <id> · retrieve <query>',
        ].join('\n'),
      };
  }
}

/* ------------------------------------------------------ slash-menu entry */

/**
 * The VS Code and Cursor extensions fill their slash menu once at startup
 * from the markdown commands on disk, so `$.command.register`'s `/lossless`
 * is never in it; `commands/lossless.md` is, as `/lossless-compact:lossless`.
 * Picking it is a prompt, not a command: `command.run` never fires and the
 * model reads the file. `skill.prompt` fires as the engine expands it, and
 * that is where the hook puts the command's real answer in the model's hands.
 * Typing `/lossless` in full still runs the command directly, no model turn.
 */
export const MENU_SKILL = `lossless-compact:${COMMAND}`;

/** Whether a `skill.prompt` is the static menu entry (plugin-qualified, or bare where a host folds the prefix). */
export function isMenuSkill(skill: string): boolean {
  return skill === MENU_SKILL || skill === COMMAND;
}

/**
 * The arguments the menu entry carried: its body opens with
 * `/lossless $ARGUMENTS`, which the host substitutes ("" when nothing was
 * typed; the marker itself on a host that does not substitute).
 */
export function menuArgs(text: string): string {
  const first = (text.split('\n', 1)[0] ?? '').trim();
  const match = new RegExp(`^/${COMMAND}\\b\\s*(.*)$`).exec(first);
  const args = (match?.[1] ?? '').trim();
  return args === '$ARGUMENTS' ? '' : args;
}

/**
 * What the model reads in the menu entry's place: the command's answer, to
 * show verbatim, and after it whatever the command put in the model's context
 * (a restored record).
 */
export function menuPrompt(args: string, answer: { text: string; context?: readonly string[] }): string {
  const command = `/${COMMAND}${args ? ` ${args}` : ''}`;
  const lines = [
    `lossless-compact answered \`${command}\` for this prompt. Show the user the answer between the markers exactly as it is, in one code block, and add nothing else: no tools, no commentary. Anything after the markers is context for you, not for the reply.`,
    '',
    '<lossless_answer>',
    answer.text,
    '</lossless_answer>',
  ];
  if (answer.context && answer.context.length > 0) lines.push('', ...answer.context);
  return lines.join('\n');
}

/* ------------------------------------------------------------- register */

/** What `/lossless` needs from the session beyond the engine: the archive's root and the classifier as resolved so far. */
type CommandState = { archiveDir: string; classifier: string; classifierNote?: string };

/**
 * `/lossless <args>` answered, for the typed command and for the menu entry
 * alike. A top-level function: the engine admits `$` only into one of those.
 */
async function answerCommand(
  $: {
    session: { id: () => Promise<string>; messages: () => Promise<readonly Message[]> };
    store: { get: (key: string) => Promise<unknown> };
  } & Parameters<typeof engineFs>[0],
  args: string,
  state: CommandState,
): Promise<{ text: string; context?: string[] }> {
  const sessionId = await $.session.id();
  const archive = new FileArchive(engineFs($), { root: state.archiveDir });
  return runContextCommand(args, {
    sessionId,
    messages: () => $.session.messages(),
    archive,
    last: async () => (await $.store.get(lastKey(sessionId))) as LastCompaction | undefined,
    classifier: state.classifier,
    ...(state.classifierNote ? { classifierNote: state.classifierNote } : {}),
  });
}

/**
 * Starts a compaction the way this host allows: `$.session.compact()` between
 * turns, or where the host refuses that — the -p/SDK path, which is what the
 * VS Code and Cursor extensions run a session on ("compaction here runs
 * inside a turn (a /compact prompt)") — the `/compact` command, queued for
 * when the session is idle. The same `session.compact` event either way, so
 * neither summarizes.
 */
async function startCompaction($: {
  session: { compact: () => Promise<unknown> };
  command: { run: (args: { command: string }) => Promise<unknown> };
  ui: { log: (text: string) => void };
}): Promise<void> {
  try {
    await $.session.compact();
  } catch (error) {
    $.ui.log(`lossless-compact: compacting through /compact instead (${error instanceof Error ? error.message : String(error)})`);
    await $.command.run({ command: 'compact' });
  }
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function safeNotify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  try {
    $.ui.log(text);
    $.ui.toast(text, { timeoutMs: 15_000 });
  } catch {
    // A failing UI must never turn a compaction into a failure (upstream #36).
  }
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveLosslessCompactConfig(options);
  let compacting = false;
  const trigger = new AutoCompactTrigger(configured);
  let classifierName: string = configured.classifier;
  let classifierNote: string | undefined;
  const commandState = (): CommandState => ({
    archiveDir: configured.archiveDir,
    classifier: classifierName,
    ...(classifierNote ? { classifierNote } : {}),
  });

  on('session.start', async ($, event, next) => {
    // Resolve `auto` up front so a fresh session can prove whether it will use
    // Jev or the local ruleset before the first compaction has happened.
    try {
      const apiKey = await getApiKey($, configured);
      classifierName = resolvedClassifierName(configured, apiKey);
      classifierNote = noKeyNotice(configured, apiKey);
      // One dim line in the terminal transcript (the debug log elsewhere); the
      // compaction note and `/lossless` carry the same line where it matters.
      if (classifierNote) $.ui.log(`lossless-compact: ${classifierNote}`);
    } catch (error) {
      try {
        $.ui.log(`lossless-compact: could not resolve the configured classifier (${error instanceof Error ? error.message : String(error)})`);
      } catch {
        // The compaction path will retry and fail less if this was transient.
      }
    }
    try {
      // Our own name: Claude Code refuses a built-in's (`/context`), and a
      // hijacked built-in never shows in the typeahead.
      await $.command.register({
        name: COMMAND,
        description: 'What lossless-compact archived: status, list, why, show, restore, retrieve',
        argumentHint: '[status|list [n]|why <id>|show <id>|restore <id>|retrieve <query>]',
      });
    } catch (error) {
      try {
        $.ui.log(`lossless-compact: /${COMMAND} not registered (${error instanceof Error ? error.message : String(error)})`);
      } catch {
        // ignore
      }
    }
    return next(event);
  });

  on('command.run', { command: COMMAND }, async ($, event) => answerCommand($, event.args, commandState()));

  on('skill.prompt', async ($, event, next) => {
    if (!isMenuSkill(event.skill)) return next(event);
    try {
      const args = menuArgs(event.text);
      const answered = await answerCommand($, args, commandState());
      $.ui.log(`lossless-compact: /${COMMAND} ${args} answered from the slash menu (one model turn relays it; typed in full it needs none)`);
      return { text: menuPrompt(args, answered) };
    } catch (error) {
      try {
        $.ui.log(`lossless-compact: menu entry not answered (${error instanceof Error ? error.message : String(error)})`);
      } catch {
        // ignore
      }
      return next(event);
    }
  });

  on('session.compact', async ($, event, next) => {
    // The archive and snapshot are on disk before any decision to fall back,
    // so the built-in summary still gets a note saying where they are.
    let fallbackNote: string | undefined;
    const fallback = async (reason: string): Promise<SessionCompactResult> => {
      safeNotify($, `fallback to built-in summary (${reason})`);
      const built = await next(event);
      if (!fallbackNote || built.skip !== undefined || !built.messages?.length) return built;
      return { ...built, messages: withCompactionNoteSession(built.messages, fallbackNote) };
    };
    try {
      const sessionId = await $.session.id();
      const apiKey = await getApiKey($, configured);
      const fetchFn: HookFetch = async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      };
      const classifier = chooseClassifier(configured, fetchFn, apiKey);
      classifierName = classifier.name;
      classifierNote = noKeyNotice(configured, apiKey);
      const archive = new FileArchive(engineFs($), { root: configured.archiveDir });
      let optimized = await optimizeSession(event.messages, configured, classifier, archive, sessionId);
      const threshold = configured.keepThreshold ?? classifier.defaultThreshold ?? 0.5;
      // Upstream #53: a classifier that keeps nothing it scored is either
      // miscalibrated or right about a disposable stretch; a model that has
      // seen the conversation (or the user) decides which, see reviewKeepNothing.
      let distrust: string | undefined;
      const calibration = suspectCalibration(optimized.result.actions, optimized.result.report.classified);
      if (calibration.suspect && !(await trustedForSession($, sessionId))) {
        const review = await reviewKeepNothing($, sessionId, event.messages, configured, optimized.result, threshold, calibration.best);
        $.ui.log(`lossless-compact: ${review.why}`);
        if (review.decision === 'keep') {
          const reviewed = classifierWithKeeps(optimized.result.decisions, new Set(review.keep), `${classifier.name}+review`);
          optimized = await optimizeSession(event.messages, configured, reviewed, archive, sessionId);
        } else if (review.decision === 'fallback') {
          distrust = review.why;
        }
      }
      const { result } = optimized;
      let { messages } = optimized;
      for (const line of reportLines(result.report)) $.ui.log(line);
      if (result.archived.length > 0 && (configured.snapshot || configured.noteRemoved)) {
        const at = new Date().toISOString();
        const cwd = await $.session.cwd();
        const root = configured.archiveDir.replace(/[\\/]+$/, '');
        const absolute = (relative: string): string => `${cwd.replace(/[\\/]+$/, '')}/${relative}`;
        let snapshotPath: string | undefined;
        if (configured.snapshot) {
          try {
            const [manifest] = await writeSnapshot(engineFs($), root, sessionId, result.report.compactionId, event.messages, at);
            snapshotPath = manifest ? absolute(manifest) : undefined;
          } catch (error) {
            $.ui.log(`lossless-compact snapshot skipped (${error instanceof Error ? error.message : String(error)})`);
          }
        }
        if (configured.noteRemoved) {
          const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
          const rawLogPath = await rawSessionLogPath(engineFs($), home, cwd, sessionId);
          const details = {
            at,
            compactionId: result.report.compactionId,
            report: result.report,
            ...(snapshotPath ? { snapshotPath } : {}),
            archiveDir: absolute(root),
            ...(rawLogPath ? { rawLogPath } : {}),
            ...(classifierNote ? { classifierNote } : {}),
          };
          messages = toSessionMessages(event.messages, withCompactionNote(result.messages, compactionNote(details)));
          fallbackNote = compactionNote({ ...details, summarized: true });
        }
      }
      for (const line of decisionLogLines(result)) $.ui.log(line);
      const ratio = reductionRatio(result);
      const tooLittle = ratio < configured.minReductionRatio;
      // The plugin's own trigger (`plugin` in the terminal; `/compact` run
      // from turn.complete on the SDK path, where `compacting` is held) asked
      // for room the user did not: too little to remove is a reason to wait
      // for the context to grow, never to summarize what was protected. A
      // typed /compact and the host's own near-limit run still fall back —
      // those need the room now.
      const own = event.trigger === 'plugin' || compacting;
      const summary = summarize(result);
      try {
        await $.store.set(lastKey(sessionId), {
          at: new Date().toISOString(),
          report: result.report,
          summary: tooLittle && own ? `left as is (below ${percent(configured.minReductionRatio)} minimum): ${summary}` : summary,
        } satisfies LastCompaction);
      } catch {
        // The status line is a nicety; never fail the compaction over it.
      }
      if (tooLittle) {
        const reason = `below ${percent(configured.minReductionRatio)} minimum: ${summary}`;
        if (own) {
          safeNotify($, `lossless-compact: nothing to compact yet (${reason}); tries again once the context has grown by a quarter`);
          return { skip: reason };
        }
        return fallback(reason);
      }
      if (distrust) return fallback(distrust);
      safeNotify(
        $,
        `lossless-compact kept ${messages.length}/${event.messages.length} messages, archived ${result.archived.length} units, no summary (${summary})${
          calibration.suspect ? ' — reviewed, see the log' : ''
        }`,
      );
      return { messages: rechain(messages) };
    } catch (error) {
      return fallback(error instanceof Error ? error.message : String(error));
    }
  });

  on('prompt.submit', async ($, event, next) => {
    if (!configured.autoRetrieve || configured.retrieveBudgetChars === 0) return next(event);
    try {
      const sessionId = await $.session.id();
      const archive = new FileArchive(engineFs($), { root: configured.archiveDir });
      const existing = (event.context ?? []).reduce((sum, block) => sum + block.length, 0);
      const room = Math.min(configured.retrieveBudgetChars, 32_000 - existing - REHYDRATION_PREFACE.length - 64);
      if (room < 200) return next(event);
      const found = await rehydrateForPrompt(archive, sessionId, event.text, { budgetChars: room });
      if (found.blocks.length === 0) return next(event);
      try {
        $.ui.log(
          `lossless-compact retrieved ${found.records.map((r) => r.id).join(', ')} (~${found.chars} chars) for this prompt`,
        );
      } catch {
        // ignore
      }
      return next({ ...event, context: [...(event.context ?? []), REHYDRATION_PREFACE, ...found.blocks] });
    } catch (error) {
      try {
        $.ui.log(`lossless-compact retrieval skipped (${error instanceof Error ? error.message : String(error)})`);
      } catch {
        // ignore
      }
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    // Upstream #35: take the lock before the first await.
    if (compacting) return next(event);
    compacting = true;
    try {
      const { context } = await $.session.usage();
      if (trigger.due(context)) await startCompaction($);
    } catch (error) {
      try {
        $.ui.log(`auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
      } catch {
        // ignore
      }
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
