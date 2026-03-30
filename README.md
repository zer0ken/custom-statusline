# custom-statusline

Custom status line for [Claude Code](https://claude.ai/code).

## Features

- Multi-repo support: shows git status for all `/add-dir` directories
- Per-project block: `PRJ` (name), `WKT` (worktree / count), `BR` (branch, ahead/behind, diff)
- Context usage bar with auto-compact warning
- Plan usage bars (5-hour / 7-day) with reset time
- Org, plan tier, uptime

## Preview

```
PRJ  UplusMobileRag
WKT  main / 1
BR   dev  (+3,-2)

PRJ  ecovector-android
WKT  feat-mmap / 3
BR   feat/mmap  ↑2 (+48,-12)

LLM  Claude Opus 4.6
CTX  [████░░░░░░  42%]
ORG  MyOrg
PLN  team (max 5x)
5H   [██████░░░░  58%] ~2pm
7D   [████░░░░░░  37%]
UP   1h 23m
```

## Install

```bash
# 1. Download
curl -o ~/.claude/statusline.mjs https://raw.githubusercontent.com/zer0ken/custom-statusline/main/statusline.mjs

# 2. Add to ~/.claude/settings.json
```

Add this to your `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline.mjs"
  }
}
```

Requires Node.js 18+.

## License

MIT
