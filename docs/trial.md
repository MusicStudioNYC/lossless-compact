# Try it on your own chats

The numbers in the README come from eight hand-built test cases. This is the
same comparison on your own long Claude Code chats: copies of each chat are
compacted with Claude Code's own `/compact`, with lossless-compact's local
ruleset and with lossless-compact + Jev, then every copy is asked the same
questions about details from the chat. Your chats are only ever read, and
nothing is installed until you say so at the end.

Paste this into a **new** Claude Code chat (the terminal, or the VS Code or
Cursor extension):

```
Run a side-by-side test of lossless-compact (github.com/MusicStudioNYC/lossless-compact) against Claude Code's own /compact, on my own long chats, without touching them. Follow these steps in order, and stop where a step says to ask me.

Ground rules: my original chats are only ever read; every test runs on copies. Nothing in my settings changes unless I choose that at the end. Do the mechanical work with the trial script, never by editing session files yourself. Apply the same rules to every method, and report what you find, including anything lossless-compact does worse.

1. Set up. Check that `claude --version` is 2.1.274 or newer and `node --version` is 18 or newer. If `claude` is not on PATH (some IDE extensions bundle their own), find the CLI binary and pass `--claude <path>` to every trial command, or ask me to install it. Then:
   git clone --depth 1 https://github.com/MusicStudioNYC/lossless-compact ~/.lossless-compact-trial/repo
   (or `git -C ~/.lossless-compact-trial/repo pull` if it is already there)
   cd ~/.lossless-compact-trial/repo && npm ci
   Below, `trial X` means `npx tsx scripts/trial.ts X`, run in that folder.

2. Find candidates. Run `trial candidates`. Show me the list as a short table: number, title, project, size in tokens, last active, and the estimated cost of the whole test. Then ask me, in one message:
   a) Which chats to test. Suggest 3-5: big ones with a lot of tool output, from different projects. Say that each one gets copied three times (Claude's /compact, lossless-compact's local ruleset, lossless-compact + Jev), that the originals are never modified, what it will roughly cost (the "whole test" column) and how long it takes (a few minutes per chat). If the cost is high, offer to run everything on Sonnet instead (`--model sonnet` on select).
   b) Whether I have a Jev (TypeSafe) API key. If I give you one, write it to ~/.lossless-compact-trial/jev-key (chmod 600) and never print it. If I don't, tell me plainly that without it this is not the full three-way comparison with the best version of the plugin, but the free local ruleset is still worth testing, and carry on with two copies per chat.
   If the list is empty or short, run `trial candidates --min-tokens 30000` and tell me.
   Wait for my answer.

3. Copy. `trial select <numbers>`, then `trial clone`. Tell me the copies exist and show up in /resume titled "[trial · …]".

4. Choose what to test, before anything is compacted. Run `trial digest`. For each chat (a subagent per chat if you can, so their contents don't fill this conversation), read its digest, and the original session file wherever the digest isn't enough, and write ~/.lossless-compact-trial/probes/<session-id>.json:
   {"probes": [{"id": "p1", "kind": "tool-only", "question": "…", "answer": "…", "accept": ["…"], "note": "…"}]}
   8 probes per chat (6-10 is fine). `answer` is a short exact string, a few words at most, that appears verbatim in the chat; `accept` optionally lists other exact wordings that count; `question` is what someone picking the work back up would naturally ask, and must not contain the answer. Aim for what a summary tends to drop:
   - at least 3 exact values that appeared only in tool output (a port, version, id, path, line number, count, config value, error code), especially early ones nobody repeated;
   - at least 2 things I said once: an instruction, a constraint, a decision, an approach I rejected;
   - at least 1 exact error message, or the file:line where something was found;
   - 1-2 controls: something central to the chat that any method should keep.
   No secrets or personal data. Pick them for what matters to the work, not for which method you expect to win.
   Run `trial lock`, fix whatever it rejects, then show me two or three of the questions per chat (not the answers).

5. Compact: `trial compact`. One copy of each chat gets Claude's real /compact; the others get lossless-compact, run from the downloaded copy (nothing is installed). Tell me how long it took, and whether lossless-compact handed any chat to Claude's summary (it does when it can't remove at least a quarter of the chat).

6. Test: `trial ask`. Every question goes to its own fork of every compacted copy, in the same words, with tools switched off.

7. Grade: `trial grade` grades the clear cases and writes ~/.lossless-compact-trial/grading.json with the rest, shuffled, without saying which copy answered. Grade each one there yourself, as its instructions say, the same way for all. Don't open grading-key.json. Then run `trial report`.

8. Show me the results. Open ~/.lossless-compact-trial/report.html in my browser (open, xdg-open or start). In the chat, give me:
   - the table `trial report` printed;
   - the 2-3 most telling examples, quoted exactly: the question, what the chat actually said, Claude's /compact answer and lossless-compact's answer;
   - anything lossless-compact did worse, and how much context each method left (a summary is smaller; lossless-compact keeps the original text);
   - time and cost of compacting: Claude's /compact as measured, what it would cost on a chat that's still cached versus one an hour old, and lossless-compact's;
   - how to check it myself: the two `claude --resume …` commands for one chat from the report (or pick the "[trial · …]" chats in /resume), so I can ask both copies the same question.

9. Ask me what to do next:
   a) Remove everything: `trial cleanup` (deletes every copy, fork and archive the trial made, and confirms my originals are unchanged), then delete ~/.lossless-compact-trial, offering to keep report.html first.
   b) Install lossless-compact properly, with auto-compaction: run `trial cleanup`; merge "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" (and "TYPESAFE_API_KEY" if I gave a key) into the "env" block of ~/.claude/settings.json without touching anything else; run `claude plugin marketplace add MusicStudioNYC/lossless-compact` and `claude plugin install lossless-compact@lossless-compact`; tell me it then handles every /compact and Claude Code's own auto-compaction, compacts on its own once a chat's context reaches 120,000 tokens (`compactAtTokens` under pluginConfigs["lossless-compact@lossless-compact"].options in the same file changes that), and to open a new chat and type /lossless to check it's active; finally delete ~/.lossless-compact-trial, offering to keep report.html.
   c) Keep the copies for now so I can try them; I'll ask you to clean up later.
```

## What it does

| Step | Command | What happens |
| --- | --- | --- |
| Find | `candidates` | Lists the newest chats under `~/.claude/projects` that are at least 50k tokens and were never compacted, with their model, how much of each is tool output, and what the test would cost |
| Copy | `select`, `clone` | Copies each chosen chat once per method, next to the original so `claude --resume` finds it: the original's bytes, only its session id renamed, titled `[trial · …]` |
| Choose | `digest`, `lock` | Writes a readable digest per chat with leads (values that only appeared in tool output, error lines, the user's instructions); Claude picks the details to test; `lock` checks each one is in the chat verbatim and freezes them (sha256) before anything is compacted |
| Compact | `compact` | `/compact` on every copy: Claude Code's own summary on one, the plugin on the others, loaded from the checkout with `--plugin-dir` and its options passed per run with `--settings`. An installed copy of the plugin is switched off for every run |
| Test | `ask` | Every question to its own fork of every compacted copy, same words, same model, tools off; the plugin's automatic retrieval stays on, as in normal use |
| Grade | `grade` | Answers that contain the exact detail, or that only say they don't know, are graded mechanically; the rest go to a shuffled sheet that doesn't say which copy answered |
| Show | `report` | `report.html`, `results.json` and a summary table |
| Undo | `cleanup` | Deletes every copy and fork (and their folders under `~/.claude`), the archives and logs, and checks each original's bytes against the hash taken when it was chosen |

Everything else lives in `~/.lossless-compact-trial` (`--dir` or
`LOSSLESS_TRIAL_DIR` to move it). lossless-compact's archives for the copies
go there too, not into your projects.

The report scores each method on:

- **Tokens removed**: Claude Code's own before/after count for the compaction.
- **Details still in context**: the exact string is in what the compacted chat starts from.
- **Details recoverable**: in context, or in the archive the compacted chat names. A summary has no archive.
- **Questions answered right**: graded as above. Wrong answers stated as fact are counted separately from "I don't know".
- **Time and cost per compaction**: Claude Code's own duration and cost counter (API list prices; on a Pro or Max plan it counts against usage limits). For Claude's `/compact` it also works out what the same call costs on a chat that is still in the prompt cache (used within the last hour, or five minutes on some setups) and on a cold one.

## What to expect

- On these chats the ruleset and Jev usually remove less than a summary: lossless-compact keeps recent and still-relevant tool output as the original text, where a summary rewrites everything into a few thousand tokens (about 50 % vs 90 %+ on real chats so far). The report shows both, and how big each copy's context was when it answered.
- Claude's `/compact` is one call that reads the whole chat and writes a summary: tens of seconds to a few minutes, and on a chat that has gone cold, the full input price. Measured on Claude Code 2.1.305, a `/compact` of a 225k-token chat read 223k tokens from cache when the chat had been used 13 minutes earlier, and cost four times as much cold.
- With no Jev key the trial runs two copies per chat (Claude's `/compact` and the ruleset). The ruleset misses some details that nothing later in the chat refers to; it archives them, so they count as recoverable, and retrieval often brings them back when asked.
- A few chats with eight questions each is a small sample, and a model's answers vary from one run to the next: two runs over the same two chats gave Claude's `/compact` copies 11 of 16 both times and the ruleset copies 14 and then 11. Small models hedge more ("I don't know… the only mention is PR #482"), which is what the "partly" grade is for. Read the quoted examples, not just the totals.
- Copies titled `[trial · …]` show up in `/resume` until `cleanup` removes them. Each is a normal session: open the `/compact` copy and a lossless-compact copy side by side and ask both the same thing.

## Running it by hand

```sh
git clone --depth 1 https://github.com/MusicStudioNYC/lossless-compact ~/.lossless-compact-trial/repo
cd ~/.lossless-compact-trial/repo && npm ci
npm run trial -- candidates
npm run trial -- select 1 3 4          # --model sonnet to run everything on Sonnet, --no-jev to skip Jev
npm run trial -- clone
npm run trial -- digest                # then write probes/<session-id>.json for each chat
npm run trial -- lock
npm run trial -- compact               # --parallel 3
npm run trial -- ask                   # --parallel 4
npm run trial -- grade                 # then grade the items left in grading.json
npm run trial -- report
npm run trial -- cleanup
```

A Jev key is read from `TYPESAFE_API_KEY`, `~/.lossless-compact-trial/jev-key`
or the `env` block of `~/.claude/settings.json`, and only passed to the Jev
runs.
