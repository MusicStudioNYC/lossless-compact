import { describe, expect, it } from 'vitest';
import { sketchResult } from '../src/core/sketch.js';

describe('sketchResult: Read / NotebookRead', () => {
  it('strips cat -n prefixes, extracts symbols, counts lines and imports', () => {
    const text = [
      '     1\texport function fooBar() {',
      '     2\t  return 1;',
      '     3\t}',
      "     4\timport { baz } from './baz.js';",
    ].join('\n');
    const sketch = sketchResult('Read', { file_path: 'src/foo.ts' }, text, false);
    expect(sketch).toBe(
      'path=src/foo.ts; lines=4; symbols=fooBar; imports=1; head=export function fooBar() {',
    );
  });

  it('strips arrow-style line-number prefixes too', () => {
    const text = ['   1→export class Widget {}', '   2→}'].join('\n');
    const sketch = sketchResult('NotebookRead', { notebook_path: 'w.ipynb' }, text, false);
    expect(sketch).toContain('path=w.ipynb');
    expect(sketch).toContain('symbols=Widget');
    expect(sketch).toContain('head=export class Widget {}');
  });

  it('caps symbols at 8 and never includes newlines', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `export const symbolNumber${i} = ${i};`);
    const sketch = sketchResult('Read', { file_path: 'many.ts' }, lines.join('\n'), false);
    const symbolsField = sketch.split('; ').find((part) => part.startsWith('symbols='));
    expect(symbolsField?.split(',')).toHaveLength(8);
    expect(sketch).not.toMatch(/\n/);
  });
});

describe('sketchResult: Grep / Glob / LS', () => {
  it('reports match count, distinct files and the pattern', () => {
    const result = ['src/a.ts:3:// TODO fix this', 'src/b.ts:10:// TODO another'].join('\n');
    const sketch = sketchResult('Grep', { pattern: 'TODO' }, result, false);
    expect(sketch).toBe('matches=2; files=src/a.ts,src/b.ts; pattern=TODO');
  });

  it('matches the tool name case-insensitively', () => {
    const sketch = sketchResult('gLoB', { pattern: '*.ts' }, 'src/a.ts\nsrc/b.ts', false);
    expect(sketch).toContain('matches=2');
    expect(sketch).toContain('pattern=*.ts');
  });
});

describe('sketchResult: Bash', () => {
  it('reports the command, exit code, line count and a head/tail preview', () => {
    const result = 'Compiling...\nBuild succeeded\nexit code 0\n';
    const sketch = sketchResult('Bash', { command: 'npm run build' }, result, false);
    expect(sketch).toBe(
      'cmd=npm run build; exit=0; lines=3; head=Compiling... Build succeeded exit code 0; ' +
        'tail=Compiling... Build succeeded exit code 0',
    );
  });

  it('recognises the other exit-code phrasings', () => {
    expect(sketchResult('Bash', { command: 'x' }, 'done\nExit code: 2', false)).toContain('exit=2');
    expect(sketchResult('Bash', { command: 'x' }, 'done\nexited with code 137', false)).toContain('exit=137');
  });

  it('lists paths mentioned in the output, up to four', () => {
    const result = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'].join('\n');
    const sketch = sketchResult('Bash', { command: 'ls src' }, result, false);
    const filesField = sketch.split('; ').find((part) => part.startsWith('files='));
    expect(filesField?.split(',')).toHaveLength(4);
  });
});

describe('sketchResult: Edit / Write / MultiEdit', () => {
  it('reports the path and the first line of the result', () => {
    const sketch = sketchResult('Edit', { file_path: 'src/foo.ts' }, 'The file src/foo.ts has been updated.', false);
    expect(sketch).toBe('path=src/foo.ts; result=The file src/foo.ts has been updated.');
  });

  it('matches the tool name case-insensitively', () => {
    const sketch = sketchResult('MULTIEDIT', { file_path: 'x.ts' }, 'ok', false);
    expect(sketch).toBe('path=x.ts; result=ok');
  });
});

describe('sketchResult: WebFetch / WebSearch', () => {
  it('reports the url or query and a head preview', () => {
    const sketch = sketchResult(
      'WebFetch',
      { url: 'https://example.com/docs' },
      'Example Domain. This domain is for use in illustrative examples.',
      false,
    );
    expect(sketch).toBe(
      'url=https://example.com/docs; head=Example Domain. This domain is for use in illustrative examples.',
    );
  });

  it('falls back to the query input for WebSearch', () => {
    const sketch = sketchResult('WebSearch', { query: 'fast-jev-compaction' }, 'top result snippet', false);
    expect(sketch).toBe('url=fast-jev-compaction; head=top result snippet');
  });
});

describe('sketchResult: Agent / Task', () => {
  it('reports a head and tail preview at fixed widths', () => {
    const text = `${'A'.repeat(150)} middle ${'B'.repeat(150)}`;
    const sketch = sketchResult('Agent', {}, text, false);
    expect(sketch).toBe(`head=${text.slice(0, 120)}; tail=${text.slice(-60)}`);
  });
});

describe('sketchResult: generic fallback', () => {
  it('uses the configured head/tail character budgets', () => {
    const text = `${'x'.repeat(50)} gap ${'y'.repeat(50)}`;
    const sketch = sketchResult('SomeUnknownTool', {}, text, false, { headChars: 10, tailChars: 5 });
    expect(sketch).toBe(`head=${text.slice(0, 10)}; tail=${text.slice(-5)}`);
  });

  it('defaults to 100/60 head/tail chars', () => {
    const text = 'z'.repeat(300);
    const sketch = sketchResult('SomeUnknownTool', {}, text, false);
    expect(sketch).toBe(`head=${'z'.repeat(100)}; tail=${'z'.repeat(60)}`);
  });
});

describe('sketchResult: error-first behaviour', () => {
  it('leads with ERR when isError is true, regardless of tool', () => {
    const sketch = sketchResult('Bash', { command: 'npm test' }, 'FAIL src/foo.test.ts\nExpected 1 to equal 2', true);
    expect(sketch.startsWith('ERR: FAIL src/foo.test.ts')).toBe(true);
  });

  it('leads with ERR when the first line matches the error regex even if isError is false', () => {
    const sketch = sketchResult('Read', { file_path: 'x.ts' }, 'ENOENT: no such file or directory', false);
    expect(sketch.startsWith('ERR: ENOENT: no such file or directory')).toBe(true);
  });

  it('does not use ERR for ordinary, non-error results', () => {
    const sketch = sketchResult('Read', { file_path: 'x.ts' }, 'export const x = 1;', false);
    expect(sketch.startsWith('ERR:')).toBe(false);
  });

  it('finds the error line even when it is not the very first line', () => {
    const sketch = sketchResult('Bash', { command: 'npm test' }, 'Running suite...\nTypeError: boom', true);
    expect(sketch.startsWith('ERR: TypeError: boom')).toBe(true);
  });
});

describe('sketchResult: bounds', () => {
  it('never exceeds maxChars and truncates with an ellipsis', () => {
    const sketch = sketchResult('SomeUnknownTool', {}, 'z'.repeat(1000), false, { maxChars: 50 });
    expect(sketch.length).toBeLessThanOrEqual(50);
    expect(sketch.endsWith('…')).toBe(true);
  });

  it('never includes newlines, even when the result has many', () => {
    const text = Array.from({ length: 10 }, (_, i) => `row ${i}\nwith a break`).join('\n');
    const sketch = sketchResult('SomeUnknownTool', {}, text, false);
    expect(sketch).not.toMatch(/\n/);
  });
});
