import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { estimateTokens } from '../../state.js';
import type { Message } from '../../types.js';

/** How a labelled tool call should come out of compaction. */
export type CallLabel = 'must_keep' | 'nice_to_keep' | 'safe_to_truncate' | 'safe_to_drop';

/** One exact detail a case's transcript carries, that a scorer checks for. */
export interface Probe {
  id: string;
  /** What the detail is: constraint | error | path | decision | fact | port | key | workaround | history */
  kind: string;
  /** An exact substring that must be findable. */
  text: string;
  /** 'active' = must remain verbatim in the compacted transcript; 'active_or_archive' = may be archived but must be recoverable. */
  where: 'active' | 'active_or_archive';
  /** Why it matters at the end of the session. */
  note: string;
}

/** The gold labels for one case: per-call verdicts plus the probes to check. */
export interface Labels {
  version: 1;
  /** tool_use_id → label, for every non-pinned tool call the author has an opinion about (unlabelled calls are ignored by scorers). */
  calls: Record<string, CallLabel>;
  probes: Probe[];
}

export interface CaseMeta {
  name: string;
  description: string;
  source: 'synthetic' | 'real';
  generator?: string;
  seed?: number;
  messages: number;
  toolCalls: number;
  chars: number;
  estTokens: number;
  createdAt: string;
}

/** One eval case loaded from disk: its transcript plus whatever labels/meta/cassette sit beside it. */
export interface DatasetCase {
  dir: string;
  name: string;
  transcript: Message[];
  labels?: Labels;
  meta?: CaseMeta;
  /** `dir/cassette.json`, may not exist. */
  cassettePath: string;
}

const TRANSCRIPT_FILE = 'transcript.json';
const LABELS_FILE = 'labels.json';
const META_FILE = 'meta.json';
const CASSETTE_FILE = 'cassette.json';

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Total content characters a transcript costs: message text, tool inputs and
 * tool outputs. A call's output is counted once, from `ToolUse.text` — per
 * `src/types.ts`, `ToolResult.text` always mirrors it, so adding both would
 * double-count every tool result.
 */
export function transcriptChars(transcript: readonly Message[]): number {
  let chars = 0;
  for (const message of transcript) {
    chars += message.text.length;
    for (const tool of message.toolUses) {
      chars += jsonLength(tool.input);
      chars += tool.text?.length ?? 0;
    }
  }
  return chars;
}

/** Number of tool_use blocks across the transcript. */
export function countToolCalls(transcript: readonly Message[]): number {
  let calls = 0;
  for (const message of transcript) calls += message.toolUses.length;
  return calls;
}

/** Same content `transcriptChars` counts, estimated in tokens via `estimateTokens`. */
export function estimateTranscriptTokens(transcript: readonly Message[]): number {
  const pieces: string[] = [];
  for (const message of transcript) {
    if (message.text) pieces.push(message.text);
    for (const tool of message.toolUses) {
      pieces.push(JSON.stringify(tool.input) ?? '');
      if (tool.text) pieces.push(tool.text);
    }
  }
  return estimateTokens(pieces.join('\n'));
}

/** The directory's own name, used as the case name. */
export function caseName(dir: string): string {
  return path.basename(dir);
}

async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Recursively collects every directory under `dir` (including `dir` itself) that holds a `transcript.json`. */
async function findCaseDirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  if (entries.some((entry) => entry.isFile() && entry.name === TRANSCRIPT_FILE)) found.push(dir);
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(...(await findCaseDirs(path.join(dir, entry.name))));
  }
  return found;
}

/** Loads every case (any subdirectory, at any depth, that holds a `transcript.json`) under `datasetDir`. */
export async function listCases(datasetDir: string): Promise<DatasetCase[]> {
  const dirs = (await findCaseDirs(datasetDir)).sort();
  const cases: DatasetCase[] = [];
  for (const dir of dirs) {
    const transcript = JSON.parse(await readFile(path.join(dir, TRANSCRIPT_FILE), 'utf8')) as Message[];
    const labels = await readJsonIfExists<Labels>(path.join(dir, LABELS_FILE));
    const meta = await readJsonIfExists<CaseMeta>(path.join(dir, META_FILE));
    const item: DatasetCase = {
      dir,
      name: caseName(dir),
      transcript,
      cassettePath: path.join(dir, CASSETTE_FILE),
    };
    if (labels) item.labels = labels;
    if (meta) item.meta = meta;
    cases.push(item);
  }
  return cases;
}

/**
 * Writes one case's `transcript.json`, `labels.json` (when given) and
 * `meta.json`, computing `meta`'s counts from the transcript itself so they
 * can never drift from the file they describe.
 */
export async function writeCase(
  dir: string,
  transcript: Message[],
  labels: Labels | undefined,
  meta: Omit<CaseMeta, 'messages' | 'toolCalls' | 'chars' | 'estTokens' | 'createdAt'>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const fullMeta: CaseMeta = {
    ...meta,
    messages: transcript.length,
    toolCalls: countToolCalls(transcript),
    chars: transcriptChars(transcript),
    estTokens: estimateTranscriptTokens(transcript),
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, TRANSCRIPT_FILE), `${JSON.stringify(transcript, null, 1)}\n`, 'utf8');
  if (labels) await writeFile(path.join(dir, LABELS_FILE), `${JSON.stringify(labels, null, 1)}\n`, 'utf8');
  await writeFile(path.join(dir, META_FILE), `${JSON.stringify(fullMeta, null, 1)}\n`, 'utf8');
}
