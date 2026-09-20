# Handoff — context-os build, 2026-09-20

**Status:** open. Successor: mark this done when Phase 3 (durable memory) lands.
**Repo:** `C:\Users\Bunkspunkles\Dropbox\Websites\fast-jev-compaction` (branch `main`, clean; the smoke-test chat of 2026-09-20 added commits `2812cae`…`969b482` plus this update — see `git log`).
**Deployed vs local:** nothing is pushed anywhere yet. `git remote -v` shows only `upstream` (tamaratran); the owner chose to push to `<owner>/context-os` — create that empty GitHub repo, then `git remote add origin <url> && git push -u origin main`. No npm publish. The plugin **has** run live in Claude Code 2.1.278 (headless `-p`; see "Live smoke test" below and docs/evals.md).
**Jev key:** `~/.typesafe_key` (one line, `apikey_…`, 108 chars; not in the repo). Verified live against `jev-1.13.0`. Use it as `TYPESAFE_API_KEY="$(cat ~/.typesafe_key)"`; for the plugin put it in `~/.claude/settings.json` `env` or the plugin's `apiKey` option.

## What was asked

`docs/plan.md` (the owner's ContextOS plan): fork fast-jev-compaction and evolve it into a memory hierarchy for agent context — verbatim working set, exact reversible archive, durable memory with provenance, retrieval/rehydration, evals that measure fidelity not just reduction, safe fallbacks, privacy. Multi-week roadmap; this chat delivered Milestones A–C plus a first cut of Milestone D's retrieval.

## What is done (with paths)

- Fork bookkeeping: `UPSTREAM.md` (fork SHA `e3f262a`, upstream issue survey, divergence table), remote `upstream`.
- Core engine, sandbox-safe (no `node:*`): `src/core/{hash,events,actions,rules,dependencies,sketch,redact,policy}.ts`, `src/classifiers/{types,jev,heuristic,replay}.ts`, `src/archive/{types,memory-store,file-store}.ts`, `src/engine/{optimize,rehydrate}.ts`. Public exports in `src/index.ts`.
- Claude Code plugin: `hooks/context-os.ts` (registered in `hooks/hooks.json`; upstream `hooks/fast-jev.ts` kept as a helper library), `.claude-plugin/plugin.json` (renamed `context-os`, new options), `/context` command, `prompt.submit` retrieval.
- Node tier: `src/node/transcripts.ts` (Claude Code JSONL → `Message[]`, usage/cache data, compaction boundaries), `src/node/fs.ts`, `src/node/evals/{dataset,scorers,run}.ts`, `scripts/{eval,capture-sessions,make-adversarial}.ts`, npm scripts `eval`, `capture`, `adversarial`, `prepack`.
- Datasets: `datasets/v1/adversarial/` (8 gold scenarios, committed, deterministic); `datasets/real/` (12 captured sessions, **git-ignored**, on this machine only).
- Docs: `README.md`, `docs/architecture.md`, `docs/evals.md` (numbers), `docs/plan.md`.
- Tests: 263 across 17 files (`npm test`); `npm run typecheck` covers the hook sandbox graph too.

## Numbers so far (docs/evals.md has the tables)

- Jev (cassettes recorded and committed for `datasets/v1`; real-session cassettes are in the git-ignored `datasets/real/`): upstream at its default deletes 4/6 must-keeps and 24/27 probes for 97 %; ours drops 0/6 and loses nothing up to threshold 0.45, first false drop at 0.50. Default set to **0.35**: 91 % adversarial, 52 % real, ~9 requests / 1.2 s per real session.
- Heuristic (no key): 93 % / 49 % at 0.4, 3/6 semantic needles evicted (2 come back through prompt retrieval), ~40–190 ms.
- Zero structural/verbatim failures anywhere.

## Also done late in the chat (owner's requests)

- Pre-compaction **snapshot** (`.context-os/snapshots/<session>/<compaction>.json`, sharded under 4 MiB) and a **note message** inserted after the first message of the compacted transcript naming what was removed and where the snapshot, the archive and the raw `~/.claude/projects/…/<session>.jsonl` are (`writeSnapshot`, `rawSessionLogPath`, `compactionNote`, `withCompactionNote` in `hooks/context-os.ts`; options `snapshot`, `noteRemoved`). The raw-log path is a best-effort guess from `$.session.cwd()` + `$.env.get('HOME'|'USERPROFILE')`, confirmed with `$.fs.exists` — verify in the live smoke test.
- `CLAUDE_NATIVE_COMPACTION` mode (a Claude-Code-style summary produced through `claude -p --model sonnet`, or the Anthropic API when `ANTHROPIC_API_KEY` exists) and an LLM judge that scores every mode against the same ground truth semantically (`src/node/evals/{model,native,judge}.ts`, flags `--native --judge native|all --native-keep-recent N --model <name>`). The report now also shows "safe_to_drop kept" (did not remove what it should have) for every mode. The first full run (`--native --judge all`, 31 min through `claude -p --model sonnet`) finished; its table and reading are in docs/evals.md ("Native `/compact` comparison"). Judge caveat: ~6 % noise (2/32 probes marked lost on the uncompacted transcript). Future runs: `--judge native` (~10 min).
- Auto-compaction triggers on an absolute count: `compactAtTokens` (default 120 000) in `hooks/context-os.ts` `shouldCompact`; `compactAtPercent` is off unless set.
- A bare `/context` now calls `next(event)` so Claude Code's built-in usage grid still shows, with our archive status underneath; subcommands are ours. (The built-in command exists — registering the same name intercepts it.)
- Settings UX, owner asked for options: recommended A (plugin `userConfig` + `/config`, already there) now, B (per-project `.context-os/config.json` + `/context set <key> <value>`, precedence project › /config › defaults, `/context` shows effective values) as the next small step; C (a plugin-drawn settings panel via `ui.render`) only if the product gets users. Owner's choice pending.

## Live smoke test (done 2026-09-20, second chat)

Driven headless. `claude.exe` 2.1.278 is at `%USERPROFILE%\.cursor\extensions\anthropic.claude-code-2.1.278-win32-x64\resources\native-binary\claude.exe` (PATH still has 2.1.238). Driver per turn: `claude -p --session-id <uuid> --plugin-dir . --model sonnet --output-format stream-json --verbose --include-hook-events --allowedTools Read,Glob,Grep --debug-file <log> "<prompt>"`, then `--resume <uuid>`; env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, `TYPESAFE_API_KEY=…` and **`MSYS_NO_PATHCONV=1`** (Git Bash otherwise turns `/compact` into `C:/Program Files/Git/compact`). The hook's `$.ui.log` lines land in the debug file as `[context-os] $.ui.log: …`. The session (`fb138cff-7114-4821-846d-8b72fc4b7d84` under `~/.claude/projects/c--Users-Bunkspunkles-Dropbox-Websites-fast-jev-compaction/`) and its `.context-os/` archive are still on disk.

Verified: the plugin loads and validates on 2.1.278; `session.compact` returned our 19 messages for a 258k-token transcript in 819 ms (Jev 400 ms) and the host logged "a hook's 19 messages stand; core never ran"; archive index + shard and the 1 MB snapshot were written; the note is message 2 and the raw `.jsonl` path is found from inside the sandbox (`$.fs.exists` works on absolute paths outside the project); bare `/context` shows the host grid plus ours, `list`/`why`/`restore` answer in ~10 ms; `prompt.submit` gets `event.text`, retrieval ran in 126 ms and the model answered from the `<retrieved_context>` block and said so. The 10 s hook budget is not a constraint (the host waited 135 s for a compaction that included its own summary).

Found and fixed, one commit each: the first compaction of a session fell back to the built-in summary (the host forwards `$.fs.read`'s ENOENT as a plain Error, message only, and `FileArchive` rethrew); removed calls left no marker because Claude Code gives every call its own text-less message (now a marker-only message, runs merged; ~3–5 points of reduction); retrieval handed over the head of a 40k-char record (now the best window around the query terms) and ranked prose words above `FsEntry` (now code-cased terms ×3, dedupe by contentHash, prose-only prompts retrieve nothing); every fallback splices a `summarized` note into the built-in summary; `$.command.register('context')` is refused as the built-in name but the `command.run` filter intercepts it anyway; `/context` status names the classifier that ran.

Still open: **the `turn.complete` auto-trigger could not be exercised** — `$.session.compact()` throws "not available in a headless (-p / SDK) session yet"; it needs one interactive session that crosses 120k tokens. `/context restore` returning `context: [block]` was only seen as text (a command in `-p` runs no model turn).

## What is left, in order

1. **Interactive verification of auto-compaction** in the VS Code extension: open Claude Code 2.1.278 in this repo with the plugin loaded, work past 120k tokens, expect the toast `context-os kept N/M messages, archived K units, no summary (…)` without typing `/compact`; then a prompt naming something archived, expect the model to cite a `retrieved_context` block; then `/context restore <id>` followed by a question answerable only from it.
2. **Label ~5 real sessions, model-assisted** (owner chose this): a subagent reads `datasets/real/<case>/transcript.json`, writes `labels.json` (must_keep / nice_to_keep / safe_to_truncate / safe_to_drop per `tool_use_id`, plus probes), the owner spot-checks; then `npm run eval -- --dataset datasets/real --modes OURS_JEV,OURS_HEURISTIC,UPSTREAM_FAST_JEV` gives the first real false-drop rate (Jev cassettes for the 12 real cases already exist). Re-check the 0.35 default against those labels.
3. **Per-project settings** (option B above, ~80 lines in the hook + tests) — owner confirmed B.
4. **Windowed classification** (upstream #52): when `fitState` reaches the `old messages collapsed` stage or worse, Jev is asked about calls it cannot see. Score in windows (build the state per batch with that batch's messages in full). `JevClassifier.score` is the place.
5. **Phase 3 durable memory**: `EXTRACT_MEMORY_AND_ARCHIVE` exists in the taxonomy but nothing produces memories yet. Plan §13: categories, provenance (`source_ids` = event ids), `active/superseded/disputed`. Extraction channel: `$.model.fork({prompt})` in the hook (cheap, shares the prompt cache) or `$.model.complete`; store under `.context-os/memory/` via `FileArchive`-style sharding; surface via `prompt.section` (cached) or `prompt.submit` context. `findConstraints` already yields USER_CONSTRAINT candidates.
6. **Retrieval quality**: today lexical only (`rankRecords`). Add embeddings (plan §14) and expand the query with recent active context (current files, errors). Add a retrieval column to the eval report (the check now lives only in docs/evals.md prose).
7. **Text-message eviction** (plan §3.1): user/assistant text is never evicted; old assistant progress chatter is the next candidate class (plan §18 order). Requires memory extraction first so nothing durable is lost.
8. **Continuous compaction** (plan §15) and cache-aware measurement: `LoadedTranscript.usage` has cache read/write per turn; wire into the report; test whether small frequent evictions beat periodic large ones.
9. Remaining upstream hardening: #38 (question headroom before fitting), #39 (`/compact` instructions ignored), #32 (pending calls invisible in state), request budget 30k → 60k (TypeSafe allows 64k/request; left at upstream's value because it is untested live).
10. Privacy transports: OpenRouter ZDR (`provider: { zdr: true, data_collection: 'deny' }` on `openrouter.ai/api/alpha/decisions`), `baseUrl`/`apiKeyEnv` options; `Redactor` already covers the payload.
11. Codex adapter (plan §26) — the core takes `Message[]`; a Codex port exists (`tylerbuilds/fast-jev-compaction-codex`, MCP-based) to study.

## Decisions and why (alternatives rejected)

- **Keep upstream files in place, build beside them** (not a monorepo rewrite): plan §9 says not to in week one; upstream patches still merge. Rejected: `packages/*` layout now.
- **Sandbox-safe core / Node tier split**: the hook runtime has no Node at all (`types/claude-code.d.ts` header; `$.fs`, `$.store`, `$.http.fetch` only). Anything the hook imports must be pure TS. `npm run typecheck:hooks` enforces it (types: [], lib es2023).
- **FileArchive over `$.fs`, sharded JSON, not SQLite**: no `node:sqlite` in the sandbox; `$.fs` is whole-file ≤ 4 MiB; `$.store` is a 4 MiB global KV. SQLite remains an option for the Node CLI only.
- **Jev threshold 0.15 + "useful" wording**: upstream #26/#52/#56 show 0.5 with upstream wording keeps nothing (0/256 results > 0.3 on 16 real sessions); #55 measured 0.15 + criteria. Provisional until our cassettes exist. Upstream wording kept as `questionStyle: 'upstream'` for A/B.
- **Heuristic threshold 0.4**: sweep in docs/evals.md; false drops did not move with the threshold, reduction did (19/49/67 %).
- **Strong vs weak references**: hard-protecting every result a later assistant message mentioned a path from protected 120/326 candidates on one real session. Now quotes/error lines/tool ids/user mentions protect; paths/symbols add +0.2.
- **Removed calls leave a marker in the narrating assistant message** (upstream #65) rather than keeping the call: the marker is additive, names the archive ids, and is the only edit ever made to text. Rejected: replacing the tool input with a stub (confuses the model).
- **Partial batch salvage** (#58) over fail-closed (#44): unscored calls are kept, so salvage cannot delete anything.
- **Hook fallback when a classifier keeps none of ≥ 5 scored results** (#53): a miscalibrated classifier must not get the transcript.
- **Rehydration scoring**: matched share of IDF-weighted query terms; a rare *original* prompt word matched exactly or as a compound component (`postgres` in `POSTGRES_PORT`) scores ≥ 0.5 on its own; stems (`fail` from "failing") rank but are never distinctive (they produced false positives on `FAIL` test lines).
- **`datasets/real/` is git-ignored**: it holds the owner's own code and prompts (redacted, but still private).
- **npm package name unchanged** (`fast-jev-compaction`), plugin renamed `context-os`: the owner has not said where this will be published; see open questions.

## Owner's answers from the chat

- Repo & name: "Push to <you>/context-os, keep npm name for now" (not done: no `gh` and no GitHub handle on this machine — see top).
- Jev key: provided (`Downloads/jev context os.txt`, copied to `~/.typesafe_key`).
- Real labels: "Yes, model-assisted on ~5 sessions".
- Next step: "Live smoke test in Claude Code 2.1.278".
- Mid-chat: "can it make a backup of the jsonl file and then … inject something like 'Full un-compacted jsonl file can be found here…' into the newly compacted context" → done (snapshot + note, above).
- Mid-chat: "compact at a fixed value, not percent … you tell me what's a reasonable number" → `compactAtTokens` default 120 000 (reasoning in README / chat).
- Mid-chat: "what's the smartest way to make settings available to everyone … GUI if simple" → options A–D laid out; owner chose **B** (per-project `.context-os/config.json` + `/context set`).
- End of chat: native-/compact eval ran to completion (owner's choice); table in docs/evals.md.
- Mid-chat: "did you make tests while knowing the ground truth … compare with a traditional /compact … how much it removed that it should not have, and how much it didn't remove that it should have?" → yes for the first (labels + probes; both error directions now in the report), and the native comparison + judge were built in response.

## Traps (deliberate things that look wrong)

- `hooks/fast-jev.ts` is not registered in `hooks.json` any more but must stay: `context-os.ts` imports its helpers (`toSessionMessages`, `jevAsker`, `resolveHookConfig`, `summarize`, `decisionLogLines`).
- `src/state.ts`, `src/compact.ts`, `src/client.ts` carry small upstream edits (sketches param, questions param, timeout); keep them minimal for merges.
- `keepThreshold` is deleted from the hook config unless the user set a number, so the classifier's `defaultThreshold` applies. `resolveOptions()` still defaults to 0.5 for the upstream API.
- `DROP_REDUNDANT` drops the *earlier* of two identical interactions (the later one is the live one).
- The dependency graph indexes anchors from result content only, not the call's input path — intentional (read→edit is normal flow).
- `lexicalScore` in `memory-store.ts` is the old ranker kept for tests; `rankRecords` is what search uses.
- vitest's default fork pool OOM'd while five agents ran in parallel; alone it is fine (`npm test` 1.4 s).
- `.gitattributes` forces LF; git on this machine has autocrlf and prints warnings — harmless.
- The upstream #53 guard (`suspectCalibration`: ≥ 5 scored, none kept → built-in summary) also fires on a session whose tool output really was all disposable (the first smoke run: 11 reads nobody referred to again). A score band was tried and dropped: the real #53 case was everything under 0.3 with a 0.5 threshold, which a band cannot tell apart. The fallback now carries the note, so a wrong trip costs a summary plus pointers, not loss. Whether to keep the guard is the owner's call (asked at the end of the smoke-test chat).
- The compaction note is a synthetic `user` message and the host records it as the session's `last-prompt` until the next real prompt — cosmetic (session picker).
- Auto-compaction cannot be started by the plugin in a headless (`-p` / SDK) session — host limitation, logged and skipped; `/compact` and the host's own trigger still route through the hook.
- Patching `hooks/context-os.ts` through `node - <<EOF` heredocs mangles template literals and `\b`; use the Edit tool for multi-line TypeScript changes.

## How to test this

1. `npm install && npm run typecheck && npm test` → 0 errors, 244 passed.
2. `npm run adversarial && npm run eval -- --dataset datasets/v1 --modes NO_COMPACTION,OURS_HEURISTIC` → a table with 0 structure failures, 5/5 probes active, 27/27 recoverable, ~93 % mean reduction.
3. `npm run capture -- --limit 3 --min-bytes 1500000 && npm run eval -- --dataset datasets/real --modes OURS_HEURISTIC` → ~50 % reduction, ~200 ms per case.
4. With Claude Code ≥ 2.1.274: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`, work until `/compact`, then `/context`, `/context list`, `/context why <id>`, `/context restore <id>`; expect `.context-os/archive/<session>/index.json` to exist and the toast `context-os kept N/M messages, archived K units`.
