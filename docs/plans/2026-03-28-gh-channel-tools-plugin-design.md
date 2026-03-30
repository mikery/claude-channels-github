# gh-channel-tools Plugin Design

## Overview

A Claude Code plugin that wraps the `claude-gh-channel` MCP server with
convenient commands and orchestration skills.

## Plugin structure

```
gh-channel-tools/
  .claude-plugin/
    plugin.json
  .mcp.json
  commands/
    watch-pr.md
    watch-ci.md
    watch-issues.md
    watch-prs.md
    watches.md
    stop-watch.md
  skills/
    pr-pilot/
      SKILL.md
    issue-pilot/
      SKILL.md
      references/
        agent-prompt.md
```

## .mcp.json

```json
{
  "mcpServers": {
    "gh-channel": {
      "command": "bunx",
      "args": ["claude-gh-channel"],
      "env": { "GH_CHANNEL_USE_GH_AUTH": "1" }
    }
  }
}
```

## Commands

Thin wrappers. Each uses `!`backtick`` inline shell to auto-detect
`owner/repo` from `git remote get-url origin`. Commands tell Claude to call
the corresponding MCP tool with parsed args.

- `/watch-pr <number>` — call `watch_pr`
- `/watch-ci <ref>` — call `watch_ci`
- `/watch-issues [--labels x,y]` — call `watch_issues`
- `/watch-prs [--labels x,y]` — call `watch_prs`
- `/watches` — call `list_watches`
- `/stop-watch <key>` — call `stop_watching`

## pr-pilot skill

Triggered by: "pilot this PR", "shepherd PR #N", "drive this PR to merge".

Instructs Claude to watch a single PR and react to events:

- **review (changes requested)**: read feedback, make fixes, push
- **review (comment)**: assess if actionable, respond if needed
- **ci failure**: investigate, attempt fix, push
- **merge_conflict**: rebase on base branch, push
- **comment**: assess if actionable
- **ready_to_merge**: ask user whether to merge (default). Auto-merge
  if explicitly instructed by issue-pilot.
- **pr_state (merged/closed)**: stop

Actions executed via `gh` CLI, not custom tools.

## issue-pilot skill

Triggered by: "pilot issues on this repo", "dispatch issues labeled X",
"auto-work issues".

Orchestration loop:

1. Call `watch_issues` with label filter
2. Call `watch_prs` on same repo
3. On `new_issue`:
   - Assess if Claude can handle it
   - If yes: create worktree, spawn sub-agent with instructions to fix
     the issue, create a PR (body includes `Closes #N`), and invoke
     pr-pilot for its own PR
   - If no: comment on the issue explaining why
4. On `pr_ready_to_merge` (from watch_prs):
   - If auto-merge enabled: `gh pr merge --squash`
   - If not: ask user
5. On `pr_merged`: clean up worktree
6. On `issue_closed`: stop sub-agent if one is working on it

Sub-agent prompt template lives in `references/agent-prompt.md`.

## Out of scope

- Publishing the plugin to a marketplace (manual install for now)
- Persistent state across sessions
- Multi-repo orchestration
