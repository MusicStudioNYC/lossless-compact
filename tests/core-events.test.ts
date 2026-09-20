import { describe, expect, it } from 'vitest';
import { fnv1a64, hashJson, hashText } from '../src/core/hash.js';
import { buildLedger, eventId, transcriptHash } from '../src/core/events.js';
import type { Message } from '../src/types.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

describe('fnv1a64 / hashText', () => {
  it('is deterministic', () => {
    expect(hashText('hello world')).toBe(hashText('hello world'));
    expect(fnv1a64('hello world')).toBe(fnv1a64('hello world'));
  });

  it('produces 16 lowercase hex characters', () => {
    expect(hashText('anything')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashText('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives different inputs different hashes', () => {
    expect(hashText('a')).not.toBe(hashText('b'));
    expect(hashText('hello')).not.toBe(hashText('Hello'));
    expect(hashText('hello world')).not.toBe(hashText('hello world '));
  });

  it('hashes the empty string without throwing', () => {
    expect(() => hashText('')).not.toThrow();
    expect(hashText('')).toBe(hashText(''));
  });

  it('hashJson falls back to a tag for unserialisable values', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => hashJson(circular)).not.toThrow();
    expect(hashJson(circular)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('buildLedger', () => {
  it('produces events in stream order with increasing seq and the right kinds', () => {
    const messages: Message[] = [
      message('user', 'please read a.ts'),
      call('c1', 'Read', { file_path: 'a.ts' }, 'file contents'),
      result('c1', 'file contents'),
      message('assistant', 'done reading'),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(ledger.events.map((e) => e.kind)).toEqual(['user_text', 'tool_use', 'tool_result', 'assistant_text']);
    expect(ledger.events.map((e) => e.messageIndex)).toEqual([0, 1, 2, 3]);
    expect(ledger.byId.size).toBe(ledger.events.length);
    for (const event of ledger.events) expect(ledger.byId.get(event.id)).toBe(event);
  });

  it('skips messages with blank text but keeps their tool events', () => {
    const messages: Message[] = [call('c1', 'Read', { file_path: 'a.ts' }, 'x'), result('c1', 'x')];
    const ledger = buildLedger(messages);
    expect(ledger.events).toHaveLength(2);
    expect(ledger.events.every((e) => e.kind !== 'user_text' && e.kind !== 'assistant_text')).toBe(true);
  });

  it('pairs tool_use with tool_result in interactions, keyed by tool_use_id', () => {
    const messages: Message[] = [
      message('user', 'go'),
      call('c1', 'Bash', { command: 'ls' }, 'a.ts\nb.ts'),
      result('c1', 'a.ts\nb.ts'),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.interactions.size).toBe(1);
    const pair = ledger.interactions.get('c1')!;
    expect(pair.use.kind).toBe('tool_use');
    expect(pair.result?.kind).toBe('tool_result');
    expect(pair.use.metadata['resultId']).toBe(pair.result?.id);
    expect(pair.use.metadata['toolUseId']).toBe('c1');
  });

  it('copies the tool name from the use onto the result', () => {
    const messages: Message[] = [call('c1', 'Grep', { pattern: 'x' }, 'match'), result('c1', 'match')];
    const ledger = buildLedger(messages);
    const pair = ledger.interactions.get('c1')!;
    expect(pair.use.toolName).toBe('Grep');
    expect(pair.result?.toolName).toBe('Grep');
  });

  it('leaves a tool_use unpaired when no matching tool_result exists', () => {
    const messages: Message[] = [call('c1', 'Read', { file_path: 'a.ts' }, 'x')];
    const ledger = buildLedger(messages);
    const pair = ledger.interactions.get('c1')!;
    expect(pair.use).toBeDefined();
    expect(pair.result).toBeUndefined();
  });
});

describe('stable ids', () => {
  it('gives the same message the same id after earlier messages are removed', () => {
    const full: Message[] = [
      message('user', 'an earlier message that will be removed'),
      message('assistant', 'the target message, unique text'),
      message('user', 'a later message'),
    ];
    const trimmed = full.slice(1);
    const idFull = buildLedger(full).events.find((e) => e.content === 'the target message, unique text')!.id;
    const idTrimmed = buildLedger(trimmed).events.find((e) => e.content === 'the target message, unique text')!.id;
    expect(idFull).toBe(idTrimmed);
  });

  it('keeps a tool interaction id stable when unrelated earlier messages are removed', () => {
    const full: Message[] = [
      message('user', 'filler 1'),
      message('user', 'filler 2'),
      call('c1', 'Read', { file_path: 'a.ts' }, 'contents of a'),
      result('c1', 'contents of a'),
    ];
    const trimmed = full.slice(2);
    const useIdFull = buildLedger(full).interactions.get('c1')!.use.id;
    const useIdTrimmed = buildLedger(trimmed).interactions.get('c1')!.use.id;
    expect(useIdFull).toBe(useIdTrimmed);
  });

  it('gives duplicate identical texts a ~2, ~3 suffix in stream order', () => {
    const messages: Message[] = [
      message('assistant', 'the exact same text'),
      message('assistant', 'the exact same text'),
      message('assistant', 'the exact same text'),
    ];
    const ledger = buildLedger(messages);
    const [first, second, third] = ledger.events;
    expect(first!.id).not.toContain('~');
    expect(second!.id).toBe(`${first!.id}~2`);
    expect(third!.id).toBe(`${first!.id}~3`);
  });

  it('eventId assigns suffixes directly against a taken set', () => {
    const taken = new Set<string>();
    const id1 = eventId('user_text', 'same content', undefined, taken);
    const id2 = eventId('user_text', 'same content', undefined, taken);
    const id3 = eventId('user_text', 'different content', undefined, taken);
    expect(id1).not.toBe(id2);
    expect(id2).toBe(`${id1}~2`);
    expect(id3).not.toBe(id1);
    expect(taken.has(id1)).toBe(true);
    expect(taken.has(id2)).toBe(true);
    expect(taken.has(id3)).toBe(true);
  });
});

describe('transcriptHash', () => {
  it('is stable for the same content and changes when content changes', () => {
    const a: Message[] = [message('user', 'hi'), message('assistant', 'hello')];
    const aAgain: Message[] = [message('user', 'hi'), message('assistant', 'hello')];
    const b: Message[] = [message('user', 'hi there'), message('assistant', 'hello')];
    expect(transcriptHash(a)).toBe(transcriptHash(aAgain));
    expect(transcriptHash(a)).not.toBe(transcriptHash(b));
  });

  it('changes when a tool result changes even if the tool_use is identical', () => {
    const a: Message[] = [call('c1', 'Read', { file_path: 'a.ts' }, 'x'), result('c1', 'version one')];
    const b: Message[] = [call('c1', 'Read', { file_path: 'a.ts' }, 'x'), result('c1', 'version two')];
    expect(transcriptHash(a)).not.toBe(transcriptHash(b));
  });
});
