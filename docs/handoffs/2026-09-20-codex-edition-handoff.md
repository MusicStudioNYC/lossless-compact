# Handoff: the Codex edition of lossless-compact

**Written 2026-09-20 for a fresh chat.** Status: **not started**. The README
now promises it (`⏳ Codex — coming soon`, owner's decision the same day), so
this is a commitment, not an idea. Mark this file done when the README line
flips to ✅.

## What was asked

Make lossless-compact work for OpenAI Codex (the CLI / IDE agent), the way it
works for Claude Code today: compaction removes tool interactions verbatim
into an archive, nothing is summarized, everything is restorable by id, and
relevant archived content comes back into a prompt automatically.

## Read first, in this order

1. `docs/handoffs/2026-09-20-context-os-handoff.md` — the whole project's
   state: what is built, every decision and why, the smoke-test method,
   the traps. Item 11 of "What is left" is this job. Its "Decisions and why"
   section explains why Codex and Cursor were deferred (ship Claude Code
   first) and why the plugin is named as it is.
2. `docs/follow-ups.md`, the two rows dated 2026-09-20 headed "Codex edition"
   and "Cursor edition" — the scoping done so far, including the one big
   caveat: Codex's pre-compaction hook *reportedly* cannot hand back
   replacement messages (unverified). If that holds, the Codex edition is a
   different, weaker promise than the Claude Code plugin and must be
   labelled as such.
3. `docs/plan.md`: "Secondary targets" (top of the file), the
   `adapters/claude-code · codex · generic` layout (§ project layout), and
   "Codex second" (the `NormalizedEvent` shape a host adapter translates
   in and out of).
4. `docs/architecture.md` — the layers. Everything under `src/` is host-
   neutral: `optimize()` in `src/engine/optimize.ts` takes `Message[]`
   (`src/types.ts`) plus a classifier and an `ArchiveStore` and returns the
   kept messages, the archive records and a report. Only
   `hooks/lossless-compact.ts` imports from `claude-code`.
5. `hooks/lossless-compact.ts` — the reference adapter. Read it as the list of
   things a host adapter has to provide: transcript → `Message[]` and back,
   a file system for `FileArchive`, the `/lossless` command (status, list,
   why, show, restore, retrieve), the snapshot + note (`compactionNote`),
   prompt-time retrieval (`rehydrateForPrompt`), the auto-compaction trigger,
   and the fallback path when it cannot remove enough.
6. `src/node/transcripts.ts` — the Claude Code JSONL importer
   (`parseTranscriptLines`, `loadTranscript`, `listSessions`). A Codex
   importer goes beside it and follows the same shape so `npm run capture`
   and `npm run eval` work on Codex sessions unchanged.
7. `UPSTREAM.md` — what the fork kept from `tamaratran/fast-jev-compaction`.
   Upstream has an MCP-based Codex port, `tylerbuilds/fast-jev-compaction-codex`;
   study it for how it gets at the transcript and where it hooks in, but
   reimplement against our engine rather than copying host logic (plan
   "Codex second").

## What is known and what must be verified

Do not trust this list; verify each point against the Codex version actually
installed and its current docs before designing around it.

- Codex keeps session rollouts as JSONL on disk (under `~/.codex/`, one file
  per session). This is the raw log an importer reads and the "never
  modified" copy the compaction note can point at — the counterpart of
  `~/.claude/projects/…/<session>.jsonl`.
- Codex has its own `/compact`. Whether a hook can *replace* its result (the
  Claude Code `session.compact` contract, where the hook's messages stand and
  the built-in summary never runs) is the open question that decides the
  edition's shape. The follow-up row says "reportedly cannot"; nobody on this
  project has checked.
- Codex can load MCP servers. An MCP server can expose tools (status / why /
  show / restore / retrieve over the archive) and works whatever the hook
  surface turns out to be, but it cannot intercept compaction on its own.
- Whether Codex has a prompt-submit hook that may add hidden context (the
  counterpart of Claude Code's `prompt.submit` with `context`), and a
  post-tool-use hook (to archive results as they happen, so a pre-compaction
  hook that cannot return messages still has everything on disk).

## Steps, in order

1. **Verify the hook surface** (above) on the installed Codex. Write the
   answers into this file. This decides everything after it.
2. **Importer first, no integration yet.** `src/node/codex-transcripts.ts`
   turning a Codex rollout into `LoadedTranscript`/`Message[]`, with tests
   on a small fixture (redact anything real). Run one real Codex session
   through `npm run capture`/`npm run eval` with the ruleset and with Jev.
   That proves the engine is host-portable and gives the first Codex numbers
   for the README before any hook code exists.
3. **Pick the shape from step 1:**
   - *A. Full edition* — Codex lets a hook replace compaction: port the
     adapter one concern at a time in the order the reference adapter lists
     them; same archive layout (`.lossless-compact/`), same note, same
     command names.
   - *B. Archive-and-retrieve edition* — it does not: snapshot on
     pre-compaction, archive every tool result on post-tool-use, retrieve on
     prompt submit, and let Codex's own summary run. Say plainly in the
     README that on Codex the summary still happens and lossless-compact
     makes it *recoverable*, not lossless. This is the shape the follow-up
     row expects.
   - *C. MCP-only* — the fallback if there are no usable hooks: the archive
     tools as an MCP server plus the importer. Worth shipping as part of A
     or B anyway, because it is host-independent.
4. **Package** under `adapters/codex/` per the plan's layout (the Claude Code
   hook can stay where it is; do not move it in this job). README gets an
   "Install in Codex" section written like "Install in Claude Code", with
   the edition's real promise in the first sentence. Flip the checklist line
   to ✅ only when a real Codex session has been compacted through it and the
   result was checked by hand, the way the Claude Code smoke test was done.
5. Update `docs/follow-ups.md` (close the Codex row, leave the Cursor row —
   Cursor's *own* agent is still out of scope; Cursor via the Claude Code
   extension already works and the README says so).

## Decisions already made (do not reopen)

- **Ship Claude Code first; Codex second** — owner, 2026-09-20.
- **The README says "coming soon" for Codex** — owner, 2026-09-20, knowing
  the ledger had advised against a launch claim. The fix for that tension
  is to ship, not to soften the line.
- **Cursor = the Claude Code extension inside Cursor**, which works today and
  is listed ✅. Cursor's own agent (Composer) exposes no compaction hook;
  not promised anywhere.
- **Reimplement against our engine, do not fork the MCP port** — plan
  "Codex second".
- **Names:** plugin `lossless-compact`, command `/lossless`, archive dir
  `.lossless-compact/`. Keep them identical on Codex.

## Traps (things that look wrong but are deliberate, and known hazards)

- The checkout folder is still called `fast-jev-compaction`; the package,
  plugin and repo are `lossless-compact`. Leave the folder alone.
- A stray `.context-os/` folder (old archive dir name) may sit untracked in
  the checkout from sessions that started before the rename; ignore or
  delete it, never commit it.
- Multi-line TypeScript edits through `node -e`/heredocs mangle template
  literals and backslashes on this machine; use the editor's Edit tool.
- Git Bash turns `/compact`-style arguments into paths unless
  `MSYS_NO_PATHCONV=1` is set.
- `npm run validate:plugin` fails with the 2.1.238 `claude` on PATH (it
  predates `modules` in `hooks.json`); the 2.1.278 binary under
  `%USERPROFILE%\.cursor\extensions\…\native-binary\claude.exe` passes.
- In the VS Code / Cursor extension every chat tab is its own `claude`
  process and toasts never render there; the transcript note is the
  visible result. The same will need checking for whatever surface Codex
  gives a hook.

## Deployed vs local

GitHub `MusicStudioNYC/lossless-compact`, branch `main`, public. No npm
publish. Nothing Codex-related exists anywhere yet.
