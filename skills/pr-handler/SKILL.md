---
name: pr-handler
description: This skill should be used when the user asks to "handle this PR", "drive this PR to merge", "watch and fix this PR", "monitor this PR", "take over this PR", "land this PR", "get this PR merged", "manage PR #123", or wants autonomous PR lifecycle management including responding to reviews, fixing CI failures, resolving merge conflicts, and getting to merge-ready state.
context: fork
allowed-tools: mcp__plugin_gh-channels_gh-channels__*, Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# PR Handler

Watch a PR for events and react to get it merged. Responds to reviews, fixes
CI failures, resolves conflicts, and merges when ready.

## Setup

The PR number is passed as $ARGUMENTS. The repo owner, name, and default
branch are available from the gh-channel server instructions (injected at
connection time).

1. Call the `watch_pr` MCP tool with the owner, repo, and PR number
2. Monitor incoming channel events and react according to the rules below

## Event Handling

### initial_status

Report the current PR state to the user: title, CI status, review status,
merge conflicts. Orient on current state before events arrive.

### review (changes requested)

1. Read each inline comment carefully, noting the file, line, and diff context
2. Assess whether the requested change is correct and reasonable
3. Make the fix in the working tree
4. Run any relevant tests to verify the fix
5. Commit with a message referencing the review feedback
6. Push with `git push`
7. Resolve the review thread if GitHub does not auto-resolve it:
   `gh api graphql` to resolve the thread, or note that pushing often
   auto-resolves. Unresolved threads block ready_to_merge.

### review (comment / approved)

Acknowledge the review. No action needed unless the comment asks a question —
if so, reply with `gh pr review <number> --comment --body "..."`.

### ci_update / ci_complete (failure)

1. Read the failure details from the notification
2. If annotations are included, start there
3. Otherwise fetch full logs with `gh run view <run_id> --log-failed`
4. Diagnose the root cause
5. Make the minimal fix
6. Run the failing test locally to verify
7. Commit and push

### merge_conflict

1. Rebase on the base branch: `git fetch origin && git rebase origin/<base>`
2. Resolve conflicts
3. Run tests to verify nothing broke
4. Force push: `git push --force-with-lease`

### conflict_resolved

Acknowledge. No action needed.

### comment

Read the comment. If it asks for a change or asks a question, address it.
If it's informational, acknowledge.

### ready_to_merge

GitHub has determined the PR meets all branch protection requirements
(required reviews, required checks, etc.) and can be merged.

Ask the user: "PR is ready to merge. Merge now?"

If invoked by the issue-handler skill with auto-merge enabled, merge directly:
`gh pr merge <number> --squash`

### pr_state (merged)

PR is done. Report completion and stop.

### pr_state (closed)

PR was closed without merging. Report and stop.

## Principles

- Make the smallest possible fix for each issue
- Always run tests before pushing
- Never force-push without `--force-with-lease`
- Ask before merging unless explicitly instructed to auto-merge
- If a review comment is unclear or the fix isn't obvious, ask the user rather than guessing
- If a fix introduces new test failures, diagnose and fix before pushing. If the failure is outside the PR's scope, report to the user
- Never merge when CI shows "no checks" — CI may not have started yet. Wait for at least 2 poll cycles. If the repo has `.github/workflows`, CI is expected
- Do not treat "no checks" as equivalent to "all checks passed"
