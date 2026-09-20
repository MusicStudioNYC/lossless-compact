# context-os

A context optimizer for coding agents. Instead of summarizing old turns, it
keeps the smallest sufficient working set **verbatim**, moves everything it
removes into an exact, searchable **archive**, and can bring any of it back
by id. Every decision is explainable (`/context why <id>`), nothing is
paraphrased, and a wrong call is recoverable rather than fatal.

It ships as a Claude Code plugin (function hooks, 2.1.274+) and as an npm
library, and is a fork of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT) — see [UPSTREAM.md](UPSTREAM.md) for what was kept, fixed and diverged.

## What it does at compaction time

```
transcript ──► ledger (stable event ids)
           ├─ pin      first message + newest N messages
           ├─ protect  unresolved errors · results later quoted / referenced by the user
           │           · results of non-reproducible tools · files being edited right now
           ├─ dedupe   identical tool+input+result seen again later
           ├─ classify Jev (TypeSafe) or a local heuristic, over a redacted, sketched state
           ├─ decide   PIN_VERBATIM · KEEP_VERBATIM · KEEP_HEAD_TAIL · RERUN_ON_DEMAND
           │           · ARCHIVE_ONLY · DROP_REDUNDANT — each with reasons
           ├─ archive  every evicted unit, exact, under .context-os/ with provenance
           └─ rebuild  stubs name the archive id; removed calls leave a marker
```

User and assistant text is never removed or rewritten (a removed tool call
appends a one-line marker to the message that narrated it, so a later turn
cannot mistake narration for work still in context; Claude Code gives each
call its own text-less message, so there the marker stands alone, and a run
of removed calls becomes one line naming every archive id). Tool call ↔
result structure is always preserved. If the classifier fails or is unsure,
content stays.

Before compacting, the exact transcript is written to
`.context-os/snapshots/<session>/<compaction>.json`, and one note is inserted
after the first message telling the model what was removed and where the
snapshot, the archive and the raw Claude Code session log
(`~/.claude/projects/…/<session>.jsonl`, which compaction never modifies) are,
so it can grep or read any removed message itself.

## How it compares

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/compare-dark.svg">
  <img alt="What survives a compaction: context-os with Jev removes 91% of tokens, keeps 6 of 6 must-keep results verbatim, keeps all 27 probes recoverable and removes 95% of droppable content; the heuristic 93%, 3 of 6, 27 of 27, 84%; Claude Code's /compact summary 90%, 0 of 6, 14 of 27, 71%; upstream fast-jev 97%, 2 of 6, 3 of 27, 74%." src="docs/img/compare.svg" width="880">
</picture>

Eight adversarial scenarios, 332k tokens in all — a port that only ever
appeared in a `cat .env.example` result, a constraint stated late, an
approach the user rejected, a root cause that looks obsolete, a needle in
pages of log output — each compacted once by every mode. Every scenario
labels the tool results that must survive and plants probes: exact strings
that must still be findable afterwards. The first three columns are exact substring scores; the
last is a Sonnet judge reading the compacted context (the only fair way to
score a summary, and ~6 % noisy). Method and full tables:
[docs/evals.md](docs/evals.md).

- **Same reduction, nothing lost.** `/compact` and context-os both cut the
  context by ~90 %. The summary keeps none of the six must-keeps verbatim and
  loses 13 of 27 probes for good; context-os keeps all six as the original
  bytes and can bring any of the 27 back by id. Asked more loosely, the judge
  finds all six must-keeps *mentioned* in the summary, paraphrased — a
  summary's port number or id is as reliable as the summarizer.
- **Less junk carried.** 29 % of the content labelled droppable is still in
  the summary; 5 % in ours, which is the judge's noise floor.
- **Every summary rewrote everything** (8/8). context-os never rewrites a
  byte: a compacted transcript is still greppable, diffable and quotable.
- **The heuristic is the no-key fallback.** Same reduction, no network; it
  misses three of the six needles that nothing later refers to — the semantic
  call Jev is for — but archives them, so `/context restore` or prompt
  retrieval brings them back.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/latency-dark.svg">
  <img alt="Time per compaction on a log scale: context-os with Jev 528 ms, the heuristic 40 ms, Claude Code's /compact summary 82 s, upstream fast-jev 305 ms." src="docs/img/latency.svg" width="880">
</picture>

A summary is one full-context model call: 82 s per compaction on these
≤ 70k-token cases (50–112 s), and 93–135 s on a real 255–294k-token session.
context-os + Jev took ~0.5 s here including the Jev round trips (the engine
itself is ~47 ms) and 819 ms end-to-end on that same real session
(258k → 49k tokens); the heuristic, 40 ms. Jev bills a few small requests per
compaction — under a cent. On real Claude Code sessions of 100k–330k tokens
context-os removes ~49 % with Jev and ~46 % with the heuristic; how a
summary's recall holds up past 200k tokens is the open question, answered
once a few of those sessions are labelled.

### The upstream project

context-os is a fork of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction),
and the idea it stands on is theirs: instead of asking a frontier model to
rewrite the conversation, ask [Jev](https://typesafe.ai), a small, fast
classifier, one question per tool result — will this be needed again? — and
act on the answers. That is what makes a compaction cost milliseconds and
fractions of a cent, its `compact()` engine still ships here unchanged, and
their issue tracker did much of the calibration work this fork picks up
(threshold sweeps, result previews, the narration-marker bug). On the same
cases their default removes more, 97 %, and with it four of the six
must-keeps and 24 of the 27 probes, because a deleted result is gone. The
difference is the archive, the deterministic protections and a calibrated
threshold; [UPSTREAM.md](UPSTREAM.md) lists everything kept, fixed and
diverged.

## Install in Claude Code

Needs Claude Code 2.1.274 or newer (`claude --version`); function hooks did
not exist before that.

1. Turn on function hooks, and give the plugin a Jev key if you have one
   (leave `TYPESAFE_API_KEY` out to run the local heuristic classifier — no
   network, no key, still verbatim and reversible):

   ```json
   // ~/.claude/settings.json
   { "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "apikey_…" } }
   ```

2. Install at user scope, so every project gets it:

   ```sh
   claude plugin marketplace add MusicStudioNYC/context-os
   claude plugin install context-os@context-os
   ```

3. Start a new session and type `/context`: under Claude Code's own usage
   grid you should see a `context-os` line naming the classifier in use.

Or from a checkout, for one session: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`

Auto-compaction: the plugin asks the host to compact once the live context
holds `compactAtTokens` tokens (default 120,000 — a count, so "big" does not
move when the model's window does; `compactAtPercent` is an optional second
trigger, off by default), and every compaction — yours, Claude Code's own
near the limit, or the plugin's — goes through the same hook, so none of
them summarize. `/context` shows the usage.

Without a `TYPESAFE_API_KEY` the plugin runs the local heuristic classifier —
no network, ~200 ms on a 300k-token transcript. With a key (env var, settings
`env`, or the plugin's `apiKey` option) it uses Jev. `/compact` and
auto-compaction both go through it; the toast reads `context-os kept N/M
messages, archived K units, no summary (…)`, or `fallback to built-in summary
(…)` when it could not remove enough or something failed — in that case the
note still goes into the summarized transcript, since the archive and the
snapshot were written first.

When the classifier keeps *none* of five or more results it scored — either
a wrong threshold or a stretch of the session whose tool output really was
disposable — the plugin does not guess: it asks a model that has read the
conversation (the session's own model over its transcript, cache-shared; a
small model with your turns quoted when that is cold) whether removing them
all is right. "Yes" proceeds, "keep these" re-runs with those kept, and
anything else asks you: remove them (archived, restorable), remove and don't
ask again this session, or use Claude's summary. The log says what was
found, who reviewed it and what was decided.

In a headless session (`claude -p`, the SDK)
the host does not let a plugin start a compaction between turns yet, so the
`compactAtTokens` trigger logs and waits; `/compact` and the host's own
near-limit compaction still run through the hook there.

### `/context`

```
/context                    Claude Code's own usage grid, then: active tokens, archived tokens, constraints found, last compaction
/context list [n]           newest archived records
/context why <id>           the action and every reason behind it
/context show <id>          print the exact archived content
/context restore <id>       put the exact content back in front of the model for this turn
/context retrieve <query>   lexical search over the archive
```

Archive ids appear in the stubs the model sees, e.g.
`[context-os archived e_3f9a…: 8421 more chars of this Read result (file_path=src/a.ts); /context restore e_3f9a… brings it back verbatim, or re-run the tool]`.

### Plugin options

| Option | Default | Description |
| --- | --- | --- |
| `classifier` | `auto` | `auto` = Jev when a key is available, else `heuristic`; or force `jev` / `heuristic` |
| `keepThreshold` | classifier's own | Jev 0.35, heuristic 0.4 (see [docs/evals.md](docs/evals.md)) |
| `questionStyle` | `useful` | Jev wording: `useful` (with criteria) or `upstream` |
| `safetyMargin` | 0 | Scores this far below the threshold still keep |
| `preserveRecentMessages` | 6 | Newest messages never touched |
| `sketches` | true | Show the classifier a tool-aware sketch of each result |
| `redact` | true | Replace keys, tokens and passwords before anything is sent to a classifier |
| `markRemovedCalls` | true | Marker in a message whose tool calls were archived |
| `archiveDir` | `.context-os` | Where the archive and snapshots live, relative to the project |
| `snapshot` | true | Write the exact pre-compaction transcript to `.context-os/snapshots/` |
| `noteRemoved` | true | Insert one message into the compacted transcript saying what was removed and where the snapshot, archive and raw session log are |
| `autoRetrieve` / `retrieveBudgetChars` | true / 6000 | Search the archive before each prompt and hand the model the best exact matches |
| `compactAtTokens` | 120000 | Live context size that triggers auto-compaction (0 = off) |
| `compactAtPercent` | 0 | Optional second trigger as a share of the model window (0 = off) |
| `minReductionRatio` | 0.25 | Below this the built-in summary is used instead |
| `truncateHeadChars` | 300 | Head of a result kept in a stub |
| `maxStateTokens` / `maxRequestTokens` | 25000 / 30000 | Jev state and request budgets |
| `model` / `apiKey` | `jev-latest` / env | TypeSafe model and key |

Add `.context-os/` to the project's `.gitignore`.

## Library

```ts
import { optimize, FileArchive, JevClient, JevClassifier, HeuristicClassifier } from 'fast-jev-compaction';
import { nodeFs } from 'fast-jev-compaction/dist/node/fs.js';

const result = await optimize(messages, {
  sessionId: 'abc',
  archive: new FileArchive(nodeFs, { root: '.context-os' }),
  classifier: process.env.TYPESAFE_API_KEY
    ? new JevClassifier(new JevClient())
    : new HeuristicClassifier(),
});
result.messages;   // the compacted transcript (untouched messages are the same objects)
result.actions;    // one ActionDecision per tool interaction, with reasons and archive ids
result.archived;   // the ArchiveRecords written this time
result.report;     // tokens before/after/archived, action and protection counts, classifier stats
```

`Message` is a subset of Claude Code's `SessionMessage`. The upstream API
(`compact`, `compactMessages`, `fitState`, `batchCalls`, …) is still exported
unchanged. Everything under `src/core`, `src/classifiers`, `src/archive` and
`src/engine` has no Node dependency and runs inside the hook sandbox;
`src/node` holds the transcript loader and the eval runner.

## Evals

```sh
npm run adversarial              # the eight gold scenarios, deterministic
npm run capture -- --limit 20    # your own long sessions from ~/.claude/projects, secrets redacted
npm run eval -- --dataset datasets/v1
```

Every report scores token reduction next to must-keep false drops, probe
retention (active / recoverable from the archive), and transcript validity.
Numbers so far are in [docs/evals.md](docs/evals.md); `npm run charts`
redraws the two figures above from the newest reports.

## Development

```sh
npm install
npm run typecheck        # library + hook sandbox graph
npm test
npm run build
npm run validate:plugin  # needs Claude Code ≥ 2.1.274
```

[docs/architecture.md](docs/architecture.md) describes the layers, the
decision precedence and the storage layout; [UPSTREAM.md](UPSTREAM.md) tracks
the fork.

## Roadmap

Durable memory extraction with provenance and supersession, automatic
retrieval into each turn (`prompt.submit` context), continuous compaction
under a token budget, cache-aware policies, a Codex adapter. The plan is
`docs/plan.md`.
