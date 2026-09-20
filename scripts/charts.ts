import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalMode, EvalReport, ModeAggregate } from '../src/node/evals/run.js';

/**
 * npm run charts -- [--report reports/<dir>] [--live reports/<dir>] [--out docs/img]
 *
 * Renders the README figures (light and dark SVGs) from eval reports, so the
 * numbers in the pictures are the numbers in the report:
 *
 *   compare.svg   what survives a compaction, per mode — from `--report`, which
 *                 defaults to the newest report that ran CLAUDE_NATIVE_COMPACTION
 *   latency.svg   time per compaction, per mode — the Jev modes' times come from
 *                 `--live`, a run that made real Jev requests (cassette misses)
 *                 rather than replaying cassettes; defaults to the newest such run
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

interface Row {
  mode: EvalMode;
  label: string;
  /** Second line under the label in the fidelity figure. */
  sub: string;
  /** Second line under the label in the latency figure: what the time includes. */
  timed: string;
  ours: boolean;
}

const ROWS: readonly Row[] = [
  { mode: 'OURS_JEV', label: 'lossless-compact + Jev', sub: 'archives, keepThreshold 0.35', timed: 'engine + live Jev requests', ours: true },
  { mode: 'OURS_RULESET', label: 'lossless-compact, local ruleset', sub: 'no model, no key, no network', timed: 'engine only, no network', ours: true },
  { mode: 'CLAUDE_NATIVE_COMPACTION', label: 'Claude Code /compact', sub: 'summary written by Sonnet', timed: 'one full-context model call', ours: false },
  { mode: 'UPSTREAM_FAST_JEV', label: 'upstream fast-jev', sub: 'deletes, keepThreshold 0.5', timed: 'engine + live Jev request', ours: false },
];

interface Metric {
  head: [string, string];
  value: (a: ModeAggregate) => { frac: number; label: string };
}

const pct = (frac: number): string => `${Math.round(frac * 100)}%`;
const ratio = (n: number, d: number) => ({ frac: d ? n / d : 0, label: `${n} / ${d}` });

/** All four read "higher is better"; the first three are exact substring scores, the last is the LLM judge's. */
const METRICS: readonly Metric[] = [
  { head: ['Tokens', 'removed'], value: (a) => ({ frac: a.meanReduction, label: pct(a.meanReduction) }) },
  { head: ['Must-keeps kept', 'verbatim'], value: (a) => ratio(a.mustKeepTotal - a.mustKeepFalseDrop, a.mustKeepTotal) },
  { head: ['Probes still', 'recoverable'], value: (a) => ratio(a.probesRecoverable, a.probesRecoverableRequired) },
  {
    head: ['Droppable content', 'removed (judge)'],
    value: (a) => {
      const frac = a.judgeSafeToDropTotal ? 1 - a.judgeSafeToDropPresent / a.judgeSafeToDropTotal : 0;
      return { frac, label: pct(frac) };
    },
  },
];

interface Theme {
  name: 'light' | 'dark';
  /** GitHub's README background, which the transparent SVG sits on. */
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  track: string;
  ours: string;
  other: string;
}

const THEMES: readonly Theme[] = [
  { name: 'light', surface: '#ffffff', ink: '#1f2328', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', track: '#f0efec', ours: '#2a78d6', other: '#b3b2ab' },
  { name: 'dark', surface: '#0d1117', ink: '#f0f0ee', ink2: '#c3c2b7', muted: '#898781', grid: '#30363d', track: '#1c2128', ours: '#3987e5', other: '#5a5a57' },
];

const W = 880;
const LEFT = 16;
const COL_X = 208;
const ROW_PITCH = 36;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function text(x: number, y: number, s: string, cls: string, anchor: 'start' | 'middle' | 'end' = 'start'): string {
  const a = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
  return `<text x="${x}" y="${y}" class="${cls}"${a}>${esc(s)}</text>`;
}

/** A horizontal bar with a 4px rounded data end and a square baseline. */
function bar(x: number, y: number, w: number, h: number, fill: string): string {
  if (w <= 0) return '';
  const r = Math.min(4, w / 2, h / 2);
  return `<path d="M${x} ${y}h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - r)}z" fill="${fill}"/>`;
}

function rowLabel(y: number, main: string, sub: string): string {
  return text(LEFT, y + 11, main, 'row') + text(LEFT, y + 25, sub, 'rowsub');
}

function svg(t: Theme, h: number, title: string, body: string): string {
  const style = `text{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:${t.ink}}
.title{font-size:15px;font-weight:600}.sub{font-size:12px;fill:${t.ink2}}.head{font-size:11.5px;fill:${t.ink2}}
.row{font-size:13px}.rowsub{font-size:11px;fill:${t.muted}}.val{font-size:12px;font-variant-numeric:tabular-nums}
.tick{font-size:11px;fill:${t.muted}}.key{font-size:11px;fill:${t.ink2}}.grid{stroke:${t.grid};stroke-width:1}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>${style}</style>
${body}
</svg>
`;
}

function key(t: Theme, y: number): string {
  return (
    `<rect x="${LEFT}" y="${y - 9}" width="10" height="10" rx="2" fill="${t.ours}"/>` +
    text(LEFT + 15, y, 'lossless-compact', 'key') +
    `<rect x="${LEFT + 92}" y="${y - 9}" width="10" height="10" rx="2" fill="${t.other}"/>` +
    text(LEFT + 107, y, 'others', 'key')
  );
}

function aggregateOf(report: EvalReport, mode: EvalMode): ModeAggregate {
  const found = report.aggregates.find((a) => a.mode === mode && a.available > 0);
  if (!found) throw new Error(`${mode} did not run in ${report.ranAt} (${report.dataset})`);
  return found;
}

const fmtK = (n: number): string => `${Math.round(n / 1000)}k`;

function compareSvg(report: EvalReport, t: Theme): string {
  const colPitch = 166;
  const barMax = 108;
  const barH = 14;
  const rowY0 = 106;
  const h = rowY0 + ROWS.length * ROW_PITCH + 26;
  const base = report.aggregates.find((a) => a.mode === 'NO_COMPACTION') ?? aggregateOf(report, ROWS[0].mode);
  const tokens = report.results.filter((r) => r.mode === base.mode).reduce((sum, r) => sum + r.tokensBefore, 0);
  const title = 'What survives a compaction';
  const parts = [
    text(LEFT, 24, title, 'title'),
    text(LEFT, 43, `${base.cases} adversarial cases, ${fmtK(tokens)} tokens before compaction · higher is better`, 'sub'),
    `<line x1="${LEFT}" x2="${W - LEFT}" y1="94" y2="94" class="grid"/>`,
  ];
  METRICS.forEach((m, i) => {
    const x = COL_X + i * colPitch;
    parts.push(text(x, 72, m.head[0], 'head'), text(x, 86, m.head[1], 'head'));
  });
  ROWS.forEach((row, ri) => {
    const agg = aggregateOf(report, row.mode);
    const y = rowY0 + ri * ROW_PITCH;
    parts.push(rowLabel(y, row.label, row.sub));
    METRICS.forEach((m, i) => {
      const x = COL_X + i * colPitch;
      const v = m.value(agg);
      parts.push(
        `<rect x="${x}" y="${y}" width="${barMax}" height="${barH}" fill="${t.track}"/>`,
        bar(x, y, Math.round(barMax * v.frac), barH, row.ours ? t.ours : t.other),
        text(x + barMax + 8, y + 11, v.label, 'val'),
      );
    });
  });
  parts.push(key(t, h - 10));
  return svg(t, h, title, parts.join('\n'));
}

interface Timing {
  mean: number;
  min: number;
  max: number;
}

function timingOf(report: EvalReport, mode: EvalMode): Timing {
  const ms = report.results.filter((r) => r.mode === mode && r.available).map((r) => r.ms);
  if (ms.length === 0) throw new Error(`${mode} did not run in ${report.ranAt}`);
  return { mean: ms.reduce((a, b) => a + b, 0) / ms.length, min: Math.min(...ms), max: Math.max(...ms) };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10000 && ms % 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

/** "~160×", "~2,100×": two significant figures at most, so a ratio never reads as precise. */
function fmtTimes(ratio: number): string {
  const unit = 10 ** Math.max(1, Math.floor(Math.log10(ratio)) - 1);
  return `~${(Math.round(ratio / unit) * unit).toLocaleString('en-US')}×`;
}

function latencySvg(report: EvalReport, live: EvalReport | undefined, t: Theme): string {
  const axisX0 = COL_X;
  const axisX1 = 720;
  const rowY0 = 72;
  const decades = [10, 100, 1000, 10000, 100000];
  const x = (ms: number): number => axisX0 + ((Math.log10(ms) - 1) / (decades.length - 1)) * (axisX1 - axisX0);
  const axisY = rowY0 + ROWS.length * ROW_PITCH - 8;
  const h = axisY + 36;

  const timings = new Map<EvalMode, Timing>();
  for (const row of ROWS) {
    const source = live && aggregateOf(report, row.mode).requests > 0 && row.mode !== 'CLAUDE_NATIVE_COMPACTION' ? live : report;
    timings.set(row.mode, timingOf(source, row.mode));
  }
  const summary = timings.get('CLAUDE_NATIVE_COMPACTION')!.mean;
  const jev = timings.get('OURS_JEV')!.mean;
  const ruleset = timings.get('OURS_RULESET')!.mean;

  const title = 'Time per compaction';
  const parts = [
    text(LEFT, 24, title, 'title'),
    text(LEFT, 43, `same cases, log scale · lossless-compact + Jev is ${fmtTimes(summary / jev)} faster than a summary, the local ruleset ${fmtTimes(summary / ruleset)}`, 'sub'),
  ];
  for (const ms of decades) {
    parts.push(
      `<line x1="${x(ms).toFixed(1)}" x2="${x(ms).toFixed(1)}" y1="${rowY0 - 12}" y2="${axisY}" class="grid"/>`,
      text(x(ms), axisY + 18, fmtMs(ms), 'tick', 'middle'),
    );
  }
  ROWS.forEach((row, ri) => {
    const timing = timings.get(row.mode)!;
    const y = rowY0 + ri * ROW_PITCH;
    const cy = y + 7;
    const color = row.ours ? t.ours : t.other;
    parts.push(
      rowLabel(y, row.label, row.timed),
      `<line x1="${x(timing.min).toFixed(1)}" x2="${x(timing.max).toFixed(1)}" y1="${cy}" y2="${cy}" stroke="${color}" stroke-width="2" stroke-linecap="round" opacity="0.45"/>`,
      `<circle cx="${x(timing.mean).toFixed(1)}" cy="${cy}" r="6" fill="${color}" stroke="${t.surface}" stroke-width="2"/>`,
      text(x(timing.max) + 12, cy + 4, fmtMs(timing.mean), 'val'),
    );
  });
  parts.push(key(t, h - 10));
  return svg(t, h, title, parts.join('\n'));
}

/** Reads a report; reports written by 0.5.0 and earlier call the ruleset mode OURS_HEURISTIC. */
async function loadReport(dir: string): Promise<EvalReport> {
  const text = await readFile(join(dir, 'report.json'), 'utf8');
  return JSON.parse(text.replaceAll('"OURS_HEURISTIC"', '"OURS_RULESET"')) as EvalReport;
}

/** Newest report under `root` that `accept`s, by directory name (an ISO timestamp). */
async function newestReport(root: string, accept: (report: EvalReport) => boolean): Promise<[string, EvalReport] | undefined> {
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  for (const dir of dirs) {
    try {
      const report = await loadReport(join(root, dir));
      if (accept(report)) return [join(root, dir), report];
    } catch {
      // not a report directory
    }
  }
  return undefined;
}

const ranLive = (report: EvalReport, mode: EvalMode): boolean =>
  report.results.some((r) => r.mode === mode && r.available && r.cassette.misses > 0);

const root = 'reports';
const reportDir = arg('report');
const chosen = reportDir
  ? ([reportDir, await loadReport(reportDir)] as const)
  : await newestReport(root, (r) => r.aggregates.some((a) => a.mode === 'CLAUDE_NATIVE_COMPACTION' && a.available > 0));
if (!chosen) {
  console.error(`no report under ${root}/ ran CLAUDE_NATIVE_COMPACTION; run \`npm run eval -- --native --judge all\` or pass --report`);
  process.exit(2);
}
const [chosenDir, report] = chosen;

const liveDir = arg('live');
const liveChosen = liveDir
  ? ([liveDir, await loadReport(liveDir)] as const)
  : await newestReport(root, (r) => ranLive(r, 'OURS_JEV') && ranLive(r, 'UPSTREAM_FAST_JEV'));
if (liveChosen && !(ranLive(liveChosen[1], 'OURS_JEV') && ranLive(liveChosen[1], 'UPSTREAM_FAST_JEV'))) {
  console.warn(`${liveChosen[0]} replayed cassettes for a Jev mode; its times exclude the Jev round trip`);
}
if (!liveChosen) console.warn('no live Jev run found; the latency figure shows cassette-replay times for the Jev modes');

const out = arg('out') ?? join('docs', 'img');
await mkdir(out, { recursive: true });
for (const t of THEMES) {
  const suffix = t.name === 'dark' ? '-dark' : '';
  await writeFile(join(out, `compare${suffix}.svg`), compareSvg(report, t));
  await writeFile(join(out, `latency${suffix}.svg`), latencySvg(report, liveChosen?.[1], t));
}
console.log(`fidelity from ${chosenDir}${liveChosen ? `, Jev timing from ${liveChosen[0]}` : ''} → ${out}/{compare,latency}{,-dark}.svg`);
