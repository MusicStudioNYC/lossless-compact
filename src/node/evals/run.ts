import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MemoryArchive } from '../../archive/memory-store.js';
import type { ArchiveRecord } from '../../archive/types.js';
import { RulesetClassifier } from '../../classifiers/ruleset.js';
import { JevClassifier } from '../../classifiers/jev.js';
import { ReplayAsker, emptyCassette, parseCassette, serialiseCassette, type Cassette } from '../../classifiers/replay.js';
import type { Classifier } from '../../classifiers/types.js';
import { JevClient } from '../../client.js';
import { compact } from '../../compact.js';
import type { ContextAction } from '../../core/actions.js';
import { buildLedger, eventTokens } from '../../core/events.js';
import { optimize } from '../../engine/optimize.js';
import type { JevAsker, Message } from '../../types.js';
import { listCases, type DatasetCase } from './dataset.js';
import { judgeItemsFor, judgeRetention, type JudgeItem, type JudgeResult } from './judge.js';
import type { ModelCall } from './model.js';
import { nativeCompaction } from './native.js';
import { scoreFidelity, type FidelityScores } from './scorers.js';

export const EVAL_MODES = [
  'NO_COMPACTION',
  'CLAUDE_NATIVE_COMPACTION',
  'UPSTREAM_FAST_JEV',
  'OURS_RULESET',
  'OURS_JEV',
  'OURS_JEV_UPSTREAM_WORDING',
] as const;

export type EvalMode = (typeof EVAL_MODES)[number];

export interface EvalOptions {
  dataset: string;
  modes?: readonly EvalMode[];
  /** Only cases whose name contains this. */
  filter?: string;
  keepThreshold?: number;
  safetyMargin?: number;
  preserveRecentMessages?: number;
  /** Call Jev for cassette misses and save the cassette. Needs `apiKey`. */
  record?: boolean;
  apiKey?: string;
  /** Where to write `report.json` and `report.md`; none when unset. */
  out?: string;
  now?: () => Date;
  /** A live model, for `CLAUDE_NATIVE_COMPACTION` and the retention judge. */
  model?: ModelCall;
  /** Score retention with an LLM judge: on the native summary only, or on every available mode. Default 'none'. */
  judge?: 'none' | 'native' | 'all';
  /** Messages kept verbatim after the native summary. Default 0 (Claude Code itself keeps none). */
  nativeKeepRecent?: number;
}

/** Per-item retention counts from the LLM judge, for one case/mode result. */
export interface JudgedCounts {
  mustKeepAbsent: number;
  mustKeepTotal: number;
  probesAbsent: number;
  probesTotal: number;
  probesParaphrased: number;
  safeToDropPresent: number;
  safeToDropTotal: number;
  missingVerdicts: number;
  ms: number;
}

export interface CaseModeResult {
  case: string;
  mode: EvalMode;
  available: boolean;
  reason?: string;
  error?: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  /** Fraction of estimated tokens removed from the active transcript. */
  reduction: number;
  archivedTokens: number;
  actions?: Record<ContextAction, number>;
  requests: number;
  ms: number;
  cassette: { hits: number; misses: number; recorded: number };
  fidelity: FidelityScores;
  /** `CLAUDE_NATIVE_COMPACTION` only: length of the summary text it produced. */
  summaryChars?: number;
  /** `CLAUDE_NATIVE_COMPACTION` only: whether the 600k render cap forced abridging older turns before summarizing. */
  abridged?: boolean;
  /** LLM-judge retention counts, when `judge` asked for this mode. */
  judged?: JudgedCounts;
}

export interface ModeAggregate {
  mode: EvalMode;
  cases: number;
  available: number;
  meanReduction: number;
  mustKeepTotal: number;
  mustKeepFalseDrop: number;
  mustKeepTruncated: number;
  probesActiveRequired: number;
  probesActiveRetained: number;
  probesRecoverableRequired: number;
  probesRecoverable: number;
  safeToDropTotal: number;
  safeToDropKept: number;
  structureFailures: number;
  verbatimFailures: number;
  meanMs: number;
  requests: number;
  /** Rows that carry judge data (0 when `judge` was 'none' or unavailable for this mode). */
  judgedCases: number;
  judgeMustKeepAbsent: number;
  judgeMustKeepTotal: number;
  judgeProbesAbsent: number;
  judgeProbesTotal: number;
  judgeProbesParaphrased: number;
  judgeSafeToDropPresent: number;
  judgeSafeToDropTotal: number;
  judgeMissingVerdicts: number;
}

export interface EvalReport {
  dataset: string;
  ranAt: string;
  options: Omit<EvalOptions, 'apiKey' | 'now'>;
  results: CaseModeResult[];
  aggregates: ModeAggregate[];
}

function tokensOf(messages: readonly Message[]): number {
  return eventTokens(buildLedger(messages).events);
}

/** Turns raw judge verdicts into the counts the report shows, split by why each item was included. */
function summarizeJudge(items: readonly JudgeItem[], judged: JudgeResult): JudgedCounts {
  const byId = new Map(judged.verdicts.map((verdict) => [verdict.id, verdict]));
  let mustKeepAbsent = 0;
  let mustKeepTotal = 0;
  let probesAbsent = 0;
  let probesTotal = 0;
  let probesParaphrased = 0;
  let safeToDropPresent = 0;
  let safeToDropTotal = 0;
  for (const item of items) {
    const present = byId.get(item.id)?.present ?? 'absent';
    if (item.expected === 'kept') {
      if (item.id.startsWith('call:')) {
        mustKeepTotal++;
        if (present === 'absent') mustKeepAbsent++;
      } else {
        probesTotal++;
        if (present === 'absent') probesAbsent++;
        else if (present === 'paraphrased') probesParaphrased++;
      }
    } else {
      safeToDropTotal++;
      if (present !== 'absent') safeToDropPresent++;
    }
  }
  return {
    mustKeepAbsent,
    mustKeepTotal,
    probesAbsent,
    probesTotal,
    probesParaphrased,
    safeToDropPresent,
    safeToDropTotal,
    missingVerdicts: judged.missingVerdicts,
    ms: judged.ms,
  };
}

async function loadCassette(path: string): Promise<Cassette> {
  try {
    return parseCassette(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return emptyCassette();
    throw error;
  }
}

interface Run {
  output: Message[];
  archived: ArchiveRecord[];
  actions?: Record<ContextAction, number>;
  requests: number;
  ms: number;
  native?: { summaryChars: number; abridged: boolean };
}

async function runMode(
  mode: EvalMode,
  transcript: Message[],
  options: EvalOptions,
  asker: JevAsker | undefined,
): Promise<Run | { unavailable: string }> {
  const common = {
    ...(options.keepThreshold !== undefined ? { keepThreshold: options.keepThreshold } : {}),
    ...(options.preserveRecentMessages !== undefined ? { preserveRecentMessages: options.preserveRecentMessages } : {}),
  };
  const started = Date.now();
  switch (mode) {
    case 'NO_COMPACTION':
      return { output: [...transcript], archived: [], requests: 0, ms: 0 };
    case 'CLAUDE_NATIVE_COMPACTION': {
      if (!options.model) {
        return { unavailable: 'no model configured (pass --native, or `model` in EvalOptions; see docs/evals.md)' };
      }
      const keepRecent = options.nativeKeepRecent ?? 0;
      const result = await nativeCompaction(transcript, options.model, { keepRecent });
      return {
        output: result.output,
        archived: [],
        requests: 1,
        ms: result.ms,
        native: { summaryChars: result.summary.length, abridged: result.abridged },
      };
    }
    case 'UPSTREAM_FAST_JEV': {
      if (!asker) return { unavailable: 'no cassette and no TYPESAFE_API_KEY' };
      const result = await compact(transcript, asker, { keepThreshold: 0.5, ...common });
      return { output: result.messages, archived: [], requests: result.stats.requests, ms: Date.now() - started };
    }
    case 'OURS_RULESET':
    case 'OURS_JEV':
    case 'OURS_JEV_UPSTREAM_WORDING': {
      let classifier: Classifier;
      if (mode === 'OURS_RULESET') classifier = new RulesetClassifier();
      else {
        if (!asker) return { unavailable: 'no cassette and no TYPESAFE_API_KEY' };
        classifier = new JevClassifier(asker, {
          questionStyle: mode === 'OURS_JEV' ? 'useful' : 'upstream',
        });
      }
      const result = await optimize(transcript, {
        ...common,
        classifier,
        archive: new MemoryArchive(),
        sessionId: 'eval',
        compactionId: 'eval',
        ...(options.safetyMargin !== undefined ? { policy: { safetyMargin: options.safetyMargin } } : {}),
        now: options.now,
      });
      return {
        output: result.messages,
        archived: result.archived,
        actions: result.report.actions,
        requests: result.stats.requests,
        ms: Date.now() - started,
      };
    }
  }
}

export async function evaluateCase(
  item: DatasetCase,
  modes: readonly EvalMode[],
  options: EvalOptions,
): Promise<CaseModeResult[]> {
  const cassette = await loadCassette(item.cassettePath);
  const inner = options.record && options.apiKey ? new JevClient({ apiKey: options.apiKey }) : undefined;
  const hasJev = inner !== undefined || Object.keys(cassette.entries).length > 0;
  const asker = hasJev ? new ReplayAsker(cassette, inner, inner ? 'auto' : 'replay') : undefined;
  const results: CaseModeResult[] = [];
  const tokensBefore = tokensOf(item.transcript);
  const judgeMode = options.judge ?? 'none';
  const judgeItems = judgeMode !== 'none' && options.model ? judgeItemsFor(item) : undefined;
  for (const mode of modes) {
    const before = asker ? { ...asker.stats } : { hits: 0, misses: 0, recorded: 0 };
    const base = {
      case: item.name,
      mode,
      messagesBefore: item.transcript.length,
      tokensBefore,
    };
    try {
      const run = await runMode(mode, item.transcript, options, asker);
      const after = asker ? asker.stats : before;
      const delta = {
        hits: after.hits - before.hits,
        misses: after.misses - before.misses,
        recorded: after.recorded - before.recorded,
      };
      if ('unavailable' in run) {
        results.push({
          ...base,
          available: false,
          reason: run.unavailable,
          messagesAfter: item.transcript.length,
          tokensAfter: tokensBefore,
          reduction: 0,
          archivedTokens: 0,
          requests: 0,
          ms: 0,
          cassette: delta,
          fidelity: scoreFidelity(item.transcript, item.transcript, item.labels, []),
        });
        continue;
      }
      const tokensAfter = tokensOf(run.output);
      const result: CaseModeResult = {
        ...base,
        available: true,
        messagesAfter: run.output.length,
        tokensAfter,
        reduction: tokensBefore === 0 ? 0 : (tokensBefore - tokensAfter) / tokensBefore,
        archivedTokens: run.archived.reduce((sum, record) => sum + record.tokenEstimate, 0),
        ...(run.actions ? { actions: run.actions } : {}),
        requests: run.requests,
        ms: run.ms,
        cassette: delta,
        fidelity: scoreFidelity(item.transcript, run.output, item.labels, run.archived),
        ...(run.native ? { summaryChars: run.native.summaryChars, abridged: run.native.abridged } : {}),
      };
      const shouldJudge =
        judgeItems &&
        options.model &&
        (judgeMode === 'all' || (judgeMode === 'native' && mode === 'CLAUDE_NATIVE_COMPACTION'));
      if (shouldJudge) {
        const judged = await judgeRetention(run.output, judgeItems!, options.model!);
        result.judged = summarizeJudge(judgeItems!, judged);
      }
      results.push(result);
    } catch (error) {
      results.push({
        ...base,
        available: true,
        error: error instanceof Error ? error.message : String(error),
        messagesAfter: item.transcript.length,
        tokensAfter: tokensBefore,
        reduction: 0,
        archivedTokens: 0,
        requests: 0,
        ms: 0,
        cassette: { hits: 0, misses: 0, recorded: 0 },
        fidelity: scoreFidelity(item.transcript, item.transcript, item.labels, []),
      });
    }
  }
  if (asker && asker.stats.recorded > 0 && options.record) {
    await writeFile(item.cassettePath, serialiseCassette(asker.cassette));
  }
  return results;
}

export function aggregate(results: readonly CaseModeResult[]): ModeAggregate[] {
  const modes = [...new Set(results.map((r) => r.mode))];
  return modes.map((mode) => {
    const rows = results.filter((r) => r.mode === mode);
    const ok = rows.filter((r) => r.available && !r.error);
    const sum = (f: (r: CaseModeResult) => number): number => ok.reduce((s, r) => s + f(r), 0);
    return {
      mode,
      cases: rows.length,
      available: ok.length,
      meanReduction: ok.length ? sum((r) => r.reduction) / ok.length : 0,
      mustKeepTotal: sum((r) => r.fidelity.mustKeepTotal),
      mustKeepFalseDrop: sum((r) => r.fidelity.mustKeepFalseDrop),
      mustKeepTruncated: sum((r) => r.fidelity.mustKeepTruncated),
      probesActiveRequired: sum((r) => r.fidelity.probes.activeRequired),
      probesActiveRetained: sum((r) => r.fidelity.probes.activeRetained),
      probesRecoverableRequired: sum((r) => r.fidelity.probes.recoverableRequired),
      probesRecoverable: sum((r) => r.fidelity.probes.recoverable),
      safeToDropTotal: sum((r) => r.fidelity.safeToDropTotal),
      safeToDropKept: sum((r) => r.fidelity.safeToDropKept),
      structureFailures: ok.filter((r) => !r.fidelity.structureValid).length,
      verbatimFailures: ok.filter((r) => !r.fidelity.keptVerbatim || !r.fidelity.orderPreserved).length,
      meanMs: ok.length ? sum((r) => r.ms) / ok.length : 0,
      requests: sum((r) => r.requests),
      judgedCases: ok.filter((r) => r.judged).length,
      judgeMustKeepAbsent: ok.reduce((s, r) => s + (r.judged?.mustKeepAbsent ?? 0), 0),
      judgeMustKeepTotal: ok.reduce((s, r) => s + (r.judged?.mustKeepTotal ?? 0), 0),
      judgeProbesAbsent: ok.reduce((s, r) => s + (r.judged?.probesAbsent ?? 0), 0),
      judgeProbesTotal: ok.reduce((s, r) => s + (r.judged?.probesTotal ?? 0), 0),
      judgeProbesParaphrased: ok.reduce((s, r) => s + (r.judged?.probesParaphrased ?? 0), 0),
      judgeSafeToDropPresent: ok.reduce((s, r) => s + (r.judged?.safeToDropPresent ?? 0), 0),
      judgeSafeToDropTotal: ok.reduce((s, r) => s + (r.judged?.safeToDropTotal ?? 0), 0),
      judgeMissingVerdicts: ok.reduce((s, r) => s + (r.judged?.missingVerdicts ?? 0), 0),
    };
  });
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ratio(part: number, whole: number): string {
  return whole === 0 ? '–' : `${part}/${whole}`;
}

export function markdownReport(report: EvalReport): string {
  const hasJudge = report.results.some((r) => r.judged);
  const lines: string[] = [];
  lines.push(`# Eval report — ${report.dataset}`, '', `Ran ${report.ranAt}.`, '');

  lines.push('## By mode', '');
  const modeHeaders = [
    'Mode',
    'Cases',
    'Mean reduction',
    'must_keep false drops',
    'must_keep truncated',
    'Probes active',
    'Probes recoverable',
    'safe_to_drop kept (exact)',
    ...(hasJudge ? ['must_keep lost (judge)', 'probes lost (judge)', 'safe_to_drop still present (judge)'] : []),
    'Mean ms',
    'Requests',
    'Notes',
  ];
  lines.push(`| ${modeHeaders.join(' | ')} |`);
  lines.push(`| ${modeHeaders.map((_, i) => (i === 0 || i === modeHeaders.length - 1 ? '---' : '---:')).join(' | ')} |`);
  for (const a of report.aggregates) {
    const cells = [
      a.mode,
      `${a.available}/${a.cases}`,
      pct(a.meanReduction),
      ratio(a.mustKeepFalseDrop, a.mustKeepTotal),
      ratio(a.mustKeepTruncated, a.mustKeepTotal),
      ratio(a.probesActiveRetained, a.probesActiveRequired),
      ratio(a.probesRecoverable, a.probesRecoverableRequired),
      ratio(a.safeToDropKept, a.safeToDropTotal),
      ...(hasJudge
        ? [
            ratio(a.judgeMustKeepAbsent, a.judgeMustKeepTotal),
            ratio(a.judgeProbesAbsent, a.judgeProbesTotal),
            ratio(a.judgeSafeToDropPresent, a.judgeSafeToDropTotal),
          ]
        : []),
      a.meanMs.toFixed(0),
      String(a.requests),
      `structure ${a.structureFailures}, verbatim ${a.verbatimFailures}`,
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }

  lines.push('', '## By case', '');
  const caseHeaders = [
    'Case',
    'Mode',
    'Tokens before → after',
    'Reduction',
    'must_keep drops',
    'Probes active',
    'Probes recoverable',
    'safe_to_drop kept (exact)',
    ...(hasJudge ? ['must_keep lost (judge)', 'probes lost (judge)', 'safe_to_drop still present (judge)'] : []),
    'Missing probes',
    'Notes',
  ];
  lines.push(`| ${caseHeaders.join(' | ')} |`);
  lines.push(
    `| ${caseHeaders
      .map((_, i) => (i < 2 || i >= caseHeaders.length - 2 ? '---' : '---:'))
      .join(' | ')} |`,
  );
  for (const r of report.results) {
    const f = r.fidelity;
    const note = r.error
      ? `error: ${r.error}`
      : !r.available
        ? `n/a: ${r.reason}`
        : [
            !f.structureValid ? 'BROKEN STRUCTURE' : '',
            !f.orderPreserved ? 'REORDERED' : '',
            !f.keptVerbatim ? 'REWRITTEN' : '',
            r.actions
              ? Object.entries(r.actions)
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => `${k}=${n}`)
                  .join(' ')
              : '',
            r.summaryChars !== undefined ? `summary=${r.summaryChars}ch` : '',
            r.abridged ? 'TRANSCRIPT ABRIDGED before summarizing (exceeded the 600k render cap)' : '',
          ]
            .filter(Boolean)
            .join('; ');
    const cells = [
      r.case,
      r.mode,
      `${r.tokensBefore.toLocaleString('en-US')} → ${r.tokensAfter.toLocaleString('en-US')}`,
      pct(r.reduction),
      ratio(f.mustKeepFalseDrop, f.mustKeepTotal),
      ratio(f.probes.activeRetained, f.probes.activeRequired),
      ratio(f.probes.recoverable, f.probes.recoverableRequired),
      ratio(f.safeToDropKept, f.safeToDropTotal),
      ...(hasJudge
        ? [
            r.judged ? ratio(r.judged.mustKeepAbsent, r.judged.mustKeepTotal) : '–',
            r.judged ? ratio(r.judged.probesAbsent, r.judged.probesTotal) : '–',
            r.judged ? ratio(r.judged.safeToDropPresent, r.judged.safeToDropTotal) : '–',
          ]
        : []),
      f.probes.missing.join(', ') || '–',
      note,
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const modes = options.modes ?? EVAL_MODES;
  const now = options.now ?? (() => new Date());
  const cases = (await listCases(options.dataset)).filter(
    (item) => !options.filter || item.name.includes(options.filter),
  );
  if (cases.length === 0) throw new Error(`no cases under ${options.dataset}`);
  const results: CaseModeResult[] = [];
  for (const item of cases) results.push(...(await evaluateCase(item, modes, options)));
  const { apiKey: _key, now: _now, ...rest } = options;
  const report: EvalReport = {
    dataset: options.dataset,
    ranAt: now().toISOString(),
    options: rest,
    results,
    aggregates: aggregate(results),
  };
  if (options.out) {
    const dir = join(options.out, report.ranAt.replace(/[:.]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 1));
    await writeFile(join(dir, 'report.md'), markdownReport(report));
  }
  return report;
}
