import type { On, PluginOptions, Register, SessionCompactResult, SessionMessage, TurnCompleteInput } from 'claude-code';

import { FileArchive, type TextFs } from '../src/archive/file-store.js';
import type { ArchiveRecord, ArchiveStore } from '../src/archive/types.js';
import type { ActionDecision } from '../src/core/actions.js';
import { HeuristicClassifier } from '../src/classifiers/heuristic.js';
import { JevClassifier, type JevQuestionStyle } from '../src/classifiers/jev.js';
import type { Classifier } from '../src/classifiers/types.js';
import { reductionRatio } from '../src/compact.js';
import { buildLedger, eventTokens } from '../src/core/events.js';
import { findConstraints } from '../src/core/rules.js';
import { optimize, type OptimizeReport, type OptimizeResult } from '../src/engine/optimize.js';
import { REHYDRATION_PREFACE, rehydrateForPrompt } from '../src/engine/rehydrate.js';
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
 * project in `.context-os/`; `/context` inspects and restores it.
 */

export type ClassifierChoice = 'auto' | 'jev' | 'heuristic';

export type ContextOsConfig = HookConfig & {
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
  /** Write the exact pre-compaction transcript under `.context-os/snapshots/`. */
  snapshot: boolean;
  /** Insert a note into the compacted transcript saying where the full history is. */
  noteRemoved: boolean;
};

const DEFAULTS = {
  classifier: 'auto' as ClassifierChoice,
  questionStyle: 'useful' as JevQuestionStyle,
  archiveDir: '.context-os',
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

export function resolveContextOsConfig(options: PluginOptions): ContextOsConfig {
  const base = resolveHookConfig(options);
  const classifier = options['classifier'];
  const style = options['questionStyle'];
  const dir = options['archiveDir'];
  const margin = options['safetyMargin'];
  const config: ContextOsConfig = {
    ...base,
    classifier:
      classifier === 'jev' || classifier === 'heuristic' || classifier === 'auto'
        ? classifier
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
  config: Pick<ContextOsConfig, 'compactAtTokens' | 'compactAtPercent'>,
): boolean {
  const percent = context.percent ?? 0;
  const tokens =
    context.tokens ?? (context.window && context.percent !== undefined ? (context.percent / 100) * context.window : undefined);
  if (config.compactAtTokens > 0 && tokens !== undefined && tokens >= config.compactAtTokens) return true;
  if (config.compactAtPercent > 0 && percent >= config.compactAtPercent) return true;
  return false;
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

/** Picks the classifier from the config and whether a key is at hand. */
export function chooseClassifier(
  config: ContextOsConfig,
  fetchFn: HookFetch,
  apiKey: string | undefined,
): Classifier {
  const wantJev = config.classifier === 'jev' || (config.classifier === 'auto' && !!apiKey);
  if (wantJev) {
    if (!apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    return new JevClassifier(jevAsker(fetchFn, apiKey, config.model), {
      questionStyle: config.questionStyle,
    });
  }
  return new HeuristicClassifier();
}

export interface SessionOptimization {
  result: OptimizeResult;
  messages: SessionMessage[];
}

/** Runs the optimizer over a session transcript; throws when the classifier cannot run. */
export async function optimizeSession(
  messages: readonly SessionMessage[],
  config: ContextOsConfig,
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
    `context-os ${report.compactionId}: ${report.classifier}; ~${report.tokens.before}→${report.tokens.after} tokens; archived ${report.tokens.archived} tokens in ${report.actions.ARCHIVE_ONLY + report.actions.KEEP_HEAD_TAIL + report.actions.RERUN_ON_DEMAND + report.actions.DROP_REDUNDANT} units`,
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
}): string {
  const { actions } = details.report;
  const removed = actions.ARCHIVE_ONLY + actions.KEEP_HEAD_TAIL + actions.RERUN_ON_DEMAND + actions.DROP_REDUNDANT;
  const units = `${removed} tool interaction${removed === 1 ? '' : 's'} (~${details.report.tokens.archived.toLocaleString('en-US')} tokens)`;
  const lines = [
    details.summarized
      ? `[context-os] This conversation was compacted at ${details.at} by Claude Code's built-in summary; the message above is a paraphrase, not the original text. Before the summary was written, context-os (compaction ${details.compactionId}) archived ${units} verbatim${
          details.snapshotPath ? ' and saved the exact pre-compaction transcript' : ''
        }. If you need anything the summary lost, the full history is on disk:`
      : `[context-os] This conversation was compacted at ${details.at} (compaction ${details.compactionId}): ${units} were removed from the active context and archived verbatim. Nothing was summarized or paraphrased; user and assistant messages are untouched. If you need any removed message, the full history is on disk:`,
  ];
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
  lines.push('The user can also run /context why <id>, /context show <id> or /context restore <id>.');
  return lines.join('\n');
}

/** The compacted transcript with the note inserted after the pinned first message. */
export function withCompactionNote(messages: readonly Message[], note: string): Message[] {
  const noteMessage: Message = { role: 'user', text: note, toolUses: [] };
  if (messages.length === 0) return [noteMessage];
  return [messages[0]!, noteMessage, ...messages.slice(1)];
}

/** The same insertion over the host's own compacted transcript (its summary comes first). */
export function withCompactionNoteSession(messages: readonly SessionMessage[], note: string): SessionMessage[] {
  const noteMessage: SessionMessage = { role: 'user', text: note, toolUses: [] };
  if (messages.length === 0) return [noteMessage];
  return [messages[0]!, noteMessage, ...messages.slice(1)];
}

/**
 * Upstream #53: a classifier that keeps none of the results it scored is more
 * often miscalibrated than right (that issue: everything under 0.3 with a 0.5
 * threshold, on 16 real sessions), so the transcript goes to the built-in
 * summary instead — with the note, since the archive and snapshot are already
 * on disk. Fewer than five scored results is too few to judge. The best
 * result score comes back so the log can say how far off it was; a session
 * whose tool output really was all disposable (a smoke test that only reads
 * files) trips this too, and the note is what makes that cheap.
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

/* ------------------------------------------------------------- /context */

export interface LastCompaction {
  at: string;
  report: OptimizeReport;
  summary: string;
}

function lastKey(sessionId: string): string {
  return `context-os:last:${sessionId}`;
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
): Promise<string> {
  const ledger = buildLedger(messages);
  const active = eventTokens(ledger.events);
  const stats = await archive.stats(sessionId);
  const constraints = findConstraints(messages, ledger);
  const lines = [
    `context-os — session ${sessionId}`,
    `Active context:        ~${formatTokens(active)} tokens (est.), ${messages.length} messages, ${ledger.interactions.size} tool interactions`,
    `Archived this session: ~${formatTokens(stats.tokens)} tokens in ${stats.records} records`,
    `Classifier:            ${last?.report.classifier ?? classifier}${last ? '' : ' (configured)'}`,
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
  lines.push('', 'Commands: /context list [n] · /context why <id> · /context show <id> · /context restore <id> · /context retrieve <query>');
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
  lines.push('', 'The original content is still stored; /context restore ' + record.id + ' brings it back.');
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
    '/context restore <id> to bring one back verbatim.',
  ].join('\n');
}

/** Dispatches `/context <sub> ...`; `context` carries what the model should read. */
export async function runContextCommand(
  args: string,
  deps: {
    sessionId: string;
    messages: () => Promise<readonly Message[]>;
    archive: ArchiveStore;
    last: () => Promise<LastCompaction | undefined>;
    classifier: string;
  },
): Promise<{ text: string; context?: string[] }> {
  const [sub = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(' ');
  switch (sub) {
    case 'status':
      return { text: await statusText(deps.sessionId, await deps.messages(), deps.archive, await deps.last(), deps.classifier) };
    case 'list':
      return { text: await listText(deps.archive, deps.sessionId, Math.max(1, Number.parseInt(arg, 10) || 20)) };
    case 'why':
      if (!arg) return { text: 'Usage: /context why <id>' };
      return { text: await whyText(deps.archive, arg) };
    case 'show':
    case 'restore': {
      if (!arg) return { text: `Usage: /context ${sub} <id>` };
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
      if (!arg) return { text: `Usage: /context ${sub} <query>` };
      return { text: await retrieveText(deps.archive, deps.sessionId, arg) };
    default:
      return {
        text: [
          `Unknown subcommand "${sub}".`,
          'Usage: /context [status] · list [n] · why <id> · show <id> · restore <id> · retrieve <query>',
        ].join('\n'),
      };
  }
}

/* ------------------------------------------------------------- register */

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
  const configured = resolveContextOsConfig(options);
  let compacting = false;
  let classifierName: string = configured.classifier;

  on('session.start', async ($, event, next) => {
    try {
      await $.command.register({
        name: 'context',
        description: 'Context usage, plus what context-os archived: inspect, explain, restore',
        argumentHint: '[list|why <id>|show <id>|restore <id>|retrieve <query>]',
      });
    } catch (error) {
      try {
        // Claude Code refuses the built-in name; the command.run hook below
        // still intercepts it (seen live on 2.1.278), so nothing is lost.
        $.ui.log(`context-os: /context is the host's own here; subcommands run through the command.run hook (${error instanceof Error ? error.message : String(error)})`);
      } catch {
        // ignore
      }
    }
    return next(event);
  });

  on('command.run', { command: 'context' }, async ($, event, next) => {
    const sessionId = await $.session.id();
    const archive = new FileArchive(engineFs($), { root: configured.archiveDir });
    const ours = await runContextCommand(event.args, {
      sessionId,
      messages: () => $.session.messages(),
      archive,
      last: async () => (await $.store.get(lastKey(sessionId))) as LastCompaction | undefined,
      classifier: classifierName,
    });
    // Claude Code's own `/context` (the usage grid) keeps working: a bare
    // `/context` shows it first, with the archive status underneath.
    if (event.args.trim().length === 0) {
      try {
        const builtin = await next(event);
        const text = [builtin.text, ours.text].filter((part) => part && part.trim().length > 0).join('\n\n');
        return { ...builtin, text };
      } catch {
        return ours;
      }
    }
    return ours;
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
      const archive = new FileArchive(engineFs($), { root: configured.archiveDir });
      const optimized = await optimizeSession(event.messages, configured, classifier, archive, sessionId);
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
            $.ui.log(`context-os snapshot skipped (${error instanceof Error ? error.message : String(error)})`);
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
          };
          messages = toSessionMessages(event.messages, withCompactionNote(result.messages, compactionNote(details)));
          fallbackNote = compactionNote({ ...details, summarized: true });
        }
      }
      for (const line of decisionLogLines(result)) $.ui.log(line);
      const summary = summarize(result);
      try {
        await $.store.set(lastKey(sessionId), {
          at: new Date().toISOString(),
          report: result.report,
          summary,
        } satisfies LastCompaction);
      } catch {
        // The status line is a nicety; never fail the compaction over it.
      }
      const ratio = reductionRatio(result);
      if (ratio < configured.minReductionRatio) {
        return fallback(`below ${percent(configured.minReductionRatio)} minimum: ${summary}`);
      }
      const threshold = configured.keepThreshold ?? classifier.defaultThreshold ?? 0.5;
      const calibration = suspectCalibration(result.actions, result.report.classified);
      if (calibration.suspect) {
        return fallback(
          `classifier kept none of ${result.report.classified} scored results (best result score ${calibration.best.toFixed(2)}, threshold ${threshold}); suspect calibration`,
        );
      }
      safeNotify(
        $,
        `context-os kept ${messages.length}/${event.messages.length} messages, archived ${result.archived.length} units, no summary (${summary})`,
      );
      return { messages };
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
          `context-os retrieved ${found.records.map((r) => r.id).join(', ')} (~${found.chars} chars) for this prompt`,
        );
      } catch {
        // ignore
      }
      return next({ ...event, context: [...(event.context ?? []), REHYDRATION_PREFACE, ...found.blocks] });
    } catch (error) {
      try {
        $.ui.log(`context-os retrieval skipped (${error instanceof Error ? error.message : String(error)})`);
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
      if (shouldCompact(context, configured)) await $.session.compact();
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
