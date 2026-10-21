/**
 * Try lossless-compact on your own long Claude Code chats, side by side with
 * Claude Code's own /compact, without touching the chats themselves.
 *
 *   npx tsx scripts/trial.ts candidates [--limit 10] [--min-tokens 50000]
 *   npx tsx scripts/trial.ts select <n|session-id>... [--model <model>] [--no-jev]
 *   npx tsx scripts/trial.ts clone      three copies of each chosen chat (two without a Jev key)
 *   npx tsx scripts/trial.ts digest     a readable digest per chat, to choose the details to test
 *   npx tsx scripts/trial.ts lock       validate probes/<session>.json and freeze them before anything is compacted
 *   npx tsx scripts/trial.ts compact    /compact every copy: Claude's summary, the ruleset, Jev
 *   npx tsx scripts/trial.ts ask        ask every compacted copy every question (one fork each, tools off)
 *   npx tsx scripts/trial.ts grade      grade what can be graded mechanically; write a blind sheet for the rest
 *   npx tsx scripts/trial.ts report     report.html + results.json, and a summary on stdout
 *   npx tsx scripts/trial.ts cleanup    delete every copy, fork and archive the trial made; check the originals
 *   npx tsx scripts/trial.ts status
 *
 * Everything lives in `--dir` (default `~/.lossless-compact-trial`). The
 * originals under `~/.claude/projects` are only ever read: a copy is the
 * original's bytes with its `sessionId` fields renamed (so a chat that was
 * active minutes ago still hits Claude's prompt cache, as it would for real),
 * written next to it so `claude --resume` finds it, and titled
 * `[trial · …] <title>` in the session picker. The plugin runs from this
 * checkout (`--plugin-dir`) with its options passed per run (`--settings`),
 * archiving under `--dir`; an installed copy of the plugin is switched off
 * for every run, so the /compact copy gets Claude's real summary.
 *
 * Costs are Claude Code's own counter (the `cost-state` it writes into each
 * session file) at API list prices; Jev is billed by TypeSafe and not counted.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileArchive } from '../src/archive/file-store.js';
import { containsSecret } from '../src/core/redact.js';
import { findConstraints } from '../src/core/rules.js';
import { nodeFs } from '../src/node/fs.js';
import { listSessions, parseTranscriptLines } from '../src/node/transcripts.js';
import type { Message } from '../src/types.js';

/* ------------------------------------------------------------------ setup */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Positional arguments after the command, skipping `--flag value` pairs. */
function positionals(): string[] {
  const out: string[] = [];
  const valued = new Set(['--dir', '--limit', '--min-tokens', '--model', '--parallel', '--claude']);
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i]!;
    if (valued.has(item)) i++;
    else if (!item.startsWith('--')) out.push(item);
  }
  return out;
}

const repoDir = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
const dir = nodePath.resolve(arg('dir') ?? process.env['LOSSLESS_TRIAL_DIR'] ?? nodePath.join(os.homedir(), '.lossless-compact-trial'));
const claudeBin = arg('claude') ?? process.env['CLAUDE_BIN'] ?? 'claude';
const paths = {
  manifest: nodePath.join(dir, 'manifest.json'),
  candidates: nodePath.join(dir, 'candidates.json'),
  digests: nodePath.join(dir, 'digests'),
  probes: nodePath.join(dir, 'probes'),
  logs: nodePath.join(dir, 'logs'),
  archives: nodePath.join(dir, 'archives'),
  settings: nodePath.join(dir, 'settings'),
  grading: nodePath.join(dir, 'grading.json'),
  gradingKey: nodePath.join(dir, 'grading-key.json'),
  results: nodePath.join(dir, 'results.json'),
  report: nodePath.join(dir, 'report.html'),
  jevKey: nodePath.join(dir, 'jev-key'),
};

const MODES = ['native', 'ruleset', 'jev'] as const;
type Mode = (typeof MODES)[number];
const LABEL: Record<Mode, { name: string; sub: string; tag: string }> = {
  native: { name: 'Claude Code /compact', sub: "a summary written by the chat's own model", tag: 'Claude /compact' },
  ruleset: { name: 'lossless-compact, local ruleset', sub: 'no model, no key, no network', tag: 'lossless ruleset' },
  jev: { name: 'lossless-compact + Jev', sub: 'TypeSafe classifier, keepThreshold 0.35', tag: 'lossless + Jev' },
};
const OURS: readonly Mode[] = ['ruleset', 'jev'];

/* ------------------------------------------------------------------ types */

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface CostState {
  totalCostUSD: number;
  usage: Usage;
}

interface RunRecord {
  ok: boolean;
  startedAt: string;
  /** Process start to exit, including Claude Code's own start-up. */
  wallMs: number;
  /** The host's own figure for the compaction (`compact_boundary.durationMs`). */
  hostMs?: number;
  preTokens?: number;
  postTokens?: number;
  costUsd?: number;
  usage?: Usage;
  /** Set when lossless-compact handed the compaction to Claude's summary, with its reason. */
  fellBack?: string;
  logs: string[];
  error?: string;
}

interface Clone {
  mode: Mode;
  id: string;
  path: string;
  compaction?: RunRecord;
}

type Grade = 'right' | 'partly' | 'wrong' | 'unknown';

interface Answer {
  probe: string;
  mode: Mode;
  fork: string;
  ok: boolean;
  text: string;
  wallMs: number;
  costUsd?: number;
  contextTokens?: number;
  /** lossless-compact's retrieval line, when it brought archived content into the prompt. */
  recalled?: string;
  /** Mechanical grade, or undefined when it needs a judgment call (see `grade`). */
  auto?: Grade;
  error?: string;
}

interface Probe {
  id: string;
  kind: string;
  question: string;
  answer: string;
  accept?: string[];
  note?: string;
}

interface TrialSession {
  n: number;
  id: string;
  title: string;
  project: string;
  cwd: string;
  path: string;
  /** Size of the original when it was chosen; the copies take exactly these bytes. */
  bytes: number;
  sha256: string;
  contextTokens: number;
  model?: string;
  cacheTtl: '5m' | '1h';
  lastActive: string;
  messages: number;
  clones: Clone[];
  probes?: { sha256: string; lockedAt: string; count: number };
  answers: Answer[];
  /** Every fork `ask` started, recorded before it runs, so `cleanup` finds one that never finished. */
  forks?: string[];
}

interface Manifest {
  version: 1;
  createdAt: string;
  repoDir: string;
  pluginVersion: string;
  claudeVersion?: string;
  /** `--model` for every run; otherwise each chat's own model. */
  model?: string;
  modes: Mode[];
  sessions: TrialSession[];
  /** Wall time of each step, for the report. */
  timings: Record<string, number>;
}

interface Candidate {
  n: number;
  id: string;
  title: string;
  project: string;
  cwd: string;
  path: string;
  bytes: number;
  contextTokens: number;
  model?: string;
  cacheTtl: '5m' | '1h';
  lastActive: string;
  messages: number;
  /** Share of the transcript's characters that are tool output: what lossless-compact can archive. */
  toolShare: number;
  /**
   * What Claude's /compact of this chat would cost now (cache warm; only
   * while it still is) and after an hour away (cold), and the whole trial
   * of it: that compaction plus the test questions to all three copies.
   */
  estimate: { freshUsd?: number; staleUsd?: number; trialUsd?: number };
}

/* ------------------------------------------------------------------ prices */

/**
 * Anthropic API list prices, USD per million tokens (2026-10). Cache reads
 * are their own column (0.1x input on most models, less on Opus 5.5 and
 * Fable 5.1); a 5-minute cache write is 1.25x input. Only used for the
 * fresh-vs-stale estimates; measured costs come from Claude Code itself.
 */
const PRICES: { match: RegExp; input: number; output: number; cacheRead: number; longAbove?: { tokens: number; input: number; output: number; cacheRead: number } }[] = [
  { match: /fable-5-1|mythos-5-1/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /fable|mythos/, input: 10, output: 50, cacheRead: 1 },
  { match: /opus-5-5/, input: 4, output: 20, cacheRead: 0.2 },
  { match: /opus/, input: 5, output: 25, cacheRead: 0.5 },
  { match: /sonnet-5/, input: 2, output: 10, cacheRead: 0.2 },
  { match: /sonnet/, input: 3, output: 15, cacheRead: 0.3 },
  { match: /haiku-5-5/, input: 0.1, output: 0.5, cacheRead: 0.01, longAbove: { tokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  { match: /haiku/, input: 1, output: 5, cacheRead: 0.1 },
];

function priceFor(model: string | undefined, promptTokens: number) {
  const row = model ? PRICES.find((p) => p.match.test(model)) : undefined;
  if (!row) return undefined;
  return row.longAbove && promptTokens > row.longAbove.tokens ? row.longAbove : row;
}

/** A summary is ~5-10k output tokens; 8k is used for estimates made before one exists. */
const SUMMARY_TOKENS = 8000;

const PROBES_PER_CHAT = 8;

/**
 * The test questions to one chat's copies: per copy, the first question
 * writes its compacted context to the cache and the rest read it. The
 * context after compaction is a guess before it happens: a summary keeps
 * ~10% (15k tokens at least), lossless-compact ~half on real chats; plus
 * ~15k of system prompt.
 */
function questionsUsd(model: string | undefined, contextTokens: number, modes: readonly Mode[]): number | undefined {
  let total = 0;
  for (const mode of modes) {
    const after = (mode === 'native' ? Math.max(15_000, contextTokens * 0.1) : contextTokens * 0.5) + 15_000;
    const price = priceFor(model, after);
    if (!price) return undefined;
    total += (after * price.input * 1.25 + (PROBES_PER_CHAT - 1) * after * price.cacheRead + PROBES_PER_CHAT * 300 * price.output) / 1e6;
  }
  return total;
}

/**
 * What one full-context call costs with the context still cached, and cold.
 * Measured on Claude Code 2.1.305: the /compact call reads a chat's cached
 * prefix when the chat was used within its cache lifetime (an hour, or five
 * minutes on some setups), and otherwise writes it at the 5-minute rate.
 */
function freshAndStale(model: string | undefined, promptTokens: number, outputTokens: number): { freshUsd?: number; staleUsd?: number } {
  const price = priceFor(model, promptTokens);
  if (!price) return {};
  return {
    freshUsd: (promptTokens * price.cacheRead + outputTokens * price.output) / 1e6,
    staleUsd: (promptTokens * price.input * 1.25 + outputTokens * price.output) / 1e6,
  };
}

/* --------------------------------------------------------------- helpers */

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await fsp.readFile(path, 'utf-8')) as T;
}

const writing = new Map<string, Promise<void>>();

/** Whole-file writes, one at a time per path and renamed into place: parallel `ask` workers all save the manifest. */
function writeJson(path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const next = (writing.get(path) ?? Promise.resolve()).then(async () => {
    await fsp.mkdir(nodePath.dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await fsp.writeFile(temp, text, 'utf-8');
    await fsp.rename(temp, path);
  });
  writing.set(path, next.catch(() => {}));
  return next;
}

async function loadManifest(): Promise<Manifest> {
  if (!existsSync(paths.manifest)) fail(`No trial in ${dir} yet: run \`candidates\`, then \`select\`.`);
  return readJson<Manifest>(paths.manifest);
}

function fail(message: string): never {
  console.error(`trial: ${message}`);
  process.exit(1);
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0);
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function kTokens(n: number | undefined): string {
  if (n === undefined) return '–';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function usd(n: number | undefined): string {
  if (n === undefined) return '–';
  if (n === 0) return '$0';
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

function seconds(ms: number | undefined): string {
  if (ms === undefined) return '–';
  return ms < 1000 ? `${Math.round(ms)} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function pool<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item);
    }
  });
  await Promise.all(workers);
}

/** Collapses whitespace so a value split across a wrapped line still counts as present. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle) || squash(haystack).includes(squash(needle));
}

/* ------------------------------------------------- reading session files */

/** Everything a transcript holds that a reader would count as context: text, tool inputs, results. */
function messagesText(messages: readonly Message[]): string {
  return messages
    .map((m) =>
      [
        m.text,
        ...m.toolUses.map((u) => `${JSON.stringify(u.input)}\n${u.text ?? ''}`),
        ...(m.toolResults ?? []).map((r) => r.text),
      ].join('\n'),
    )
    .join('\n');
}

/**
 * The context a resumed session starts from: the records chained after its
 * last compaction (all of it when there is none), plus the stretch of recent
 * messages Claude's /compact keeps verbatim beside its summary.
 */
function activeText(raw: string[]): string {
  const loaded = parseTranscriptLines(raw, { includeAttachments: true });
  const parts = [messagesText(loaded.messages)];
  let preserved: string[] = [];
  for (const line of raw) {
    if (!line.includes('"compact_boundary"')) continue;
    const record = parse(line);
    const meta = record?.['compactMetadata'] as { preservedMessages?: { allUuids?: string[] } } | undefined;
    preserved = meta?.preservedMessages?.allUuids ?? [];
  }
  if (preserved.length > 0) {
    const keep = new Set(preserved);
    const segment = raw.filter((line) => {
      const uuid = parse(line)?.['uuid'];
      return typeof uuid === 'string' && keep.has(uuid);
    });
    parts.push(messagesText(parseTranscriptLines(segment, { includeAttachments: true }).messages));
  }
  return parts.join('\n');
}

/** The newest `cost-state` record: Claude Code's running cost and token counts for the session. */
async function lastCostState(path: string): Promise<CostState | undefined> {
  if (!existsSync(path)) return undefined;
  const text = await fsp.readFile(path, 'utf-8');
  const at = text.lastIndexOf('"type":"cost-state"');
  if (at === -1) return undefined;
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  const record = parse(text.slice(start, end === -1 ? undefined : end));
  if (!record) return undefined;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const model of Object.values((record['modelUsage'] ?? {}) as Record<string, Record<string, number>>)) {
    usage.input += model['inputTokens'] ?? 0;
    usage.output += model['outputTokens'] ?? 0;
    usage.cacheRead += model['cacheReadInputTokens'] ?? 0;
    usage.cacheWrite += model['cacheCreationInputTokens'] ?? 0;
  }
  return { totalCostUSD: Number(record['totalCostUSD'] ?? 0), usage };
}

function costDelta(before: CostState | undefined, after: CostState | undefined): { costUsd?: number; usage?: Usage } {
  if (!after) return {};
  const base = before ?? { totalCostUSD: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  return {
    costUsd: Math.max(0, after.totalCostUSD - base.totalCostUSD),
    usage: {
      input: after.usage.input - base.usage.input,
      output: after.usage.output - base.usage.output,
      cacheRead: after.usage.cacheRead - base.usage.cacheRead,
      cacheWrite: after.usage.cacheWrite - base.usage.cacheWrite,
    },
  };
}

interface SessionFacts {
  title?: string;
  firstPrompt?: string;
  cwd?: string;
  model?: string;
  contextTokens: number;
  cacheTtl: '5m' | '1h';
  lastActive?: string;
  compacted: boolean;
  trialCopy: boolean;
}

/** Title, working directory, model and live context size, from the records Claude Code writes. */
function sessionFacts(raw: string[]): SessionFacts {
  const facts: SessionFacts = { contextTokens: 0, cacheTtl: '5m', compacted: false, trialCopy: false };
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let summary: string | undefined;
  for (const line of raw) {
    const record = parse(line);
    if (!record) continue;
    const type = record['type'];
    if (typeof record['timestamp'] === 'string') facts.lastActive = record['timestamp'];
    if (typeof record['cwd'] === 'string') facts.cwd = record['cwd'];
    if (type === 'system' && record['subtype'] === 'compact_boundary') facts.compacted = true;
    if (record['isCompactSummary'] === true) facts.compacted = true;
    if (type === 'custom-title' && typeof record['customTitle'] === 'string') customTitle = record['customTitle'];
    if (type === 'ai-title' && typeof record['aiTitle'] === 'string') aiTitle = record['aiTitle'];
    if (type === 'summary' && typeof record['summary'] === 'string') summary = record['summary'];
    if (record['isSidechain'] === true) continue;
    const message = record['message'] as { content?: unknown; model?: string; usage?: Record<string, unknown> } | undefined;
    if (type === 'user' && !facts.firstPrompt && record['isMeta'] !== true && typeof message?.content === 'string') {
      const text = message.content.trim();
      if (text && !text.startsWith('<')) facts.firstPrompt = text;
    }
    if (type === 'assistant' && message?.usage && message.model && message.model !== '<synthetic>') {
      const u = message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number } };
      facts.model = message.model;
      facts.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      if ((u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) facts.cacheTtl = '1h';
    }
  }
  facts.title = customTitle ?? aiTitle ?? summary ?? (facts.firstPrompt ? clip(facts.firstPrompt, 80) : undefined);
  facts.trialCopy = customTitle?.startsWith('[trial') ?? false;
  return facts;
}

/* ------------------------------------------------------- running claude */

/**
 * The parent Claude Code session's own variables would make a nested
 * `claude` think it is that session, or a child of it; none of them should
 * reach a trial run. Auth, proxy and the user's own settings pass through.
 */
const HOST_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SYNC_SESSION_REFS',
  'CLAUDE_CODE_TEE_SDK_STDOUT',
  'CLAUDE_CODE_REMOTE_SEND_KEEPALIVES',
  'CLAUDE_CODE_HOLD_UNANSWERED_PARKED_PERMISSION',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'CLAUDE_AFTER_LAST_COMPACT',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'CLAUDE_PID',
  'CLAUDE_CODE_SSE_PORT',
  'SESSION_INGRESS_URL',
];

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of HOST_SESSION_VARS) delete env[name];
  return env;
}

function winQuote(value: string): string {
  return value === '' ? '""' : /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

interface ClaudeRun {
  code: number | null;
  ms: number;
  events: Record<string, unknown>[];
  stderr: string;
}

/** `claude -p … --output-format stream-json --verbose`, the prompt over stdin, every event kept. */
function runClaude(args: string[], options: { cwd: string; input: string; env: Record<string, string>; timeoutMs: number; log: string }): Promise<ClaudeRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const full = ['-p', ...args, '--output-format', 'stream-json', '--verbose'];
    const windows = process.platform === 'win32';
    const child = spawn(windows ? winQuote(claudeBin) : claudeBin, windows ? full.map(winQuote) : full, {
      cwd: options.cwd,
      env: childEnv(options.env),
      shell: windows,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const done = async (code: number | null): Promise<void> => {
      clearTimeout(timer);
      await fsp.mkdir(nodePath.dirname(options.log), { recursive: true });
      await fsp.writeFile(options.log, stdout + (stderr ? `\n# stderr\n${stderr}` : ''), 'utf-8');
      const events = lines(stdout)
        .map(parse)
        .filter((e): e is Record<string, unknown> => e !== undefined);
      resolve({ code, ms: Date.now() - started, events, stderr });
    };
    child.on('error', (error) => {
      stderr += String(error);
      void done(null);
    });
    child.on('close', (code) => void done(code));
    child.stdin.write(options.input, 'utf8');
    child.stdin.end();
  });
}

function pluginLogs(events: readonly Record<string, unknown>[]): string[] {
  return events
    .filter((e) => e['subtype'] === 'ui_log' && typeof e['text'] === 'string' && String(e['plugin'] ?? '').startsWith('lossless-compact'))
    .map((e) => String(e['text']));
}

function resultEvent(events: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  return [...events].reverse().find((e) => e['type'] === 'result');
}

/** Every installed copy of the plugin (any marketplace), so each run can switch it off. */
async function installedPluginKeys(): Promise<string[]> {
  try {
    const settings = await readJson<{ enabledPlugins?: Record<string, unknown> }>(nodePath.join(os.homedir(), '.claude', 'settings.json'));
    return Object.keys(settings.enabledPlugins ?? {}).filter((key) => /^(lossless-compact|fast-jev-compaction)@/.test(key) && key !== 'lossless-compact@inline');
  } catch {
    return [];
  }
}

async function writeSettings(modes: readonly Mode[]): Promise<void> {
  const off = Object.fromEntries([...new Set(['lossless-compact@lossless-compact', ...(await installedPluginKeys())])].map((key) => [key, false]));
  for (const mode of modes) {
    const settings: Record<string, unknown> = { enabledPlugins: off };
    if (mode !== 'native') {
      // `@inline` is the name a --plugin-dir copy is loaded under.
      settings['pluginConfigs'] = {
        'lossless-compact@inline': { options: { classifier: mode, archiveDir: paths.archives, compactAtTokens: 0 } },
      };
    }
    await writeJson(settingsFile(mode), settings);
  }
}

function settingsFile(mode: Mode): string {
  return nodePath.join(paths.settings, `${mode}.json`);
}

async function jevKey(): Promise<string | undefined> {
  if (process.env['TYPESAFE_API_KEY']) return process.env['TYPESAFE_API_KEY'];
  if (existsSync(paths.jevKey)) {
    const key = (await fsp.readFile(paths.jevKey, 'utf-8')).trim();
    if (key) return key;
  }
  try {
    const settings = await readJson<{ env?: Record<string, unknown> }>(nodePath.join(os.homedir(), '.claude', 'settings.json'));
    const key = settings.env?.['TYPESAFE_API_KEY'];
    if (typeof key === 'string' && key) return key;
  } catch {
    // no settings file
  }
  return undefined;
}

/** What a run of `mode` needs on top of `claude -p --resume <id>`. */
async function modeArgs(manifest: Manifest, session: TrialSession, mode: Mode): Promise<{ args: string[]; env: Record<string, string> }> {
  const args = ['--settings', settingsFile(mode)];
  const env: Record<string, string> = { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' };
  if (mode !== 'native') args.push('--plugin-dir', manifest.repoDir);
  const model = manifest.model ?? session.model;
  if (model) args.push('--model', model);
  if (mode === 'jev') {
    const key = await jevKey();
    if (key) env['TYPESAFE_API_KEY'] = key;
  }
  return { args, env };
}

/* -------------------------------------------------------------- commands */

async function candidates(): Promise<void> {
  const limit = Number(arg('limit') ?? '10');
  const minTokens = Number(arg('min-tokens') ?? '50000');
  const exclude = new Set([process.env['CLAUDE_CODE_SESSION_ID'], arg('exclude')].filter((id): id is string => Boolean(id)));
  const skipped: Record<string, number> = {};
  const skip = (why: string): void => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const found: Omit<Candidate, 'n'>[] = [];
  // Newest first, and stop at `limit`: someone with hundreds of long chats should not wait for all of them.
  const files = (await listSessions()).sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  for (const file of files) {
    if (found.length >= limit) break;
    // ~4 bytes of JSONL per token at the very least; smaller files cannot be long chats.
    if (file.bytes < minTokens * 3) continue;
    if (exclude.has(file.sessionId)) {
      skip('this chat');
      continue;
    }
    if (Date.now() - Date.parse(file.modified) < 90_000) {
      skip('in use right now');
      continue;
    }
    const text = await fsp.readFile(file.path, 'utf-8');
    if (text.includes('"compact_boundary"') || text.includes('"isCompactSummary":true')) {
      skip('already compacted');
      continue;
    }
    const raw = lines(text);
    const facts = sessionFacts(raw);
    if (facts.trialCopy) continue;
    if (facts.compacted) {
      skip('already compacted');
      continue;
    }
    if (facts.contextTokens < minTokens) {
      skip(`under ${kTokens(minTokens)} tokens`);
      continue;
    }
    if (!facts.cwd || !existsSync(facts.cwd)) {
      skip('its folder is gone');
      continue;
    }
    const loaded = parseTranscriptLines(raw);
    let toolChars = 0;
    let allChars = 0;
    for (const m of loaded.messages) {
      const results = (m.toolResults ?? []).reduce((sum, r) => sum + r.text.length, 0);
      toolChars += results;
      allChars += results + m.text.length + m.toolUses.reduce((sum, u) => sum + JSON.stringify(u.input).length, 0);
    }
    const lastActive = facts.lastActive ?? file.modified;
    const fresh = Date.now() - Date.parse(lastActive) < (facts.cacheTtl === '1h' ? 3_600_000 : 300_000);
    const estimate: Candidate['estimate'] = freshAndStale(facts.model, facts.contextTokens, SUMMARY_TOKENS);
    const questions = questionsUsd(facts.model, facts.contextTokens, MODES);
    const compactNow = fresh ? estimate.freshUsd : estimate.staleUsd;
    if (questions !== undefined && compactNow !== undefined) estimate.trialUsd = compactNow + questions;
    found.push({
      id: file.sessionId,
      title: facts.title ?? '(untitled)',
      project: file.project,
      cwd: facts.cwd,
      path: file.path,
      bytes: file.bytes,
      contextTokens: facts.contextTokens,
      ...(facts.model ? { model: facts.model } : {}),
      cacheTtl: facts.cacheTtl,
      lastActive,
      messages: loaded.messages.length,
      toolShare: allChars ? toolChars / allChars : 0,
      estimate: fresh ? estimate : { ...(estimate.staleUsd !== undefined ? { staleUsd: estimate.staleUsd } : {}), ...(estimate.trialUsd !== undefined ? { trialUsd: estimate.trialUsd } : {}) },
    });
  }
  found.sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  const list: Candidate[] = found.slice(0, limit).map((c, i) => ({ n: i + 1, ...c }));
  await writeJson(paths.candidates, { scannedAt: new Date().toISOString(), minTokens, candidates: list, skipped });

  console.log(`Long chats that were never compacted, newest first (${list.length}):\n`);
  console.log('| # | Title | Project | Context | Last active | Model | Tool output | /compact would cost | Whole test (est.) |');
  console.log('| ---: | --- | --- | ---: | --- | --- | ---: | ---: | ---: |');
  for (const c of list) {
    const cost = c.estimate.freshUsd !== undefined ? `${usd(c.estimate.freshUsd)} now (cached), ${usd(c.estimate.staleUsd)} cold` : usd(c.estimate.staleUsd);
    console.log(
      `| ${c.n} | ${clip(c.title, 60)} | ${clip(c.project.replace(/^-+/, ''), 28)} | ${kTokens(c.contextTokens)} | ${ago(c.lastActive)} | ${c.model ?? '?'} | ${Math.round(c.toolShare * 100)}% | ${cost} | ${usd(c.estimate.trialUsd)} |`,
    );
  }
  const skips = Object.entries(skipped).map(([why, n]) => `${n} ${why}`);
  if (skips.length) console.log(`\nSkipped: ${skips.join(', ')}.`);
  console.log(
    `\nCosts are API list prices (on a Pro or Max plan they count against usage limits instead). "Whole test" is Claude's /compact of the chat plus ${PROBES_PER_CHAT} test questions to each of its three copies; without a Jev key there are two copies and it is a little less.`,
  );
  console.log(`Saved to ${paths.candidates}. Next: select <#>… (e.g. select 1 2 3).`);
}

async function select(): Promise<void> {
  const picks = positionals();
  if (picks.length === 0) fail('select needs at least one candidate number or session id.');
  if (!existsSync(paths.candidates)) fail('run `candidates` first.');
  const { candidates: list } = await readJson<{ candidates: Candidate[] }>(paths.candidates);
  if (existsSync(paths.manifest)) {
    const old = await readJson<Manifest>(paths.manifest);
    if (old.sessions.some((s) => s.clones.length > 0)) fail(`a trial with copies already exists in ${dir}; run \`cleanup\` first.`);
  }
  const chosen: Candidate[] = [];
  for (const pick of picks) {
    const match = /^\d+$/.test(pick) ? list.find((c) => c.n === Number(pick)) : list.find((c) => c.id.startsWith(pick));
    if (!match) fail(`no candidate ${pick} in ${paths.candidates}.`);
    if (!chosen.includes(match)) chosen.push(match);
  }
  const hasKey = (await jevKey()) !== undefined;
  const modes: Mode[] = ['native', 'ruleset', ...(hasKey && !flag('no-jev') ? (['jev'] as const) : [])];
  const pkg = await readJson<{ version: string }>(nodePath.join(repoDir, 'package.json'));
  const sessions: TrialSession[] = [];
  for (const [i, c] of chosen.entries()) {
    const bytes = await fsp.readFile(c.path);
    sessions.push({
      n: i + 1,
      id: c.id,
      title: c.title,
      project: c.project,
      cwd: c.cwd,
      path: c.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      contextTokens: c.contextTokens,
      ...(c.model ? { model: c.model } : {}),
      cacheTtl: c.cacheTtl,
      lastActive: c.lastActive,
      messages: c.messages,
      clones: [],
      answers: [],
    });
  }
  const model = arg('model');
  const claudeVersion = spawnSync(claudeBin, ['--version'], { encoding: 'utf-8', shell: process.platform === 'win32', env: childEnv({}) }).stdout?.trim().split(/\s/)[0];
  const manifest: Manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    repoDir,
    pluginVersion: pkg.version,
    ...(claudeVersion ? { claudeVersion } : {}),
    ...(model ? { model } : {}),
    modes,
    sessions,
    timings: {},
  };
  await writeJson(paths.manifest, manifest);
  await writeSettings(modes);

  const compactCost = sessions.reduce(
    (sum, s) => {
      const e = freshAndStale(model ?? s.model, s.contextTokens, SUMMARY_TOKENS);
      return { fresh: sum.fresh + (e.freshUsd ?? 0), stale: sum.stale + (e.staleUsd ?? 0) };
    },
    { fresh: 0, stale: 0 },
  );
  console.log(`Chosen: ${sessions.map((s) => `#${s.n} ${clip(s.title, 50)}`).join('; ')}`);
  console.log(`Modes: ${modes.map((m) => LABEL[m].name).join(' · ')} → ${sessions.length * modes.length} copies.`);
  if (!hasKey) {
    console.log('No Jev (TypeSafe) key found: the trial compares Claude Code /compact with the local ruleset only, not the full three-way comparison.');
  }
  const questions = sessions.reduce((sum, s) => sum + (questionsUsd(model ?? s.model, s.contextTokens, modes) ?? 0), 0);
  console.log(
    `Claude's /compact of all ${sessions.length}: about ${usd(compactCost.stale)} if the chats are cold (an hour or more since their last message), ${usd(compactCost.fresh)} if all were still cached. lossless-compact: $0 (ruleset)${modes.includes('jev') ? ', under a cent per chat (Jev)' : ''}.`,
  );
  console.log(`The test questions (${PROBES_PER_CHAT} per copy): about ${usd(questions)}. API list prices; on a Pro or Max plan this counts against usage limits instead.`);
  console.log(`Time: Claude's /compact takes ~30 s to 3 min per chat (three run at once), lossless-compact seconds; the questions ~1 min per chat.`);
  console.log(`Next: clone, then digest.`);
}

async function clone(): Promise<void> {
  const started = Date.now();
  const manifest = await loadManifest();
  for (const session of manifest.sessions) {
    const original = await fsp.readFile(session.path);
    if (sha256(original.subarray(0, session.bytes)) !== session.sha256) {
      fail(`#${session.n} ${session.title}: the original changed under the trial (not just grew); select it again.`);
    }
    const text = original.subarray(0, session.bytes).toString('utf-8');
    for (const mode of manifest.modes) {
      if (session.clones.some((c) => c.mode === mode)) continue;
      const id = randomUUID();
      // Only the record field changes: inside a message's text the quotes are
      // escaped, so the pattern cannot match there, and every other byte stays.
      const body = text.replaceAll(`"sessionId":"${session.id}"`, `"sessionId":"${id}"`);
      const title = JSON.stringify({ type: 'custom-title', customTitle: `[trial · ${LABEL[mode].tag}] ${session.title}`, sessionId: id });
      const path = nodePath.join(nodePath.dirname(session.path), `${id}.jsonl`);
      await fsp.writeFile(path, `${body}${body.endsWith('\n') ? '' : '\n'}${title}\n`, { encoding: 'utf-8', mode: 0o600 });
      session.clones.push({ mode, id, path });
      await writeJson(paths.manifest, manifest);
    }
    console.log(`#${session.n} ${clip(session.title, 60)}: ${session.clones.map((c) => `${LABEL[c.mode].tag} ${c.id}`).join(', ')}`);
  }
  manifest.timings['clone'] = Date.now() - started;
  await writeJson(paths.manifest, manifest);
  console.log(`\nOriginals untouched (read only). Copies sit next to them and show up in /resume as "[trial · …]". Next: digest.`);
}

/**
 * Strings a summary tends to lose: exact values that only ever appeared in
 * tool output. Ranked so settings, ports, codes and versions come before ids
 * and paths, which tool listings produce by the hundred.
 */
const DETAIL_PATTERNS: { kind: string; rank: number; re: RegExp }[] = [
  { kind: 'setting', rank: 0, re: /\b[A-Z][A-Z0-9_]{2,}\s*[=:]\s*[^\s'",;)}\]]{1,80}/g },
  { kind: 'port', rank: 0, re: /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b|\b\d{4,5}:\d{2,5}\b/g },
  { kind: 'code', rank: 0, re: /\b(?:ERR_[A-Z0-9_]{2,}|E(?:ACCES|ADDRINUSE|CONNREFUSED|CONNRESET|EXIST|NOENT|NOTFOUND|PERM|TIMEDOUT)|[A-Z]{2,}-\d{2,}(?:-\d+)?)\b/g },
  { kind: 'version', rank: 1, re: /\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/g },
  { kind: 'location', rank: 1, re: /\b[\w@.-]+(?:\/[\w@.-]+)*\.[a-z]{1,6}:\d+\b/g },
  { kind: 'id', rank: 2, re: /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,40})\b/g },
  { kind: 'path', rank: 2, re: /(?:~|\.{1,2})?\/?(?:[\w@.-]+\/)+[\w@.-]+\.[a-z]{1,6}\b/g },
];
const NOISE = /(^|\/)(\.git|node_modules|\.lossless-compact)\//;
const ERROR_LINE = /\b(error|errors|failed|fail|failure|exception|traceback|panic|refused|denied|cannot|can't|unable|expected .+ (to|but))\b/i;

function digestFor(session: TrialSession, raw: string[]): string {
  const loaded = parseTranscriptLines(raw);
  const messages = loaded.messages;
  const spoken = messages
    .filter((m) => (m.toolResults ?? []).length === 0)
    .map((m) => m.text)
    .join('\n');
  const details: { value: string; kind: string; rank: number; at: number; line: string }[] = [];
  const errors: { line: string; at: number }[] = [];
  const seen = new Set<string>();
  messages.forEach((m, index) => {
    let fromHere = 0;
    for (const result of m.toolResults ?? []) {
      for (const line of result.text.split('\n').slice(0, 4000)) {
        if (NOISE.test(line)) continue;
        if (ERROR_LINE.test(line) && errors.length < 40 && !errors.some((e) => e.line === clip(line, 220))) errors.push({ line: clip(line, 220), at: index + 1 });
        for (const { kind, rank, re } of DETAIL_PATTERNS) {
          for (const match of line.matchAll(re)) {
            const value = match[0].trim();
            if (value.length < 4 || seen.has(value) || spoken.includes(value) || containsSecret(value)) continue;
            if (details.some((d) => d.value.includes(value))) continue;
            seen.add(value);
            if (fromHere++ >= 8) continue;
            details.push({ value, kind, rank, at: index + 1, line: clip(line, 200) });
          }
        }
      }
    }
  });
  details.sort((a, b) => a.rank - b.rank || a.at - b.at);
  const constraints = findConstraints(messages);
  const out: string[] = [
    `# ${session.title}`,
    '',
    `session ${session.id} · ${session.project} · ${messages.length} messages · ~${kTokens(session.contextTokens)} tokens · ${session.model ?? 'model unknown'} · last active ${session.lastActive}`,
    '',
    'Leads for choosing the details to test, not answers: check each one in the transcript below before you use it.',
    '',
    `## Exact values that appeared only in tool output (${Math.min(details.length, 50)} of ${details.length})`,
    '',
    ...details.slice(0, 50).map((d) => `- \`${clip(d.value, 100)}\` (${d.kind}, message #${d.at}): ${d.line}`),
    '',
    `## Error and failure lines in tool output (${errors.length})`,
    '',
    ...errors.map((e) => `- message #${e.at}: ${e.line}`),
    '',
    `## Instructions and constraints the user gave (${constraints.length})`,
    '',
    ...constraints.slice(0, 40).map((c) => `- message #${c.messageIndex + 1}: "${clip(c.text, 240)}"`),
    '',
    '## Transcript',
    '',
  ];
  messages.forEach((m, index) => {
    const results = m.toolResults ?? [];
    if (results.length > 0 && !m.text.trim()) return;
    out.push(`### #${index + 1} ${m.role}`);
    if (m.text.trim()) out.push(m.text.length > 6000 ? `${m.text.slice(0, 6000)}\n[… ${m.text.length - 6000} more chars]` : m.text);
    for (const use of m.toolUses) {
      const result = use.text ?? '';
      out.push(`→ ${use.tool} ${clip(JSON.stringify(use.input), 200)}`);
      if (result) {
        const head = result.slice(0, 400);
        out.push(`  result (${result.length} chars): ${head.replace(/\n/g, '\n  ')}${result.length > 400 ? ' …' : ''}`);
        const notable = result
          .split('\n')
          .slice(4)
          .filter((line) => !NOISE.test(line) && (ERROR_LINE.test(line) || /[A-Z][A-Z0-9_]{2,}\s*[=:]|:\d{2,5}\b/.test(line)))
          .slice(0, 5);
        for (const line of notable) out.push(`  … ${clip(line, 200)}`);
      }
    }
    out.push('');
  });
  return out.join('\n');
}

async function digest(): Promise<void> {
  const manifest = await loadManifest();
  for (const session of manifest.sessions) {
    const raw = lines((await fsp.readFile(session.path)).subarray(0, session.bytes).toString('utf-8'));
    const path = nodePath.join(paths.digests, `${session.n}-${session.id.slice(0, 8)}.md`);
    await fsp.mkdir(paths.digests, { recursive: true });
    await fsp.writeFile(path, digestFor(session, raw), 'utf-8');
    const probes = nodePath.join(paths.probes, `${session.id}.json`);
    console.log(`#${session.n} ${clip(session.title, 60)}\n   digest: ${path}\n   write:  ${probes}`);
  }
  console.log(`\nNext: write each probes file, then lock.`);
}

function probesPath(session: TrialSession): string {
  return nodePath.join(paths.probes, `${session.id}.json`);
}

async function readProbes(session: TrialSession): Promise<Probe[]> {
  return (await readJson<{ probes: Probe[] }>(probesPath(session))).probes;
}

async function lock(): Promise<void> {
  const manifest = await loadManifest();
  const problems: string[] = [];
  for (const session of manifest.sessions) {
    const path = probesPath(session);
    if (!existsSync(path)) {
      problems.push(`#${session.n}: ${path} is missing`);
      continue;
    }
    const text = await fsp.readFile(path, 'utf-8');
    if (session.clones.some((c) => c.compaction) && session.probes?.sha256 !== sha256(text)) {
      problems.push(`#${session.n}: its copies are already compacted; the probes cannot change now`);
      continue;
    }
    let probes: Probe[];
    try {
      probes = (JSON.parse(text) as { probes: Probe[] }).probes;
    } catch (error) {
      problems.push(`#${session.n}: ${path} is not valid JSON (${(error as Error).message})`);
      continue;
    }
    const raw = lines((await fsp.readFile(session.path)).subarray(0, session.bytes).toString('utf-8'));
    const original = activeText(raw);
    const ids = new Set<string>();
    if (!Array.isArray(probes) || probes.length < 4) problems.push(`#${session.n}: needs at least 4 probes`);
    for (const p of probes ?? []) {
      const where = `#${session.n} ${p.id ?? '?'}`;
      if (!p.id || ids.has(p.id)) problems.push(`${where}: missing or duplicate id`);
      ids.add(p.id);
      if (!p.question?.trim() || !p.answer?.trim()) problems.push(`${where}: needs a question and an answer`);
      else {
        if (p.answer.length > 120) problems.push(`${where}: the answer should be a short exact string (≤ 120 chars)`);
        if (!contains(original, p.answer)) problems.push(`${where}: "${clip(p.answer, 60)}" does not appear verbatim in the chat`);
        if (contains(p.question, p.answer)) problems.push(`${where}: the question gives the answer away`);
        if (containsSecret(p.answer)) problems.push(`${where}: the answer looks like a secret; pick another detail`);
      }
    }
    if (problems.some((line) => line.startsWith(`#${session.n}`))) continue;
    session.probes = { sha256: sha256(text), lockedAt: new Date().toISOString(), count: probes.length };
    console.log(`#${session.n} ${clip(session.title, 60)}: ${probes.length} probes locked (sha256 ${session.probes.sha256.slice(0, 12)})`);
  }
  await writeJson(paths.manifest, manifest);
  if (problems.length) fail(`fix these and run lock again:\n  ${problems.join('\n  ')}`);
  console.log('\nNext: compact.');
}

async function compactOne(manifest: Manifest, session: TrialSession, copy: Clone): Promise<void> {
  const { args, env } = await modeArgs(manifest, session, copy.mode);
  const before = await lastCostState(copy.path);
  const startedAt = new Date().toISOString();
  const run = await runClaude(['--resume', copy.id, ...args], {
    cwd: session.cwd,
    input: '/compact',
    env,
    timeoutMs: 30 * 60_000,
    log: nodePath.join(paths.logs, `compact-${session.n}-${copy.mode}.ndjson`),
  });
  const logs = pluginLogs(run.events);
  const boundary = run.events.find((e) => e['subtype'] === 'compact_boundary')?.['compact_metadata'] as
    | { pre_tokens?: number; post_tokens?: number; duration_ms?: number }
    | undefined;
  const result = resultEvent(run.events);
  const record: RunRecord = { ok: false, startedAt, wallMs: run.ms, logs };
  if (boundary?.duration_ms !== undefined) record.hostMs = boundary.duration_ms;
  if (boundary?.pre_tokens !== undefined) record.preTokens = boundary.pre_tokens;
  if (boundary?.post_tokens !== undefined) record.postTokens = boundary.post_tokens;
  Object.assign(record, costDelta(before, await lastCostState(copy.path)));
  const fallback = logs.find((line) => line.includes("used Claude's built-in summary instead"));
  if (fallback) record.fellBack = fallback.replace(/^lossless-compact: /, '');
  if (!boundary) record.error = result?.['is_error'] ? String(result['result'] ?? 'error') : `no compaction happened (exit ${run.code}) ${clip(run.stderr, 300)}`;
  else if (copy.mode === 'native' && logs.length > 0) record.error = 'lossless-compact ran on the /compact copy; switch the installed plugin off and run again';
  else record.ok = true;
  copy.compaction = record;
}

async function compact(): Promise<void> {
  const started = Date.now();
  const manifest = await loadManifest();
  const unlocked = manifest.sessions.filter((s) => !s.probes);
  if (unlocked.length) fail(`lock the probes first (${unlocked.map((s) => `#${s.n}`).join(', ')}): they are chosen before anything is compacted.`);
  if (manifest.sessions.some((s) => s.clones.length === 0)) fail('run `clone` first.');
  if (manifest.modes.includes('jev') && !(await jevKey())) fail('the trial includes Jev but no TypeSafe key is available any more.');
  const work = manifest.sessions
    .flatMap((session) => session.clones.filter((c) => !c.compaction?.ok).map((copy) => ({ session, copy })))
    // The summaries take minutes; start the biggest first.
    .sort((a, b) => Number(b.copy.mode === 'native') - Number(a.copy.mode === 'native') || b.session.contextTokens - a.session.contextTokens);
  console.log(`Compacting ${work.length} copies (${Number(arg('parallel') ?? '3')} at a time)…`);
  await pool(work, Number(arg('parallel') ?? '3'), async ({ session, copy }) => {
    await compactOne(manifest, session, copy);
    await writeJson(paths.manifest, manifest);
    const r = copy.compaction!;
    const what = r.ok
      ? `${kTokens(r.preTokens)} → ${kTokens(r.postTokens)} tokens in ${seconds(r.hostMs ?? r.wallMs)}, ${usd(r.costUsd)}${r.fellBack ? ` (handed to Claude's summary: ${clip(r.fellBack, 120)})` : ''}`
      : `FAILED: ${r.error}`;
    console.log(`#${session.n} ${LABEL[copy.mode].name}: ${what}`);
  });
  manifest.timings['compact'] = (manifest.timings['compact'] ?? 0) + (Date.now() - started);
  await writeJson(paths.manifest, manifest);
  console.log('\nNext: ask.');
}

/** The same words for every copy: tools are off, so the answer is what the compacted context (and retrieval) holds. */
function questionPrompt(question: string): string {
  return [
    'Quick memory check about this conversation. Your tools are switched off for this one question, so answer only from what you know of the conversation so far.',
    '',
    `Question: ${question}`,
    '',
    'Give the answer in one or two lines. If you do not know or are not sure, say "I don\'t know" instead of guessing.',
  ].join('\n');
}

function normal(text: string): string {
  return squash(text.toLowerCase().replace(/[`*"“”'‘’]/g, '')).trim();
}

const DONT_KNOW = /\b(i (?:do not|don'?t) know|not sure|unknown|can'?t (?:recall|tell|confirm|remember)|cannot (?:recall|tell|confirm|remember)|no (?:record|information) of)\b/i;

/** The expected detail as a whole token of the answer: `24` is in "24 MB", not in "240". */
function mentions(said: string, expected: string): boolean {
  const target = normal(expected);
  if (!target) return false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`).test(said);
}

/**
 * Only the clear cases: the detail without a hedge is right, a hedge without
 * the detail is "unknown". "I don't know… the only mention is PR #482" is
 * neither, and goes to the blind sheet like any other answer.
 */
function autoGrade(probe: Probe, text: string): Grade | undefined {
  const said = normal(text);
  const hit = [probe.answer, ...(probe.accept ?? [])].some((expected) => mentions(said, expected));
  const unsure = DONT_KNOW.test(text);
  if (hit && !unsure) return 'right';
  if (unsure && !hit) return 'unknown';
  return undefined;
}

async function askOne(manifest: Manifest, session: TrialSession, copy: Clone, probe: Probe): Promise<void> {
  const fork = randomUUID();
  (session.forks ??= []).push(fork);
  await writeJson(paths.manifest, manifest);
  // The archive is keyed by session; a fork has a new id, so it gets its own copy of it.
  const archived = nodePath.join(paths.archives, 'archive', copy.id);
  if (copy.mode !== 'native' && existsSync(archived)) await fsp.cp(archived, nodePath.join(paths.archives, 'archive', fork), { recursive: true });
  const { args, env } = await modeArgs(manifest, session, copy.mode);
  const before = await lastCostState(copy.path);
  const run = await runClaude(['--resume', copy.id, '--fork-session', '--session-id', fork, '--tools', '', ...args], {
    cwd: session.cwd,
    input: questionPrompt(probe.question),
    env,
    timeoutMs: 10 * 60_000,
    log: nodePath.join(paths.logs, `ask-${session.n}-${copy.mode}-${probe.id}.ndjson`),
  });
  const result = resultEvent(run.events);
  const usage = result?.['usage'] as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
  const text = typeof result?.['result'] === 'string' ? result['result'] : '';
  const ok = Boolean(result) && result?.['is_error'] !== true && text.length > 0;
  const answer: Answer = { probe: probe.id, mode: copy.mode, fork, ok, text, wallMs: run.ms };
  const after = await lastCostState(nodePath.join(nodePath.dirname(copy.path), `${fork}.jsonl`));
  const { costUsd } = costDelta(before, after);
  if (costUsd !== undefined) answer.costUsd = costUsd;
  if (usage) answer.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const recalled = pluginLogs(run.events).find((line) => line.includes('recalled'));
  if (recalled) answer.recalled = recalled.replace(/^lossless-compact: /, '');
  if (!ok) answer.error = clip(text || run.stderr || `exit ${run.code}`, 300);
  else {
    const grade = autoGrade(probe, text);
    if (grade) answer.auto = grade;
  }
  session.answers = session.answers.filter((a) => !(a.probe === probe.id && a.mode === copy.mode));
  session.answers.push(answer);
}

async function ask(): Promise<void> {
  const started = Date.now();
  const manifest = await loadManifest();
  const parallel = Number(arg('parallel') ?? '4');
  type Job = { session: TrialSession; copy: Clone; probe: Probe };
  const first: Job[] = [];
  const rest: Job[] = [];
  for (const session of manifest.sessions) {
    const probes = await readProbes(session);
    if (sha256(await fsp.readFile(probesPath(session), 'utf-8')) !== session.probes?.sha256) fail(`#${session.n}: the probes changed after they were locked.`);
    for (const copy of session.clones) {
      if (!copy.compaction?.ok) continue;
      const todo = probes.filter((p) => !session.answers.some((a) => a.probe === p.id && a.mode === copy.mode && a.ok));
      // One question per copy first, so the rest read its context from the prompt cache.
      todo.forEach((probe, i) => (i === 0 ? first : rest).push({ session, copy, probe }));
    }
  }
  const total = first.length + rest.length;
  let done = 0;
  console.log(`Asking ${total} questions (${parallel} at a time, tools off, one fork each)…`);
  const run = async ({ session, copy, probe }: Job): Promise<void> => {
    await askOne(manifest, session, copy, probe);
    await writeJson(paths.manifest, manifest);
    done++;
    if (done % 10 === 0 || done === total) console.log(`  ${done}/${total}`);
  };
  await pool(first, parallel, run);
  await pool(rest, parallel, run);
  manifest.timings['ask'] = (manifest.timings['ask'] ?? 0) + (Date.now() - started);
  await writeJson(paths.manifest, manifest);
  const failed = manifest.sessions.flatMap((s) => s.answers.filter((a) => !a.ok));
  if (failed.length) console.log(`${failed.length} questions failed (see ${paths.logs}); run ask again to retry them.`);
  console.log('Next: grade.');
}

interface GradingItem {
  gid: string;
  question: string;
  expected: string;
  alsoAccept?: string[];
  answer: string;
  grade: Grade | null;
}

/** Seeded shuffle: the sheet's order says nothing about which copy answered. */
function shuffle<T>(items: T[], seed: string): T[] {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16);
  const random = (): number => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function grade(): Promise<void> {
  const manifest = await loadManifest();
  const existing = existsSync(paths.grading) ? await readJson<{ items: GradingItem[] }>(paths.grading) : { items: [] };
  const key = existsSync(paths.gradingKey) ? await readJson<Record<string, string>>(paths.gradingKey) : {};
  const graded = new Map(existing.items.map((item) => [key[item.gid], item.grade]));
  const pending: { ref: string; item: Omit<GradingItem, 'gid'> }[] = [];
  let automatic = 0;
  for (const session of manifest.sessions) {
    const probes = new Map((await readProbes(session)).map((p) => [p.id, p]));
    for (const answer of session.answers) {
      if (!answer.ok) continue;
      const auto = autoGrade(probes.get(answer.probe)!, answer.text);
      if (auto) answer.auto = auto;
      else delete answer.auto;
      if (answer.auto) {
        automatic++;
        continue;
      }
      const probe = probes.get(answer.probe)!;
      const ref = `${session.id}|${answer.mode}|${answer.probe}`;
      pending.push({
        ref,
        item: {
          question: probe.question,
          expected: probe.answer,
          ...(probe.accept?.length ? { alsoAccept: probe.accept } : {}),
          answer: answer.text,
          grade: graded.get(ref) ?? null,
        },
      });
    }
  }
  await writeJson(paths.manifest, manifest);
  const order = shuffle(pending, manifest.createdAt);
  const items: GradingItem[] = order.map((p, i) => ({ gid: `g${String(i + 1).padStart(3, '0')}`, ...p.item }));
  await writeJson(paths.grading, {
    instructions:
      'Grade each answer against the expected detail, the same way for every item. "right": gives the expected detail as its answer, in any wording, even with a caveat that it could not re-check it. "partly": close but incomplete or imprecise (the right file but the wrong line), or mentions the detail while doubting it is the answer. "wrong": states something else as fact, including "you never said that" when the chat did. "unknown": says it does not know and offers nothing that matches. Which compaction produced an answer is deliberately not shown.',
    items,
  });
  await writeJson(
    paths.gradingKey,
    Object.fromEntries(items.map((item, i) => [item.gid, order[i]!.ref])),
  );
  const open = items.filter((item) => item.grade === null).length;
  console.log(`${automatic} answers graded mechanically (the exact detail is in the answer, or it said it does not know).`);
  console.log(`${items.length} need a judgment call, ${open} still ungraded: ${paths.grading}`);
  console.log(open ? 'Set each "grade", then run report.' : 'All graded. Next: report.');
}

/* ------------------------------------------------------------------ report */

interface ModeSummary {
  mode: Mode;
  chats: number;
  fellBack: number;
  preTokens: number;
  postTokens: number;
  removedPct?: number;
  probes: number;
  inContext: number;
  recoverable: number;
  asked: number;
  right: number;
  partly: number;
  wrong: number;
  unknown: number;
  ungraded: number;
  medianMs?: number;
  totalMs: number;
  costUsd: number;
  questionCostUsd: number;
  medianContextTokens?: number;
}

interface ProbeRow {
  session: number;
  title: string;
  probe: Probe;
  inContext: Partial<Record<Mode, boolean>>;
  recoverable: Partial<Record<Mode, boolean>>;
  answers: Partial<Record<Mode, { text: string; grade?: Grade; recalled?: string }>>;
}

interface ChatRow {
  n: number;
  title: string;
  cwd: string;
  model?: string;
  lastActive: string;
  contextTokens: number;
  probes: number;
  modes: Partial<Record<Mode, { cloneId: string; run?: RunRecord; inContext: number; recoverable: number; right: number; fresh?: number; stale?: number }>>;
}

async function archiveText(cloneId: string): Promise<string> {
  const archive = new FileArchive(nodeFs, { root: paths.archives });
  const list = await archive.list({ sessionId: cloneId });
  const records = await archive.getMany(list.map((s) => s.id));
  return records.map((r) => r.content).join('\n');
}

async function report(): Promise<void> {
  const manifest = await loadManifest();
  const key = existsSync(paths.gradingKey) ? await readJson<Record<string, string>>(paths.gradingKey) : {};
  const sheet = existsSync(paths.grading) ? await readJson<{ items: GradingItem[] }>(paths.grading) : { items: [] };
  const judged = new Map(sheet.items.map((item) => [key[item.gid], item.grade]));
  const probeRows: ProbeRow[] = [];
  const chats: ChatRow[] = [];
  const summaries = new Map<Mode, ModeSummary>(
    manifest.modes.map((mode) => [
      mode,
      { mode, chats: 0, fellBack: 0, preTokens: 0, postTokens: 0, probes: 0, inContext: 0, recoverable: 0, asked: 0, right: 0, partly: 0, wrong: 0, unknown: 0, ungraded: 0, totalMs: 0, costUsd: 0, questionCostUsd: 0 },
    ]),
  );
  const times = new Map<Mode, number[]>();
  const contexts = new Map<Mode, number[]>();
  for (const session of manifest.sessions) {
    if (!session.probes) continue;
    const probes = await readProbes(session);
    const chat: ChatRow = {
      n: session.n,
      title: session.title,
      cwd: session.cwd,
      ...(session.model ? { model: session.model } : {}),
      lastActive: session.lastActive,
      contextTokens: session.contextTokens,
      probes: probes.length,
      modes: {},
    };
    const rows = new Map<string, ProbeRow>(probes.map((probe) => [probe.id, { session: session.n, title: session.title, probe, inContext: {}, recoverable: {}, answers: {} }]));
    for (const copy of session.clones) {
      const run = copy.compaction;
      const s = summaries.get(copy.mode)!;
      const entry: NonNullable<ChatRow['modes'][Mode]> = { cloneId: copy.id, ...(run ? { run } : {}), inContext: 0, recoverable: 0, right: 0 };
      chat.modes[copy.mode] = entry;
      if (!run?.ok) continue;
      s.chats++;
      if (run.fellBack) s.fellBack++;
      s.preTokens += run.preTokens ?? 0;
      s.postTokens += run.postTokens ?? 0;
      s.totalMs += run.hostMs ?? run.wallMs;
      s.costUsd += run.costUsd ?? 0;
      (times.get(copy.mode) ?? times.set(copy.mode, []).get(copy.mode)!).push(run.hostMs ?? run.wallMs);
      if (copy.mode === 'native' && run.usage) {
        const prompt = run.usage.input + run.usage.cacheRead + run.usage.cacheWrite;
        const e = freshAndStale(manifest.model ?? session.model, prompt, run.usage.output);
        if (e.freshUsd !== undefined) entry.fresh = e.freshUsd;
        if (e.staleUsd !== undefined) entry.stale = e.staleUsd;
      }
      const active = activeText(lines(await fsp.readFile(copy.path, 'utf-8')));
      const archived = copy.mode === 'native' ? '' : await archiveText(copy.id);
      for (const probe of probes) {
        const row = rows.get(probe.id)!;
        const here = contains(active, probe.answer);
        const back = here || (archived.length > 0 && contains(archived, probe.answer));
        row.inContext[copy.mode] = here;
        row.recoverable[copy.mode] = back;
        s.probes++;
        if (here) {
          s.inContext++;
          entry.inContext++;
        }
        if (back) {
          s.recoverable++;
          entry.recoverable++;
        }
      }
      for (const answer of session.answers.filter((a) => a.mode === copy.mode && a.ok)) {
        const row = rows.get(answer.probe);
        if (!row) continue;
        const g = answer.auto ?? judged.get(`${session.id}|${answer.mode}|${answer.probe}`) ?? undefined;
        row.answers[copy.mode] = { text: answer.text, ...(g ? { grade: g } : {}), ...(answer.recalled ? { recalled: answer.recalled } : {}) };
        s.asked++;
        s.questionCostUsd += answer.costUsd ?? 0;
        if (answer.contextTokens) (contexts.get(copy.mode) ?? contexts.set(copy.mode, []).get(copy.mode)!).push(answer.contextTokens);
        if (g === 'right') {
          s.right++;
          entry.right++;
        } else if (g === 'partly') s.partly++;
        else if (g === 'wrong') s.wrong++;
        else if (g === 'unknown') s.unknown++;
        else s.ungraded++;
      }
    }
    probeRows.push(...rows.values());
    chats.push(chat);
  }
  const modes = [...summaries.values()].filter((s) => s.chats > 0);
  for (const s of modes) {
    if (s.preTokens > 0) s.removedPct = 1 - s.postTokens / s.preTokens;
    const m = median(times.get(s.mode) ?? []);
    if (m !== undefined) s.medianMs = m;
    const c = median(contexts.get(s.mode) ?? []);
    if (c !== undefined) s.medianContextTokens = c;
  }
  const ungraded = modes.reduce((sum, s) => sum + s.ungraded, 0);
  if (ungraded > 0 && !flag('allow-ungraded')) fail(`${ungraded} answers are still ungraded in ${paths.grading} (or pass --allow-ungraded).`);
  const results = { generatedAt: new Date().toISOString(), pluginVersion: manifest.pluginVersion, modes, chats, probes: probeRows, timings: manifest.timings };
  await writeJson(paths.results, results);
  await fsp.writeFile(paths.report, renderReport(manifest, modes, chats, probeRows), 'utf-8');

  console.log(`Report: ${paths.report}\n`);
  console.log(`| | Tokens removed | Details still in context | Details recoverable | Questions answered right | Said "don't know" | Answered wrong | Time per compaction | Cost of compacting |`);
  console.log(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const s of modes) {
    console.log(
      `| ${LABEL[s.mode].name} | ${s.removedPct === undefined ? '–' : `${Math.round(s.removedPct * 100)}%`} | ${s.inContext}/${s.probes} | ${s.recoverable}/${s.probes} | ${s.right}/${s.asked} | ${s.unknown} | ${s.wrong} | ${seconds(s.medianMs)} | ${usd(s.costUsd)} |`,
    );
  }
  const fellBack = modes.filter((s) => s.fellBack > 0);
  for (const s of fellBack) console.log(`\n${LABEL[s.mode].name} handed ${s.fellBack} of ${s.chats} chats to Claude's summary (it could not remove enough); those count as summaries here.`);
}

/* ----------------------------------------------------------- report html */

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const METRICS = ['Tokens removed', 'Details still in context', 'Details recoverable', 'Questions answered right', 'Time per compaction', 'Cost of compacting'];

function bar(metric: number, value: number, max: number, label: string, title: string, ours: boolean): string {
  const width = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return `<div class="metric" title="${esc(title)}"><span class="mlabel">${esc(METRICS[metric]!)}</span><div class="track"><div class="fill ${ours ? 'ours' : 'other'}" style="width:${(width * 100).toFixed(1)}%"></div></div><span class="val">${esc(label)}</span></div>`;
}

function gradeLabel(grade: Grade | undefined): string {
  return grade === 'right' ? 'right' : grade === 'partly' ? 'partly right' : grade === 'wrong' ? 'wrong' : grade === 'unknown' ? "didn't know" : 'ungraded';
}

function renderReport(manifest: Manifest, modes: ModeSummary[], chats: ChatRow[], probes: ProbeRow[]): string {
  const totalBefore = chats.reduce((sum, c) => sum + c.contextTokens, 0);
  const probeCount = chats.reduce((sum, c) => sum + c.probes, 0);
  const maxMs = Math.max(...modes.map((s) => s.medianMs ?? 0), 1);
  const maxCost = Math.max(...modes.map((s) => s.costUsd), 0.000001);
  const header = (lines2: [string, string]) => `<div class="colhead">${esc(lines2[0])}<br>${esc(lines2[1])}</div>`;
  const summaryRows = modes
    .map((s) => {
      const ours = OURS.includes(s.mode);
      const pct = s.removedPct ?? 0;
      return `<div class="row">
  <div class="name">${esc(LABEL[s.mode].name)}<small>${esc(LABEL[s.mode].sub)}${s.fellBack ? ` · ${s.fellBack} handed to the summary` : ''}</small></div>
  ${bar(0, pct, 1, `${Math.round(pct * 100)}%`, `${kTokens(s.preTokens)} → ${kTokens(s.postTokens)} tokens (Claude Code's count)`, ours)}
  ${bar(1, s.inContext, s.probes, `${s.inContext} / ${s.probes}`, 'the exact detail is still in the compacted context', ours)}
  ${bar(2, s.recoverable, s.probes, `${s.recoverable} / ${s.probes}`, ours ? 'in context, or in the archive the context points to' : 'a summary has no archive: only what it kept', ours)}
  ${bar(3, s.right, s.asked, `${s.right} / ${s.asked}`, `${s.partly} partly right, ${s.unknown} "don't know", ${s.wrong} wrong`, ours)}
  ${bar(4, s.medianMs ?? 0, maxMs, seconds(s.medianMs), 'median time Claude Code reports for one compaction; shorter is better', ours)}
  ${bar(5, s.costUsd, maxCost, usd(s.costUsd), `all ${s.chats} compactions, Claude Code's own cost counter${s.mode === 'jev' ? '; Jev requests are billed by TypeSafe (under a cent per compaction) and not included' : ''}`, ours)}
</div>`;
    })
    .join('\n');

  const nativeRun = modes.find((s) => s.mode === 'native');
  const wrongCards = modes
    .map(
      (s) => `<div class="tile"><div class="tile-num">${s.wrong}</div><div class="tile-label">wrong answers stated as fact<br><b>${esc(LABEL[s.mode].name)}</b></div></div>`,
    )
    .join('');

  // Where the copies disagree: our wins first (the summary lost a detail we kept), then the opposite.
  const score = (g: Grade | undefined): number => (g === 'right' ? 2 : g === 'partly' ? 1 : 0);
  const ours = modes.filter((s) => OURS.includes(s.mode)).map((s) => s.mode);
  const wins = probes.filter((p) => p.answers.native && ours.some((m) => score(p.answers[m]?.grade) > score(p.answers.native?.grade)));
  const losses = probes.filter((p) => p.answers.native && ours.every((m) => p.answers[m] && score(p.answers[m]?.grade) < score(p.answers.native?.grade)));
  const pick = (rows: ProbeRow[], n: number): ProbeRow[] => {
    const out: ProbeRow[] = [];
    const sorted = [...rows].sort((a, b) => Number(b.answers.native?.grade === 'wrong') - Number(a.answers.native?.grade === 'wrong'));
    for (const row of sorted) if (out.length < n && !out.some((o) => o.session === row.session)) out.push(row);
    for (const row of sorted) if (out.length < n && !out.includes(row)) out.push(row);
    return out;
  };
  const card = (row: ProbeRow): string => {
    const answers = manifest.modes
      .filter((m) => row.answers[m])
      .map((m) => {
        const a = row.answers[m]!;
        return `<div class="answer ${a.grade ?? 'ungraded'}"><div class="who">${esc(LABEL[m].name)} <span class="badge">${gradeLabel(a.grade)}</span></div><div class="said">${esc(clip(a.text, 420))}</div>${a.recalled ? `<div class="note">${esc(clip(a.recalled, 160))}</div>` : ''}</div>`;
      })
      .join('');
    return `<article class="card"><div class="q">${esc(row.probe.question)}</div><div class="meta">Chat #${row.session} · ${esc(clip(row.title, 70))} · the chat said <code>${esc(row.probe.answer)}</code>${row.probe.note ? ` · ${esc(row.probe.note)}` : ''}</div>${answers}</article>`;
  };

  const tryIt = chats
    .map((c) => {
      const cmds = manifest.modes
        .filter((m) => c.modes[m]?.run?.ok)
        .map((m) => {
          const id = c.modes[m]!.cloneId;
          const base = `cd "${c.cwd}" && `;
          const cmd =
            m === 'native'
              ? `${base}claude --resume ${id} --settings "${settingsFile(m)}"`
              : `${base}CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --resume ${id} --plugin-dir "${manifest.repoDir}" --settings "${settingsFile(m)}"`;
          return `<div class="cmd"><span>${esc(LABEL[m].name)}</span><code>${esc(cmd)}</code></div>`;
        })
        .join('');
      return `<details><summary>#${c.n} ${esc(clip(c.title, 80))}</summary>${cmds}</details>`;
    })
    .join('\n');

  const chatRows = chats
    .map((c) => {
      const cells = manifest.modes
        .map((m) => {
          const e = c.modes[m];
          const r = e?.run;
          if (!r?.ok) return `<td colspan="4" class="muted">${esc(r?.error ? `failed: ${clip(r.error, 60)}` : 'not run')}</td>`;
          return `<td>${kTokens(r.postTokens)}${r.fellBack ? ' <span class="badge">summary</span>' : ''}</td><td>${e!.right} / ${c.probes}</td><td>${seconds(r.hostMs ?? r.wallMs)}</td><td>${usd(r.costUsd)}</td>`;
        })
        .join('');
      return `<tr><td>#${c.n}</td><td>${esc(clip(c.title, 60))}<div class="muted">${esc(c.model ?? '')} · last active ${esc(ago(c.lastActive))}</div></td><td>${kTokens(c.contextTokens)}</td>${cells}</tr>`;
    })
    .join('\n');
  const costRows = chats
    .filter((c) => c.modes.native?.run?.ok)
    .map((c) => {
      const e = c.modes.native!;
      return `<tr><td>#${c.n}</td><td>${esc(clip(c.title, 60))}</td><td>${kTokens(c.contextTokens)}</td><td>${usd(e.run!.costUsd)}</td><td>${usd(e.fresh)}</td><td>${usd(e.stale)}</td><td>${seconds(e.run!.hostMs ?? e.run!.wallMs)}</td></tr>`;
    })
    .join('\n');
  const lockedAt = manifest.sessions.map((s) => s.probes?.lockedAt).filter(Boolean).sort()[0];
  const firstCompaction = manifest.sessions.flatMap((s) => s.clones.map((c) => c.compaction?.startedAt)).filter(Boolean).sort()[0];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compaction Trial Results</title>
<style>
:root{--bg:#fcfcfb;--ink:#1f2328;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--track:#f0efec;--ours:#2a78d6;--other:#9e9d96;--card:#ffffff;--good:#1a7f37;--bad:#cf222e;--warn:#9a6700;--code:#f3f2ee}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1a1a19;--ink:#e6e4dd;--ink2:#b5b3ab;--muted:#8a8882;--grid:#2e2e2b;--track:#262624;--ours:#3987e5;--other:#6b6a66;--card:#21211f;--good:#3fb950;--bad:#f85149;--warn:#d29922;--code:#2a2a27}}
:root[data-theme="dark"]{--bg:#1a1a19;--ink:#e6e4dd;--ink2:#b5b3ab;--muted:#8a8882;--grid:#2e2e2b;--track:#262624;--ours:#3987e5;--other:#6b6a66;--card:#21211f;--good:#3fb950;--bad:#f85149;--warn:#d29922;--code:#2a2a27}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:36px 0 8px}.sub{color:var(--ink2);margin:0 0 20px}
.chart{border-top:1px solid var(--grid);overflow-x:auto}.grid{display:grid;grid-template-columns:minmax(190px,1.4fr) repeat(6,minmax(110px,1fr));gap:10px 14px;min-width:900px;align-items:center;padding:10px 0}
.colhead{font-size:12px;color:var(--ink2);line-height:1.3}.row{display:contents}.name{font-size:14px}.name small{display:block;color:var(--muted);font-size:11.5px}
.metric{display:flex;align-items:center;gap:8px}.track{flex:1;height:14px;background:var(--track);border-radius:0 4px 4px 0}.fill{height:14px;border-radius:0 4px 4px 0}.fill.ours{background:var(--ours)}.fill.other{background:var(--other)}
.val{font-variant-numeric:tabular-nums;font-size:12.5px;min-width:56px}.key{display:flex;gap:16px;color:var(--ink2);font-size:12px;margin-top:6px}.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.tiles{display:flex;flex-wrap:wrap;gap:12px}.tile{background:var(--card);border:1px solid var(--grid);border-radius:8px;padding:12px 16px;min-width:200px;flex:1}.tile-num{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums}.tile-label{color:var(--ink2);font-size:12.5px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}.card{background:var(--card);border:1px solid var(--grid);border-radius:8px;padding:14px}.q{font-weight:600;margin-bottom:4px}.meta{color:var(--muted);font-size:12px;margin-bottom:8px}
.answer{border-left:3px solid var(--grid);padding:4px 0 4px 10px;margin-top:8px}.answer.right{border-color:var(--good)}.answer.wrong{border-color:var(--bad)}.answer.partly{border-color:var(--warn)}.who{font-size:12px;color:var(--ink2)}.said{white-space:pre-wrap;word-break:break-word}.note{font-size:11.5px;color:var(--muted)}
.badge{display:inline-block;font-size:11px;border:1px solid var(--grid);border-radius:10px;padding:0 7px;color:var(--ink2)}
code{background:var(--code);border-radius:4px;padding:1px 5px;font-size:12.5px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--grid);vertical-align:top}th{color:var(--ink2);font-weight:500}td{font-variant-numeric:tabular-nums}.muted{color:var(--muted);font-size:12px}
.tablewrap{overflow-x:auto}details{border-bottom:1px solid var(--grid);padding:8px 0}summary{cursor:pointer}.cmd{display:flex;flex-direction:column;gap:2px;margin:8px 0 0 14px}.cmd span{font-size:12px;color:var(--ink2)}
ul.notes{color:var(--ink2);padding-left:18px}
.mlabel{display:none}
@media (max-width:720px){.grid{grid-template-columns:1fr;min-width:0;gap:6px}.colhead,.grid>div:first-child{display:none}.name{margin-top:14px;font-weight:600}.mlabel{display:block;width:118px;flex:none;font-size:12px;color:var(--ink2)}}
</style>
</head>
<body>
<main>
<h1>What survives a compaction — on your own chats</h1>
<p class="sub">${chats.length} chat${chats.length === 1 ? '' : 's'}, ${kTokens(totalBefore)} tokens before compaction · ${probeCount} details chosen before anything was compacted · each copy asked the same ${probeCount} questions with its tools off · higher is better except time and cost</p>
<div class="chart"><div class="grid">
<div></div>${header(['Tokens', 'removed'])}${header(['Details still in', 'context, verbatim'])}${header(['Details still', 'recoverable'])}${header(['Questions', 'answered right'])}${header(['Time per', 'compaction'])}${header(['Cost of all', 'compactions'])}
${summaryRows}
</div></div>
<div class="key"><span><i style="background:var(--ours)"></i>lossless-compact</span><span><i style="background:var(--other)"></i>Claude Code's own /compact</span></div>

<h2>Did it make things up?</h2>
<p class="sub">An answer graded "wrong" stated something other than what the chat said, as fact. "I don't know" is not counted here.</p>
<div class="tiles">${wrongCards}</div>

<h2>See for yourself</h2>
<p class="sub">Questions where the copies disagreed${wins.length ? '' : ' (none: every copy answered the same way)'}. Every answer is quoted as given.</p>
<div class="cards">${pick(wins, 6).map(card).join('\n')}</div>
${losses.length ? `<h2>Where lossless-compact did worse</h2><p class="sub">Shown so the comparison is honest.</p><div class="cards">${pick(losses, 3).map(card).join('\n')}</div>` : ''}

<h2>Ask them yourself</h2>
<p class="sub">Every copy is a normal Claude Code session. Open two side by side (or pick them in <code>/resume</code>: they are titled <code>[trial · …]</code>) and ask the same question. On Windows PowerShell, set the variable with <code>$env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1</code> first.</p>
${tryIt}

<h2>Per chat</h2>
<div class="tablewrap"><table>
<thead><tr><th>#</th><th>Chat</th><th>Before</th>${manifest.modes.map((m) => `<th colspan="4">${esc(LABEL[m].name)}<div class="muted">after · right · time · cost</div></th>`).join('')}</tr></thead>
<tbody>${chatRows}</tbody>
</table></div>

${
  nativeRun
    ? `<h2>What Claude's /compact costs</h2>
<p class="sub">A summary is one call that reads the whole chat and writes a new one. Right after you used a chat, its context is still in Claude's prompt cache and that read is cheap; an hour later (five minutes on some setups) it is read in full again. lossless-compact makes no Claude call to compact${manifest.modes.includes('jev') ? '; Jev is a few small TypeSafe requests, under a cent' : ''}.</p>
<div class="tablewrap"><table><thead><tr><th>#</th><th>Chat</th><th>Context</th><th>Measured now</th><th>If still cached</th><th>If an hour old or more</th><th>Time</th></tr></thead><tbody>${costRows}</tbody></table></div>`
    : ''
}

<h2>How this was measured</h2>
<ul class="notes">
<li>Each chat was copied once per method; the originals were only read. A copy keeps the original's bytes (only its session id changes), so a chat used minutes ago still hit Claude's prompt cache, as it would for real.</li>
<li>The details were chosen by reading each chat and locked (sha256) at ${esc(lockedAt ?? '–')}, before the first compaction at ${esc(firstCompaction ?? '–')}.</li>
<li>"Still in context" and "recoverable" are exact-string checks. "Recoverable" also counts lossless-compact's archive, which the compacted chat names and can restore by id; a summary has nothing to restore from.</li>
<li>Every question went to its own fork of the compacted copy, same words, same model (${esc(manifest.model ?? 'each chat\'s own')}), tools off. lossless-compact's automatic retrieval was on, as it is in normal use. Answers containing the exact detail, or saying they did not know, were graded mechanically; the rest were graded blind, without knowing which copy answered.</li>
<li>Tokens and times are Claude Code's own figures (the compaction record it writes). Costs are Claude Code's cost counter at API list prices; on a Pro or Max plan they count against your usage limits instead. Median context per question: ${modes.map((s) => `${esc(LABEL[s.mode].name)} ${kTokens(s.medianContextTokens)}`).join(', ')}.</li>
<li>lossless-compact ${esc(manifest.pluginVersion)}${manifest.claudeVersion ? `, Claude Code ${esc(manifest.claudeVersion)}` : ''}. Raw data: <code>${esc(paths.results)}</code></li>
</ul>
</main>
</body>
</html>
`;
}

/* --------------------------------------------------------------- cleanup */

async function removeSession(projectDir: string, id: string): Promise<number> {
  const home = nodePath.join(os.homedir(), '.claude');
  const targets = [
    nodePath.join(projectDir, `${id}.jsonl`),
    nodePath.join(projectDir, id),
    nodePath.join(home, 'session-env', id),
    nodePath.join(home, 'file-history', id),
  ];
  let removed = 0;
  for (const target of targets) {
    if (!existsSync(target)) continue;
    await fsp.rm(target, { recursive: true, force: true });
    removed++;
  }
  const todos = nodePath.join(home, 'todos');
  if (existsSync(todos)) {
    for (const name of await fsp.readdir(todos)) {
      if (!name.startsWith(id)) continue;
      await fsp.rm(nodePath.join(todos, name), { force: true });
      removed++;
    }
  }
  return removed;
}

async function cleanup(): Promise<void> {
  const manifest = await loadManifest();
  let sessions = 0;
  let files = 0;
  for (const session of manifest.sessions) {
    const projectDir = nodePath.dirname(session.path);
    const ids = [...new Set([...session.clones.map((c) => c.id), ...session.answers.map((a) => a.fork), ...(session.forks ?? [])])];
    for (const id of ids) {
      const n = await removeSession(projectDir, id);
      if (n > 0) sessions++;
      files += n;
    }
    session.clones = [];
    session.answers = [];
    session.forks = [];
    if (!existsSync(session.path)) {
      console.log(`#${session.n} ${clip(session.title, 60)}: the original is gone (deleted outside the trial).`);
      continue;
    }
    const now = await fsp.readFile(session.path);
    const untouched = now.length >= session.bytes && sha256(now.subarray(0, session.bytes)) === session.sha256;
    const grew = now.length - session.bytes;
    console.log(
      `#${session.n} ${clip(session.title, 60)}: original ${untouched ? `unchanged${grew > 0 ? ` (you added ${kTokens(Math.round(grew / 4))} tokens of new messages since)` : ''}` : 'DIFFERS from when it was chosen'}`,
    );
  }
  for (const target of [paths.archives, paths.logs, paths.settings]) await fsp.rm(target, { recursive: true, force: true });
  await writeJson(paths.manifest, manifest);
  console.log(`\nRemoved ${sessions} trial sessions (${files} files and folders) and the trial's archives and logs.`);
  console.log(`Kept in ${dir}: the report, results.json, probes and digests. Delete the folder to remove those too.`);
}

async function status(): Promise<void> {
  if (!existsSync(paths.manifest)) {
    console.log(`No trial in ${dir}. Start with: candidates`);
    return;
  }
  const manifest = await loadManifest();
  console.log(`Trial in ${dir} · lossless-compact ${manifest.pluginVersion} · ${manifest.modes.map((m) => LABEL[m].name).join(' · ')}`);
  for (const s of manifest.sessions) {
    const compacted = s.clones.filter((c) => c.compaction?.ok).length;
    const answered = s.answers.filter((a) => a.ok).length;
    console.log(
      `#${s.n} ${clip(s.title, 60)}: ${s.clones.length} copies, probes ${s.probes ? `locked (${s.probes.count})` : 'not locked'}, ${compacted} compacted, ${answered} answers`,
    );
  }
  const steps = Object.entries(manifest.timings).map(([step, ms]) => `${step} ${seconds(ms)}`);
  if (steps.length) console.log(`Time so far: ${steps.join(', ')}`);
}

/* ------------------------------------------------------------------ main */

const commands: Record<string, () => Promise<void>> = { candidates, select, clone, digest, lock, compact, ask, grade, report, cleanup, status };
const command = process.argv[2] ?? 'status';
const run = commands[command];
if (!run) fail(`unknown command ${command}; one of: ${Object.keys(commands).join(', ')}`);
await run();
