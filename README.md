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
cannot mistake narration for work still in context). Tool call ↔ result
structure is always preserved. If the classifier fails or is unsure, content
stays.

## Install in Claude Code

```json
// ~/.claude/settings.json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

```sh
claude plugin marketplace add <your-github-user>/context-os
claude plugin install context-os@context-os
```

Or from a checkout: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`

Without a `TYPESAFE_API_KEY` the plugin runs the local heuristic classifier —
no network, ~200 ms on a 300k-token transcript. With a key (env var, settings
`env`, or the plugin's `apiKey` option) it uses Jev. `/compact` and
auto-compaction (at `compactAtPercent`, default 60 %) both go through it; the
toast reads `context-os kept N/M messages, archived K units, no summary (…)`,
or `fallback to built-in summary (…)` when it could not remove enough or
something failed.

### `/context`

```
/context                    status: active tokens, archived tokens, constraints found, last compaction
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
| `keepThreshold` | classifier's own | Jev 0.15, heuristic 0.4 (see [docs/evals.md](docs/evals.md)) |
| `questionStyle` | `useful` | Jev wording: `useful` (with criteria) or `upstream` |
| `safetyMargin` | 0 | Scores this far below the threshold still keep |
| `preserveRecentMessages` | 6 | Newest messages never touched |
| `sketches` | true | Show the classifier a tool-aware sketch of each result |
| `redact` | true | Replace keys, tokens and passwords before anything is sent to a classifier |
| `markRemovedCalls` | true | Marker in a message whose tool calls were archived |
| `archiveDir` | `.context-os` | Where the archive lives, relative to the project |
| `compactAtPercent` | 60 | Context usage that triggers auto-compaction |
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
Numbers so far are in [docs/evals.md](docs/evals.md).

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
