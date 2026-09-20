/**
 * npx tsx scripts/capture-sessions.ts [--out datasets/real] [--min-bytes 500000]
 *   [--limit 20] [--project needle] [--redact-user-paths]
 *
 * Captures real Claude Code session transcripts (`~/.claude/projects/**\/*.jsonl`,
 * via `src/node/transcripts.ts`) into `<out>/<project>--<sessionId>/
 * {transcript.json,meta.json}`, redacting secrets (and, with
 * --redact-user-paths, the user segment of home-directory paths) through
 * `src/core/redact.ts`'s `Redactor` on the way. Prints a summary table.
 *
 * `<out>` (`datasets/real` by default) is not added to `.gitignore` by this
 * script — decide separately whether real captures should stay untracked.
 */
import { joinPath, nodeFs } from '../src/node/fs.js';
import { listSessions, loadTranscript } from '../src/node/transcripts.js';
import { estimateTokens } from '../src/state.js';
import type { Message } from '../src/types.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const out = arg('out') ?? 'datasets/real';
const minBytes = Number(arg('min-bytes') ?? '500000');
const limit = Number(arg('limit') ?? '20');
const projectFilter = arg('project');
const redactUserPaths = flag('redact-user-paths');

interface RedactorLike {
  redact(text: string): string;
  count: number;
}
type RedactorCtor = new (options?: { redactUserPaths?: boolean }) => RedactorLike;

/**
 * `src/core/redact.ts` is written by another agent in parallel; import it
 * dynamically so a missing module fails with one clear message instead of a
 * bare "Cannot find module" from a static import.
 */
async function loadRedactorCtor(): Promise<RedactorCtor> {
  try {
    const mod = (await import('../src/core/redact.js')) as { Redactor?: RedactorCtor };
    if (!mod.Redactor) throw new Error('module has no `Redactor` export');
    return mod.Redactor;
  } catch (error) {
    console.error(
      "capture-sessions: could not import '../src/core/redact.js'. Expected it to export " +
        '`class Redactor { constructor(options?: { redactUserPaths?: boolean }); redact(text: string): string; readonly count: number }`.',
    );
    console.error((error as Error).message);
    process.exit(1);
  }
}

/** Same content `messageChars` (src/compact.ts) counts: text, tool inputs, and each result once (via ToolUse.text). */
function transcriptText(messages: readonly Message[]): string {
  const pieces: string[] = [];
  for (const message of messages) {
    if (message.text) pieces.push(message.text);
    for (const tool of message.toolUses) {
      pieces.push(JSON.stringify(tool.input) ?? '');
      if (tool.text) pieces.push(tool.text);
    }
  }
  return pieces.join('\n');
}

interface Row {
  session: string;
  messages: number;
  toolCalls: number;
  chars: number;
  estTokens: number;
  compactions: number;
}

function printTable(rows: readonly Row[]): void {
  const columns: { key: keyof Row; header: string }[] = [
    { key: 'session', header: 'session' },
    { key: 'messages', header: 'messages' },
    { key: 'toolCalls', header: 'tool calls' },
    { key: 'chars', header: 'chars' },
    { key: 'estTokens', header: 'est tokens' },
    { key: 'compactions', header: 'compactions' },
  ];
  const cell = (row: Row, key: keyof Row): string => String(row[key]);
  const widths = columns.map((column) => Math.max(column.header.length, ...rows.map((row) => cell(row, column.key).length)));
  const line = (cells: string[]): string => cells.map((value, i) => value.padEnd(widths[i] ?? 0)).join('  ');
  console.log(line(columns.map((column) => column.header)));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(columns.map((column) => cell(row, column.key))));
}

const Redactor = await loadRedactorCtor();

const allSessions = await listSessions();
const filtered = allSessions.filter(
  (session) => session.bytes >= minBytes && (!projectFilter || session.project.includes(projectFilter)),
);
const picked = filtered.slice(0, limit);

if (picked.length === 0) {
  console.log(`No sessions matched (min-bytes=${minBytes}, project=${projectFilter ?? '*'}); scanned ${allSessions.length} session(s).`);
  process.exit(0);
}

const rows: Row[] = [];
for (const session of picked) {
  const redactor = new Redactor({ redactUserPaths });
  const loaded = await loadTranscript(session.path, { redact: (text) => redactor.redact(text) });

  const caseName = `${session.project}--${session.sessionId}`;
  const caseDir = joinPath(out, caseName);
  await nodeFs.write(joinPath(caseDir, 'transcript.json'), `${JSON.stringify(loaded.messages, null, 1)}\n`);

  const usageTotals = loaded.usage.reduce(
    (totals, entry) => ({
      input: totals.input + entry.input,
      cacheRead: totals.cacheRead + entry.cacheRead,
      cacheWrite: totals.cacheWrite + entry.cacheWrite,
      output: totals.output + entry.output,
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );

  const meta = {
    sessionId: loaded.sessionId,
    project: session.project,
    cwd: loaded.cwd,
    gitBranch: loaded.gitBranch,
    version: loaded.version,
    startedAt: loaded.startedAt,
    endedAt: loaded.endedAt,
    stats: loaded.stats,
    usageTotals,
    compactionIndices: loaded.compactionIndices,
    source: session.path,
    capturedAt: new Date().toISOString(),
    redactedSecrets: redactor.count,
  };
  await nodeFs.write(joinPath(caseDir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`);

  rows.push({
    session: caseName,
    messages: loaded.stats.messages,
    toolCalls: loaded.stats.toolUses,
    chars: loaded.stats.chars,
    estTokens: estimateTokens(transcriptText(loaded.messages)),
    compactions: loaded.compactionIndices.length,
  });
}

printTable(rows);
console.log(`\nWrote ${rows.length} case(s) under ${out}/.`);
console.log(`Note: ${out} is not added to .gitignore by this script; add it yourself if these captures should stay untracked.`);
