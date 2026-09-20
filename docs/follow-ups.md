# Follow-up ledger

Deferred items with the reason they were deferred. Move an item to the
handoff's "what is left" list when it is picked up; delete it when done.

| Added | Item | Why deferred |
| --- | --- | --- |
| 2026-09-20 | Live smoke test of the plugin in Claude Code ≥ 2.1.274 (`$.fs.list` shape, `command.register` timing, `prompt.submit` `text`, 10 s hook budget on 300k tokens) | `claude` on PATH is 2.1.238; the VS Code extension has 2.1.278 — needs an interactive session |
| 2026-09-20 | Windowed Jev classification when `fitState` passes `texts abridged` (upstream #52) | Needs cassettes to measure; design in handoff |
| 2026-09-20 | Raise `maxRequestTokens` default 30k → 60k (TypeSafe: 64k/request, 32k state) | Untested against the live API; halves request count when confirmed |
| 2026-09-20 | Upstream #38 (question headroom before fitting), #39 (`/compact` instructions), #32 (pending calls in state) | Hardening, no measured impact yet |
| 2026-09-20 | Retrieval column in the eval report (needle recovered by final prompt) | Check exists only as prose in docs/evals.md |
| 2026-09-20 | Read the first native+judge run (`reports/<newest>/report.md`), paste into docs/evals.md, sanity-check the judge | Run was still executing when the chat ended |
| 2026-09-20 | Per-project settings: `.context-os/config.json` + `/context set` (option B) | Owner confirmed; after the smoke test |
| 2026-09-20 | Cache read/write metrics from `LoadedTranscript.usage` in the report | Plan §3.5; data is loaded, not aggregated |
| 2026-09-20 | Label ~5 real sessions model-assisted (`labels.json`) and re-check the Jev 0.35 default | Owner chose model-assisted; next chat after the smoke test |
| 2026-09-20 | Create `<owner>/context-os` on GitHub, add `origin`, push | No `gh` and no handle on this machine |
| 2026-09-20 | Verify `rawSessionLogPath` finds the real `.jsonl` from inside the hook (`$.fs.exists` on an absolute path) | Live smoke test |
| 2026-09-20 | Embedding-based retrieval + query expansion from recent context | Plan §14; lexical v1 recovers 2/3 needles |
| 2026-09-20 | Durable memory extraction via `$.model.fork` with invalidation | Phase 3; nothing produces `EXTRACT_MEMORY_AND_ARCHIVE` yet |
| 2026-09-20 | OpenRouter ZDR transport option (`provider: { zdr: true, data_collection: 'deny' }`) | Plan §23; verify OpenRouter routes `~typesafe/jev-latest` through a ZDR provider first |
| 2026-09-20 | Decide npm package name (`fast-jev-compaction` → `context-os`?) and the GitHub remote for `origin` | Owner decision |
| 2026-09-20 | Dedupe rehydration across turns (the same record re-injected every prompt that mentions it) | Per-turn cost; needs a `$.store` note of recently injected ids |
