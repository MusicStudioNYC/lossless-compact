import { EVAL_MODES, markdownReport, runEval, type EvalMode } from '../src/node/evals/run.js';

/**
 * npm run eval -- --dataset datasets/v1 [--modes OURS_HEURISTIC,UPSTREAM_FAST_JEV]
 *   [--filter needle] [--threshold 0.15] [--margin 0.05] [--recent 6] [--record] [--out reports]
 *
 * Modes that need Jev run from each case's `cassette.json`; with `--record`
 * and TYPESAFE_API_KEY set, misses are asked live and saved.
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const modesArg = arg('modes');
const modes = modesArg
  ? (modesArg.split(',').map((m) => m.trim()) as EvalMode[])
  : [...EVAL_MODES];
for (const mode of modes) {
  if (!EVAL_MODES.includes(mode)) {
    console.error(`unknown mode ${mode}; known: ${EVAL_MODES.join(', ')}`);
    process.exit(2);
  }
}

const number = (name: string): number | undefined => {
  const value = arg(name);
  return value === undefined ? undefined : Number(value);
};

const report = await runEval({
  dataset: arg('dataset') ?? 'datasets/v1',
  modes,
  filter: arg('filter'),
  keepThreshold: number('threshold'),
  safetyMargin: number('margin'),
  preserveRecentMessages: number('recent'),
  record: flag('record'),
  apiKey: process.env['TYPESAFE_API_KEY'],
  out: arg('out') ?? 'reports',
});

process.stdout.write(markdownReport(report));
