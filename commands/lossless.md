---
description: What lossless-compact archived — status, list, why, show, restore, retrieve
argument-hint: "[status|list [n]|why <id>|show <id>|restore <id>|retrieve <query>]"
---
/lossless $ARGUMENTS

This entry puts `/lossless` in the slash-command menu of hosts that list
commands once at startup (the VS Code and Cursor extensions). Picking it runs
this prompt through the model; when the plugin's hook is active, its
`skill.prompt` hook replaces this text with the command's answer before the
model reads it. Typing `/lossless` in full runs the command directly instead,
with no model turn.

If you are reading this, the hook did not run. Tell the user that lossless-compact's
hook is not active in this session (function hooks need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
and Claude Code 2.1.274+) and that `.lossless-compact/archive/<session-id>/index.json`
holds every archived record.
