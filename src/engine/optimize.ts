import { MemoryArchive } from '../archive/memory-store.js';
import type { ArchiveRecord, ArchiveStore } from '../archive/types.js';
import { RulesetClassifier } from '../classifiers/ruleset.js';
import { JevClassifier } from '../classifiers/jev.js';
import type { Classifier, ClassifierRun } from '../classifiers/types.js';
import { messageChars, resolveOptions } from '../compact.js';
import { evicts, toBaselineAction, type ActionDecision, type ContextAction } from '../core/actions.js';
import { buildDependencyGraph, type DependencyGraph } from '../core/dependencies.js';
import { buildLedger, eventTokens, type Ledger, type NormalizedEvent } from '../core/events.js';
import { decideInteraction, resolvePolicyOptions, type PolicyOptions } from '../core/policy.js';
import { Redactor } from '../core/redact.js';
import {
  findConstraints,
  protectionsFor,
  resolveRuleOptions,
  targetChangedLater,
  type ConstraintHit,
  type Protection,
  type RuleOptions,
} from '../core/rules.js';
import { sketchResult } from '../core/sketch.js';
import { collectToolCalls } from '../state.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
  ToolUse,
} from '../types.js';

export interface OptimizeOptions extends CompactOptions {
  /** Identifies the conversation in the archive. Default `session`. */
  sessionId?: string;
  /** Identifies this compaction in the archive. Default a time-based id. */
  compactionId?: string;
  /** Where evicted content goes. Default a fresh in-memory archive (returned in the result). */
  archive?: ArchiveStore;
  /** Scores the candidates. Default: Jev over `asker` when given, otherwise the local ruleset. */
  classifier?: Classifier;
  asker?: JevAsker;
  rules?: Partial<RuleOptions>;
  policy?: Partial<Omit<PolicyOptions, 'keepThreshold'>>;
  /** Show the classifier a sketch of each result instead of only its size. Default true. */
  sketches?: boolean;
  /** Redact secrets from everything shown to the classifier. Default true. */
  redact?: boolean | Redactor;
  /** Note in an assistant message when its tool calls were removed (upstream #65). Default true. */
  markRemovedCalls?: boolean;
  now?: () => Date;
}

export interface OptimizeReport {
  sessionId: string;
  compactionId: string;
  classifier: string;
  messages: { before: number; after: number };
  tokens: { before: number; after: number; archived: number };
  chars: { before: number; after: number };
  actions: Record<ContextAction, number>;
  protections: Record<string, number>;
  constraints: number;
  duplicates: number;
  candidates: number;
  classified: number;
  unscored: number;
  redactedSecrets: number;
  classifierStats: ClassifierRun['stats'];
  ms: number;
}

export interface OptimizeResult extends CompactResult {
  actions: ActionDecision[];
  archived: ArchiveRecord[];
  archive: ArchiveStore;
  constraints: ConstraintHit[];
  report: OptimizeReport;
}

function emptyActionCounts(): Record<ContextAction, number> {
  return {
    PIN_VERBATIM: 0,
    KEEP_VERBATIM: 0,
    KEEP_HEAD_TAIL: 0,
    EXTRACT_MEMORY_AND_ARCHIVE: 0,
    ARCHIVE_ONLY: 0,
    REPLACE_WITH_REFERENCE: 0,
    RERUN_ON_DEMAND: 0,
    DROP_REDUNDANT: 0,
  };
}

function defaultCompactionId(now: Date): string {
  return `c_${now.getTime().toString(36)}`;
}

/** Copies of the messages with every text, tool input and result redacted. */
function redactMessages(messages: readonly Message[], redactor: Redactor): Message[] {
  return messages.map((message) => {
    const copy: Message = {
      role: message.role,
      text: redactor.redact(message.text),
      toolUses: message.toolUses.map((tool) => {
        const use: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: redactor.redactValue(tool.input),
        };
        if (tool.text !== undefined) use.text = redactor.redact(tool.text);
        if (tool.isError) use.isError = true;
        return use;
      }),
    };
    if (message.toolResults) {
      copy.toolResults = message.toolResults.map((result) => {
        const out: ToolResult = { tool_use_id: result.tool_use_id, text: redactor.redact(result.text) };
        if (result.isError !== undefined) out.isError = result.isError;
        return out;
      });
    }
    return copy;
  });
}

function inputSummary(call: ToolCall): string {
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'prompt']) {
    const value = call.input[key];
    if (typeof value === 'string' && value.length > 0) {
      const flat = value.replace(/\s+/g, ' ');
      const head = `${key}=${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
      // A chunked read is only identifiable by its offset.
      const offset = call.input['offset'];
      return typeof offset === 'number' && offset > 1 ? `${head} offset=${offset}` : head;
    }
  }
  return '';
}

/**
 * The text left in place of an evicted result: a bounded head, then a note
 * naming the archive record so the assistant (or the user) can bring the
 * exact content back.
 */
export function stubResultText(
  text: string,
  call: ToolCall,
  action: ContextAction,
  archiveId: string,
  headChars: number,
): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  const what = `${text.length - headChars} more chars of this ${call.tool} result${call.isError ? ' (error)' : ''}`;
  const how =
    action === 'RERUN_ON_DEMAND'
      ? `re-run ${call.tool} with the same input to reproduce it, or /lossless restore ${archiveId}`
      : `/lossless restore ${archiveId} brings it back verbatim, or re-run the tool`;
  const about = inputSummary(call);
  return `${head}[lossless-compact archived ${archiveId}: ${what}${about ? ` (${about})` : ''}; ${how}]`;
}

/** The note appended to an assistant message whose tool calls were removed. */
export function removedCallsMarker(removed: readonly { call: ToolCall; archiveId: string }[]): string {
  // Terse on purpose: one of these stands for every removed call in a live
  // session (Claude Code gives each call its own message), and the
  // compaction note explains the mechanism once.
  const items = removed.map((r) => `${`${r.call.tool} ${inputSummary(r.call)}`.trim()} → ${r.archiveId}`).join('; ');
  return `[lossless-compact archived ${removed.length} tool call${removed.length === 1 ? '' : 's'} made here: ${items} — out of context; /lossless restore <id>]`;
}

interface Applied {
  messages: Message[];
  archived: ArchiveRecord[];
}

function archiveRecord(
  event: NormalizedEvent,
  decision: ActionDecision,
  options: { sessionId: string; compactionId: string; archivedAt: string },
  related: ArchiveRecord['related'],
  metadata: Record<string, unknown>,
): ArchiveRecord {
  const record: ArchiveRecord = {
    id: event.id,
    sessionId: options.sessionId,
    seq: event.seq,
    role: event.role,
    kind: event.kind,
    content: event.content,
    contentHash: event.contentHash,
    tokenEstimate: event.tokenEstimate,
    archivedAt: options.archivedAt,
    compactionId: options.compactionId,
    action: decision.action,
    reasons: decision.reasons,
    related,
    metadata,
  };
  if (event.toolName) record.toolName = event.toolName;
  if (event.toolUseId) record.toolUseId = event.toolUseId;
  if (event.isError) record.isError = true;
  return record;
}

/**
 * Rebuilds the transcript from the decisions and produces the archive records
 * of everything that left it. Untouched messages are returned as the same
 * objects; no result is ever left without its call; a message that loses all
 * its content is removed.
 */
export function applyActions(
  messages: readonly Message[],
  decisions: readonly ActionDecision[],
  calls: readonly ToolCall[],
  ledger: Ledger,
  options: {
    sessionId: string;
    compactionId: string;
    archivedAt: string;
    headChars: number;
    markRemovedCalls: boolean;
  },
): Applied {
  const byUseId = new Map(calls.map((call) => [call.tool_use_id, call]));
  const byEventId = new Map(decisions.map((decision) => [decision.eventId, decision]));
  const decisionOf = new Map<string, ActionDecision>();
  for (const call of calls) {
    const pair = ledger.interactions.get(call.tool_use_id);
    const decision = pair && byEventId.get(pair.use.id);
    if (decision && evicts(decision.action)) decisionOf.set(call.tool_use_id, decision);
  }

  const archived: ArchiveRecord[] = [];
  const archivedIds = new Set<string>();
  const archiveInteraction = (call: ToolCall, decision: ActionDecision): string => {
    const pair = ledger.interactions.get(call.tool_use_id)!;
    // A tool_use and its tool_result normally live in different messages, so
    // this runs once from each message's loop below; only the first call must
    // do the archiving, or the second one's empty `ids` clobbers `archiveIds`.
    if (decision.archiveIds) return pair.result?.id ?? pair.use.id;
    const baseline = toBaselineAction(decision.action);
    const meta: Record<string, unknown> = { tool: call.tool, input: call.input };
    for (const key of ['file_path', 'path', 'command', 'pattern', 'url']) {
      if (typeof call.input[key] === 'string') meta[key] = call.input[key];
    }
    if (decision.action === 'RERUN_ON_DEMAND') meta['rerun'] = { tool: call.tool, input: call.input };
    const duplicate = decision.reasons.find((r) => r.code === 'duplicate')?.refs?.[0];
    if (duplicate) meta['duplicateOf'] = duplicate;
    const ids: string[] = [];
    if (pair.result && !archivedIds.has(pair.result.id)) {
      archived.push(
        archiveRecord(
          pair.result,
          decision,
          options,
          [{ relation: 'call', id: pair.use.id }],
          { ...meta, resultChars: pair.result.content.length, isError: call.isError },
        ),
      );
      archivedIds.add(pair.result.id);
      ids.push(pair.result.id);
    }
    if (baseline === 'drop_call' && !archivedIds.has(pair.use.id)) {
      archived.push(
        archiveRecord(
          pair.use,
          decision,
          options,
          pair.result ? [{ relation: 'result', id: pair.result.id }] : [],
          meta,
        ),
      );
      archivedIds.add(pair.use.id);
      ids.push(pair.use.id);
    }
    decision.archiveIds = ids;
    return pair.result?.id ?? pair.use.id;
  };

  const kept: Message[] = [];
  /** Marker-only messages by the calls they stand for, so adjacent ones merge into one line. */
  const markerRuns = new Map<Message, { call: ToolCall; archiveId: string }[]>();
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => decisionOf.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => decisionOf.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const removed: { call: ToolCall; archiveId: string }[] = [];
    const toolUses: ToolUse[] = [];
    for (const tool of message.toolUses) {
      const decision = decisionOf.get(tool.tool_use_id);
      const call = byUseId.get(tool.tool_use_id);
      if (!decision || !call) {
        toolUses.push(tool);
        continue;
      }
      const baseline = toBaselineAction(decision.action);
      const archiveId = archiveInteraction(call, decision);
      if (baseline === 'drop_call') {
        removed.push({ call, archiveId });
        continue;
      }
      const text = stubResultText(tool.text ?? '', call, decision.action, archiveId, options.headChars);
      if ((tool.text ?? '') === text) {
        toolUses.push(tool);
        continue;
      }
      const copy: ToolUse = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input, text };
      if (tool.isError) copy.isError = true;
      toolUses.push(copy);
    }
    const toolResults: ToolResult[] = [];
    for (const result of message.toolResults ?? []) {
      const decision = decisionOf.get(result.tool_use_id);
      const call = byUseId.get(result.tool_use_id);
      if (!decision || !call) {
        toolResults.push(result);
        continue;
      }
      const baseline = toBaselineAction(decision.action);
      const archiveId = archiveInteraction(call, decision);
      if (baseline === 'drop_call') continue;
      const text = stubResultText(result.text, call, decision.action, archiveId, options.headChars);
      if (text === result.text) {
        toolResults.push(result);
        continue;
      }
      const copy: ToolResult = { tool_use_id: result.tool_use_id, text };
      if (result.isError !== undefined) copy.isError = result.isError;
      toolResults.push(copy);
    }
    let text = message.text;
    if (removed.length > 0 && options.markRemovedCalls) {
      // Claude Code puts each tool call in its own text-less assistant
      // message, so a message often has nothing left once its call goes:
      // it becomes the marker alone, and a run of them merges below.
      text = message.text.trim().length > 0 ? `${message.text}\n\n${removedCallsMarker(removed)}` : removedCallsMarker(removed);
    }
    const originalResults = message.toolResults ?? [];
    if (
      removed.length === 0 &&
      toolUses.length === message.toolUses.length &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.length === originalResults.length &&
      toolResults.every((result, index) => result === originalResults[index])
    ) {
      kept.push(message);
      continue;
    }
    if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) continue;
    const rebuilt: Message = { role: message.role, text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    const markerOnly = message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0;
    const previous = kept[kept.length - 1];
    const previousRemoved = previous ? markerRuns.get(previous) : undefined;
    if (markerOnly && previous && previousRemoved) {
      const run = [...previousRemoved, ...removed];
      const merged: Message = { role: 'assistant', text: removedCallsMarker(run), toolUses: [] };
      kept[kept.length - 1] = merged;
      markerRuns.set(merged, run);
      continue;
    }
    if (markerOnly) markerRuns.set(rebuilt, removed);
    kept.push(rebuilt);
  }
  return { messages: kept, archived };
}

/**
 * A later reference to a result is strong when it quotes it, repeats an error
 * from it, names its tool id, or comes from the user; a path or symbol the
 * assistant mentions is weak. Strong references protect, weak ones only raise
 * the keep probability (plan §11.C).
 */
export function splitReferences(
  graph: DependencyGraph,
  ledger: Ledger,
): { strong: Map<string, string[]>; weak: Map<string, string[]> } {
  const strong = new Map<string, string[]>();
  const weak = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const from = ledger.byId.get(edge.from);
    const isStrong =
      edge.via === 'error' || edge.via === 'quote' || edge.via === 'tool_id' || from?.kind === 'user_text';
    const target = isStrong ? strong : weak;
    const list = target.get(edge.to) ?? [];
    if (!list.includes(edge.from)) list.push(edge.from);
    target.set(edge.to, list);
  }
  for (const [id] of strong) weak.delete(id);
  return { strong, weak };
}

/** Candidates whose exact interaction (tool, input and result) recurs later; the later one survives. */
function findDuplicates(
  calls: readonly ToolCall[],
  ledger: Ledger,
): Map<string, string> {
  const latest = new Map<string, { call: ToolCall; resultId: string }>();
  const duplicateOf = new Map<string, string>();
  const key = (call: ToolCall, result: NormalizedEvent): string =>
    `${call.tool}\u0000${ledger.interactions.get(call.tool_use_id)!.use.contentHash}\u0000${result.contentHash}`;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    const result = ledger.interactions.get(call.tool_use_id)?.result;
    if (!result || result.content.length < 40) continue;
    const k = key(call, result);
    const later = latest.get(k);
    if (later) {
      if (!call.pinned) duplicateOf.set(call.id, later.resultId);
    } else {
      latest.set(k, { call, resultId: result.id });
    }
  }
  return duplicateOf;
}

function toCallDecision(call: ToolCall, decision: ActionDecision): CallDecision {
  const action = toBaselineAction(decision.action);
  return {
    id: call.id,
    tool: call.tool,
    keepCall: decision.scores?.keepCall ?? 1,
    keepResult: decision.scores?.keepResult ?? 1,
    action,
    reason:
      decision.action === 'PIN_VERBATIM'
        ? 'pinned'
        : action === 'keep'
          ? 'kept'
          : action === 'drop_result'
            ? 'result_dropped'
            : 'call_dropped',
  };
}

/**
 * The context optimizer: pins, protects, de-duplicates, classifies, decides,
 * archives and rebuilds. Everything that leaves the transcript is in the
 * archive before the new transcript is returned. Throws only when the
 * classifier cannot run at all (the caller decides whether to fall back);
 * a partially failed classification keeps whatever it could not score.
 */
export async function optimize(
  messages: readonly Message[],
  options: OptimizeOptions = {},
): Promise<OptimizeResult> {
  const started = Date.now();
  const now = options.now ?? (() => new Date());
  const classifier: Classifier =
    options.classifier ?? (options.asker ? new JevClassifier(options.asker) : new RulesetClassifier());
  const resolved: ResolvedCompactOptions = resolveOptions({
    ...options,
    keepThreshold: options.keepThreshold ?? classifier.defaultThreshold,
  });
  const ruleOptions = resolveRuleOptions(options.rules);
  const policyOptions = resolvePolicyOptions({ ...options.policy, keepThreshold: resolved.keepThreshold });
  const sessionId = options.sessionId ?? 'session';
  const compactionId = options.compactionId ?? defaultCompactionId(now());
  const archive = options.archive ?? new MemoryArchive();
  const redactor =
    options.redact === false ? undefined : options.redact instanceof Redactor ? options.redact : new Redactor();

  const ledger = buildLedger(messages);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const seen = new Map<string, number>();
  for (const call of calls) seen.set(call.tool_use_id, (seen.get(call.tool_use_id) ?? 0) + 1);
  const graph = buildDependencyGraph(ledger);
  const { strong: strongRefs, weak: weakRefs } = splitReferences(graph, ledger);
  const constraints = findConstraints(messages, ledger);
  const duplicates = findDuplicates(calls, ledger);

  const candidates = calls.filter((call) => !call.pinned);
  const protections = new Map<string, Protection[]>();
  for (const call of candidates) {
    const found = protectionsFor(call, {
      messages,
      ledger,
      calls,
      options: ruleOptions,
      referencedBy: strongRefs,
    });
    if ((seen.get(call.tool_use_id) ?? 0) > 1) {
      found.push({ rule: 'ambiguous_structure', detail: 'tool_use_id occurs more than once in the transcript' });
    }
    protections.set(call.id, found);
  }

  const toClassify = candidates.filter(
    (call) => (protections.get(call.id) ?? []).length === 0 && !duplicates.has(call.id),
  );
  let run: ClassifierRun = {
    scores: new Map(),
    stats: { requests: 0, stateTokens: 0, stateStage: '', ms: 0, unscored: [] },
  };
  if (toClassify.length > 0) {
    const shown = redactor ? redactMessages(messages, redactor) : messages;
    const shownCalls = redactor ? collectToolCalls(shown, resolved.preserveRecentMessages) : calls;
    let sketches: Map<string, string> | undefined;
    if (options.sketches !== false) {
      sketches = new Map();
      for (const call of shownCalls) {
        const result = shown[call.resultIndex]?.toolResults?.find((r) => r.tool_use_id === call.tool_use_id);
        if (result) sketches.set(call.id, sketchResult(call.tool, call.input, result.text, call.isError));
      }
    }
    const shownById = new Map(shownCalls.map((call) => [call.id, call]));
    const context = {
      messages: shown,
      ledger: redactor ? buildLedger(shown) : ledger,
      calls: shownCalls,
      options: resolved,
      ...(sketches ? { sketches } : {}),
    };
    run = await classifier.score(
      toClassify.map((call) => shownById.get(call.id) ?? call),
      context,
    );
  }
  const unscored = new Set(run.stats.unscored);

  const decisions: ActionDecision[] = [];
  const baseline: CallDecision[] = [];
  const actionCounts = emptyActionCounts();
  const protectionCounts: Record<string, number> = {};
  for (const call of calls) {
    const pair = ledger.interactions.get(call.tool_use_id)!;
    const found = protections.get(call.id) ?? [];
    const decision = decideInteraction(
      {
        call,
        use: pair.use,
        ...(pair.result ? { result: pair.result } : {}),
        protections: found,
        ...(duplicates.has(call.id) ? { duplicateOf: duplicates.get(call.id) } : {}),
        ...(run.scores.has(call.id) ? { scores: run.scores.get(call.id) } : {}),
        unscored: unscored.has(call.id),
        targetUnchanged: !targetChangedLater(call, calls),
        ...(pair.result && weakRefs.has(pair.result.id) ? { softReferences: weakRefs.get(pair.result.id) } : {}),
      },
      policyOptions,
    );
    decisions.push(decision);
    baseline.push(toCallDecision(call, decision));
    actionCounts[decision.action]++;
    for (const rule of decision.protectedBy) protectionCounts[rule] = (protectionCounts[rule] ?? 0) + 1;
  }

  const applied = applyActions(messages, decisions, calls, ledger, {
    sessionId,
    compactionId,
    archivedAt: now().toISOString(),
    headChars: resolved.truncateHeadChars,
    markRemovedCalls: options.markRemovedCalls !== false,
  });
  if (applied.archived.length > 0) await archive.put(applied.archived);

  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);
  const charsAfter = applied.messages.reduce((sum, message) => sum + messageChars(message), 0);
  const tokensBefore = eventTokens(ledger.events);
  const tokensAfter = eventTokens(buildLedger(applied.messages).events);
  const ms = Date.now() - started;
  const count = (reason: CallDecision['reason']): number => baseline.filter((d) => d.reason === reason).length;

  const report: OptimizeReport = {
    sessionId,
    compactionId,
    classifier: classifier.name,
    messages: { before: messages.length, after: applied.messages.length },
    tokens: {
      before: tokensBefore,
      after: tokensAfter,
      archived: applied.archived.reduce((sum, record) => sum + record.tokenEstimate, 0),
    },
    chars: { before: charsBefore, after: charsAfter },
    actions: actionCounts,
    protections: protectionCounts,
    constraints: constraints.length,
    duplicates: duplicates.size,
    candidates: candidates.length,
    classified: run.scores.size,
    unscored: unscored.size,
    redactedSecrets: redactor?.count ?? 0,
    classifierStats: run.stats,
    ms,
  };

  return {
    messages: applied.messages,
    decisions: baseline,
    actions: decisions,
    archived: applied.archived,
    archive,
    constraints,
    report,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: applied.messages.length,
      charsBefore,
      charsAfter,
      calls: calls.length,
      kept: count('kept'),
      resultsDropped: count('result_dropped'),
      callsDropped: count('call_dropped'),
      pinned: count('pinned'),
      stateTokens: run.stats.stateTokens,
      stateStage: run.stats.stateStage,
      requests: run.stats.requests,
      ms,
    },
  };
}
