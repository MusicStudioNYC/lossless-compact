# Handoff Plan: Build a High-Fidelity Context Optimizer for Coding Agents

**Working name:** ContextOS / Semantic Context GC — shipped as **lossless-compact** (renamed 2026-09-20)  
**Audience:** Implementation LLM / senior agentic-systems engineer  
**Date:** 2026-09-19  
**Primary initial target:** Claude Code  
**Secondary targets:** Codex and other coding agents with hookable context/compaction lifecycles

---

## 0. Mission

Build a production-grade context optimization layer for long-running coding-agent sessions that reduces repeated long-context consumption **without destroying important information**.

The product should be materially better than ordinary summarization-based `/compact`.

The core principle is:

> **Keep the smallest sufficient working set, preserve critical information verbatim, and make everything removed recoverable.**

This is not merely a "smart compact" command. The intended end state is a **memory hierarchy / semantic garbage collector for agent context**.

The product should:

1. Preserve important user instructions, constraints, decisions, errors, paths, commands, code facts, and unresolved threads.
2. Remove or truncate stale/redundant tool traffic aggressively.
3. Avoid paraphrasing when exact source material can be retained.
4. Move durable facts/decisions into structured memory.
5. Move bulky evidence into a retrievable archive rather than deleting it forever.
6. Rehydrate exact prior context when it becomes relevant again.
7. Be measurable: token savings, cache behavior, latency, false-prune rate, retrieval success, and downstream task quality must all be benchmarked.
8. Fail safely. If confidence is poor, keep more context rather than deleting aggressively.

The baseline to beat is **`tamaratran/fast-jev-compaction`**:

https://github.com/tamaratran/fast-jev-compaction

It is MIT-licensed and should be treated as the minimum bar for behavior, integration quality, and performance.

---

# 1. Strong recommendation: fork first, then evolve

## Decision

**Start by forking `tamaratran/fast-jev-compaction`, not by rebuilding its current functionality from scratch.**

Reasons:

- It already implements the Claude Code function-hook integration.
- It already pairs `tool_use` ↔ `tool_result`.
- It already has the Jev transport and decision abstraction.
- It already has state fitting, batching, thresholds, reconstruction, fallbacks, tests, and plugin packaging.
- It is MIT licensed.
- It is extremely new and changing rapidly, so starting from its working code gives us a realistic baseline immediately.
- Re-implementing its first-generation capabilities gives us little differentiation.

However:

> Do **not** merely rebrand the fork.

Our roadmap must quickly diverge from "Jev chooses tool calls to drop" into a broader context-management system.

### Fork strategy

Create:

```text
our-org/lossless-compact
```

Preserve upstream attribution and MIT license.

Add upstream remote:

```bash
git remote add upstream https://github.com/tamaratran/fast-jev-compaction.git
```

Track their fixes during the first development phase.

Create a document:

```text
UPSTREAM.md
```

It should record:

- original repository
- original commit SHA we forked
- patches pulled from upstream
- features intentionally diverged
- known upstream bugs that we fixed differently

Do not allow the product to become a permanently shallow fork. The desired architecture should make the original Jev pruner only one policy engine among several.

---

# 2. What the baseline currently does

As of 2026-09-19, `fast-jev-compaction` works roughly as follows:

1. Pairs tool calls and tool results by `tool_use_id`.
2. Pins the first message plus a configurable number of recent messages.
3. Builds a compact representation of the conversation for Jev.
4. Preserves user/assistant text verbatim in the resulting conversation.
5. Scores each old tool interaction with two Jev decisions:
   - should the call remain?
   - should the result remain verbatim?
6. Applies three broad outcomes:
   - **KEEP RESULT**: keep call + result
   - **KEEP CALL**: keep call, truncate result
   - **DROP**: remove call + result
7. Rebuilds a valid message sequence.
8. Falls back to native Claude compaction on Jev errors or insufficient reduction.

Important baseline files/components to study and retain conceptually:

```text
src/
hooks/
tests/
.claude-plugin/
```

Important exported concepts from upstream include:

```text
collectToolCalls
fitState
batchCalls
decideCall
applyDecisions
compact
compactMessages
JevAsker
```

Default upstream settings documented at the time of writing include approximately:

```text
keepThreshold: 0.5
preserveRecentMessages: 6
maxStateTokens: 25,000
maxRequestTokens: 30,000
truncateHeadChars: 300
```

The upstream implementation is a useful baseline, **not proof that the decision policy is correct**.

---

# 3. Known baseline weaknesses we must explicitly address

Before adding features, reproduce and investigate current upstream problems.

There are already active issues / PRs concerning topics such as:

- threshold semantics / probability scale behavior
- request budget calculation
- question wording
- state-fitting removing information that is itself needed to judge relevance
- whether Jev should see previews of tool results
- retries and partial batch salvage
- API key / gateway ergonomics

Do not assume defaults are calibrated correctly.

Also address these architectural limitations:

## 3.1 It only prunes tool traffic

Upstream intentionally does not remove or shorten ordinary user/assistant text in final output.

That means conversational context can still grow indefinitely.

We need a richer model that can safely transform old context into:

- pinned exact context
- structured durable memory
- archived/retrievable exact context
- dropped noise

## 3.2 A binary relevance score is not enough

A message may be:

- currently relevant
- a durable instruction
- a completed fact
- superseded
- recoverable by rerunning a tool
- expensive to recreate
- dangerous to forget
- useful only if a related topic returns
- merely redundant

These should not all collapse to one "keep probability."

## 3.3 Deletion must be reversible

An exact error, old architectural discussion, abandoned implementation, or one-time observation may become relevant later.

If we permanently delete it, a wrong classifier decision is unrecoverable.

The product should instead prefer:

```text
active context
    ↓ evict
archive/index
    ↑ retrieve
```

Think **virtual memory**, not garbage disposal.

## 3.4 The classifier itself has context limits

Do not blindly send the entire 150K–1M token session to Jev.

The system needs hierarchical representations and candidate generation before fine-grained classification.

## 3.5 Prompt-cache behavior matters

Repeatedly rewriting early history may invalidate or reduce cache benefits depending on the host/model.

We must benchmark:

- gross input tokens removed
- cache read/write changes
- actual billed tokens/cost if exposed
- latency
- number of prompt-prefix changes

A context optimizer that reduces nominal context but increases cache churn could be a net loss.

## 3.6 Privacy

A classifier that receives session state may see:

- source code
- shell commands
- file paths
- diffs
- secrets accidentally printed by tools
- proprietary instructions

We need:

- provider abstraction
- redaction layer
- optional zero-data-retention transport
- local policy mode where possible
- clear disclosure
- "never send secrets" filters

There is already an ecosystem fork using OpenRouter ZDR as a transport; study it for ideas:

https://github.com/ingebyd/fast-jev-compaction-openrouter

Do not automatically adopt a third-party privacy claim without independently verifying configuration and provider behavior.

---

# 4. Product thesis

The differentiated product is:

> **Semantic Context GC: an automatic memory hierarchy for coding agents that preserves a high-fidelity working set, externalizes durable knowledge, archives exact history, and retrieves it only when needed.**

We are optimizing for:

```text
minimum active tokens
subject to:
    no meaningful loss in task success
    no forgotten hard constraints
    no broken tool/result structure
    bounded rehydration latency
```

This should eventually work continuously, not only when `/compact` fires.

---

# 5. Memory tiers

Every context item should be assigned to one or more logical tiers.

## Tier A — Pinned working context

Exact, verbatim, always present during the active task.

Examples:

- current user request
- current plan
- explicit constraints
- safety-critical instructions
- latest code state
- unresolved errors
- recent tool outputs
- current file names / symbols being edited

## Tier B — Durable semantic memory

Small structured facts extracted from history.

Examples:

```yaml
constraints:
  - "Do not edit src/generated."
  - "Must preserve backward compatibility with v1 API."

decisions:
  - decision: "Use PostgreSQL advisory locks."
    reason: "Avoid duplicate workers."
    source_refs: [...]

facts:
  - "Auth middleware lives in src/auth/middleware.ts"

open_threads:
  - "Need to add migration rollback test."
```

Important: this tier may summarize **knowledge**, but it must retain provenance back to exact source spans.

## Tier C — Verbatim archive

Exact old messages/tool results stored outside active context.

Should be searchable/retrievable.

Each archived unit needs:

```text
id
session_id
timestamp / sequence
role
tool name if applicable
tool_use_id if applicable
full exact text
token count
semantic metadata
source relationships
hash
```

## Tier D — Reconstructible / rerunnable context

Tool results that can be cheaply reproduced.

Examples:

- directory listings
- file reads for files still unchanged
- grep results
- generated logs

These can be evicted aggressively **if** the system records how to reproduce them and detects invalidation.

## Tier E — Disposable noise

Examples:

- repeated progress updates
- duplicate tool results
- stale searches
- dead-end exploration with no durable learning
- successful no-op confirmations

These can be fully dropped after provenance / metrics are recorded.

---

# 6. Classification taxonomy

Replace the baseline KEEP/TRUNCATE/DROP worldview with an explicit action taxonomy.

Each candidate context unit should receive:

```ts
type ContextAction =
  | "PIN_VERBATIM"
  | "KEEP_VERBATIM"
  | "KEEP_HEAD_TAIL"
  | "EXTRACT_MEMORY_AND_ARCHIVE"
  | "ARCHIVE_ONLY"
  | "REPLACE_WITH_REFERENCE"
  | "RERUN_ON_DEMAND"
  | "DROP_REDUNDANT"
```

Classifier dimensions should include at least:

```text
current_relevance
future_relevance
constraint_importance
exactness_requirement
reconstruction_cost
rerun_cost
superseded_probability
privacy_sensitivity
dependency_count
confidence
```

Do not require Jev to produce all of these if that harms reliability. Several calibrated yes/no questions may work better.

---

# 7. Critical invariant: preserve exact provenance

Every extracted memory must point back to exact archived evidence.

Example:

```json
{
  "kind": "constraint",
  "text": "Never edit src/generated.",
  "source_ids": ["msg_00127"],
  "confidence": 0.998,
  "created_at_sequence": 127
}
```

If the model later needs the original wording:

```text
retrieve(msg_00127)
```

returns it verbatim.

This is essential.

Summaries become indexes, not replacements for reality.

---

# 8. Proposed architecture

```text
┌─────────────────────────────┐
│ Host coding agent           │
│ Claude Code / Codex / etc.  │
└──────────────┬──────────────┘
               │ session events
               ▼
┌─────────────────────────────┐
│ Integration Adapter         │
│ - hooks                     │
│ - transcript normalization  │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ Context Ledger              │
│ canonical event stream      │
└───────┬─────────────┬───────┘
        │             │
        ▼             ▼
┌───────────────┐  ┌────────────────┐
│ Active Window │  │ Verbatim Store │
└───────┬───────┘  └───────┬────────┘
        │                  │
        ▼                  ▼
┌──────────────────────────────────┐
│ Context Policy Engine            │
│ - hard rules                     │
│ - Jev decisions                  │
│ - heuristics                     │
│ - dependency graph               │
│ - token budget                   │
└──────────────┬───────────────────┘
               │
       ┌───────┴─────────┐
       ▼                 ▼
┌───────────────┐  ┌─────────────────┐
│ Memory Store  │  │ Retrieval Index │
│ facts/decisions│ │ semantic + lexical│
└───────────────┘  └────────┬────────┘
                            │
                            ▼
                    ┌─────────────────┐
                    │ Rehydration     │
                    │ manager         │
                    └─────────────────┘
```

---

# 9. Suggested repository layout

Refactor toward:

```text
packages/
  core/
    ledger/
    normalization/
    candidate-selection/
    policies/
    budgeting/
    reconstruction/
    provenance/
    metrics/

  classifiers/
    jev/
    heuristic/
    llm/
    mock/

  memory/
    extraction/
    store/
    index/
    retrieval/

  adapters/
    claude-code/
    codex/
    generic/

  evals/
    datasets/
    replay/
    scorers/
    reports/

apps/
  cli/
  inspector/

tests/
docs/
```

For the first week, do not prematurely perform a huge monorepo rewrite. Get baseline reproducibility first.

---

# 10. Phase 0 — Fork, freeze, benchmark

## Goal

Establish a trustworthy baseline before altering behavior.

### Tasks

1. Fork upstream.
2. Record upstream SHA.
3. Run:
   ```bash
   npm install
   npm run typecheck
   npm test
   npm run build
   npm run validate:plugin
   ```
4. Add deterministic replay support.
5. Capture 10–30 real long sessions.
6. Sanitize secrets.
7. Record:
   - tokens/messages before
   - tokens/messages after
   - which calls were dropped
   - which results were truncated
   - classifier probabilities
   - elapsed compaction time
   - number of Jev requests
   - fallbacks
8. Re-run those same transcripts against vanilla Claude compaction.
9. Add a no-compaction control.

### Exit criteria

We can execute:

```bash
npm run eval -- --dataset datasets/v1
```

and get reproducible comparison reports for:

```text
NO_COMPACTION
CLAUDE_NATIVE_COMPACTION
UPSTREAM_FAST_JEV
OUR_CURRENT_BUILD
```

---

# 11. Phase 1 — Make upstream behavior trustworthy

Before inventing new architecture, make the fork at least as robust as baseline plus outstanding fixes.

## Required work

### A. Threshold calibration

Do not blindly use `0.5`.

Run a labeled eval set.

For each tool interaction, manually/LLM-assisted label:

```text
must_keep
nice_to_keep
safe_to_truncate
safe_to_drop
```

Build precision/recall curves.

The dangerous error is:

```text
false DROP of must_keep
```

Optimize for extremely low false-drop rate.

### B. Better evidence shown to Jev

A classifier cannot know a tool result matters if it only sees:

```text
Read foo.ts → ok, 8421 chars omitted
```

Experiment with result sketches:

- first N chars
- first + last N
- extracted identifiers
- errors/exceptions
- changed files
- tool-specific metadata
- keyword snippets
- hash and size

For code/file reads, extract:

```text
path
symbols
imports
exports
changed lines
diagnostics
```

For shell commands:

```text
command
exit code
stderr summary
files changed
```

### C. Dependency-preserving pruning

If a later assistant message explicitly references information from a tool result, raise its keep weight.

Build a light dependency graph:

```text
message → prior message/tool IDs
```

Use:

- tool IDs
- filenames
- symbols
- command fragments
- error strings
- explicit quotations

### D. Safety fallback

If any of these are true, keep rather than delete:

```text
classifier unavailable
low confidence
malformed answer
dependency ambiguity
unpaired tool structures
active unresolved error
candidate contains explicit user constraint
```

### Exit criteria

Our product must never benchmark worse than upstream on:

- valid transcript reconstruction
- reduction ratio
- runtime
- false-drop rate

---

# 12. Phase 2 — Add reversible archive

This is the first major differentiation.

When a context unit is removed from the live prompt, write it to an exact archive.

Initial implementation can use SQLite.

Suggested schema:

```sql
sessions(
  id,
  created_at,
  host,
  repo_root,
  metadata_json
)

events(
  id,
  session_id,
  seq,
  role,
  kind,
  tool_name,
  tool_use_id,
  content,
  content_hash,
  token_estimate,
  archived_at,
  metadata_json
)

memories(
  id,
  session_id,
  kind,
  text,
  confidence,
  created_seq,
  invalidated_seq,
  metadata_json
)

memory_sources(
  memory_id,
  event_id
)

retrieval_terms(
  event_id,
  lexical_text,
  metadata_json
)
```

Do not delete original events when compressing the active prompt.

### User control

Add commands such as:

```text
/context status
/context inspect
/context archive
/context retrieve <query>
/context restore <id>
/context pin <id>
```

Names can change.

---

# 13. Phase 3 — Durable memory extraction

Create a pass that detects information that should survive even when original conversation is archived.

Start with these categories:

```text
USER_CONSTRAINT
ARCHITECTURE_DECISION
CODEBASE_FACT
KNOWN_FAILURE
OPEN_TASK
RESOLVED_TASK
PREFERENCE_FOR_THIS_PROJECT
IMPORTANT_COMMAND
ENVIRONMENT_FACT
```

Example memory:

```yaml
id: mem_043
kind: ARCHITECTURE_DECISION
text: "Use Redis Streams rather than Pub/Sub because jobs must survive worker restart."
source_ids:
  - msg_883
  - msg_887
status: active
```

### Important

Memory must support invalidation.

If later the user says:

> Actually use Kafka instead.

Do not leave both as equal active facts.

Use:

```text
active
superseded
disputed
```

and link replacement chains.

---

# 14. Phase 4 — Retrieval and rehydration

This is what turns pruning into virtual memory.

Before each model request, inspect:

- current user message
- current plan
- active file paths
- recent tool actions
- errors
- mentioned symbols
- durable memories

Retrieve old exact context likely to matter.

Use hybrid retrieval:

```text
lexical/BM25
+ embeddings
+ metadata filters
+ dependency edges
+ optional Jev reranker
```

Do not start with a complicated vector database. SQLite FTS + embeddings is enough for v1.

### Rehydration budget

Example:

```text
active recent window:   30k
pinned context:          8k
durable memory:          6k
retrieved verbatim:     12k
reserve/output/tools:   remaining
```

Budget should adapt to the host context window.

### Rehydration format

Prefer exact snippets with provenance:

```text
<retrieved_context id="event_481">
[exact historical content]
</retrieved_context>
```

Do not pretend archived material was continuously present.

---

# 15. Phase 5 — Smart continuous compaction

Do not wait until the context is nearly full.

Maintain a target working-set percentage.

Example policy:

```text
< 45% context: no action
45–60%: archive obvious redundant tool output
60–70%: classify stale tool interactions
70–80%: extract durable memory + archive old text
> 80%: aggressive budget rebalance
```

The exact thresholds must be benchmark-driven.

Continuous small evictions may preserve cache prefixes better than periodic massive rewrites. Test this rather than assuming it.

---

# 16. Phase 6 — Tool-aware reconstruction policy

Different tools have different eviction economics.

Examples:

## File read

If the file has not changed since the read:

```text
archive result
record:
  path
  file hash
  line range
```

Can rerun later.

If file changed since the read, the old read may be historically important because rerunning returns different content.

Therefore old result becomes more valuable.

## Grep/search

Usually cheap to rerun.

Store query + scope; archive result aggressively.

## Shell command

If deterministic and harmless, rerunnable.

If destructive / time-dependent / external, preserve result more carefully.

## Test result

Keep failing test names and exact failure signatures in durable memory.

Full logs can usually be archived.

## Web/API response

May not be reproducible.

Weight exact historical result higher.

## User-provided content

Never treat as trivially rerunnable.

Preserve or archive with very conservative policies.

---

# 17. Jev's role

Jev should remain a core fast classifier, but **not the entire intelligence layer**.

Use Jev for narrow calibrated questions such as:

```text
"Is this item required to continue the CURRENT task?"
"Would deleting the exact result risk losing a non-reconstructible fact?"
"Has this item been superseded by later context?"
"Is this item redundant with information already retained?"
"Would this item likely be useful if the current error persists?"
```

Combine with deterministic rules.

Example:

```ts
if (containsExplicitUserConstraint(item)) {
  return PIN_VERBATIM;
}

if (isRecent(item)) {
  return KEEP_VERBATIM;
}

if (isCheaplyRerunnable(item) && !isHistoricallyUnique(item)) {
  return RERUN_ON_DEMAND;
}

const scores = await classifier.score(...);

return policy(scores, dependencies, budget);
```

The product must function in degraded mode if Jev is unavailable.

---

# 18. Candidate-selection hierarchy

Do not classify every token equally.

Use this order:

```text
1. deterministic pinning
2. deterministic redundancy removal
3. cheap rerunnable outputs
4. stale tool-result candidates
5. stale tool calls
6. old assistant progress chatter
7. old conversational text
8. durable facts/decisions
9. explicit user constraints
```

The bottom items are hardest to evict.

---

# 19. Benchmark design

This product lives or dies by evals.

Do not market token reduction alone.

## Primary metrics

### Efficiency

```text
active prompt tokens
cumulative input tokens
cache read tokens
cache write tokens
classifier tokens
classifier cost
host-model cost
latency
compaction runtime
```

### Fidelity

```text
hard-constraint retention rate
exact-error retention rate
file/path retention
decision retention
open-thread retention
false-drop rate
retrieval precision
retrieval recall
rehydration success
```

### Downstream quality

After compaction, ask the coding agent to continue realistic work.

Measure:

```text
task completion rate
tests passed
regressions introduced
unnecessary repeated tool calls
questions re-asked
forgotten constraints
incorrect architectural reversals
```

## Gold-standard adversarial scenarios

Create sessions where one tiny old detail matters much later.

Examples:

1. At turn 20:
   > Never modify `src/generated`.

   At turn 800, task naturally tempts the agent to edit it.

2. An exact port number appears once in a tool result.

3. A flaky-test workaround appears 100K tokens ago.

4. User rejects approach A and chooses approach B.
   Later context contains many references to A.

5. An earlier file read shows content that later changes.
   The historical state becomes relevant to debugging.

6. Two similar API keys / IDs exist and only one is correct.

7. A tool result looks obsolete but contains the root cause of a later failure.

8. Long session contains 100K tokens of harmless logs around a 20-token critical constraint.

The optimizer should excel on these.

---

# 20. Evaluation matrix

Every release should compare:

| Mode | Token reduction | Constraint retention | Task success | Latency | Cache impact |
|---|---:|---:|---:|---:|---:|
| No compaction | baseline | baseline | baseline | baseline | baseline |
| Native Claude compact | measure | measure | measure | measure | measure |
| Upstream fast-jev | measure | measure | measure | measure | measure |
| Our Jev-only mode | measure | measure | measure | measure | measure |
| Our hybrid archive+retrieval | measure | measure | measure | measure | measure |

Do not declare victory from synthetic token counts.

---

# 21. Product UX

The ideal experience is mostly automatic.

### Status

```text
/context
```

Could show:

```text
Active context:       62,418 tokens
Pinned:                8,201
Durable memory:        4,837
Retrieved archive:     7,402
Recent working set:   41,978

Archived this session: 384,202 tokens
Estimated tokens avoided: 1.72M
Rehydrations: 14
Classifier latency p50: 122ms

Protection:
✓ explicit user constraints pinned
✓ unresolved errors pinned
✓ current files pinned
```

### Explainability

For any removed item:

```text
/context why event_481
```

Example response:

```text
Action: ARCHIVE_ONLY

Reasons:
- 0.97 probability not needed for current task
- duplicated by event_512
- result is reproducible by rerunning grep
- no downstream dependency detected

Original content is still stored and can be restored.
```

This builds trust.

---

# 22. Safety properties / hard invariants

Write these as tests.

1. Never produce an orphan `tool_result`.
2. Never reorder surviving messages.
3. Never silently modify verbatim content marked as retained.
4. Never permanently destroy archived content unless the user explicitly purges it.
5. Never evict the current user message.
6. Never evict explicitly pinned content.
7. Default-pin explicit negative constraints:
   ```text
   never
   must not
   do not
   forbidden
   required
   must
   ```
   Use semantics, not regex alone.
8. Never allow classifier failure to corrupt a transcript.
9. Every extracted durable memory must have provenance.
10. Every rehydrated item must correspond to an archive record.
11. If confidence is below safe threshold, keep.
12. Detect transcript schema/version changes and fail open.
13. Secrets detected in content should not be transmitted to external classifier providers unless policy allows it.

---

# 23. Privacy / security plan

Add a redaction stage before remote classification.

Detect common:

```text
API keys
JWTs
private keys
password assignments
AWS credentials
GitHub tokens
database URLs
.env values
```

Classification state can replace them with stable placeholders:

```text
<SECRET_1>
```

Archive remains local.

Make transport configurable:

```text
Jev direct
OpenRouter ZDR
future gateway
local heuristic only
custom classifier
```

Do not log raw remote-classifier payloads by default.

---

# 24. Storage scope and controls

Support:

```text
session-only memory
project memory
global memory
```

Initial release should default to:

```text
session archive
+ project-scoped durable memory
```

Do not automatically turn personal conversational facts into global memory.

For coding tasks, project memory is the useful unit.

---

# 25. Handling codebase changes

A retrieved historical fact may be stale.

Example:

```text
"Auth middleware is src/auth.ts"
```

but file moved.

Memories need freshness metadata:

```text
source_commit
file_hash
observed_at
last_validated_at
```

When retrieving code facts:

- compare current git state where possible
- mark stale evidence
- re-read current file if cheap
- retain historical fact when debugging chronology matters

---

# 26. Host adapters

## Claude Code first

Reuse upstream function-hook integration.

The plugin should support:

```text
manual /compact
automatic compaction
continuous background policy where lifecycle hooks permit
```

Feature-detect hook APIs because they are early / evolving.

## Codex second

Study ports of the upstream idea, but reimplement against our core abstraction rather than copying host-specific logic wholesale.

The core engine should accept a normalized event stream.

```ts
interface NormalizedEvent {
  id: string;
  seq: number;
  role: "user" | "assistant" | "tool";
  kind: string;
  content: string;
  toolName?: string;
  toolUseId?: string;
  metadata: Record<string, unknown>;
}
```

Host-specific adapters translate in/out.

---

# 27. First implementation milestones

## Milestone A — 1 day

- Fork upstream.
- Get all tests green.
- Add upstream remote.
- Add benchmark CLI.
- Add transcript fixture loader.
- Generate first comparison report.

## Milestone B — 2–4 days

- Fix/reconcile upstream threshold/request-budget issues.
- Add richer result preview.
- Add deterministic pinning.
- Add dependency-aware protection.
- Add metrics JSON.

## Milestone C — 4–7 days

- SQLite exact archive.
- Every pruned item archived.
- `/context inspect`, `/context restore`.
- Provenance IDs.

## Milestone D — week 2

- durable memory extraction
- invalidation/supersession
- hybrid lexical/semantic retrieval
- automatic rehydration

## Milestone E — week 3

- continuous token-budget manager
- tool-aware rerun policies
- privacy/redaction layer
- cache-aware optimization

## Milestone F — week 4

- large replay benchmark suite
- A/B trials on real projects
- Codex adapter
- packaged release

These are targets, not promises. Correctness beats schedule.

---

# 28. MVP definition

The MVP is **not** "a Jev compaction plugin."

The MVP is complete when:

1. It works in Claude Code.
2. It matches or beats upstream fast-jev on reduction.
3. It archives every removed item verbatim.
4. It extracts durable constraints/decisions with provenance.
5. It can retrieve and reinsert relevant archived context automatically.
6. It has measurable false-drop / forgotten-constraint evals.
7. Users can inspect why an item was evicted.
8. A classifier outage does not break the session.
9. Sensitive data has a redaction/privacy path.
10. It demonstrates meaningful net context savings on real long sessions.

---

# 29. Stretch features

Do only after the core evals are strong.

### A. Context time-travel

```text
/context snapshot
/context diff snapshot_A snapshot_B
/context restore-state snapshot_A
```

### B. Branch-aware memory

Different git branches should have partially separate code facts.

### C. Shared team memory

Project decisions shared across agents/developers with provenance.

### D. Session merge

Two parallel agents can merge durable findings without merging full transcripts.

### E. Predictive prefetch

Before a tool call, retrieve history related to:

```text
file
symbol
error
test
endpoint
package
```

### F. Local model fallback

Small local classifier for sensitive repositories.

### G. UI inspector

Timeline showing:

```text
green = live
blue = memory
gray = archive
red = dropped redundant
purple = rehydrated
```

---

# 30. Anti-goals

Do **not**:

- merely summarize the whole conversation more aggressively
- permanently delete uncertain context
- optimize only for raw token count
- hide pruning decisions from the user
- require Jev for basic operation
- assume every tool result can be rerun
- treat confidence scores as truth
- overwrite exact user constraints with paraphrases
- build a giant vector-DB platform before evals
- make host-specific code the core architecture
- promise "no quality loss" without benchmarks

---

# 31. Key research questions the implementation LLM must answer experimentally

1. Does Jev outperform a cheap LLM / embeddings / heuristics at context eviction?
2. What threshold achieves near-zero loss of must-keep items?
3. How much result preview does Jev need?
4. Does classification degrade when the state itself is heavily fitted?
5. Is a multi-stage classifier better than one giant state?
6. How often are evicted results later needed?
7. Can retrieval recover them before task quality suffers?
8. What content is safest to rerun versus archive?
9. How much cache cost does context rewriting introduce?
10. Is continuous small pruning cheaper than occasional giant pruning?
11. What percentage of long coding-session tokens are:
    - tool results
    - tool calls
    - assistant chatter
    - user instructions
    - code
12. Which categories produce the highest downstream failure when forgotten?
13. Can durable memory be extracted without introducing false facts?
14. When should the system prefer exact retrieval over a structured memory entry?

Every answer should be backed by replay data.

---

# 32. Success targets

Treat these as hypotheses to test, not marketing claims.

For sessions that would otherwise exceed 150K active tokens:

```text
50–80% reduction in active historical context
< 1% false-drop rate on "must keep" labeled items
> 99.9% retention of explicit user constraints
< 500ms typical policy/classification overhead where Jev is used
near-zero broken transcript structures
retrieval recall high enough that downstream task success is statistically
indistinguishable from uncompressed control
```

The most important result is:

> **task quality per dollar / per token improves**

not merely compression ratio.

---

# 33. Initial TODO checklist for the coding LLM

Start here, in this exact order:

- [ ] Clone/fork `tamaratran/fast-jev-compaction`
- [ ] Read `README.md`, `src/`, `hooks/`, and `tests/`
- [ ] Record exact upstream commit SHA
- [ ] Confirm MIT license and retain attribution
- [ ] Run existing tests/typecheck/build/plugin validation
- [ ] Inspect open upstream issues and PRs before modifying threshold/batching logic
- [ ] Add deterministic transcript replay harness
- [ ] Add machine-readable benchmark report
- [ ] Add baseline modes: native/no-compact/upstream
- [ ] Add richer tool-result sketches for classification
- [ ] Add deterministic "never prune" rules
- [ ] Add dependency-aware protection
- [ ] Create SQLite verbatim archive
- [ ] Archive every evicted item
- [ ] Add stable event IDs and provenance
- [ ] Implement durable memory schema
- [ ] Implement memory invalidation/supersession
- [ ] Implement hybrid retrieval
- [ ] Implement automatic rehydration under a token budget
- [ ] Add privacy redaction before remote classifier calls
- [ ] Add context-inspection CLI/commands
- [ ] Build adversarial eval suite
- [ ] Run real-session A/B benchmarks
- [ ] Only then tune default policies

---

# 34. Definition of "at least as good as fast-jev-compaction"

Do not claim parity until all are true:

- Claude Code install/use is no harder.
- Tool call ↔ result integrity is preserved.
- Recent context is safely pinned.
- Kept content remains verbatim.
- Jev failures have a safe fallback.
- Reduction ratio is at least comparable.
- Runtime is at least comparable.
- Unit tests cover baseline behavior.
- Configurability is not worse.
- We do not regress on transcripts where upstream succeeds.

Then differentiate with:

- reversible archive
- durable memory
- provenance
- automatic retrieval
- invalidation
- tool-aware rerun logic
- cache-aware policies
- explainability
- privacy controls
- cross-agent adapters

---

# 35. External references to inspect

Primary baseline:

- `fast-jev-compaction`  
  https://github.com/tamaratran/fast-jev-compaction

Relevant privacy/transport fork:

- `fast-jev-compaction-openrouter`  
  https://github.com/ingebyd/fast-jev-compaction-openrouter

Jev announcement:

- TypeSafe — Introducing System One Models & Jev  
  https://typesafe.ai/blog/introducing-system-one-models-and-jev

Also inspect upstream GitHub Issues and Pull Requests immediately before coding because this repository is evolving very quickly.

---

# 36. Final direction to the implementation LLM

Do not approach this as "make `/compact` smarter."

Approach it as an operating system problem:

> **The model has scarce fast memory (the active context window), abundant slower memory (verbatim archived history), and compact durable state (structured memory). Your job is to manage movement between those tiers without losing correctness.**

The existing `fast-jev-compaction` project proves a useful first primitive: fast semantic eviction of stale tool traffic.

Use it.

Match it.

Then move beyond it.

The winning product is the layer that lets an agent work for hours or days without hauling its entire transcript through every model call — while still being able to recover the exact thing it learned 500,000 tokens ago when that fact suddenly matters again.
