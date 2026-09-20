# Handoff — context-os build, 2026-09-20

**Status:** open. Successor: mark this done when Phase 3 (durable memory) lands.
**Repo:** `C:\Users\Bunkspunkles\Dropbox\Websites\fast-jev-compaction` (branch `main`, commit `ed19d03`, clean).
**Deployed vs local:** nothing is pushed anywhere. `git remote -v` shows only `upstream` (tamaratran). No npm publish. The plugin has not yet been loaded in a live Claude Code session.

## What was asked

`docs/plan.md` (the owner's ContextOS plan): fork fast-jev-compaction and evolve it into a memory hierarchy for agent context — verbatim working set, exact reversible archive, durable memory with provenance, retrieval/rehydration, evals that measure fidelity not just reduction, safe fallbacks, privacy. Multi-week roadmap; this chat delivered Milestones A–C plus a first cut of Milestone D's retrieval.

## What is done (with paths)

- Fork bookkeeping: `UPSTREAM.md` (fork SHA `e3f262a`, upstream issue survey, divergence table), remote `upstream`.
- Core engine, sandbox-safe (no `node:*`): `src/core/{hash,events,actions,rules,dependencies,sketch,redact,policy}.ts`, `src/classifiers/{types,jev,heuristic,replay}.ts`, `src/archive/{types,memory-store,file-store}.ts`, `src/engine/{optimize,rehydrate}.ts`. Public exports in `src/index.ts`.
- Claude Code plugin: `hooks/context-os.ts` (registered in `hooks/hooks.json`; upstream `hooks/fast-jev.ts` kept as a helper library), `.claude-plugin/plugin.json` (renamed `context-os`, new options), `/context` command, `prompt.submit` retrieval.
- Node tier: `src/node/transcripts.ts` (Claude Code JSONL → `Message[]`, usage/cache data, compaction boundaries), `src/node/fs.ts`, `src/node/evals/{dataset,scorers,run}.ts`, `scripts/{eval,capture-sessions,make-adversarial}.ts`, npm scripts `eval`, `capture`, `adversarial`, `prepack`.
- Datasets: `datasets/v1/adversarial/` (8 gold scenarios, committed, deterministic); `datasets/real/` (12 captured sessions, **git-ignored**, on this machine only).
- Docs: `README.md`, `docs/architecture.md`, `docs/evals.md` (numbers), `docs/plan.md`.
- Tests: 244 across 15 files (`npm test`); `npm run typecheck` covers the hook sandbox graph too.

## Numbers so far (docs/evals.md has the tables)

Heuristic classifier, no Jev: adversarial 93 % mean reduction at threshold 0.4, real sessions 49 %, ~40–190 ms, zero structural/verbatim failures, 5/5 constraints active, 27/27 probes recoverable, 3/6 labelled must-keeps evicted (all three are semantic needles; 2 of them come back through prompt retrieval).

## What is left, in order

1. **Live smoke test in Claude Code.** The `claude` CLI on PATH is 2.1.238 (function hooks need 2.1.274+; `validate:plugin` fails on it) but the VS Code extension runs 2.1.278 — this very session's transcript says so. Run `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .` with a ≥ 2.1.274 binary, drive a long session, `/compact`, `/context`, check `.context-os/` is written, check `prompt.submit` retrieval appears in the model's context. Unverified assumptions to confirm: `$.fs.list` entry shape (`{name}`), `$.command.register` from `session.start`, `event.text` on `prompt.submit`, the 10 s hook budget on a 300k-token transcript.
2. **Jev calibration** (needs a `TYPESAFE_API_KEY`; upstream #54 says issuance is opaque — the owner may not have one): `npm run eval -- --record` to fill cassettes for `datasets/v1` and a few real cases; sweep `--threshold` and `questionStyle`; confirm or replace the provisional Jev default 0.15. Compare `UPSTREAM_FAST_JEV` vs `OURS_JEV` on the same cassettes.
3. **Windowed classification** (upstream #52): when `fitState` reaches the `old messages collapsed` stage or worse, Jev is asked about calls it cannot see. Score in windows (build the state per batch with that batch's messages in full). `JevClassifier.score` is the place.
4. **Phase 3 durable memory**: `EXTRACT_MEMORY_AND_ARCHIVE` exists in the taxonomy but nothing produces memories yet. Plan §13: categories, provenance (`source_ids` = event ids), `active/superseded/disputed`. Extraction channel: `$.model.fork({prompt})` in the hook (cheap, shares the prompt cache) or `$.model.complete`; store under `.context-os/memory/` via `FileArchive`-style sharding; surface via `prompt.section` (cached) or `prompt.submit` context. `findConstraints` already yields USER_CONSTRAINT candidates.
5. **Retrieval quality**: today lexical only (`rankRecords`). Add embeddings (plan §14) and expand the query with recent active context (current files, errors). Add a retrieval column to the eval report (the check now lives only in docs/evals.md prose).
6. **Text-message eviction** (plan §3.1): user/assistant text is never evicted; old assistant progress chatter is the next candidate class (plan §18 order). Requires memory extraction first so nothing durable is lost.
7. **Continuous compaction** (plan §15) and cache-aware measurement: `LoadedTranscript.usage` has cache read/write per turn; wire into the report; test whether small frequent evictions beat periodic large ones.
8. Remaining upstream hardening: #38 (question headroom before fitting), #39 (`/compact` instructions ignored), #32 (pending calls invisible in state), request budget 30k → 60k (TypeSafe allows 64k/request; left at upstream's value because it is untested live).
9. Privacy transports: OpenRouter ZDR (`provider: { zdr: true, data_collection: 'deny' }` on `openrouter.ai/api/alpha/decisions`), `baseUrl`/`apiKeyEnv` options; `Redactor` already covers the payload.
10. Codex adapter (plan §26) — the core takes `Message[]`; a Codex port exists (`tylerbuilds/fast-jev-compaction-codex`, MCP-based) to study.

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

None yet — the owner's only message was "Build this … use subagents smartly … leave a handoff if needed". Questions are batched at the end of the chat (naming/remote, TypeSafe key, labelling real sessions, next priority).

## Traps (deliberate things that look wrong)

- `hooks/fast-jev.ts` is not registered in `hooks.json` any more but must stay: `context-os.ts` imports its helpers (`toSessionMessages`, `jevAsker`, `resolveHookConfig`, `summarize`, `decisionLogLines`).
- `src/state.ts`, `src/compact.ts`, `src/client.ts` carry small upstream edits (sketches param, questions param, timeout); keep them minimal for merges.
- `keepThreshold` is deleted from the hook config unless the user set a number, so the classifier's `defaultThreshold` applies. `resolveOptions()` still defaults to 0.5 for the upstream API.
- `DROP_REDUNDANT` drops the *earlier* of two identical interactions (the later one is the live one).
- The dependency graph indexes anchors from result content only, not the call's input path — intentional (read→edit is normal flow).
- `lexicalScore` in `memory-store.ts` is the old ranker kept for tests; `rankRecords` is what search uses.
- vitest's default fork pool OOM'd while five agents ran in parallel; alone it is fine (`npm test` 1.4 s).
- `.gitattributes` forces LF; git on this machine has autocrlf and prints warnings — harmless.

## How to test this

1. `npm install && npm run typecheck && npm test` → 0 errors, 244 passed.
2. `npm run adversarial && npm run eval -- --dataset datasets/v1 --modes NO_COMPACTION,OURS_HEURISTIC` → a table with 0 structure failures, 5/5 probes active, 27/27 recoverable, ~93 % mean reduction.
3. `npm run capture -- --limit 3 --min-bytes 1500000 && npm run eval -- --dataset datasets/real --modes OURS_HEURISTIC` → ~50 % reduction, ~200 ms per case.
4. With Claude Code ≥ 2.1.274: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`, work until `/compact`, then `/context`, `/context list`, `/context why <id>`, `/context restore <id>`; expect `.context-os/archive/<session>/index.json` to exist and the toast `context-os kept N/M messages, archived K units`.
