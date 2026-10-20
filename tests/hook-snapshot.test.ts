import { describe, expect, it } from 'vitest';
import type { SessionMessage } from 'claude-code';
import type { TextFs } from '../src/archive/file-store.js';
import type { OptimizeReport } from '../src/engine/optimize.js';
import {
  archiveRoot,
  compactionNote,
  outsideWebRoot,
  projectRoot,
  rawSessionLogPath,
  rechain,
  suspectCalibration,
  withCompactionNote,
  withCompactionNoteSession,
  writeSnapshot,
} from '../hooks/lossless-compact.js';

function fakeFs(): TextFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path) {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
      return text;
    },
    async write(path, text) {
      files.set(path, text);
    },
    async exists(path) {
      return files.has(path);
    },
    // A directory's own entries, as the host lists them: files and subfolders by name.
    async list(dir) {
      const names = [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]!);
      return [...new Set(names)];
    },
  };
}

/** The slice of `$` the archive root reads: a working directory that can move, a git root, a log. */
function fakeHost(cwd: string, repo: string | null) {
  const host = {
    cwd,
    repoCalls: 0,
    logs: [] as string[],
    session: {
      cwd: async () => host.cwd,
      repo: async () => {
        host.repoCalls += 1;
        return repo === null ? null : { root: repo };
      },
    },
    ui: { log: (text: string) => void host.logs.push(text) },
  };
  return host;
}

const session: SessionMessage[] = [
  { role: 'user', text: 'Fix the test. Never edit src/generated.', toolUses: [], handle: 'h1' },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'src/a.ts' }, text: 'const a = 1;' }],
    handle: 'h2',
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'const a = 1;', isError: false }], handle: 'h3' },
];

const report: OptimizeReport = {
  sessionId: 's1',
  compactionId: 'c_1',
  classifier: 'ruleset',
  messages: { before: 3, after: 2 },
  tokens: { before: 100, after: 40, archived: 60 },
  chars: { before: 400, after: 160 },
  actions: {
    PIN_VERBATIM: 1,
    KEEP_VERBATIM: 0,
    KEEP_HEAD_TAIL: 1,
    EXTRACT_MEMORY_AND_ARCHIVE: 0,
    ARCHIVE_ONLY: 2,
    REPLACE_WITH_REFERENCE: 0,
    RERUN_ON_DEMAND: 0,
    DROP_REDUNDANT: 1,
  },
  protections: {},
  constraints: 1,
  duplicates: 1,
  candidates: 4,
  classified: 3,
  unscored: 0,
  redactedSecrets: 0,
  classifierStats: { requests: 0, stateTokens: 0, stateStage: 'ruleset', ms: 1, unscored: [] },
  ms: 2,
};

describe('writeSnapshot', () => {
  it('writes the exact transcript without engine handles as one JSON file', async () => {
    const fs = fakeFs();
    const paths = await writeSnapshot(fs, '.lossless-compact', 's1', 'c_1', session, '2026-09-20T00:00:00.000Z');
    expect(paths).toEqual(['.lossless-compact/snapshots/s1/c_1.json']);
    const parsed = JSON.parse(fs.files.get(paths[0]!)!);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0]).toEqual({ role: 'user', text: 'Fix the test. Never edit src/generated.', toolUses: [] });
    expect(JSON.stringify(parsed)).not.toContain('handle');
    expect(parsed.messages[2].toolResults[0].text).toBe('const a = 1;');
  });

  it('splits a transcript larger than the write cap into parts with a manifest', async () => {
    const fs = fakeFs();
    const big: SessionMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: 'assistant',
      text: 'x'.repeat(1.2 * 1024 * 1024),
      toolUses: [],
      handle: `h${i}`,
    }));
    const paths = await writeSnapshot(fs, '.lossless-compact', 's1', 'c_2', big, '2026-09-20T00:00:00.000Z');
    expect(paths[0]).toBe('.lossless-compact/snapshots/s1/c_2.json');
    expect(paths.length).toBeGreaterThan(2);
    for (const path of paths) expect(fs.files.get(path)!.length).toBeLessThanOrEqual(3.6 * 1024 * 1024);
    const manifest = JSON.parse(fs.files.get(paths[0]!)!);
    expect(manifest.messages).toBe(6);
    expect(manifest.parts).toEqual(paths.slice(1).map((p) => p.split('/').pop()));
    const total = paths.slice(1).reduce((n, p) => n + JSON.parse(fs.files.get(p)!).messages.length, 0);
    expect(total).toBe(6);
  });
});

describe('rawSessionLogPath', () => {
  it('finds the session log under ~/.claude/projects by the encoded cwd, trying drive-letter cases', async () => {
    const fs = fakeFs();
    const path = 'C:/Users/me/.claude/projects/c--Users-me-proj/abc.jsonl';
    fs.files.set(path, '');
    expect(await rawSessionLogPath(fs, 'C:/Users/me', ['C:\\Users\\me\\proj'], 'abc')).toBe(path);
    expect(await rawSessionLogPath(fs, 'C:/Users/me', ['C:\\Users\\me\\other'], 'nope')).toBeUndefined();
    expect(await rawSessionLogPath(fs, undefined, ['C:\\Users\\me\\proj'], 'abc')).toBeUndefined();
  });

  it('still finds it after a cd or a folder switch, by the session id alone', async () => {
    const fs = fakeFs();
    const path = 'C:/Users/me/.claude/projects/C--scratch-ws/abc.jsonl';
    fs.files.set(path, '');
    fs.files.set('C:/Users/me/.claude/projects/c--Users-me-proj/zzz.jsonl', '');
    expect(await rawSessionLogPath(fs, 'C:/Users/me', ['C:\\Users\\me\\proj\\public_html\\themes', 'C:/Users/me/proj'], 'abc')).toBe(path);
  });
});

describe('outsideWebRoot', () => {
  it('climbs above the first served folder, any case, either separator', () => {
    expect(outsideWebRoot('D:\\Websites\\aigalaxy.app\\public_html\\themes')).toBe('D:/Websites/aigalaxy.app');
    expect(outsideWebRoot('C:/xampp/HTDOCS/shop')).toBe('C:/xampp');
    expect(outsideWebRoot('/inetpub/wwwroot')).toBe('/inetpub');
    expect(outsideWebRoot('/public_html')).toBe('/');
  });

  it('leaves everything else alone, www and public included', () => {
    expect(outsideWebRoot('D:\\Websites\\aigalaxy.app')).toBe('D:\\Websites\\aigalaxy.app');
    expect(outsideWebRoot('/var/www/site')).toBe('/var/www/site');
    expect(outsideWebRoot('/home/me/app/public')).toBe('/home/me/app/public');
    expect(outsideWebRoot('/home/me/public_html_backup')).toBe('/home/me/public_html_backup');
  });
});

describe('archiveRoot', () => {
  it('stays at the git root while the session cds around inside the project (2026-09-23)', async () => {
    const host = fakeHost('D:\\Websites\\aigalaxy.app', 'D:\\Websites\\aigalaxy.app');
    const roots = new Map<string, string>();
    const fs = fakeFs();
    expect(await archiveRoot(host, '.lossless-compact', roots)).toBe('D:\\Websites\\aigalaxy.app/.lossless-compact');
    host.cwd = 'D:\\Websites\\aigalaxy.app\\public_html\\themes';
    const root = await archiveRoot(host, '.lossless-compact/', roots);
    expect(root).toBe('D:\\Websites\\aigalaxy.app/.lossless-compact');
    const [manifest] = await writeSnapshot(fs, root, 's1', 'c_1', session, '2026-09-23T18:13:10.000Z');
    expect(manifest).toBe('D:\\Websites\\aigalaxy.app/.lossless-compact/snapshots/s1/c_1.json');
    expect([...fs.files.keys()].some((p) => /public_html/i.test(p))).toBe(false);
    expect(host.logs).toEqual([]);
  });

  it('asks git once per working directory', async () => {
    const host = fakeHost('/repo/src', '/repo');
    const roots = new Map<string, string>();
    await archiveRoot(host, '.lossless-compact', roots);
    await archiveRoot(host, '.lossless-compact', roots);
    expect(host.repoCalls).toBe(1);
    host.cwd = '/repo/docs';
    await archiveRoot(host, '.lossless-compact', roots);
    expect(host.repoCalls).toBe(2);
  });

  it('uses the working directory outside a repo, but never a served folder', async () => {
    const roots = new Map<string, string>();
    expect(await archiveRoot(fakeHost('/home/me/notes', null), '.lossless-compact', roots)).toBe('/home/me/notes/.lossless-compact');
    const served = fakeHost('/home/me/site/public_html/blog', null);
    expect(await archiveRoot(served, '.lossless-compact', roots)).toBe('/home/me/site/.lossless-compact');
    expect(served.logs.join('\n')).toContain('inside a web root');
  });

  it('falls back to the working directory when git cannot be asked, and says so', async () => {
    const host = fakeHost('/repo', '/repo');
    host.session.repo = async () => {
      throw new Error('git missing');
    };
    expect(await archiveRoot(host, '.lossless-compact', new Map())).toBe('/repo/.lossless-compact');
    expect(host.logs.join('\n')).toContain('git missing');
  });

  it('takes an absolute archiveDir as given, without asking git', async () => {
    const host = fakeHost('/repo/public_html', '/repo');
    expect(await archiveRoot(host, 'D:\\archives\\', new Map())).toBe('D:\\archives');
    expect(await archiveRoot(host, '/srv/archives', new Map())).toBe('/srv/archives');
    expect(host.repoCalls).toBe(0);
  });

  it('projectRoot is the same anchor, for finding the raw log', async () => {
    expect(await projectRoot(fakeHost('/repo/a/b', '/repo'), new Map())).toBe('/repo');
  });
});

describe('compactionNote / withCompactionNote', () => {
  it('names what was removed and where every copy of the history is', () => {
    const note = compactionNote({
      at: '2026-09-20T00:00:00.000Z',
      compactionId: 'c_1',
      report,
      snapshotPath: 'C:/proj/.lossless-compact/snapshots/s1/c_1.json',
      archiveDir: 'C:/proj/.lossless-compact',
      rawLogPath: 'C:/Users/me/.claude/projects/c--proj/s1.jsonl',
    });
    expect(note).toContain('4 tool interactions (~60 tokens) were removed');
    expect(note).toContain('Classifier: ruleset · ~100→40 tokens (60% fewer) · 3→2 messages · 2 ms.');
    expect(note).toContain('C:/proj/.lossless-compact/snapshots/s1/c_1.json');
    expect(note).toContain('C:/proj/.lossless-compact/archive/');
    expect(note).toContain('C:/Users/me/.claude/projects/c--proj/s1.jsonl');
    expect(note).toContain('/lossless restore <id>');
    expect(note).not.toMatch(/summar(y|ized) of/);
  });

  it('carries the no-key line right after the outcome, and only when given', () => {
    const base = {
      at: '2026-09-20T00:00:00.000Z',
      compactionId: 'c_1',
      report,
      archiveDir: 'C:/proj/.lossless-compact',
    };
    expect(compactionNote(base)).not.toContain('No TypeSafe key');
    const lines = compactionNote({ ...base, classifierNote: 'No TypeSafe key found: ruleset.' }).split('\n');
    const outcome = lines.findIndex((line) => line.startsWith('Classifier: ruleset'));
    expect(lines[outcome + 1]).toBe('No TypeSafe key found: ruleset.');
  });

  it('inserts the note after the pinned first message as a user message', () => {
    const messages = withCompactionNote(
      [
        { role: 'user', text: 'first', toolUses: [] },
        { role: 'assistant', text: 'second', toolUses: [] },
      ],
      'NOTE',
    );
    expect(messages.map((m) => m.text)).toEqual(['first', 'NOTE', 'second']);
    expect(messages[1]!.role).toBe('user');
  });

  it('the summarized variant says the summary is a paraphrase and still points at every copy', () => {
    const note = compactionNote({
      at: '2026-09-20T00:00:00.000Z',
      compactionId: 'c_1',
      report,
      snapshotPath: 'C:/proj/.lossless-compact/snapshots/s1/c_1.json',
      archiveDir: 'C:/proj/.lossless-compact',
      summarized: true,
    });
    expect(note).toMatch(/built-in summary; the message above is a paraphrase/);
    expect(note).toContain('archived 4 tool interactions (~60 tokens) verbatim and saved the exact pre-compaction transcript');
    expect(note).toContain('Classifier: ruleset · 2 ms (its ~100→40 token result was replaced by the summary).');
    expect(note).not.toContain('% fewer');
    expect(note).toContain('C:/proj/.lossless-compact/snapshots/s1/c_1.json');
    expect(note).toContain('C:/proj/.lossless-compact/archive/');
    expect(note).not.toContain('Nothing was summarized');
    // No stubs survive a summary, so it must not tell the model to look for one.
    expect(note).not.toContain('a stub in this transcript');
  });

  it('rechain strips every engine handle and drops messages that are nothing without one', () => {
    const messages = rechain([
      { role: 'user', text: 'first', toolUses: [], handle: 'h1' },
      { role: 'assistant', text: '', toolUses: [], handle: 'h2' }, // thinking only
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: {}, text: 'x' }], handle: 'h3' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'x', isError: false }], handle: 'h4' },
      { role: 'user', text: 'NOTE', toolUses: [] },
    ]);
    expect(messages.map((m) => m.text)).toEqual(['first', '', '', 'NOTE']);
    expect(messages.every((m) => !('handle' in m))).toBe(true);
    expect(messages[1]!.toolUses[0]!.tool_use_id).toBe('t1');
    expect(messages[2]!.toolResults![0]!.tool_use_id).toBe('t1');
  });

  it('withCompactionNoteSession inserts after the host summary, keeping the host messages as given', () => {
    const summary = { role: 'assistant' as const, text: 'summary', toolUses: [], handle: 'h1' };
    const recent = { role: 'user' as const, text: 'recent', toolUses: [], handle: 'h2' };
    const messages = withCompactionNoteSession([summary, recent], 'NOTE');
    expect(messages.map((m) => m.text)).toEqual(['summary', 'NOTE', 'recent']);
    expect(messages[0]).toBe(summary);
    expect(messages[2]).toBe(recent);
    expect(withCompactionNoteSession([], 'NOTE').map((m) => m.text)).toEqual(['NOTE']);
  });
});

describe('suspectCalibration (upstream #53)', () => {
  const decision = (action: 'KEEP_VERBATIM' | 'ARCHIVE_ONLY', keepResult: number, scored = true) =>
    ({ id: 'x', action, reasons: [], ...(scored ? { scores: { keepCall: keepResult, keepResult } } : {}) }) as never;

  it('distrusts a classifier that kept none of five or more scored results, reporting its best score', () => {
    const marginal = [0.34, 0.31, 0.3, 0.28, 0.33].map((s) => decision('ARCHIVE_ONLY', s));
    expect(suspectCalibration(marginal, 5)).toEqual({ suspect: true, best: 0.34 });
    // The live smoke test: eleven file reads nothing referred to again, all far below 0.35.
    const low = [0.14, 0.1, 0.09, 0.08, 0.08, 0.08].map((s) => decision('ARCHIVE_ONLY', s));
    expect(suspectCalibration(low, 6)).toEqual({ suspect: true, best: 0.14 });
  });

  it('never fires below five scored results, or when anything scored was kept', () => {
    const low = [0.3, 0.3, 0.3, 0.3].map((s) => decision('ARCHIVE_ONLY', s));
    expect(suspectCalibration(low, 4).suspect).toBe(false);
    const oneKept = [...low, decision('KEEP_VERBATIM', 0.6), decision('ARCHIVE_ONLY', 0.3)];
    expect(suspectCalibration(oneKept, 6).suspect).toBe(false);
    // Unscored keeps (pins, protections) do not count as the classifier keeping something.
    const pinnedOnly = [...low, decision('ARCHIVE_ONLY', 0.3), decision('KEEP_VERBATIM', 1, false)];
    expect(suspectCalibration(pinnedOnly, 5).suspect).toBe(true);
  });
});

describe('shouldCompact', () => {
  it('triggers on an absolute token count, deriving it from percent and window when needed', async () => {
    const { shouldCompact } = await import('../hooks/lossless-compact.js');
    const config = { compactAtTokens: 120_000, compactAtPercent: 0 };
    expect(shouldCompact({ tokens: 119_999, percent: 60 }, config)).toBe(false);
    expect(shouldCompact({ tokens: 120_000, percent: 10 }, config)).toBe(true);
    expect(shouldCompact({ percent: 70, window: 200_000 }, config)).toBe(true);
    expect(shouldCompact({ percent: 50, window: 200_000 }, config)).toBe(false);
    expect(shouldCompact({ percent: 95 }, config)).toBe(false);
    expect(shouldCompact({ percent: 61, tokens: 10 }, { compactAtTokens: 0, compactAtPercent: 60 })).toBe(true);
    expect(shouldCompact({ percent: 99, tokens: 999_999 }, { compactAtTokens: 0, compactAtPercent: 0 })).toBe(false);
  });
});

describe('AutoCompactTrigger', () => {
  it('fires once per crossing, and again only after the context shrank or grew by a quarter', async () => {
    const { AutoCompactTrigger } = await import('../hooks/lossless-compact.js');
    const trigger = new AutoCompactTrigger({ compactAtTokens: 120_000, compactAtPercent: 0 });
    expect(trigger.due({ tokens: 100_000 })).toBe(false);
    expect(trigger.due({ tokens: 121_000 })).toBe(true);
    // The compaction was skipped or fell back: the context is still there. No loop.
    expect(trigger.due({ tokens: 121_500 })).toBe(false);
    expect(trigger.due({ tokens: 140_000 })).toBe(false);
    // A quarter more since the attempt: new material, try again.
    expect(trigger.due({ tokens: 151_250 })).toBe(true);
    expect(trigger.due({ tokens: 152_000 })).toBe(false);
    // It worked: below the threshold re-arms, the next crossing fires.
    expect(trigger.due({ tokens: 50_000 })).toBe(false);
    expect(trigger.due({ tokens: 120_000 })).toBe(true);
  });
});
