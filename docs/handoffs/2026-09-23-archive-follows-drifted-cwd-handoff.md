# Handoff: the archive lands wherever the session has `cd`'d to

**Status:** open. Written 2026-09-23 by a Claude Code chat working in yttl.org and
aigalaxy.app, at the owner's request: "write me a handoff about the event so that
the agent in that repo should look into why it did that, these dot folders are not
meant to be there". Mark done (or delete) when the fix ships.

## What happened

A lossless-compact archive (an `archive/` and a `snapshots/` entry, 3 files,
about 450 KB of verbatim chat) was written to
`aigalaxy.app\public_html\themes\.lossless-compact\`, **inside the public web
root** of a live multi-domain site, instead of `aigalaxy.app\.lossless-compact\`.

Evidence (session `ac562d96-2fa2-46f2-844e-19de021ded20`, transcript in
`~\.claude\projects\c--Users-Bunkspunkles-Dropbox-Websites-aigalaxy-app\`), from
the `cwd` field of its JSONL records:

| From (UTC) | To (UTC) | `cwd` |
|---|---|---|
| 17:06:06 | 17:43:34 | `C:\Users\Bunkspunkles\Dropbox\Websites\aigalaxy.app` |
| 17:43:34 | 18:13:10 | `C:\Users\Bunkspunkles\Dropbox\Websites\aigalaxy.app\public_html\themes` |

The chat ran a Bash `cd public_html/themes` at 17:43 that persisted as the session
directory. The compaction at 18:13:10 UTC (14:13 local, the files' mtime) wrote
its archive there.

No harm done: the folder was never uploaded (checked on the server 2026-09-23),
and it was moved to `aigalaxy.app\.lossless-compact\archive|snapshots\ac562d96-…`
(kept, not deleted), where `/lossless` can still find it from a session at the
repo root. It showed up only because aigalaxy's `.gitignore` anchors the rule
(`/.lossless-compact/`), so the stray copy appeared as untracked. Transcripts can
hold keys and customer data. Had the owner's "upload changed files" habit, or a
deploy of untracked files, reached it, a chat would have been public at
`https://<22 domains>/themes/.lossless-compact/...`.

Every other `.lossless-compact` folder under `Dropbox\Websites` is at a repo root
(aigalaxy.app, fast-jev-compaction, kosher.chat); this was the only stray one.

## Why (the code)

`hooks/lossless-compact.ts`, around line 1007:

```ts
const cwd = await $.session.cwd();
const root = configured.archiveDir.replace(/[\\/]+$/, '');   // '.lossless-compact'
const absolute = (relative: string): string => `${cwd...}/${relative}`;
... writeSnapshot(engineFs($), root, ...)                       // relative path
```

`$.session.cwd()` is "the directory the session runs in" **now**
(`types/claude-code.d.ts`), which follows a persisted `cd`. `archiveDir` is
relative, so the archive, the snapshot, and the `archiveDir` recorded in the
note all resolve against the drifted directory. `src/archive/file-store.ts:81`
defaults `root` to the same relative `.lossless-compact`.

Second symptom of the same cause: `rawSessionLogPath(engineFs($), home, cwd,
sessionId)` (around line 1021, helper near line 360) finds the raw log by
encoding `cwd` into the `~/.claude/projects/<key>` folder name. After a `cd`, the
key is `...-aigalaxy-app-public-html-themes`, which does not exist, so the
`rawLogPath` lookup quietly misses. Worth confirming in a test.

## What to do, in order

1. Anchor the archive to the **project root**, not the live cwd. Candidates, most
   robust first (measure which the host actually provides to function hooks):
   - the directory encoded in the session's `transcript_path` / project key
     (the folder `~/.claude/projects/<key>/` is named after the directory the
     session *started* in, which is what the owner calls "the project");
   - `CLAUDE_PROJECT_DIR` via `$.env.get(...)`, if function hooks receive it the
     way command hooks do;
   - the first `cwd` recorded in the session's own JSONL;
   - walk up from `cwd` to the nearest directory holding `.git` or an existing
     `.lossless-compact/`.
   Resolve once per session and reuse it for the snapshot, the archive, the
   recorded `archiveDir` and `rawSessionLogPath`.
2. `/lossless` (inspect/restore) must look in the same anchored place, and it
   would be kind to also find archives already stranded in a subfolder (like
   this one) and offer to move them.
3. A test: a session whose cwd changes mid-way archives into the start directory,
   and `rawLogPath` is still found.
4. Consider refusing to write under a folder that looks like a web root
   (`public_html`, `wwwroot`, `htdocs`, `www`) even when the anchor logic fails:
   log it and fall back to the project root. The owner's sites serve those.

## Rejected

- **Changing each repo's `.gitignore` to an unanchored `.lossless-compact/`.**
  Worth doing as defence (kosher.chat and yttl.org already have it; aigalaxy.app
  will get it when it moves to GitHub), but it only hides the symptom: the folder
  still lands in a served directory, and git ignoring it does not stop an SFTP
  upload or a web server from serving it. The owner asked for the cause to be
  fixed ("these dot folders are not meant to be there").
- **An absolute `archiveDir` in user config.** One setting cannot fit every repo,
  and archives from different projects would mix.

## Traps

- Do not delete the moved archive in `aigalaxy.app\.lossless-compact\`: it is the
  only verbatim copy of what that session compacted away.
- The chat that found this (session `50a50b9b-adad-4957-a8d2-1bbc01a23659`, also
  in aigalaxy.app) printed some key fragments while cleaning yttl.org's history.
  If its compaction ever ran, its archive holds them: the reason these archives
  must never sit in a served folder.
