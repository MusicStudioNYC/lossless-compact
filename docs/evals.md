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

## Native `/compact` comparison and the judge

`--native` runs `CLAUDE_NATIVE_COMPACTION`: Claude writes a summary with a
prompt modelled on Claude Code's own `/compact` and it replaces the history
(`--native-keep-recent N` keeps a tail for parity). `--judge native` scores
that summary against the same ground truth with an LLM judge
(verbatim / paraphrased / absent per must-keep, probe and safe-to-drop item);
`--judge all` judges every mode. Prefer `--judge native`: the verbatim modes
are scored exactly by substring already, and every judge call sends the
whole compacted context. Cost of one full run on `datasets/v1` through
`claude -p --model sonnet`: 8 summaries + 8 judge calls ≈ 0.6M input tokens
(~10 min); with `--judge all` ≈ 2M tokens (~45 min, sequential process
spawns). With `ANTHROPIC_API_KEY` set the same run bills the API instead of
the subscription and skips the per-call process start.

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

## Jev results (2026-09-20, jev-1.13.0, cassettes committed for `datasets/v1`)

All modes on the adversarial set, each classifier at its own default:

| Mode | Mean reduction | must_keep false drops | Probes active / recoverable | Structure failures | Mean ms | Requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| NO_COMPACTION | 0 % | 0/6 | 5/5 · 27/27 | 0 | 0 | 0 |
| UPSTREAM_FAST_JEV (threshold 0.5, upstream wording, deletes) | **97.0 %** | **4/6** | 5/5 · **3/27** | 0 | 305 | 8 |
| OURS_JEV (`useful` wording, sketches, archive) | see sweep | **0/6** | 5/5 · 27/27 | 0 | ~500 | 15 |
| OURS_HEURISTIC (0.4) | 93.0 % | 3/6 | 5/5 · 27/27 | 0 | 36 | 0 |

Upstream's headline reduction is deletion: two thirds of the labelled
must-keeps and 24 of 27 probes are gone for good. Ours never loses a probe
(everything is archived) and, with Jev, never drops a must-keep.

Threshold sweep for OURS_JEV from the same cassettes (adversarial / 12 real
sessions, false drops on the adversarial labels):

| keepThreshold | Adversarial reduction | Real reduction | must_keep false drops |
| ---: | ---: | ---: | ---: |
| 0.10 | 24.4 % | 0.5 % | 0/6 |
| 0.15 (upstream #55's suggestion) | 43.7 % | 4.9 % | 0/6 |
| 0.20 | 51.3 % | 9.4 % | 0/6 |
| 0.30 | 71.4 % | 22.5 % | 0/6 |
| **0.35 (default)** | 91.2 % | 51.9 % | 0/6 |
| 0.40 | 96.4 % | 65.7 % | 0/6 |
| 0.45 | 96.8 % | – | 0/6 |
| 0.50 | 96.8 % | – | 1/6 |

Upstream wording inside our engine (`OURS_JEV_UPSTREAM_WORDING`): 0/6 up to
0.40, 1/6 at 0.50 — the `useful` wording buys about 0.05 of headroom. On real
sessions Jev puts most results in the 0.3–0.4 band with this wording, so the
default is set at 0.35: 0.15 below the first observed false drop, and enough
reduction that the hook does not fall back to the built-in summary. Jev costs
~9 requests and ~1.2 s per 250–760-message session (bounded concurrency 4).
Real-session fidelity is unlabelled so far (follow-ups).

## Native `/compact` comparison (2026-09-20, judge = Sonnet via `claude -p`, report `2026-09-20T07-23-10-412Z`)

Exact = substring scoring; judge = Sonnet reading the *active* compacted
context and marking each ground-truth item verbatim / paraphrased / absent
(the fair scoring for a paraphrasing summary; ~6 % noisy — it marked 2/32
probes lost on the uncompacted transcript).

| Mode | Compacted to | Must-keeps lost (exact) | Must-keeps lost (judge) | Probes recoverable (exact) | Probes in active context (judge) | Droppable content still present (judge) | Verbatim | Time / compaction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| NO_COMPACTION | 100 % | 0/6 | 0/6 | 27/27 | 30/32 | 262/279 | yes | – |
| UPSTREAM_FAST_JEV | 3 % | 4/6 | 2/6 | 3/27 | 9/32 | 73/279 | yes | 6 ms + Jev |
| OURS_JEV (0.35) | 9 % | 0/6 | 0/6 | 27/27 | 11/32 (+27/27 archived) | 14/279 (5 %) | yes | 47 ms + ~1 s Jev, ~1¢ |
| OURS_HEURISTIC (0.4) | 7 % | 3/6 | 1/6 | 27/27 | 10/32 | 45/279 | yes | 40 ms, $0 |
| CLAUDE_NATIVE_COMPACTION (summary) | 10 % | 6/6 (nothing verbatim survives) | 0/6 | 14/27 | 16/32 | 80/279 (29 %) | no — 8/8 rewritten | 82 s, full-context model call |

Reading: on the six needles the summary matched us semantically (Sonnet saw
the whole ≤ 70k-token transcript and wrote the salient facts down); our
advantage there is that the value is the original bytes rather than a
paraphrase. The summary keeps more distractor facts in the active context
(16/32 vs 11/32) but drags 29 % of the droppable content along and rewrites
everything; ours keeps 5 % and can bring any of the 27/27 archived probes
back (2 of 3 evicted needles returned through prompt retrieval). Upstream is
worst on every axis. Open question for real sessions: a summary's recall at
200k+ tokens, to be answered once ~5 real sessions are labelled.

## Heuristic results (2026-09-20, no Jev)

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
