# Evals

The product lives or dies by these numbers, and token reduction is never
reported alone: every run also scores whether labelled must-keep results
survived, whether every probe is still findable, and whether the transcript is
still well-formed.

```sh
npm run adversarial                       # regenerate datasets/v1/adversarial (deterministic)
npm run eval -- --dataset datasets/v1     # all modes, report under reports/<timestamp>/
npm run eval -- --modes OURS_HEURISTIC,NO_COMPACTION --filter needle
npm run eval -- --threshold 0.15 --margin 0.05 --recent 6
TYPESAFE_API_KEY=… npm run eval -- --record   # ask Jev for cassette misses and save cassettes
```

## Modes

| Mode | What runs | Needs |
| --- | --- | --- |
| `NO_COMPACTION` | identity | – |
| `CLAUDE_NATIVE_COMPACTION` | the host's summary | a live Claude Code session; not runnable offline (reported as n/a) |
| `UPSTREAM_FAST_JEV` | upstream `compact()` at threshold 0.5 | cassette or key |
| `OURS_HEURISTIC` | `optimize()` with the offline heuristic classifier | – |
| `OURS_JEV` | `optimize()` with Jev, `useful` wording, threshold 0.15 | cassette or key |
| `OURS_JEV_UPSTREAM_WORDING` | `optimize()` with Jev, upstream wording | cassette or key |

Jev answers are recorded per case in `cassette.json`, keyed by a canonical hash
of `{state, questions}`; a cassette replays for free and deterministically.
Because our state includes sketches and different question wording, upstream
and ours never share cassette entries.

## Dataset layout

```
datasets/<set>/<case>/transcript.json   Message[] (the library's shape)
datasets/<set>/<case>/labels.json       { version: 1, calls: { tool_use_id: label }, probes: [...] }
datasets/<set>/<case>/meta.json         provenance and counts
datasets/<set>/<case>/cassette.json     recorded Jev answers (optional)
```

Labels: `must_keep` · `nice_to_keep` · `safe_to_truncate` · `safe_to_drop`.
Probes: `{ id, kind, text, where: 'active' | 'active_or_archive', note }` — an
exact substring that must remain in the active transcript, or at least be
recoverable from the archive.

`datasets/v1/adversarial` holds the eight gold scenarios from the plan
(late constraint, port in a tool result, flaky-test workaround, rejected
approach, file changed since read, two similar keys, obsolete-looking root
cause, needle in logs), each with distractor probes and an exact duplicate
interaction.

## Real sessions

```sh
npm run capture -- --limit 20 --min-bytes 500000 [--project aigalaxy] [--redact-user-paths]
```

reads `~/.claude/projects/**/*.jsonl`, follows the main conversation chain,
redacts secrets and writes `datasets/real/<project>--<session>/`. `datasets/real/`
is git-ignored: it holds your own code and prompts. Label the interesting ones
by hand (or with a model) before trusting fidelity numbers on them.

## Metrics

Per case and mode: tokens before/after (the estimator in `src/state.ts`),
reduction, archived tokens, action counts, requests, ms; fidelity —
`mustKeepFalseDrop` (the dangerous error), `mustKeepTruncated`,
`niceToKeepDropped`, `safeToDropKept`, probe retention (active / recoverable),
`structureValid`, `orderPreserved`, `keptVerbatim`.

Cache behaviour (cache read/write tokens per turn) is available from the real
transcripts' `usage` records (`LoadedTranscript.usage`) and is the next metric
to wire into the report.

## First results (2026-09-20, heuristic classifier, no Jev)

Adversarial set (8 cases) and 12 real sessions (98k–330k tokens each, the
post-compaction tails of long `aigalaxy.app` sessions), threshold sweep:

| keepThreshold | Adversarial reduction | Real reduction | must_keep false drops | Probes active / recoverable | Structure failures |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.3 | 39.4 % | 19.2 % | 3/6 | 5/5 · 27/27 | 0 |
| **0.4 (default)** | 93.0 % | 49.1 % | 3/6 | 5/5 · 27/27 | 0 |
| 0.5 | 95.3 % | 67.2 % | 3/6 | 5/5 · 27/27 | 0 |

Mean compaction time ~40 ms (adversarial) and ~190 ms (real, 250–760
messages), no network. The three evicted must-keeps are the needles nothing
later references (a port in a `cat .env` result, an early file read, a peer
dependency warning) — a semantic call the Jev classifier is for; they remain
recoverable from the archive. Two other needles were caught deterministically
(a user quoting an id from a result; a later reference to an error line).

Retrieval check (the final user prompt of each adversarial case against the
archive after compaction, `scratch`-style script, not yet a report column):
2 of the 3 evicted needles come back through `rehydrateForPrompt` on the
prompt alone (`POSTGRES_PORT=54329` for "can't reach Postgres", the
`UNMET PEER DEPENDENCY zod` line for "zod type error"); the third
(`MAX_UPLOAD_MB = 25` for "uploads of 30MB failing") is beyond lexical
retrieval because "upload" is common in that transcript. No junk was
retrieved on the five cases whose needle was already active.

Two engine bugs were found by the harness on its first runs: dropped results
surviving because of a vacuous `[].every`, and hard-protecting every result a
later assistant message mentioned a path from (120/326 candidates on one real
session) — now only strong references (quotes, error lines, tool ids, any user
mention) protect; weak ones raise the keep probability by 0.2.
