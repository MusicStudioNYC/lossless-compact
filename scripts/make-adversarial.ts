#!/usr/bin/env tsx
/**
 * Generates the adversarial eval dataset: eight synthetic transcripts, each
 * built to exercise one specific way a compaction engine can lose something
 * that still matters. Fully deterministic — every random choice comes from a
 * seeded mulberry32 PRNG, never from `Date` or `Math.random` — so re-running
 * this script reproduces byte-identical `transcript.json` files.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { CallLabel, Labels, Probe } from '../src/node/evals/dataset.js';
import { countToolCalls, estimateTranscriptTokens, transcriptChars, writeCase } from '../src/node/evals/dataset.js';
import type { Message } from '../src/types.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty array');
    return item;
  }
  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }
}

// ---------------------------------------------------------------------------
// Content banks — generic, deterministic filler with enough variety that a
// classifier can't trivially pattern-match on fixed strings.
// ---------------------------------------------------------------------------

const AREAS = [
  'services', 'controllers', 'routes', 'models', 'utils', 'components',
  'hooks', 'lib', 'middleware', 'jobs', 'workers', 'adapters', 'schemas', 'validators',
] as const;

const TOPICS = [
  'auth', 'billing', 'user', 'order', 'cart', 'email', 'notification', 'session',
  'cache', 'queue', 'metrics', 'logging', 'search', 'payment', 'inventory', 'shipping',
  'profile', 'report', 'webhook', 'upload', 'pricing', 'shipment', 'refund', 'tax',
  'coupon', 'address', 'review', 'wishlist',
] as const;

const SUFFIXES = [
  'service', 'controller', 'handler', 'repository', 'client', 'helper', 'validator', 'worker',
] as const;

const NARRATIONS = [
  'Checking the related module next.',
  'That looks fine; moving on.',
  'Let me also verify the test coverage here.',
  'No issues found there.',
  'Continuing through the remaining files.',
  'Nothing surprising in this one.',
  "I'll take a quick look at the neighbouring code too.",
  'Making a note of this and moving to the next file.',
  'This matches what I expected.',
  'One more check before continuing.',
] as const;

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function randomFilePath(rng: Rng): string {
  return `src/${rng.pick(AREAS)}/${rng.pick(TOPICS)}-${rng.pick(SUFFIXES)}.ts`;
}

/** A plausible TypeScript-flavoured file body, deterministically padded to roughly `targetChars`. */
function codeSnippet(rng: Rng, filePath: string, targetChars: number): string {
  const topic = rng.pick(TOPICS);
  const header = [
    `// ${filePath}`,
    `import { logger } from '../lib/logger.js';`,
    '',
    `export interface ${cap(topic)}Options {`,
    `  retries?: number;`,
    `  timeoutMs?: number;`,
    `}`,
    '',
    `export async function process${cap(topic)}(id: string, options: ${cap(topic)}Options = {}): Promise<void> {`,
    `  logger.debug('processing ${topic}', { id, options });`,
  ].join('\n');
  let body = `${header}\n`;
  let i = 0;
  while (body.length < targetChars) {
    body += `  // step ${i}: validate ${rng.pick(TOPICS)} field #${rng.int(1, 999)}\n`;
    i += 1;
  }
  body += '}\n';
  return body;
}

function testRunOutput(rng: Rng, file: string, pass: boolean): string {
  const suites = Array.from(
    { length: rng.int(3, 8) },
    () => `  ✓ ${rng.pick(TOPICS)} ${rng.pick(['accepts valid input', 'rejects invalid input', 'handles the happy path', 'retries on transient failure', 'validates required fields'])} (${rng.int(2, 40)} ms)`,
  ).join('\n');
  if (pass) {
    return `PASS ${file}\n${suites}\n\nTest Files  1 passed (1)\n     Tests  ${suites.split('\n').length} passed\n  Duration  ${rng.int(100, 900)} ms`;
  }
  return `FAIL ${file}\n${suites}\n  ${rng.pick(TOPICS)} > handles concurrent writes\n    Expected: true\n    Received: false\n    at ${file}:${rng.int(10, 300)}:${rng.int(1, 40)}\n\nTest Files  1 failed (1)\n     Tests  1 failed, ${suites.split('\n').length} passed`;
}

function npmInstallOutput(rng: Rng): string {
  const n = rng.int(400, 900);
  const lines = Array.from(
    { length: rng.int(15, 40) },
    () => `${rng.pick(['added', 'changed', 'audited'])} ${rng.pick(TOPICS)}-${rng.pick(SUFFIXES)}@${rng.int(1, 9)}.${rng.int(0, 30)}.${rng.int(0, 20)}`,
  );
  return `${lines.join('\n')}\n\nadded ${n} packages, and audited ${n + 1} packages in ${rng.int(3, 20)}s\n\n${rng.int(30, 90)} packages are looking for funding\n  run \`npm fund\` for details\n\nfound 0 vulnerabilities`;
}

function gitStatusOutput(rng: Rng): string {
  const files = Array.from({ length: rng.int(3, 9) }, () => randomFilePath(rng));
  return `On branch feature/${rng.pick(TOPICS)}-cleanup\nYour branch is up to date with 'origin/feature/${rng.pick(TOPICS)}-cleanup'.\n\nChanges not staged for commit:\n${files
    .map((f) => `  modified:   ${f}`)
    .join('\n')}\n\nno changes added to commit (use "git add" and/or "git commit -a")`;
}

function lsOutput(rng: Rng, dir: string): string {
  const names = Array.from({ length: rng.int(10, 24) }, () => `${rng.pick(TOPICS)}-${rng.pick(SUFFIXES)}.ts`);
  return `${dir}:\n${[...new Set(names)].join('\n')}`;
}

function lintOutput(rng: Rng): string {
  if (rng.bool(0.5)) return `✔ No ESLint warnings or errors (${rng.int(80, 260)} files checked)`;
  const warnings = Array.from(
    { length: rng.int(2, 6) },
    () => `${randomFilePath(rng)}\n  ${rng.int(1, 90)}:${rng.int(1, 40)}  warning  '${rng.pick(TOPICS)}Id' is defined but never used  no-unused-vars`,
  );
  return `${warnings.join('\n\n')}\n\n${warnings.length} problems (0 errors, ${warnings.length} warnings)`;
}

function bashMisc(rng: Rng): { command: string; output: string } {
  const kind = rng.pick(['test', 'install', 'git', 'ls', 'lint'] as const);
  switch (kind) {
    case 'test':
      return { command: `npx vitest run ${randomFilePath(rng)}`, output: testRunOutput(rng, randomFilePath(rng), rng.bool(0.85)) };
    case 'install':
      return { command: 'npm install', output: npmInstallOutput(rng) };
    case 'git':
      return { command: 'git status', output: gitStatusOutput(rng) };
    case 'ls': {
      const dir = `src/${rng.pick(AREAS)}`;
      return { command: `ls -la ${dir}`, output: lsOutput(rng, dir) };
    }
    case 'lint':
      return { command: 'npm run lint', output: lintOutput(rng) };
  }
}

/** A "mostly identical" build-log chunk: same structure and wording every time, only numbers vary. */
function buildLogChunk(rng: Rng, targetChars: number, seqBase: number): string {
  const lines: string[] = ['> build', '> tsc -p tsconfig.json', ''];
  let n = seqBase;
  while (lines.join('\n').length < targetChars) {
    const mod = rng.pick(AREAS);
    const topic = rng.pick(TOPICS);
    lines.push(`[${String(n).padStart(5, '0')}] compiling src/${mod}/${topic}.ts (${rng.int(10, 400)} ms)`);
    n += 1;
  }
  lines.push('', `Compilation complete. ${n - seqBase} files, ${rng.int(1000, 4000)} ms total.`);
  return lines.join('\n');
}

const FACT_BANK: ((rng: Rng) => string)[] = [
  (rng) => `The local dev cache lives at .cache/build-${rng.int(0x1000, 0xffff).toString(16)}.`,
  (rng) => `CI currently runs on node${rng.pick([18, 20, 22])}.x images.`,
  (rng) => `The staging bucket name is assets-staging-${rng.int(100, 999)}.`,
  (rng) => `Lint takes about ${rng.int(20, 90)}s on a clean cache.`,
  (rng) => `The ${rng.pick(TOPICS)} service listens on internal port ${rng.int(9000, 9999)}.`,
];

// ---------------------------------------------------------------------------
// Transcript builder
// ---------------------------------------------------------------------------

class TranscriptBuilder {
  readonly rng: Rng;
  readonly transcript: Message[] = [];
  readonly calls: Record<string, CallLabel> = {};
  readonly probes: Probe[] = [];
  /** Running total of content characters added so far (message text + tool input JSON + tool output). */
  approxChars = 0;
  private readonly caseId: string;
  private counter = 0;
  private probeCounter = 0;

  constructor(caseId: string, rng: Rng) {
    this.caseId = caseId;
    this.rng = rng;
  }

  private nextId(): string {
    this.counter += 1;
    return `toolu_${this.caseId}_${this.counter}`;
  }

  user(text: string): void {
    this.transcript.push({ role: 'user', text, toolUses: [] });
    this.approxChars += text.length;
  }

  assistant(text: string): void {
    this.transcript.push({ role: 'assistant', text, toolUses: [] });
    this.approxChars += text.length;
  }

  /** Pushes an assistant tool_use message followed by its matching user tool_result message. */
  call(
    tool: string,
    input: Record<string, unknown>,
    output: string,
    opts: { isError?: boolean; label?: CallLabel; narration?: string } = {},
  ): string {
    const tool_use_id = this.nextId();
    const isError = opts.isError ?? false;
    const narration = opts.narration ?? '';
    this.transcript.push({
      role: 'assistant',
      text: narration,
      toolUses: [{ tool_use_id, tool, input, text: output, isError }],
    });
    this.transcript.push({
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id, text: output, isError }],
    });
    this.approxChars += narration.length + (JSON.stringify(input)?.length ?? 0) + output.length;
    if (opts.label) this.calls[tool_use_id] = opts.label;
    return tool_use_id;
  }

  label(toolUseId: string, callLabel: CallLabel): void {
    this.calls[toolUseId] = callLabel;
  }

  probe(kind: string, text: string, where: Probe['where'], note: string): void {
    this.probeCounter += 1;
    this.probes.push({ id: `p${this.probeCounter}_${kind}`, kind, text, where, note });
  }

  build(): { transcript: Message[]; labels: Labels } {
    return { transcript: this.transcript, labels: { version: 1, calls: this.calls, probes: this.probes } };
  }
}

/** Reads a fresh random file, embeds a unique fact in its content, and records a recoverability probe for it. */
function addFactFiller(b: TranscriptBuilder, index: number): void {
  const fact = FACT_BANK[index % FACT_BANK.length]!(b.rng);
  const file = randomFilePath(b.rng);
  const output = `${codeSnippet(b.rng, file, b.rng.int(800, 2000))}// NOTE: ${fact}\n`;
  const label: CallLabel = b.rng.bool(0.5) ? 'safe_to_drop' : 'safe_to_truncate';
  const id = b.call('Read', { file_path: file }, output, { label });
  b.probe('fact', fact, 'active_or_archive', `Incidental detail in a droppable Read result (${id}); should stay recoverable via the archive even once dropped from the active window.`);
}

/** One exact-duplicate tool interaction: the same file read twice, unchanged, so redundancy removal is exercised. */
function addDuplicateRead(b: TranscriptBuilder): void {
  const file = randomFilePath(b.rng);
  const content = codeSnippet(b.rng, file, b.rng.int(1200, 3000));
  b.call('Read', { file_path: file }, content, { label: 'safe_to_drop' });
  b.assistant(b.rng.pick(NARRATIONS));
  b.call('Read', { file_path: file }, content);
}

type FillerKind = 'read' | 'grep' | 'glob' | 'bash' | 'edit' | 'write';
const FILLER_KINDS: readonly FillerKind[] = ['read', 'grep', 'glob', 'bash', 'edit', 'write'];

interface FillerOptions {
  /** How many filler tool calls to add (each contributes two messages). */
  calls: number;
  /** Chance of inserting a short assistant narration line between calls. Default 0.15. */
  narrationChance?: number;
  /** Extra deterministic content mentioning some topic, labelled `safe_to_truncate` (used by the rejected-approach case). */
  mention?: { text: string; count: number };
}

/** A burst of generic, varied, unrelated-looking Read/Grep/Glob/Bash/Edit/Write calls. */
function addGenericFillerBurst(b: TranscriptBuilder, opts: FillerOptions): void {
  const narrationChance = opts.narrationChance ?? 0.15;
  let mentionsLeft = opts.mention?.count ?? 0;
  for (let i = 0; i < opts.calls; i++) {
    const label: CallLabel = b.rng.bool(0.7) ? 'safe_to_drop' : 'safe_to_truncate';
    const useMention = mentionsLeft > 0 && b.rng.bool(0.4);
    if (useMention) mentionsLeft -= 1;
    const kind = b.rng.pick(FILLER_KINDS);
    switch (kind) {
      case 'read': {
        const file = randomFilePath(b.rng);
        let content = codeSnippet(b.rng, file, b.rng.int(1500, 6000));
        if (useMention) content += `// ${opts.mention!.text}\n`;
        b.call('Read', { file_path: file }, content, { label: useMention ? 'safe_to_truncate' : label });
        break;
      }
      case 'grep': {
        const pattern = b.rng.pick(['TODO', 'FIXME', 'console.log', 'export function', b.rng.pick(TOPICS)]);
        const hitCount = b.rng.int(3, 18);
        const hits = Array.from({ length: hitCount }, () => `${randomFilePath(b.rng)}:${b.rng.int(1, 300)}:  // ${pattern} in ${b.rng.pick(TOPICS)} handling here`);
        const output = useMention
          ? [...hits, `${randomFilePath(b.rng)}:${b.rng.int(1, 300)}:  // ${opts.mention!.text}`].join('\n')
          : hits.join('\n') || 'No matches found';
        b.call('Grep', { pattern }, output, { label: useMention ? 'safe_to_truncate' : label });
        break;
      }
      case 'glob': {
        const glob = `src/${b.rng.pick(AREAS)}/**/*.ts`;
        const files = Array.from({ length: b.rng.int(8, 24) }, () => randomFilePath(b.rng));
        b.call('Glob', { pattern: glob }, [...new Set(files)].join('\n'), { label });
        break;
      }
      case 'bash': {
        const { command, output } = bashMisc(b.rng);
        b.call('Bash', { command }, useMention ? `${output}\n${opts.mention!.text}` : output, {
          label: useMention ? 'safe_to_truncate' : label,
        });
        break;
      }
      case 'edit': {
        const file = randomFilePath(b.rng);
        const oldLine = `const ${b.rng.pick(TOPICS)}Limit = ${b.rng.int(1, 100)};`;
        const newLine = `const ${b.rng.pick(TOPICS)}Limit = ${b.rng.int(1, 100)};`;
        b.call('Edit', { file_path: file, old_string: oldLine, new_string: newLine }, `The file ${file} has been updated.`, { label });
        break;
      }
      case 'write': {
        const file = randomFilePath(b.rng);
        const content = codeSnippet(b.rng, file, b.rng.int(1200, 4000));
        b.call('Write', { file_path: file, content }, `File created successfully at: ${file}`, { label });
        break;
      }
    }
    if (b.rng.bool(narrationChance)) b.assistant(b.rng.pick(NARRATIONS));
  }
}

/** A burst of bulk, near-identical build-log Bash results, all labelled droppable. Returns total chars added. */
function addLogBurst(b: TranscriptBuilder, count: number, chunkChars: number): void {
  for (let i = 0; i < count; i++) {
    const output = buildLogChunk(b.rng, chunkChars, i * 200);
    b.call('Bash', { command: 'npm run build' }, output, { label: 'safe_to_drop' });
  }
}

function finishWithRecentTurns(b: TranscriptBuilder, finalUserText: string, assistantReply: string): void {
  b.user(finalUserText);
  b.assistant(assistantReply);
}

// ---------------------------------------------------------------------------
// The eight scenarios
// ---------------------------------------------------------------------------

interface ScenarioResult {
  transcript: Message[];
  labels: Labels;
  description: string;
}

function buildLateConstraint(seed: number): ScenarioResult {
  const b = new TranscriptBuilder('late-constraint', new Rng(seed));

  b.user('We need to clean up a few lint warnings and fix a type error before the release. Start by looking around the codebase.');
  b.assistant('Sure — let me take a look at the project layout first.');
  b.call(
    'Glob',
    { pattern: 'src/**/*.ts' },
    ['src/generated/api.ts', 'src/generated/schema.ts', ...Array.from({ length: 10 }, () => randomFilePath(b.rng))].join('\n'),
    { label: 'safe_to_drop' },
  );
  b.call('Bash', { command: 'npm run lint' }, lintOutput(b.rng), { label: 'safe_to_drop' });

  // The constraint — stated once, early, then never repeated.
  b.user('Never modify anything under src/generated/ — those files are built by codegen.');
  b.probe(
    'constraint',
    'Never modify anything under src/generated/',
    'active',
    'A standing rule stated once near the start of the session; must still hold ~150 messages later when the final task touches src/generated/.',
  );
  b.assistant('Understood — I will leave src/generated/ untouched and only edit the source files that feed into it.');

  addDuplicateRead(b);
  addFactFiller(b, 0);
  addFactFiller(b, 1);
  addGenericFillerBurst(b, { calls: 66 });
  addFactFiller(b, 2);
  addGenericFillerBurst(b, { calls: 6 });

  b.call('Bash', { command: 'npx tsc --noEmit' }, "src/generated/api.ts:42:7 - error TS2322: Type 'string' is not assignable to type 'number'.\n\nFound 1 error.", {
    isError: true,
    label: 'must_keep',
  });

  finishWithRecentTurns(
    b,
    'Please fix the type error in src/generated/api.ts.',
    'That file is under src/generated/, which you said earlier is off limits — codegen owns it. Let me check whether the error actually comes from the generator input rather than editing the generated file directly.',
  );
  b.call('Read', { file_path: 'src/generated/api.ts' }, codeSnippet(b.rng, 'src/generated/api.ts', 500), { label: 'nice_to_keep' });

  return {
    ...b.build(),
    description:
      'A standing "never touch src/generated/" rule is stated at message ~5, then buried under ~150 messages of unrelated work before the final task asks to edit exactly that path.',
  };
}

function buildPortInToolResult(seed: number): ScenarioResult {
  const b = new TranscriptBuilder('port-in-tool-result', new Rng(seed));

  b.user('Set up the local dev environment and get the API server running against Postgres.');
  b.assistant("I'll check the environment template first.");
  const envId = b.call(
    'Bash',
    { command: 'cat .env.example' },
    ['NODE_ENV=development', 'API_PORT=3000', 'POSTGRES_HOST=localhost', 'POSTGRES_PORT=54329', 'POSTGRES_DB=app_dev', 'REDIS_URL=redis://localhost:6379'].join('\n'),
    { label: 'must_keep' },
  );
  b.probe('port', '54329', 'active_or_archive', `The only place the non-default Postgres port is stated (${envId}); the final task needs it to connect.`);
  b.assistant('Postgres runs on a non-standard port here; noted. Continuing with the setup.');

  addDuplicateRead(b);
  addFactFiller(b, 0);
  addGenericFillerBurst(b, { calls: 60 });
  addFactFiller(b, 1);
  addFactFiller(b, 2);
  addGenericFillerBurst(b, { calls: 8 });

  finishWithRecentTurns(
    b,
    "The API server can't reach Postgres — health check is timing out. Can you check the connection settings and fix it?",
    "Let me check what port and host the API is configured to use versus what's actually running.",
  );
  b.call('Bash', { command: 'docker compose ps' }, 'NAME       IMAGE         STATUS\napp-db     postgres:16   Up 2 minutes', { label: 'safe_to_truncate' });

  return {
    ...b.build(),
    description:
      'A single early `cat .env.example` result states POSTGRES_PORT=54329 once and it is never repeated; the final task needs the API to connect to that same database.',
  };
}

function buildFlakyTestWorkaround(seed: number): ScenarioResult {
  const b = new TranscriptBuilder('flaky-test-workaround', new Rng(seed));

  b.user('The auth test suite has been unreliable in CI. Can you look into it?');
  b.assistant("I'll run it a few times and see what's going on.");
  b.call('Bash', { command: 'npx vitest run src/services/auth-service.test.ts' }, testRunOutput(b.rng, 'src/services/auth-service.test.ts', true), { label: 'safe_to_drop' });
  const hangId = b.call(
    'Bash',
    { command: 'npx vitest run src/services/auth-service.test.ts' },
    'RUN  src/services/auth-service.test.ts\n\n(hangs — no output after 120s, cancelled)',
    { isError: true, label: 'must_keep', narration: "Found it — the auth suite hangs intermittently, and only on Windows, unless vitest runs with a separate process pool." },
  );
  b.assistant('Switching the pool option fixes it locally. I want to confirm before making it the default.');
  b.user('Confirmed — run vitest with --pool=forks or the auth suite hangs on Windows. Please make that the default for this suite.');
  b.probe(
    'workaround',
    '--pool=forks',
    'active',
    `The fix for a hang discovered around ${hangId} and confirmed by the user; the final message reports the same symptom returning.`,
  );
  b.call('Bash', { command: 'npx vitest run src/services/auth-service.test.ts --pool=forks' }, testRunOutput(b.rng, 'src/services/auth-service.test.ts', true), { label: 'safe_to_truncate' });

  addDuplicateRead(b);
  addFactFiller(b, 0);
  addFactFiller(b, 1);
  addFactFiller(b, 2);
  // ~150k-250k chars of harmless, mostly-identical build logs.
  addLogBurst(b, 58, 3000);

  finishWithRecentTurns(
    b,
    'The auth tests are hanging again in CI.',
    'Let me check whether the --pool=forks setting is still in place for this suite.',
  );

  return {
    ...b.build(),
    description:
      'An early flaky-test investigation lands on a one-line workaround (--pool=forks), confirmed by the user; ~150k+ chars of harmless, near-identical build logs follow before the same symptom resurfaces.',
  };
}

function buildRejectedApproach(seed: number): ScenarioResult {
  const b = new TranscriptBuilder('rejected-approach', new Rng(seed));

  b.user('We need a job dispatch mechanism for the background worker fleet. What do you suggest?');
  b.assistant("I'd suggest we use Redis Pub/Sub for job dispatch — it's simple to wire up and we already depend on Redis.");
  b.user('No — use Redis Streams, jobs must survive a worker restart.');
  b.probe(
    'decision',
    'use Redis Streams, jobs must survive a worker restart',
    'active',
    'The settled decision, stated once, overriding an earlier proposal that keeps resurfacing in later filler content.',
  );
  b.assistant('Understood — Redis Streams it is, with consumer groups so an in-flight job is redelivered if a worker dies.');

  addDuplicateRead(b);
  addFactFiller(b, 0);
  addGenericFillerBurst(b, { calls: 50, mention: { text: 'still references the old Redis Pub/Sub dispatch prototype', count: 10 } });
  addFactFiller(b, 1);
  addFactFiller(b, 2);
  addGenericFillerBurst(b, { calls: 8 });

  finishWithRecentTurns(
    b,
    'The worker pool needs to restart for a deploy — will in-flight jobs be lost?',
    'No — jobs are dispatched over the chosen mechanism with consumer groups, so a restarted worker picks up any job it had not acknowledged.',
  );

  return {
    ...b.build(),
    description:
      'The assistant proposes Redis Pub/Sub; the user rejects it for Redis Streams with an explicit reason. Later filler content keeps mentioning the rejected Pub/Sub approach.',
  };
}

function buildFileChangedSinceRead(seed: number): ScenarioResult {
  const b = new TranscriptBuilder('file-changed-since-read', new Rng(seed));

  b.user('Uploads over 25MB are being rejected client-side even though the spec says we support more. Can you look at the limit?');
  const readOldId = b.call(
    'Read',
    { file_path: 'src/config/limits.ts' },
    "export const MAX_UPLOAD_MB = 25;\nexport const MAX_REQUEST_MB = 30;\nexport const MAX_BATCH_SIZE = 50;\n",
    { label: 'must_keep' },
  );
  b.probe(
    'history',
    'MAX_UPLOAD_MB = 25',
    'active_or_archive',
    `The original value read at ${readOldId}, before the edit that follows; needed later to explain why production still rejects 30MB uploads.`,
  );
  b.assistant('The limit is set to 25MB in config; raising it to 100MB per the spec.');
  b.call(
    'Edit',
    { file_path: 'src/config/limits.ts', old_string: 'export const MAX_UPLOAD_MB = 25;', new_string: 'export const MAX_UPLOAD_MB = 100;' },
    'The file src/config/limits.ts has been updated.',
    { label: 'safe_to_truncate' },
  );
  b.call('Bash', { command: 'npx vitest run src/config/limits.test.ts' }, testRunOutput(b.rng, 'src/config/limits.test.ts', true), { label: 'safe_to_drop' });

  addDuplicateRead(b);
  addFactFiller(b, 0);
  addGenericFillerBurst(b, { calls: 56 });
  addFactFiller(b, 1);
  addFactFiller(b, 2);

  b.call(
    'Read',
    { file_path: 'src/config/limits.ts' },
    "export const MAX_UPLOAD_MB = 100;\nexport const MAX_REQUEST_MB = 30;\nexport const MAX_BATCH_SIZE = 50;\n",
    { label: 'nice_to_keep' },
  );

  addGenericFillerBurst(b, { calls: 8 });

  finishWithRecentTurns(
    b,
    'A customer reports uploads of 30MB failing in production. The deployed build should already have the 100MB limit — can you check what happened?',
    "Let me check whether the change actually shipped, or whether production is still running the build from before the limit was raised.",
  );

  return {
    ...b.build(),
    description:
      'An early Read shows MAX_UPLOAD_MB = 25; a later Edit raises it to 100 and a still-later Read confirms it; the final bug report only makes sense once the original value and the change are both visible.',
  };
}

function buildTwoSimilarKeys(seed: number): ScenarioResult {
  const b = new TranscriptBuilder('two-similar-keys', new Rng(seed));

  b.user('We need to verify Stripe webhook signatures. Find the webhook id we should be using.');
  const docId = b.call(
    'Read',
    { file_path: 'docs/integrations/stripe-setup.md' },
    '# Stripe setup (last reviewed 8 months ago)\n\nWebhook id for this environment:\n\nSTRIPE_WEBHOOK_ID=we_1PqK7mAbCdEf\n\nUse this to verify incoming signatures.\n',
    { label: 'safe_to_truncate' },
  );
  b.assistant('Found a webhook id in the setup doc; let me cross-check it against what Stripe actually has configured, since that doc looks old.');
  const cliId = b.call(
    'Bash',
    { command: 'stripe webhook_endpoints list --live' },
    'id                          url                                  status\nwe_1PqK7nGhIjKl             https://api.example.com/hooks/stripe active\n',
    { label: 'must_keep' },
  );
  b.assistant('The live CLI output shows a different id than the doc. Flagging the discrepancy.');
  b.user('The live one (we_1PqK7nGhIjKl) is right; the doc is stale.');
  b.probe(
    'key',
    'we_1PqK7nGhIjKl',
    'active',
    `The correct webhook id, confirmed by the user after ${docId} (stale doc) and ${cliId} (live CLI) disagreed; must not be confused with the stale one later.`,
  );

  addDuplicateRead(b);
  addFactFiller(b, 0);
  addGenericFillerBurst(b, { calls: 54 });
  addFactFiller(b, 1);
  addFactFiller(b, 2);
  addGenericFillerBurst(b, { calls: 8 });

  finishWithRecentTurns(
    b,
    'Add signature verification for incoming Stripe webhooks using the confirmed webhook id.',
    "I'll wire up verification using the webhook id we confirmed against the live Stripe CLI output, not the one from the stale doc.",
  );

  return {
    ...b.build(),
    description:
      'A stale doc and a live CLI call disagree on the Stripe webhook id; the user states which one is correct in a short message that must not get confused with the stale value later.',
  };
}

function buildObsoleteLookingRootCause(seed: number): ScenarioResult {
  const b = new TranscriptBuilder('obsolete-looking-root-cause', new Rng(seed));

  b.user('Before we start, do a routine dependency check.');
  const lsId = b.call(
    'Bash',
    { command: 'npm ls' },
    'app@1.4.0\n├── express@4.19.2\n├── zod@3.22.4\nUNMET PEER DEPENDENCY zod@^3.23\n├── vitest@2.1.8\n└── typescript@5.7.2\n',
    { label: 'must_keep' },
  );
  b.probe(
    'error',
    'UNMET PEER DEPENDENCY zod@^3.23',
    'active_or_archive',
    `Looks like routine, ignorable npm ls output at ${lsId}; is in fact the root cause of a build failure ~80 messages later.`,
  );
  b.assistant('Nothing urgent there — continuing with the requested work.');

  addDuplicateRead(b);
  addFactFiller(b, 0);
  addGenericFillerBurst(b, { calls: 38 });
  addFactFiller(b, 1);
  addFactFiller(b, 2);
  addGenericFillerBurst(b, { calls: 8 });

  finishWithRecentTurns(
    b,
    'The build is now failing with a zod type error I do not understand — can you take a look?',
    "Let me check the zod version actually installed versus what the code expects; this might be a peer dependency mismatch rather than a bug in our code.",
  );
  b.call(
    'Bash',
    { command: 'npx tsc --noEmit' },
    "src/schemas/order-schema.ts:18:3 - error TS2345: Argument of type 'ZodString' is not assignable to parameter of type 'ZodTypeAny'.\n\nFound 1 error.",
    { isError: true, label: 'safe_to_truncate' },
  );

  return {
    ...b.build(),
    description:
      'A routine-looking `npm ls` early on contains an unmet peer dependency warning for zod; ~80 messages later the build fails with a zod type error whose cause is that same mismatch.',
  };
}

function buildNeedleInLogs(seed: number): ScenarioResult {
  const b = new TranscriptBuilder('needle-in-logs', new Rng(seed));

  b.user('Run the full CI pipeline locally and make sure everything is green before we deploy.');
  b.assistant("I'll work through the pipeline steps one at a time.");

  addLogBurst(b, 28, 3000);

  b.user('Always run migrations with --dry-run first; production DB has no backups this week.');
  b.probe(
    'constraint',
    'Always run migrations with --dry-run first; production DB has no backups this week',
    'active',
    'A single 20-token safety constraint stated in the middle of a ~150k-250k-char run of harmless build logs.',
  );
  b.assistant('Understood — I will always pass --dry-run before running any migration for the rest of this session.');

  addLogBurst(b, 28, 3000);
  addFactFiller(b, 0);
  addDuplicateRead(b);
  addFactFiller(b, 1);
  addFactFiller(b, 2);

  finishWithRecentTurns(
    b,
    'Time to run the pending migrations against production.',
    "Right — I'll run them with --dry-run first, per what you told me earlier, before touching production.",
  );

  return {
    ...b.build(),
    description:
      'A single, high-stakes migration-safety constraint sits in the middle of ~150k-250k chars of harmless, unrelated build-log noise.',
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface CaseSpec {
  name: string;
  seed: number;
  build: (seed: number) => ScenarioResult;
}

const SCENARIOS: CaseSpec[] = [
  { name: 'late-constraint', seed: 1001, build: buildLateConstraint },
  { name: 'port-in-tool-result', seed: 1002, build: buildPortInToolResult },
  { name: 'flaky-test-workaround', seed: 1003, build: buildFlakyTestWorkaround },
  { name: 'rejected-approach', seed: 1004, build: buildRejectedApproach },
  { name: 'file-changed-since-read', seed: 1005, build: buildFileChangedSinceRead },
  { name: 'two-similar-keys', seed: 1006, build: buildTwoSimilarKeys },
  { name: 'obsolete-looking-root-cause', seed: 1007, build: buildObsoleteLookingRootCause },
  { name: 'needle-in-logs', seed: 1008, build: buildNeedleInLogs },
];

export interface CaseRow {
  case: string;
  messages: number;
  calls: number;
  chars: number;
  estTokens: number;
  probes: number;
  labels: number;
}

const DEFAULT_OUT_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../datasets/v1/adversarial');

/** Builds all eight cases and writes them under `outDir`. Returns one summary row per case, in scenario order. */
export async function generateAdversarialDataset(outDir: string = DEFAULT_OUT_DIR): Promise<CaseRow[]> {
  const rows: CaseRow[] = [];
  for (const spec of SCENARIOS) {
    const { transcript, labels, description } = spec.build(spec.seed);
    const dir = path.join(outDir, spec.name);
    await writeCase(dir, transcript, labels, {
      name: spec.name,
      description,
      source: 'synthetic',
      generator: 'scripts/make-adversarial.ts',
      seed: spec.seed,
    });
    rows.push({
      case: spec.name,
      messages: transcript.length,
      calls: countToolCalls(transcript),
      chars: transcriptChars(transcript),
      estTokens: estimateTranscriptTokens(transcript),
      probes: labels.probes.length,
      labels: Object.keys(labels.calls).length,
    });
  }
  return rows;
}

function printTable(rows: CaseRow[]): void {
  const headers = ['case', 'messages', 'calls', 'chars', 'estTokens', 'probes', 'labels'];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length)),
  );
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(line(headers));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) {
    console.log(
      line([r.case, String(r.messages), String(r.calls), String(r.chars), String(r.estTokens), String(r.probes), String(r.labels)]),
    );
  }
}

async function main(): Promise<void> {
  const rows = await generateAdversarialDataset();
  printTable(rows);
  console.log(`\nWrote ${rows.length} cases to ${path.relative(process.cwd(), DEFAULT_OUT_DIR)}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
