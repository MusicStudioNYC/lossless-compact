import { describe, expect, it } from 'vitest';
import { buildLedger } from '../src/core/events.js';
import {
  errorResolvedLater,
  fileReads,
  laterSuccesses,
  protectionsFor,
  resolveRuleOptions,
  shellReads,
} from '../src/core/rules.js';
import { collectToolCalls } from '../src/state.js';
import type { Message, ToolCall } from '../src/types.js';

type Step = { tool: string; input: Record<string, unknown>; text: string; isError?: boolean };

/** One user prompt, then each step as a call message and a result message. */
function session(steps: readonly Step[]): { messages: Message[]; calls: ToolCall[] } {
  const messages: Message[] = [{ role: 'user', text: 'Set up the test database.', toolUses: [] }];
  steps.forEach((step, index) => {
    const id = `u${index + 1}`;
    messages.push({
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: id, tool: step.tool, input: step.input, text: step.text, ...(step.isError ? { isError: true } : {}) }],
    });
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: step.text, isError: step.isError ?? false }] });
  });
  return { messages, calls: collectToolCalls(messages, 0) };
}

const refused = 'Quoted text in this command can\'t be checked before it runs';
const missing = 'File does not exist. Note: your current working directory is /home/u/proj.';
const compose = 'services:\n  db:\n    image: postgres:16\n    ports: ["55432:5432"]\n    environment:\n      POSTGRES_DB: billing_test\n';

describe('shellReads', () => {
  it('names the files a command only prints', () => {
    expect(shellReads('for f in docker-compose.yml .env.example; do echo "== $f"; cat "$f"; done')).toEqual(
      new Set(['docker-compose.yml', '.env.example']),
    );
    expect(shellReads('cd /home/u/proj && head -n 40 config/App.Settings.json 2>/dev/null')).toEqual(new Set(['app.settings.json']));
    expect(shellReads("sed -n '1,80p' src/server.ts | nl")).toEqual(new Set(['server.ts']));
    expect(shellReads('cat docker-compose.yml 2>&1 || echo missing')).toEqual(new Set(['docker-compose.yml']));
  });

  it('is not a read when the command does anything but print files', () => {
    expect(shellReads('npx vitest run src/services/auth.test.ts')).toBeUndefined();
    expect(shellReads('cat a.yml > b.yml')).toBeUndefined();
    expect(shellReads('cat a.yml | tee b.yml')).toBeUndefined();
    expect(shellReads("sed -i 's/a/b/' src/a.ts")).toBeUndefined();
    expect(shellReads('cat $(find . -name "*.yml")')).toBeUndefined();
    expect(shellReads('ls -la && echo done')).toBeUndefined();
  });
});

describe('fileReads', () => {
  it('counts a Read and a printing Bash, not a Grep or a Glob', () => {
    expect(fileReads({ tool: 'Read', input: { file_path: '/home/u/proj/Docker-Compose.yml' } })).toEqual(new Set(['docker-compose.yml']));
    expect(fileReads({ tool: 'Bash', input: { command: 'cat docker-compose.yml' } })).toEqual(new Set(['docker-compose.yml']));
    expect(fileReads({ tool: 'Grep', input: { pattern: 'POSTGRES', path: 'docker-compose.yml' } })).toEqual(new Set());
    expect(fileReads({ tool: 'Glob', input: { pattern: '**/docker-compose.yml' } })).toEqual(new Set());
  });
});

describe('errorResolvedLater / unresolved_error', () => {
  const protectedAs = (messages: Message[], calls: ToolCall[], index: number): string[] =>
    protectionsFor(calls[index]!, { messages, ledger: buildLedger(messages), calls, options: resolveRuleOptions() }).map((p) => p.rule);

  it('a Read at a wrong path is fixed by a later Read of the same file name at the right path', () => {
    const { messages, calls } = session([
      { tool: 'Read', input: { file_path: '/home/u/wrong/docker-compose.yml' }, text: missing, isError: true },
      { tool: 'Read', input: { file_path: '/home/u/proj/docker-compose.yml' }, text: compose },
    ]);
    expect(errorResolvedLater(calls[0]!, calls)).toBe(true);
    expect(protectedAs(messages, calls, 0)).not.toContain('unresolved_error');
    expect(laterSuccesses(calls[0]!, calls).map((c) => c.tool_use_id)).toEqual(['u2']);
  });

  it('a refused Bash cat is fixed by a later Read of the file, and the other way round', () => {
    const { messages, calls } = session([
      { tool: 'Bash', input: { command: 'for f in docker-compose.yml; do cat "$f"; done' }, text: refused, isError: true },
      { tool: 'Read', input: { file_path: '/home/u/wrong/docker-compose.yml' }, text: missing, isError: true },
      { tool: 'Bash', input: { command: 'cat /home/u/proj/docker-compose.yml' }, text: compose },
    ]);
    expect(errorResolvedLater(calls[0]!, calls)).toBe(true);
    expect(errorResolvedLater(calls[1]!, calls)).toBe(true);
    expect(protectedAs(messages, calls, 0)).not.toContain('unresolved_error');
    expect(protectedAs(messages, calls, 1)).not.toContain('unresolved_error');
  });

  it('a failed Bash read of several files stays unresolved until every one of them was read', () => {
    const steps: Step[] = [
      { tool: 'Bash', input: { command: 'for f in docker-compose.yml .env.example; do cat "$f"; done' }, text: refused, isError: true },
      { tool: 'Read', input: { file_path: '/home/u/proj/docker-compose.yml' }, text: compose },
    ];
    const partly = session(steps);
    expect(errorResolvedLater(partly.calls[0]!, partly.calls)).toBe(false);
    expect(protectedAs(partly.messages, partly.calls, 0)).toContain('unresolved_error');
    // ...but the read that did happen is a later success for it
    expect(laterSuccesses(partly.calls[0]!, partly.calls).map((c) => c.tool_use_id)).toEqual(['u2']);
    const fully = session([...steps, { tool: 'Read', input: { file_path: '/home/u/proj/.env.example' }, text: 'DB=1' }]);
    expect(errorResolvedLater(fully.calls[0]!, fully.calls)).toBe(true);
  });

  it('an error never fixed stays protected', () => {
    const { messages, calls } = session([
      { tool: 'Read', input: { file_path: '/home/u/wrong/docker-compose.yml' }, text: missing, isError: true },
      { tool: 'Read', input: { file_path: '/home/u/proj/README.md' }, text: '# proj' },
      { tool: 'Glob', input: { pattern: '**/docker-compose.yml' }, text: '/home/u/proj/docker-compose.yml' },
      { tool: 'Grep', input: { pattern: 'POSTGRES_DB', path: '/home/u/proj/docker-compose.yml' }, text: '/home/u/proj/docker-compose.yml' },
    ]);
    expect(errorResolvedLater(calls[0]!, calls)).toBe(false);
    expect(protectedAs(messages, calls, 0)).toContain('unresolved_error');
    expect(laterSuccesses(calls[0]!, calls)).toEqual([]);
  });

  it('a read that came before the failure fixes nothing', () => {
    const { calls } = session([
      { tool: 'Read', input: { file_path: '/home/u/proj/docker-compose.yml' }, text: compose },
      { tool: 'Read', input: { file_path: '/home/u/wrong/docker-compose.yml' }, text: missing, isError: true },
    ]);
    expect(errorResolvedLater(calls[1]!, calls)).toBe(false);
  });

  it('a failed command that does more than print a file is not fixed by reading the file', () => {
    const { calls } = session([
      { tool: 'Bash', input: { command: 'npx vitest run src/auth.test.ts' }, text: 'FAIL src/auth.test.ts', isError: true },
      { tool: 'Read', input: { file_path: 'src/auth.test.ts' }, text: 'it("logs in", () => {});' },
    ]);
    expect(errorResolvedLater(calls[0]!, calls)).toBe(false);
    expect(laterSuccesses(calls[0]!, calls)).toEqual([]);
  });

  it('a failed Edit is not fixed by a later read of the file, only by a later Edit of it', () => {
    const edit = { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' };
    const read = session([
      { tool: 'Edit', input: edit, text: 'String to replace not found in file.', isError: true },
      { tool: 'Read', input: { file_path: 'src/a.ts' }, text: 'const z = 1;' },
    ]);
    expect(errorResolvedLater(read.calls[0]!, read.calls)).toBe(false);
    const edited = session([
      { tool: 'Edit', input: edit, text: 'String to replace not found in file.', isError: true },
      { tool: 'Edit', input: { ...edit, old_string: 'z' }, text: 'ok' },
    ]);
    expect(errorResolvedLater(edited.calls[0]!, edited.calls)).toBe(true);
  });

  it('keeps the original rule: the same command, or the same tool on the same path, succeeding later', () => {
    const { calls } = session([
      { tool: 'Bash', input: { command: 'npm test' }, text: 'FAIL', isError: true },
      { tool: 'Bash', input: { command: 'npm test' }, text: 'PASS' },
    ]);
    expect(errorResolvedLater(calls[0]!, calls)).toBe(true);
    const grep = session([
      { tool: 'Grep', input: { pattern: 'x(', path: 'src' }, text: 'regex parse error', isError: true },
      { tool: 'Grep', input: { pattern: 'x\\(', path: 'src' }, text: 'src/a.ts' },
    ]);
    expect(errorResolvedLater(grep.calls[0]!, grep.calls)).toBe(true);
  });
});
