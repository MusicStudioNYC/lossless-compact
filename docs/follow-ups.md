# Follow-up ledger

Deferred items with the reason they were deferred. Move an item to the
handoff's "what is left" list when it is picked up; delete it when done.

| Added | Item | Why deferred |
| --- | --- | --- |
| 2026-09-20 | Windowed Jev classification when `fitState` passes `texts abridged` (upstream #52) | Needs cassettes to measure; design in handoff |
| 2026-09-20 | Raise `maxRequestTokens` default 30k → 60k (TypeSafe: 64k/request, 32k state) | Untested against the live API; halves request count when confirmed |
| 2026-09-20 | Upstream #38 (question headroom before fitting), #39 (`/compact` instructions), #32 (pending calls in state) | Hardening, no measured impact yet |
| 2026-09-20 | Per-project settings: `.context-os/config.json` + `/context set` (option B) | Owner confirmed; after the smoke test |
| 2026-09-20 | Cache read/write metrics from `LoadedTranscript.usage` in the report | Plan §3.5; data is loaded, not aggregated |
| 2026-09-20 | Label ~5 real sessions model-assisted (`labels.json`) and re-check the Jev 0.35 default | Owner chose model-assisted; next chat after the smoke test |
| 2026-09-20 | Embedding-based retrieval + query expansion from recent context | Plan §14; lexical v1 recovers 2/3 needles |
| 2026-09-20 | Durable memory extraction via `$.model.fork` with invalidation | Phase 3; nothing produces `EXTRACT_MEMORY_AND_ARCHIVE` yet |
| 2026-09-20 | OpenRouter ZDR transport option (`provider: { zdr: true, data_collection: 'deny' }`) | Plan §23; verify OpenRouter routes `~typesafe/jev-latest` through a ZDR provider first |
| 2026-09-20 | Decide npm package name (`fast-jev-compaction` → `context-os`?) | Owner decision; the plugin path needs no npm |
| 2026-09-20 | Flip `MusicStudioNYC/context-os` from private to public (`gh repo edit --visibility public --accept-visibility-change-consequences`) | Owner wants the interactive auto-compaction check first; handoff docs carry local paths |
| 2026-09-20 | Dedupe rehydration across turns (the same record re-injected every prompt that mentions it) | Per-turn cost; needs a `$.store` note of recently injected ids |
| 2026-09-20 | Interactive check of the `turn.complete` auto-compaction trigger (needs a VS Code session past 120k tokens); `$.session.compact()` is unavailable headless | Only the headless path was exercised in the smoke test |
| 2026-09-20 | Retrieval column in `scripts/eval.ts` report (today `scripts/retrieval-check.ts` is separate) | Small; the check script exists and is cited in docs/evals.md |
| 2026-09-20 | The compaction note becomes the session's `last-prompt` until the next real prompt (cosmetic in the session picker) | Would need an assistant-role note or a host change; not worth a role change yet |
| 2026-09-20 | Strong-reference rule missed `ORCHARD_DB_PORT=61873` quoted in backticks by the assistant (protected: none in the smoke run; Jev kept it anyway) | Check `splitReferences` quote detection on short `KEY=value` spans |
| 2026-09-20 | Interactive check of the keep-nothing review: `$.model.fork` verdict and the `$.ui.ask` dialog (headless: fork cold, ask rejects; haiku path verified live) | Needs a VS Code session with ≥ 5 disposable reads, then `/compact` |
| 2026-09-20 | Hook token estimator (chars/4) runs ~1.7× under the host count on Read-heavy transcripts; consider `$.session.usage()` or a per-block overhead in the log lines | Cosmetic: the trigger uses the host count |
| 2026-09-20 | Report the `rechain` finding upstream to Claude Code (hook-compacted transcript undone on `--resume` when kept messages keep their handle) | Needs the GitHub issue tracker / feedback channel |
