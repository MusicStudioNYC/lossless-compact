import { claudeCli, defaultModel } from '../src/node/evals/model.js';
import { EVAL_MODES, markdownReport, runEval, type EvalMode } from '../src/node/evals/run.js';

/**
 * npm run eval -- --dataset datasets/v1 [--modes OURS_RULESET,UPSTREAM_FAST_JEV]
 *   [--filter needle] [--threshold 0.15] [--margin 0.05] [--recent 6] [--record] [--out reports]
 *   [--native] [--judge native|all] [--native-keep-recent 6] [--model sonnet]
 *
 * Modes that need Jev run from each case's `cassette.json`; with `--record`
 * and TYPESAFE_API_KEY set, misses are asked live and saved.
 *
 * `--native` runs `CLAUDE_NATIVE_COMPACTION` for real (needs a live model:
 * `ANTHROPIC_API_KEY`, or the `claude` CLI on PATH — see docs/evals.md).
 * `--judge` scores retention with an LLM judge, on the native summary only
 * ('native') or on every available mode's output ('all'); it needs the same
 * model. `--model <name>` forces `claude -p --model <name>` regardless of
 * `ANTHROPIC_API_KEY` (default: sonnet, for cost).
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
  ? (modesArg.split(',').map((m) => (m.trim() === 'OURS_HEURISTIC' ? 'OURS_RULESET' : m.trim())) as EvalMode[])
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

const judgeArg = arg('judge');
if (judgeArg !== undefined && judgeArg !== 'native' && judgeArg !== 'all') {
  console.error(`unknown --judge value ${judgeArg}; expected native or all`);
  process.exit(2);
}

const needsModel = flag('native') || judgeArg !== undefined;
const modelName = arg('model');
const model = needsModel ? (modelName ? claudeCli({ model: modelName }) : defaultModel()) : undefined;
if (needsModel && !model) {
  console.error(
    'no model available for --native/--judge: set ANTHROPIC_API_KEY, or install the `claude` CLI on PATH (see docs/evals.md)',
  );
  process.exit(2);
}

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
  ...(model ? { model } : {}),
  ...(judgeArg ? { judge: judgeArg } : {}),
  ...(number('native-keep-recent') !== undefined ? { nativeKeepRecent: number('native-keep-recent') } : {}),
});

process.stdout.write(markdownReport(report));
