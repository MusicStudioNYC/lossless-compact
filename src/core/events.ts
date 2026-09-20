import { hashJson, hashText } from './hash.js';
import { estimateTokens } from '../state.js';
import type { Message } from '../types.js';

/**
 * The canonical, host-independent view of a conversation: a flat stream of
 * events. A host adapter turns its transcript into events (and back); every
 * policy, archive record and memory refers to events by their stable ids.
 */
export type EventRole = 'user' | 'assistant' | 'tool';

export type EventKind = 'user_text' | 'assistant_text' | 'tool_use' | 'tool_result';

export interface NormalizedEvent {
  /** Stable across compactions of the same session: derived from content, not position. */
  id: string;
  /** Position in the stream this ledger was built from (0-based). */
  seq: number;
  role: EventRole;
  kind: EventKind;
  /** Exact content: the text, or the serialised tool input, or the tool result. */
  content: string;
  toolName?: string;
  toolUseId?: string;
  /** For a tool_use: the parsed input, kept so tools can be re-run. */
  toolInput?: Record<string, unknown>;
  isError?: boolean;
  /** Index of the `Message` this event came from. */
  messageIndex: number;
  /** Fingerprint of `content` (plus tool name and input for a tool_use). */
  contentHash: string;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
}

/** Events grouped back by their source message, in order. */
export interface Ledger {
  events: NormalizedEvent[];
  byId: Map<string, NormalizedEvent>;
  /** tool_use_id → [tool_use event, tool_result event or undefined]. */
  interactions: Map<string, { use: NormalizedEvent; result?: NormalizedEvent }>;
}

function serialiseInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? '{}';
  } catch {
    return '[unserializable input]';
  }
}

/**
 * The stable id of an event: a fingerprint of what it is and says, so the same
 * message gets the same id no matter how many messages before it were removed.
 * Identical repeated texts get a `~2`, `~3` … suffix in stream order.
 */
export function eventId(
  kind: EventKind,
  content: string,
  toolUseId: string | undefined,
  taken: Set<string>,
): string {
  const base = `e_${hashText(`${kind}\u0000${toolUseId ?? ''}\u0000${content}`)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}~${n}`;
  taken.add(id);
  return id;
}

/** Turns a transcript into its event stream, pairing tool uses with results. */
export function buildLedger(messages: readonly Message[]): Ledger {
  const events: NormalizedEvent[] = [];
  const taken = new Set<string>();
  const push = (event: Omit<NormalizedEvent, 'id' | 'seq' | 'tokenEstimate' | 'contentHash'>): void => {
    const hashed =
      event.kind === 'tool_use'
        ? hashText(`${event.toolName}\u0000${event.content}`)
        : hashText(event.content);
    events.push({
      ...event,
      id: eventId(event.kind, event.content, event.toolUseId, taken),
      seq: events.length,
      contentHash: hashed,
      tokenEstimate: estimateTokens(event.content),
    });
  };
  messages.forEach((message, messageIndex) => {
    if (message.text.trim().length > 0) {
      push({
        role: message.role,
        kind: message.role === 'user' ? 'user_text' : 'assistant_text',
        content: message.text,
        messageIndex,
        metadata: {},
      });
    }
    for (const tool of message.toolUses) {
      push({
        role: 'assistant',
        kind: 'tool_use',
        content: serialiseInput(tool.input),
        toolName: tool.tool,
        toolUseId: tool.tool_use_id,
        toolInput: tool.input,
        messageIndex,
        metadata: {},
      });
    }
    for (const result of message.toolResults ?? []) {
      push({
        role: 'tool',
        kind: 'tool_result',
        content: result.text,
        toolUseId: result.tool_use_id,
        isError: result.isError ?? false,
        messageIndex,
        metadata: {},
      });
    }
  });
  const byId = new Map(events.map((event) => [event.id, event]));
  const interactions = new Map<string, { use: NormalizedEvent; result?: NormalizedEvent }>();
  for (const event of events) {
    if (event.kind === 'tool_use' && event.toolUseId) {
      interactions.set(event.toolUseId, { use: event });
    }
  }
  for (const event of events) {
    if (event.kind === 'tool_result' && event.toolUseId) {
      const pair = interactions.get(event.toolUseId);
      if (pair) {
        pair.result = event;
        pair.use.metadata['resultId'] = event.id;
      }
    }
  }
  for (const [toolUseId, pair] of interactions) {
    if (pair.result) pair.result.toolName = pair.use.toolName;
    pair.use.metadata['toolUseId'] = toolUseId;
  }
  return { events, byId, interactions };
}

/** Sum of the estimated tokens of a set of events. */
export function eventTokens(events: Iterable<NormalizedEvent>): number {
  let total = 0;
  for (const event of events) total += event.tokenEstimate;
  return total;
}

/** A fingerprint of a whole transcript (for cassettes, reports and change detection). */
export function transcriptHash(messages: readonly Message[]): string {
  return hashJson(
    messages.map((message) => [
      message.role,
      message.text,
      message.toolUses.map((tool) => [tool.tool_use_id, tool.tool, serialiseInput(tool.input)]),
      (message.toolResults ?? []).map((result) => [result.tool_use_id, result.text, result.isError ?? false]),
    ]),
  );
}
