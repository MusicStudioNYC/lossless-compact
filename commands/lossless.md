---
description: What lossless-compact archived — status, list, why, show, restore, retrieve
argument-hint: "[status|list [n]|why <id>|show <id>|restore <id>|retrieve <query>]"
---
This file only puts `/lossless` in the slash-command menus of hosts that read the
command list once at startup (the VS Code and Cursor extensions). The plugin's
`command.run` hook answers the command itself before this prompt is used.

If you are reading this, the hook did not run. Tell the user that lossless-compact's
hook is not active in this session (function hooks need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
and Claude Code 2.1.274+) and that `.lossless-compact/archive/<session-id>/index.json`
holds every archived record.
