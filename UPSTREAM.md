# Upstream provenance

This repository is a fork of **tamaratran/fast-jev-compaction** (MIT). It keeps
the upstream code, attribution and license, and evolves it into a broader
context-management layer ("ContextOS / semantic context GC") in which the
original Jev tool-call pruner is one policy engine among several.

| | |
| --- | --- |
| Original repository | https://github.com/tamaratran/fast-jev-compaction |
| Forked at commit | `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0` (2026-09-17, "Merge pull request #17 … readme-tagline") |
| Upstream package version at fork | `0.2.0` (plugin manifest `0.3.0`) |
| Fork date | 2026-09-20 |
| License | MIT — see [LICENSE](LICENSE); upstream copyright retained |
| Git remote | `upstream` → tamaratran/fast-jev-compaction |

Baseline verification at the fork point (2026-09-20, Node 18+, Claude Code CLI 2.1.238):

```
npm install          ok (lockfile drifted trivially: upstream lock still said 0.1.0)
npm run typecheck    ok (library + hook)
npm test             ok — 29 tests, 2 files
npm run build        ok
npm run validate:plugin  FAILS locally: "hooks: Invalid input: expected record, received undefined"
```

The `validate:plugin` failure is not an upstream bug: function hooks
(`hooks.json` with a `modules` list) need Claude Code **2.1.274+**, and the CLI
on this machine is 2.1.238, whose validator still expects the older
record-shaped `hooks`. Re-run after upgrading the CLI.

## Tracking upstream

```sh
git fetch upstream
git log --oneline HEAD..upstream/main      # what we have not pulled yet
git merge upstream/main                    # or cherry-pick individual fixes
```

The upstream source files (`src/*.ts`, `hooks/fast-jev.ts`, `tests/*.test.ts`)
are kept in place and are edited as little as possible so upstream patches keep
merging cleanly. New capabilities live in new directories beside them (see
[docs/architecture.md](docs/architecture.md)).

## Upstream state at fork time (surveyed 2026-09-20)

`main` has not moved since the fork point. 65 issues/PRs exist; 12 merged (all
before the fork), 30 open. The open ones that matter, and what we did:

| Upstream | Finding | Ours |
| --- | --- | --- |
| #26, #52, #56, #55 | `keepThreshold` 0.5 is Jev's "unsure" point, not a midpoint; with the default wording 0/256 results on 16 real sessions ever scored > 0.3 — the baseline is effectively "drop everything non-pinned". #55 measured 0.15 + explicit criteria as workable. | `JevClassifier` defaults to the `useful` wording with criteria and `defaultThreshold` 0.35 (from our cassette sweep: 0/6 false drops up to 0.45, first at 0.50; 0.15 removes only 5 % on real sessions); `upstream` wording kept for A/B. |
| #57, #61 | Showing Jev a result preview raised ranking AUC 0.61→0.71; wording mattered more. | Tool-aware `sketchResult` shown beside the size note (`fitState` takes `sketches`). |
| #65 | `drop_call` removes the `tool_use` but leaves the assistant's narration, so later turns believe work is in context that is not. | `applyActions` appends a marker naming the archived ids to the narrating message. |
| #64 | Tool inputs (credentials) go to Jev unredacted. | `Redactor` runs over every text, input and sketch shown to a classifier. |
| #58 vs #44 | Partial batch failure: salvage vs fail closed. | Salvage: unscored calls are kept, never dropped; the run fails only when no batch succeeded. |
| #29, #30 | Probabilities outside [0,1] and thresholds outside [0,1] drive deletions. | Rejected in `JevClassifier`; threshold clamped in `resolvePolicyOptions`. |
| #31 | Duplicate `tool_use_id` can delete a pinned call. | Protected with rule `ambiguous_structure`. |
| #35, #36 | Auto-compact lock taken after an `await`; a throwing `ui.log` breaks the hook. | Lock before the first `await`; UI calls wrapped. |
| #53 | Zero kept among scored calls reads as "94% reduction" instead of a miscalibrated classifier. | Hook falls back to the built-in summary when ≥ 5 scored results were all evicted. |
| #37 | `npm pack` can ship without `dist/`. | `prepack` builds. |
| #54 | No public path to a TypeSafe key. | The heuristic classifier makes the plugin work with no key at all. |
| #33, #34, #38, #39, #32 | Unbounded concurrency, no request timeout, question headroom, `/compact` instructions ignored, pending calls invisible in state. | **Open** — see the follow-up ledger in the handoff. |

TypeSafe facts that changed defaults: 64k tokens per request, 32k for state +
longest question; 1,200 rpm; input $0.042/MTok, output free; no public
retention/ZDR statement found (the OpenRouter fork's ZDR claim rests on
OpenRouter's `provider: { zdr: true, data_collection: 'deny' }` routing).

## Patches pulled from upstream

_None yet beyond the fork point (upstream has not moved)._

## Features intentionally diverged

- Every eviction is archived verbatim (`src/archive`), with provenance and a
  stub naming the record; upstream deletes.
- Deterministic protections run before the classifier (unresolved errors,
  later references, current files, non-reproducible tools).
- Exact duplicate interactions are removed without asking the classifier.
- The hook registers `/context` and stores the archive under `.context-os/`.
- Plugin renamed `context-os` (manifest and marketplace); the npm package name
  is still `fast-jev-compaction` pending the owner's decision.

## Known upstream bugs fixed differently

- #65 marker instead of keeping the call; #58/#44 salvage instead of either.
