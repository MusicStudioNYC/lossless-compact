import type { Message } from '../../types.js';
import type { ModelCall } from './model.js';

/** Cap on one tool_result's rendered length before the `[… N chars omitted …]` marker. */
const RESULT_CHARS = 20_000;
/** Cap on the whole rendered transcript; oldest turns are abridged first. */
const TOTAL_CHARS = 600_000;

export interface RenderOptions {
  resultChars?: number;
  totalChars?: number;
}

export interface RenderedTranscript {
  text: string;
  /** Whether the 600k total cap forced any abridgement. */
  truncated: boolean;
  /** Characters removed from the rendering to fit the cap (0 when `truncated` is false). */
  omittedChars: number;
}

function serialiseInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? '{}';
  } catch {
    return '[unserializable input]';
  }
}

function capResult(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n[… ${omitted} chars omitted …]`;
}

/** Renders one message as `role:` followed by its text, tool_use and tool_result lines; `''` when it has nothing to show. */
function renderMessage(message: Message, resultChars: number): string {
  const lines: string[] = [];
  if (message.text.trim().length > 0) lines.push(message.text);
  for (const tool of message.toolUses) {
    lines.push(`[tool_use ${tool.tool} ${serialiseInput(tool.input)}]`);
  }
  for (const result of message.toolResults ?? []) {
    lines.push(`[tool_result ${result.tool_use_id}]\n${capResult(result.text, resultChars)}`);
  }
  if (lines.length === 0) return '';
  return `${message.role}:\n${lines.join('\n')}`;
}

/**
 * Renders a transcript as role-labelled text for a model prompt: `tool_use`
 * as `[tool_use <tool> <json input>]`, `tool_result` as `[tool_result
 * <id>]\n<text>` capped at `resultChars` (default 20 000) each. If the whole
 * rendering still exceeds `totalChars` (default 600 000), the oldest turns
 * are replaced with short placeholders first (never the most recent one),
 * and — if that alone isn't enough — the remaining overage is cut from the
 * front. Shared by `nativeCompaction` and `judgeRetention` so both see the
 * conversation the same way.
 */
export function renderTranscript(messages: readonly Message[], options: RenderOptions = {}): RenderedTranscript {
  const resultChars = options.resultChars ?? RESULT_CHARS;
  const totalChars = options.totalChars ?? TOTAL_CHARS;
  const join = (blocks: readonly string[]): string => blocks.filter((block) => block.length > 0).join('\n\n');

  const blocks = messages.map((message) => renderMessage(message, resultChars));
  let text = join(blocks);
  if (text.length <= totalChars) return { text, truncated: false, omittedChars: 0 };

  const working = [...blocks];
  let omittedChars = 0;
  for (let i = 0; i < working.length - 1 && join(working).length > totalChars; i++) {
    const original = working[i]!;
    if (original.length === 0) continue;
    const placeholder = `[… message ${i} abridged, ${original.length} chars omitted …]`;
    if (placeholder.length >= original.length) continue;
    omittedChars += original.length - placeholder.length;
    working[i] = placeholder;
  }
  text = join(working);
  if (text.length > totalChars) {
    // A single huge recent message is still over the cap on its own: cut from the front.
    const over = text.length - totalChars;
    omittedChars += over;
    text = `[… ${over} chars omitted …]\n${text.slice(over)}`;
  }
  return { text, truncated: true, omittedChars };
}

/**
 * The instructions half of Claude Code's own `/compact` prompt, approximated
 * faithfully: a detailed, structured summary in place of the conversation.
 * `nativeCompaction` prepends the rendered transcript.
 */
export const NATIVE_COMPACTION_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you have covered all necessary points. In your analysis:
1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify the user's explicit requests and intents, your approach to addressing them, key decisions, technical concepts and code patterns, and specific details like file names, full code snippets, function signatures, and file edits.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where important, noting any specific changes that have been made, and explain why each file is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results, verbatim where short. These are critical for understanding the user's feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take, directly in line with the user's explicit requests and the task immediately before this summary request; do not start on tangential work without confirming with the user first. Include a direct quote from the most recent conversation showing exactly what task you were working on and where you left off.

Output only the summary, structured as the numbered sections above. No preamble, no closing remarks.`;

export interface NativeCompactionResult {
  /** The compacted transcript: the summary as a single user message, then the kept tail. */
  output: Message[];
  summary: string;
  ms: number;
  /** Length of the rendered transcript sent to the model. */
  renderedChars: number;
  /** Whether the renderer had to abridge older turns to fit its 600k cap. */
  abridged: boolean;
  omittedChars: number;
}

/** Drops any tool_result in `tail` whose tool_use isn't also in `tail` (it was cut into the summary). */
function dropOrphanResults(tail: readonly Message[]): Message[] {
  const kept = new Set<string>();
  for (const message of tail) for (const tool of message.toolUses) kept.add(tool.tool_use_id);
  return tail.map((message) => {
    const toolResults = message.toolResults ?? [];
    const filtered = toolResults.filter((result) => kept.has(result.tool_use_id));
    if (filtered.length === toolResults.length) return message;
    const next: Message = { ...message, toolResults: filtered };
    return next;
  });
}

/**
 * Approximates Claude Code's `/compact`: renders the whole transcript,
 * asks `model` for a detailed summary, then replaces the history with that
 * summary plus the last `keepRecent` messages (default 0 — Claude Code
 * itself keeps nothing but the summary; the eval runner can pass a non-zero
 * `keepRecent` for parity with the other modes' `preserveRecentMessages`).
 */
export async function nativeCompaction(
  transcript: Message[],
  model: ModelCall,
  options: { keepRecent?: number } = {},
): Promise<NativeCompactionResult> {
  const keepRecent = options.keepRecent ?? 0;
  const rendered = renderTranscript(transcript);
  const prompt = `Here is the full conversation transcript so far, oldest first:\n\n${rendered.text}\n\n${NATIVE_COMPACTION_PROMPT}`;
  const started = Date.now();
  const { text } = await model(prompt);
  const summary = text.trim();
  const ms = Date.now() - started;

  const tail = keepRecent > 0 ? transcript.slice(-keepRecent) : [];
  const kept = dropOrphanResults(tail);
  const output: Message[] = [{ role: 'user', text: summary, toolUses: [] }, ...kept];

  return {
    output,
    summary,
    ms,
    renderedChars: rendered.text.length,
    abridged: rendered.truncated,
    omittedChars: rendered.omittedChars,
  };
}
