import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MemoryArchive } from '../../archive/memory-store.js';
import type { ArchiveRecord } from '../../archive/types.js';
import { HeuristicClassifier } from '../../classifiers/heuristic.js';
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
import { scoreFidelity, type FidelityScores } from './scorers.js';

export const EVAL_MODES = [
  'NO_COMPACTION',
  'CLAUDE_NATIVE_COMPACTION',
  'UPSTREAM_FAST_JEV',
  'OURS_HEURISTIC',
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
  structureFailures: number;
  verbatimFailures: number;
  meanMs: number;
  requests: number;
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
    case 'CLAUDE_NATIVE_COMPACTION':
      return { unavailable: 'needs the host model; run inside Claude Code (see docs/evals.md)' };
    case 'UPSTREAM_FAST_JEV': {
      if (!asker) return { unavailable: 'no cassette and no TYPESAFE_API_KEY' };
      const result = await compact(transcript, asker, { keepThreshold: 0.5, ...common });
      return { output: result.messages, archived: [], requests: result.stats.requests, ms: Date.now() - started };
    }
    case 'OURS_HEURISTIC':
    case 'OURS_JEV':
    case 'OURS_JEV_UPSTREAM_WORDING': {
      let classifier: Classifier;
      if (mode === 'OURS_HEURISTIC') classifier = new HeuristicClassifier();
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
      results.push({
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
      });
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
      structureFailures: ok.filter((r) => !r.fidelity.structureValid).length,
      verbatimFailures: ok.filter((r) => !r.fidelity.keptVerbatim || !r.fidelity.orderPreserved).length,
      meanMs: ok.length ? sum((r) => r.ms) / ok.length : 0,
      requests: sum((r) => r.requests),
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
  const lines: string[] = [];
  lines.push(`# Eval report — ${report.dataset}`, '', `Ran ${report.ranAt}.`, '');
  lines.push('## By mode', '');
  lines.push('| Mode | Cases | Mean reduction | must_keep false drops | must_keep truncated | Probes active | Probes recoverable | Structure/verbatim failures | Mean ms | Requests |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const a of report.aggregates) {
    lines.push(
      `| ${a.mode} | ${a.available}/${a.cases} | ${pct(a.meanReduction)} | ${ratio(a.mustKeepFalseDrop, a.mustKeepTotal)} | ${ratio(a.mustKeepTruncated, a.mustKeepTotal)} | ${ratio(a.probesActiveRetained, a.probesActiveRequired)} | ${ratio(a.probesRecoverable, a.probesRecoverableRequired)} | ${a.structureFailures}/${a.verbatimFailures} | ${a.meanMs.toFixed(0)} | ${a.requests} |`,
    );
  }
  lines.push('', '## By case', '');
  lines.push('| Case | Mode | Tokens before → after | Reduction | must_keep drops | Probes active | Probes recoverable | Missing probes | Notes |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const r of report.results) {
    const f = r.fidelity;
    const note = r.error ? `error: ${r.error}` : !r.available ? `n/a: ${r.reason}` : [
      !f.structureValid ? 'BROKEN STRUCTURE' : '',
      !f.orderPreserved ? 'REORDERED' : '',
      !f.keptVerbatim ? 'REWRITTEN' : '',
      r.actions ? Object.entries(r.actions).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ') : '',
    ].filter(Boolean).join('; ');
    lines.push(
      `| ${r.case} | ${r.mode} | ${r.tokensBefore.toLocaleString('en-US')} → ${r.tokensAfter.toLocaleString('en-US')} | ${pct(r.reduction)} | ${ratio(f.mustKeepFalseDrop, f.mustKeepTotal)} | ${ratio(f.probes.activeRetained, f.probes.activeRequired)} | ${ratio(f.probes.recoverable, f.probes.recoverableRequired)} | ${f.probes.missing.join(', ') || '–'} | ${note} |`,
    );
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
