import { createReadStream, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as readline from 'node:readline';

import { messageChars } from '../compact.js';
import type { Message, ToolResult, ToolUse } from '../types.js';

/**
 * Turns real Claude Code session transcripts (`~/.claude/projects/<project>/
 * <sessionId>.jsonl`) into the library's `Message[]`. This is the only Node
 * boundary of the repo: everything here may use `node:fs`/`node:path`/
 * `node:os`/`node:readline`, which nothing outside `src/node/` is allowed to.
 */

export interface LoadedTranscript {
  sessionId: string;
  path: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  startedAt?: string;
  endedAt?: string;
  /** The compacted transcript; main chain only, in order. */
  messages: Message[];
  /** Per assistant API call, in order: token usage as recorded by the host. */
  usage: { timestamp?: string; model?: string; input: number; cacheRead: number; cacheWrite: number; output: number }[];
  /** Where the host compacted: index into `messages` of each compaction-summary message. */
  compactionIndices: number[];
  /** Records skipped by type (or by exclusion reason), for diagnostics. */
  skipped: Record<string, number>;
  stats: { records: number; messages: number; toolUses: number; toolResults: number; chars: number; parseErrors: number };
}

export interface LoadOptions {
  /** Include subagent (`isSidechain: true`) records inline. Default false: a subagent's transcript is a separate context. */
  includeSidechains?: boolean;
  /** Include `attachment` records (rendered system reminders) as their own user messages. Default false. */
  includeAttachments?: boolean;
  /** Prepend `[thinking] …` to the assistant text from `thinking` blocks. Default false: thinking is not sent back. */
  includeThinking?: boolean;
  /**
   * Strip `<system-reminder>…</system-reminder>` blocks out of user text (real
   * user messages and, when `includeAttachments` is on, attachment text).
   * Default false: they are genuinely part of the context, so they are kept
   * verbatim unless the caller asks to drop them.
   */
  stripSystemReminders?: boolean;
  /** Applied to every text, tool input string value and tool result before it is returned. */
  redact?: (text: string) => string;
}

/** A single parsed JSONL record; the host's schema is large and not fully typed here on purpose. */
interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  sessionId?: string;
  message?: RawApiMessage;
  rendered?: Array<{ content?: string }>;
  [key: string]: unknown;
}

interface RawApiMessage {
  id?: string;
  model?: string;
  role?: string;
  content?: unknown;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

type ContentBlock = Record<string, unknown>;

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function stripReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '');
}

function isBlockArray(content: unknown): content is ContentBlock[] {
  return Array.isArray(content);
}

/** One content block (`text` or `image`; anything else renders as ''). */
function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as ContentBlock;
  if (b['type'] === 'text') return typeof b['text'] === 'string' ? b['text'] : '';
  if (b['type'] === 'image') return '[image]';
  return '';
}

/** A tool_result's or a plain message's `content`: a string, or blocks of text/image. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isBlockArray(content)) {
    return content
      .map(blockText)
      .filter((text) => text.length > 0)
      .join('\n');
  }
  return '';
}

interface ParsedUserContent {
  text: string;
  toolResults: { tool_use_id: string; text: string; isError: boolean }[];
}

/** Splits a user message's `content` into its plain text and its tool_result blocks. */
function parseUserContent(content: unknown): ParsedUserContent {
  if (typeof content === 'string') return { text: content, toolResults: [] };
  if (!isBlockArray(content)) return { text: '', toolResults: [] };
  const textParts: string[] = [];
  const toolResults: ParsedUserContent['toolResults'] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block['type'] === 'tool_result') {
      toolResults.push({
        tool_use_id: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '',
        text: contentToText(block['content']),
        isError: block['is_error'] === true,
      });
      continue;
    }
    const text = blockText(block);
    if (text) textParts.push(text);
  }
  return { text: textParts.join('\n'), toolResults };
}

/** Deep-applies `redact` to every string leaf of a tool_use's `input`, leaving structure intact. */
function redactInput(input: Record<string, unknown>, redact: (text: string) => string): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = walk(inner);
      return out;
    }
    return value;
  };
  return walk(input) as Record<string, unknown>;
}

function isMessageEmpty(message: Message): boolean {
  return message.text === '' && message.toolUses.length === 0 && !(message.toolResults && message.toolResults.length > 0);
}

/**
 * Pure: turns already-split JSONL lines into a `LoadedTranscript`. `sessionId`
 * and `path` are filled in from the records themselves (or left `''`) since a
 * bare line iterable carries neither; `loadTranscript` fills them from the file.
 *
 * Building `messages`:
 * - The main chain is found by taking the last (by line order) `user`/
 *   `assistant` record that has a `uuid`, then walking `parentUuid` back to a
 *   root. Claude Code's own compactions show up as a record whose
 *   `parentUuid` is `null` partway through the file (the synthetic summary
 *   replaces everything before it) — that is a normal root, not a broken
 *   chain, so the walk simply stops there, which is exactly the "current"
 *   conversation. Records of every type (including `attachment`s) sit on the
 *   same `uuid`/`parentUuid` tree, so the walk passes through them; only
 *   `user`/`assistant` (and, optionally, `attachment`) records become
 *   `Message`s, everything else is counted in `skipped`.
 * - If a `parentUuid` points at a `uuid` this file never defines, the chain is
 *   broken: fall back to file order of non-sidechain records and count one
 *   `skipped.orphan_chain`.
 * - Consecutive `assistant` records sharing `message.id` (Claude Code writes
 *   one line per content block) are grouped into a single `Message`.
 * - Every `tool_use` gets its `text`/`isError` from the later `tool_result`
 *   with the same id, wherever in the chain it lands.
 */
export function parseTranscriptLines(lines: Iterable<string>, options: LoadOptions = {}): LoadedTranscript {
  const includeSidechains = options.includeSidechains ?? false;
  const includeAttachments = options.includeAttachments ?? false;
  const includeThinking = options.includeThinking ?? false;
  const doRedact = options.redact ?? ((text: string) => text);
  const doStrip = options.stripSystemReminders ? stripReminders : (text: string) => text;

  const skipped: Record<string, number> = {};
  const bump = (key: string): void => {
    skipped[key] = (skipped[key] ?? 0) + 1;
  };

  const records: RawRecord[] = [];
  const byUuid = new Map<string, RawRecord>();
  let sessionId = '';
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let parseErrors = 0;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let record: RawRecord;
    try {
      record = JSON.parse(line) as RawRecord;
    } catch {
      parseErrors++;
      continue;
    }
    records.push(record);
    if (typeof record.uuid === 'string') byUuid.set(record.uuid, record);
    if (!sessionId && typeof record.sessionId === 'string' && record.sessionId) sessionId = record.sessionId;
    if (typeof record.cwd === 'string') cwd = record.cwd;
    if (typeof record.gitBranch === 'string') gitBranch = record.gitBranch;
    if (typeof record.version === 'string') version = record.version;
    if (typeof record.timestamp === 'string') {
      if (startedAt === undefined) startedAt = record.timestamp;
      endedAt = record.timestamp;
    }
  }

  // Auxiliary record types (queue-operation, file-history-*, ai-title, atis-latch,
  // last-prompt, mode, system, …) never carry a uuid the chain walk could reach,
  // so they are tallied once here regardless of which path below is taken.
  for (const record of records) {
    const type = record.type ?? 'unknown';
    if (type !== 'user' && type !== 'assistant' && type !== 'attachment') bump(type);
  }

  const isMessageType = (record: RawRecord): boolean => record.type === 'user' || record.type === 'assistant';
  const sidechainOk = (record: RawRecord): boolean => includeSidechains || record.isSidechain !== true;

  const leafCandidates = records.filter((record) => isMessageType(record) && typeof record.uuid === 'string' && sidechainOk(record));

  let orderedChain: RawRecord[] = [];
  if (leafCandidates.length > 0) {
    const leaf = leafCandidates[leafCandidates.length - 1]!;
    const reversed: RawRecord[] = [];
    const visited = new Set<string>();
    let currentUuid: string | null | undefined = leaf.uuid;
    let orphan = false;
    while (currentUuid) {
      if (visited.has(currentUuid)) {
        orphan = true;
        break;
      }
      visited.add(currentUuid);
      const node = byUuid.get(currentUuid);
      if (!node) {
        orphan = true;
        break;
      }
      reversed.push(node);
      currentUuid = node.parentUuid ?? null;
    }
    if (orphan) {
      bump('orphan_chain');
      // Restricted to the types the loop below already knows how to handle
      // (user/assistant become messages, attachment is decided by
      // `includeAttachments`): the purely auxiliary types (queue-operation,
      // mode, …) were already tallied above, and including them here again
      // would double-count them.
      orderedChain = records.filter((record) => sidechainOk(record) && (isMessageType(record) || record.type === 'attachment'));
    } else {
      orderedChain = reversed.reverse();
    }
  }

  const messages: Message[] = [];
  const compactionIndices: number[] = [];
  const usage: LoadedTranscript['usage'] = [];
  const pendingToolUses = new Map<string, ToolUse>();

  const pushMessage = (message: Message): number | undefined => {
    if (isMessageEmpty(message)) {
      bump('empty');
      return undefined;
    }
    const index = messages.length;
    messages.push(message);
    return index;
  };

  const applyToolResults = (toolResults: ToolResult[]): void => {
    for (const result of toolResults) {
      const pending = pendingToolUses.get(result.tool_use_id);
      if (pending) {
        pending.text = result.text;
        pending.isError = result.isError;
        pendingToolUses.delete(result.tool_use_id);
      }
    }
  };

  let i = 0;
  while (i < orderedChain.length) {
    const record = orderedChain[i]!;

    if (record.isSidechain === true && !includeSidechains) {
      bump('sidechain');
      i++;
      continue;
    }

    if (record.type === 'attachment') {
      if (!includeAttachments) {
        bump('attachment');
        i++;
        continue;
      }
      const raw = (record.rendered ?? [])
        .map((entry) => entry?.content ?? '')
        .filter((text) => text.length > 0)
        .join('\n\n');
      const text = doRedact(doStrip(raw));
      pushMessage({ role: 'user', text, toolUses: [] });
      i++;
      continue;
    }

    if (record.type === 'user') {
      const { text: rawText, toolResults: rawToolResults } = parseUserContent(record.message?.content);
      const text = doRedact(doStrip(rawText));
      const toolResults: ToolResult[] = rawToolResults.map((result) => ({
        tool_use_id: result.tool_use_id,
        text: doRedact(result.text),
        isError: result.isError,
      }));
      const message: Message = { role: 'user', text, toolUses: [] };
      if (toolResults.length > 0) message.toolResults = toolResults;
      applyToolResults(toolResults);
      const index = pushMessage(message);
      if (index !== undefined && record.isCompactSummary === true) compactionIndices.push(index);
      i++;
      continue;
    }

    if (record.type === 'assistant') {
      const messageId = record.message?.id;
      const group: RawRecord[] = [record];
      let j = i + 1;
      while (
        j < orderedChain.length &&
        orderedChain[j]!.type === 'assistant' &&
        !(orderedChain[j]!.isSidechain === true && !includeSidechains) &&
        orderedChain[j]!.message?.id === messageId
      ) {
        group.push(orderedChain[j]!);
        j++;
      }

      const thinkingParts: string[] = [];
      const textParts: string[] = [];
      const toolUses: ToolUse[] = [];
      for (const block of group) {
        const content = block.message?.content;
        if (!isBlockArray(content)) continue;
        for (const item of content) {
          const type = item['type'];
          if (type === 'text') {
            const text = item['text'];
            if (typeof text === 'string') textParts.push(text);
          } else if (type === 'thinking') {
            const thinking = item['thinking'];
            if (includeThinking && typeof thinking === 'string' && thinking.length > 0) thinkingParts.push(thinking);
          } else if (type === 'tool_use') {
            const id = item['id'];
            const name = item['name'];
            const input = item['input'];
            if (typeof id === 'string' && typeof name === 'string') {
              const toolUse: ToolUse = {
                tool_use_id: id,
                tool: name,
                input: redactInput((input && typeof input === 'object' ? (input as Record<string, unknown>) : {}), doRedact),
              };
              toolUses.push(toolUse);
              pendingToolUses.set(id, toolUse);
            }
          }
        }
      }

      let text = textParts.join('\n');
      if (thinkingParts.length > 0) text = `[thinking] ${thinkingParts.join('\n')}${text ? `\n${text}` : ''}`;
      text = doRedact(text);

      pushMessage({ role: 'assistant', text, toolUses });

      const last = group[group.length - 1]!;
      const rawUsage = last.message?.usage;
      if (rawUsage) {
        usage.push({
          timestamp: last.timestamp,
          model: last.message?.model,
          input: rawUsage.input_tokens ?? 0,
          cacheRead: rawUsage.cache_read_input_tokens ?? 0,
          cacheWrite: rawUsage.cache_creation_input_tokens ?? 0,
          output: rawUsage.output_tokens ?? 0,
        });
      }

      i = j;
      continue;
    }

    // Any other type reachable via the parentUuid tree (only possible in the
    // orphan/fallback path, since the chain walk otherwise only ever visits
    // uuid-bearing user/assistant/attachment nodes it was pointed at).
    bump(record.type ?? 'unknown');
    i++;
  }

  const stats = {
    records: records.length,
    messages: messages.length,
    toolUses: messages.reduce((sum, message) => sum + message.toolUses.length, 0),
    toolResults: messages.reduce((sum, message) => sum + (message.toolResults?.length ?? 0), 0),
    chars: messages.reduce((sum, message) => sum + messageChars(message), 0),
    parseErrors,
  };

  const result: LoadedTranscript = {
    sessionId,
    path: '',
    messages,
    usage,
    compactionIndices,
    skipped,
    stats,
  };
  if (cwd !== undefined) result.cwd = cwd;
  if (gitBranch !== undefined) result.gitBranch = gitBranch;
  if (version !== undefined) result.version = version;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (endedAt !== undefined) result.endedAt = endedAt;
  return result;
}

/** Streams a transcript file line by line (never reading the whole file into one string) and parses it. */
export async function loadTranscript(path: string, options: LoadOptions = {}): Promise<LoadedTranscript> {
  const lines: string[] = [];
  const rl = readline.createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) lines.push(line);

  const parsed = parseTranscriptLines(lines, options);
  parsed.path = path;
  if (!parsed.sessionId) parsed.sessionId = nodePath.basename(path, '.jsonl');
  return parsed;
}

/** `~/.claude/projects`, where Claude Code keeps one folder of `.jsonl` transcripts per project. */
export function claudeProjectsRoot(): string {
  return nodePath.join(os.homedir(), '.claude', 'projects');
}

/** Lists session transcript files under `root` (default `claudeProjectsRoot()`), largest first. */
export async function listSessions(
  root: string = claudeProjectsRoot(),
): Promise<{ path: string; project: string; sessionId: string; bytes: number; modified: string }[]> {
  let projectEntries: string[];
  try {
    projectEntries = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const sessions: { path: string; project: string; sessionId: string; bytes: number; modified: string }[] = [];
  for (const project of projectEntries) {
    const projectDir = nodePath.join(root, project);
    let names: string[];
    try {
      names = await fsp.readdir(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = nodePath.join(projectDir, name);
      let stat: Awaited<ReturnType<typeof fsp.stat>>;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      sessions.push({
        path: filePath,
        project,
        sessionId: name.slice(0, -'.jsonl'.length),
        bytes: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
  }
  sessions.sort((a, b) => b.bytes - a.bytes);
  return sessions;
}
