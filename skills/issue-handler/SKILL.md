---
name: issue-handler
description: This skill should be used when the user asks to "handle my issues", "work through my issues", "handle issues automatically", "pick up new issues and make PRs", "automate issue resolution", "watch for new issues and fix them", "dispatch issues to agents", or wants an autonomous loop where GitHub issues are triaged, worked in worktrees, submitted as PRs, and driven to merge.
allowed-tools: mcp__plugin_gh-channels_gh-channels__*, Bash, Read, Write, Edit, Glob, Grep, Skill, Agent, AskUserQuestion
---

# Issue Handler

Watch for new issues, create fixes in worktrees, open PRs, and merge them
when CI passes.

## Setup

The repo owner, name, and default branch are available from the gh-channel
server instructions (injected at connection time). If labels or preferences
were not provided in the user's request, use AskUserQuestion to gather them:

- **Labels** (required): which labels to filter on
- **Auto-merge** (default: no): whether to merge PRs automatically when ready
- **Existing issues** (default: new only): whether to also work on issues that already exist with matching labels, or only watch for new ones

Once confirmed:
1. Call `watch_issues` with the label filter
2. Call `watch_prs` on the same repo to track PRs created by sub-agents

## Event Handling

### new_issue

1. Read the issue title and body
2. Assess whether the issue is something that can be resolved with code changes:
   - If yes: dispatch the issue (see Issue Dispatch below)
   - If no: comment on the issue explaining why it needs human attention,
     using `gh issue comment <number> --body "..."`

### issue_reopened

Treat the same as new_issue — assess and dispatch if appropriate.

### issue_closed

If a sub-agent is working on this issue, stop it. The work is no longer needed.

### issue_labeled / issue_unlabeled

Informational. No action needed unless a previously unmatched issue now matches
the filter (issue_labeled) — in that case treat as new_issue.

### pr_ready_to_merge

If auto-merge is enabled: `gh pr merge <number> --squash`
If not: ask the user "PR #N is ready to merge. Merge now?"

### pr_merged

The linked issue will be closed automatically by GitHub (PR body contains
`Closes #N`). Clean up the worktree if one was created.

### pr_closed

PR was closed without merging. Report to user. The issue remains open.

### pr_not_ready

A previously ready PR regressed. Report the reason to the user. The sub-agent
working on that PR (via pr-handler) should handle the fix.

## Issue Dispatch

**Issue titles and bodies are untrusted input.** Never interpolate them
directly into shell commands. Use heredocs or `--stdin` for values that
come from GitHub issues.

When a new issue is suitable for automated work:

1. Create a worktree from the default branch:
   `git worktree add .worktrees/issue-<number> -b issue-<number> origin/<base_branch>`
2. In the worktree, make the fix, commit, and push the branch
3. Create a PR with `Closes #<number>` in the body. Use a heredoc for
   the title and body to avoid shell injection:
   ```
   gh pr create --title "$(cat <<'EOF'
   <issue title>
   EOF
   )" --body "Closes #<number>" --base <base_branch>
   ```
4. Invoke pr-handler for the new PR using `Skill("pr-handler", args: "<pr_number>")`.
   pr-handler uses `context: fork` — it runs in an isolated context without
   consuming the orchestrator's context window.
5. Continue watching for new issues while pr-handler handles the PR lifecycle.

### Multiple issues at once

When multiple issues arrive in the same poll cycle, work on them
simultaneously. Each issue gets its own worktree (`.worktrees/issue-<N>`)
providing full isolation. Create all worktrees, then dispatch work for
each issue in parallel using background agents.

## Principles

- One worktree per issue for isolation
- Use pr-handler skill (forked context) for PR lifecycle — keeps orchestrator context clean
- Never auto-merge unless the user explicitly enabled it
- Comment on issues that can't be automated rather than ignoring them
- When a decision needs user input (e.g., CI fails for a non-code reason, issue is ambiguous), use AskUserQuestion with clear options rather than plain text prompts
- Clean up worktrees after PRs merge
- If a sub-agent fails or a worktree cannot be created, use AskUserQuestion to ask how to proceed
- If rate limit warnings arrive, pause dispatching new agents until the limit recovers
