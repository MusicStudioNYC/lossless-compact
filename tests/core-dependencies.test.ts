import { describe, expect, it } from 'vitest';
import { anchorsOf, buildDependencyGraph } from '../src/core/dependencies.js';
import { buildLedger } from '../src/core/events.js';
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

describe('anchorsOf', () => {
  it('extracts paths, code-shaped symbols, error signatures and long distinctive lines', () => {
    const text = [
      'See src/example.ts for details.',
      'The parseUserInput function handles this.',
      "TypeError: Cannot read properties of undefined (reading 'x')",
      'This is a distinctive sentence that is definitely long enough to count as a quote.',
      'ok',
    ].join('\n');
    const anchors = anchorsOf(text);
    expect(anchors.paths.has('src/example.ts')).toBe(true);
    expect(anchors.symbols.has('parseUserInput')).toBe(true);
    expect([...anchors.errors].some((e) => e.includes('TypeError'))).toBe(true);
    expect([...anchors.errors]).toContain('TypeError');
    expect([...anchors.quotes].some((q) => q.startsWith('This is a distinctive sentence'))).toBe(true);
    expect(anchors.quotes.has('ok')).toBe(false);
  });

  it('excludes short and stoplisted identifiers from symbols', () => {
    const anchors = anchorsOf('function Default is not a symbol but myLongName123 is.', { minSymbolLength: 6 });
    expect(anchors.symbols.has('function')).toBe(false);
    expect(anchors.symbols.has('Default')).toBe(false);
    expect(anchors.symbols.has('myLongName123')).toBe(true);
  });
});

describe('buildDependencyGraph: path references', () => {
  it('creates an edge when a later Edit or Bash command mentions a path an earlier result printed', () => {
    const messages: Message[] = [
      message('user', 'List the src files'),
      call('c1', 'Bash', { command: 'ls src' }, ''),
      result('c1', 'src/utils.ts\nsrc/index.ts\n'),
      message('assistant', 'Found the files.'),
      message('assistant', 'Now let me look closer.'),
      message('assistant', 'One more filler message.'),
      call('c2', 'Edit', { file_path: 'src/utils.ts', old_string: 'a', new_string: 'b' }, ''),
      result('c2', 'ok'),
      message('assistant', 'Also checking via bash.'),
      message('assistant', 'filler'),
      message('assistant', 'filler'),
      call('c3', 'Bash', { command: 'cat src/utils.ts' }, ''),
      result('c3', 'file contents'),
    ];
    const ledger = buildLedger(messages);
    const graph = buildDependencyGraph(ledger);

    const lsResult = ledger.interactions.get('c1')!.result!;
    const editUse = ledger.interactions.get('c2')!.use;
    const bashUse = ledger.interactions.get('c3')!.use;

    const toLs = graph.edges.filter((e) => e.to === lsResult.id);
    expect(toLs.some((e) => e.from === editUse.id && e.via === 'path' && e.fragment === 'src/utils.ts')).toBe(true);
    expect(toLs.some((e) => e.from === bashUse.id && e.via === 'path')).toBe(true);
    expect(graph.referencedBy.get(lsResult.id)).toEqual(expect.arrayContaining([editUse.id, bashUse.id]));
  });
});

describe('buildDependencyGraph: symbol references', () => {
  it('creates an edge when a rare symbol is mentioned later', () => {
    const messages: Message[] = [
      message('user', 'start'),
      call('c1', 'Read', { file_path: 'a.ts' }, ''),
      result('c1', 'export function rareHelperFn() { return 1 }'),
      message('assistant', 'filler'),
      message('assistant', 'filler'),
      message('assistant', 'filler'),
      message('assistant', 'Calling rareHelperFn should fix it.'),
    ];
    const ledger = buildLedger(messages);
    const graph = buildDependencyGraph(ledger);
    const readResult = ledger.interactions.get('c1')!.result!;
    const mention = ledger.events.find(
      (e) => e.kind === 'assistant_text' && e.content.includes('rareHelperFn should'),
    )!;
    expect(
      graph.edges.some((e) => e.from === mention.id && e.to === readResult.id && e.via === 'symbol'),
    ).toBe(true);
  });

  it('does not create a symbol edge when the symbol occurs in more than three results', () => {
    const messages: Message[] = [message('user', 'start')];
    for (let i = 0; i < 4; i++) {
      messages.push(call(`c${i}`, 'Read', { file_path: `f${i}.ts` }, ''));
      messages.push(result(`c${i}`, 'export function commonHelperFn() { return 1 }'));
    }
    messages.push(message('assistant', 'filler'));
    messages.push(message('assistant', 'filler'));
    messages.push(message('assistant', 'filler'));
    messages.push(message('assistant', 'Calling commonHelperFn again.'));
    const ledger = buildLedger(messages);
    const graph = buildDependencyGraph(ledger);
    const mention = ledger.events.find(
      (e) => e.kind === 'assistant_text' && e.content.includes('commonHelperFn again'),
    )!;
    expect(graph.edges.some((e) => e.from === mention.id && e.via === 'symbol')).toBe(false);
  });
});

describe('buildDependencyGraph: error references', () => {
  it('creates an edge when a later message repeats an error line verbatim', () => {
    const messages: Message[] = [
      message('user', 'run the tests'),
      call('c1', 'Bash', { command: 'npm test' }, ''),
      result('c1', "Running suite...\nTypeError: Cannot read properties of undefined (reading 'foo')\n", true),
      message('assistant', 'filler'),
      message('assistant', 'filler'),
      message(
        'assistant',
        "Let me look at this again.\nTypeError: Cannot read properties of undefined (reading 'foo')\nI'll fix it now.",
      ),
    ];
    const ledger = buildLedger(messages);
    const graph = buildDependencyGraph(ledger);
    const testResult = ledger.interactions.get('c1')!.result!;
    const mention = ledger.events.find((e) => e.kind === 'assistant_text' && e.content.includes('Let me look'))!;
    const edge = graph.edges.find((e) => e.from === mention.id && e.to === testResult.id);
    expect(edge?.via).toBe('error');
    expect(edge?.fragment).toContain('TypeError');
  });
});

describe('buildDependencyGraph: quote references', () => {
  it('creates an edge when a later message repeats a long distinctive line', () => {
    const quote = 'This particular sentence appears exactly once in this whole transcript.';
    const messages: Message[] = [
      message('user', 'start'),
      call('c1', 'WebFetch', { url: 'https://example.com' }, ''),
      result('c1', `Intro line.\n${quote}\nMore text.`),
      message('assistant', 'filler'),
      message('assistant', 'filler'),
      message('assistant', 'filler'),
      message('assistant', `Let's revisit this.\n${quote}\nI will act on it.`),
    ];
    const ledger = buildLedger(messages);
    const graph = buildDependencyGraph(ledger);
    const fetchResult = ledger.interactions.get('c1')!.result!;
    const mention = ledger.events.find((e) => e.kind === 'assistant_text' && e.content.includes("Let's revisit"))!;
    // the quote must appear on its own line for the exact-line anchor to match
    expect(mention.content.split('\n')).toContain(quote);
    const edge = graph.edges.find((e) => e.from === mention.id && e.to === fetchResult.id);
    expect(edge?.via).toBe('quote');
  });
});

describe('buildDependencyGraph: message gap', () => {
  it('ignores references within minMessageGap messages and honours a custom gap', () => {
    const messages: Message[] = [
      message('user', 'start'),
      call('c1', 'Bash', { command: 'ls' }, ''),
      result('c1', 'src/gap-target.ts\n'),
      message('assistant', 'Found src/gap-target.ts already.'),
      message('assistant', 'filler'),
      message('assistant', 'filler'),
      message('assistant', 'Editing src/gap-target.ts now.'),
    ];
    const ledger = buildLedger(messages);
    const graph = buildDependencyGraph(ledger);
    const lsResult = ledger.interactions.get('c1')!.result!;
    const near = ledger.events.find((e) => e.content.includes('Found src/gap-target.ts'))!;
    const far = ledger.events.find((e) => e.content.includes('Editing src/gap-target.ts'))!;

    expect(graph.edges.some((e) => e.from === near.id && e.to === lsResult.id)).toBe(false);
    expect(graph.edges.some((e) => e.from === far.id && e.to === lsResult.id)).toBe(true);

    const zeroGap = buildDependencyGraph(ledger, { minMessageGap: 0 });
    expect(zeroGap.edges.some((e) => e.from === near.id && e.to === lsResult.id)).toBe(true);
  });
});

describe('buildDependencyGraph: dedupe', () => {
  it('keeps only one edge per (from, to) pair, preferring the more specific via', () => {
    const messages: Message[] = [
      message('user', 'start'),
      call('c1', 'Bash', { command: 'ls' }, ''),
      result('c1', 'src/dedupe-target.ts exports rareDedupeSymbol.'),
      message('assistant', 'filler'),
      message('assistant', 'filler'),
      message('assistant', 'filler'),
      message('assistant', 'Check src/dedupe-target.ts and rareDedupeSymbol together.'),
    ];
    const ledger = buildLedger(messages);
    const graph = buildDependencyGraph(ledger);
    const lsResult = ledger.interactions.get('c1')!.result!;
    const mention = ledger.events.find((e) => e.content.includes('Check src/dedupe-target.ts'))!;

    const edgesForPair = graph.edges.filter((e) => e.from === mention.id && e.to === lsResult.id);
    expect(edgesForPair).toHaveLength(1);
    expect(edgesForPair[0]?.via).toBe('path');
    expect(graph.referencedBy.get(lsResult.id)).toEqual([mention.id]);
  });
});
