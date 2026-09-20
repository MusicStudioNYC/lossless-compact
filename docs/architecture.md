# Architecture

lossless-compact treats an agent's context window as scarce fast memory, the verbatim
archive as abundant slow memory, and durable memory as compact structured
state. The engine moves context between those tiers without paraphrasing
anything and without making anything unrecoverable.

```
host transcript (Claude Code SessionMessage[])
        │  hooks/lossless-compact.ts  (adapter: in/out mapping, $.fs archive, /context)
        ▼
   Message[]  ──►  buildLedger  ──►  NormalizedEvent[] with stable ids
        │
        ├─ collectToolCalls        (upstream: pairs tool_use ↔ tool_result, pins first + recent)
        ├─ buildDependencyGraph    (later text → earlier result it references)
        ├─ findConstraints         (explicit user instructions; never evicted, feed memory)
        ├─ protectionsFor          (unresolved errors, referenced results, current files, non-reproducible tools)
        ├─ findDuplicates          (identical tool+input+result retained later)
        ├─ Classifier.score        (Jev | ruleset | replay) over a redacted, sketched state
        ├─ decideInteraction       (rules → redundancy → scores → ContextAction, with reasons)
        ├─ applyActions            (rebuild transcript; stubs name archive ids; #65 markers)
        └─ archive.put             (every evicted unit, verbatim, with provenance)
```

## Layers and where they may run

| Directory | Runs in | Notes |
| --- | --- | --- |
| `src/*.ts` (upstream) | anywhere | Kept as-is so upstream patches merge; the Jev pruner is now one classifier. |
| `src/core/` | anywhere | hash, events/ledger, action taxonomy, rules, dependencies, sketches, redaction, policy. **No Node imports.** |
| `src/classifiers/` | anywhere | `Classifier` interface; `jev` (upstream protocol + salvage), `ruleset` (hand-written, deterministic; offline, no model), `replay` (cassettes). |
| `src/archive/` | anywhere | `ArchiveStore` contract, `MemoryArchive`, `FileArchive` over a 4-method `TextFs`. |
| `src/engine/` | anywhere | `optimize()` — the orchestration. |
| `src/node/` | Node only | Claude Code JSONL transcript loader, `nodeFs`, eval runner. The only place `node:*` is imported. |
| `hooks/` | Claude Code hook sandbox | No Node, no `fetch`; only `$` (see `types/claude-code.d.ts`). |

The hook sandbox (Claude Code ≥ 2.1.274 function hooks) has **no Node at
all**: `$.fs` gives whole-file read/write under the project directory capped at
4 MiB per call, `$.store` is a 4 MiB global JSON KV, `$.http.fetch` is the only
network, `$.command.register` adds `/context`, `prompt.submit` can append up to
32k chars of hidden `context` before a turn (the rehydration channel), and
`$.model.fork` runs a cheap completion over the live transcript (the memory
extraction channel). Each hook dispatch has a 10 s budget.

## Core types

- `NormalizedEvent` (`src/core/events.ts`): one text, tool_use or tool_result;
  `id` is `e_<fnv1a64 of kind+toolUseId+content>` so it is stable across
  compactions; `contentHash`, `tokenEstimate`, `messageIndex`.
- `ContextAction` (`src/core/actions.ts`): `PIN_VERBATIM`, `KEEP_VERBATIM`,
  `KEEP_HEAD_TAIL`, `EXTRACT_MEMORY_AND_ARCHIVE`, `ARCHIVE_ONLY`,
  `REPLACE_WITH_REFERENCE`, `RERUN_ON_DEMAND`, `DROP_REDUNDANT`. Every action
  but the first two archives the exact original.
- `ActionDecision`: action + `reasons[]` (shown by `/context why`) +
  `protectedBy[]` + `confidence` + `archiveIds[]`.
- `ArchiveRecord` (`src/archive/types.ts`): the event, its hash and tokens,
  the compaction that evicted it, the action and reasons, `related` links
  (call ↔ result, duplicate_of, referenced_by) and tool metadata (path,
  command, rerun recipe).

## Decision precedence (`src/core/policy.ts`)

1. pinned window (first message, newest `preserveRecentMessages`) → `PIN_VERBATIM`
2. any protection rule → `KEEP_VERBATIM` (`protectedBy` lists the rules):
   `unresolved_error`, `non_reproducible`, `current_file`, `ambiguous_structure`,
   and `referenced_later` for a **strong** reference — a later message quotes
   a line of the result, repeats an error from it, names its tool id, or the
   reference comes from the user
3. exact duplicate (same tool, input and result) retained later → `DROP_REDUNDANT`
4. no scores (classifier absent or failed for this call) → `KEEP_VERBATIM`
5. a **weak** reference (a path or symbol the assistant mentions later) adds
   `softReferenceBoost` (0.2) to `keepResult`, with reason `referenced_weakly`
6. `keepResult ≥ threshold` → `KEEP_VERBATIM`; within `safetyMargin` below → keep
7. `keepCall ≥ threshold` → `RERUN_ON_DEMAND` (rerunnable tool whose target
   was not edited later) or `KEEP_HEAD_TAIL`
8. otherwise → `ARCHIVE_ONLY`

Fail-safe by construction: anything the system is unsure about stays. The
dependency graph indexes anchors found in a result's *content* (paths,
identifiers, error lines, long lines), not the call's input path, so a plain
read-then-edit of the same file is not a reference (re-reading is cheap).

## Rehydration (`src/engine/rehydrate.ts`, hook `prompt.submit`)

Before each prompt the archive is ranked against the prompt text
(`rankRecords`: IDF-weighted terms, compound-identifier matches such as
`postgres` in `POSTGRES_PORT`, light stemming; a rare word the prompt itself
contains, matched exactly or as a compound, is distinctive evidence on its
own). Records scoring ≥ 0.34 are handed to the model as
`<retrieved_context id=… archived=…>` blocks, up to `retrieveBudgetChars`
(6000) per prompt inside the host's 32k hidden-context cap, after a preface
saying the content was not continuously present. Embeddings and a Jev
reranker are the planned next step (plan §14).

## Divergences from upstream (see UPSTREAM.md for the list with reasons)

- Every eviction is archived; stubs name the archive id.
- Removed calls leave a marker in the assistant text that narrated them (#65).
- Secrets are redacted from the classifier state (#64).
- Partial batch failures keep the unscored calls instead of failing (#58-style).
- Threshold clamped to [0, 1]; probabilities validated (#29/#30).
- Duplicate `tool_use_id` protects instead of corrupting (#31).

## Storage layout (FileArchive)

```
<project>/.lossless-compact/archive/<sessionId>/index.json          summaries + shard names
<project>/.lossless-compact/archive/<sessionId>/<compactionId>.json  records (≤ 3.5 MiB per shard)
```

## Evals (`src/node/evals`, `npm run eval`)

Datasets are directories of `transcript.json` (`Message[]`) plus optional
`labels.json` and `cassette.json`. Modes: `NO_COMPACTION`, `UPSTREAM_FAST_JEV`,
`OURS_RULESET`, `OURS_JEV`, `CLAUDE_NATIVE_COMPACTION` (needs a model; opt-in).
Reports are JSON plus a markdown table.
