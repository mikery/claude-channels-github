# CI Noise Fix + Repo Watching Design

## CI Noise Fix

### Problem

Every check run state transition (queued → running → success) emits a separate
notification. Ancillary bot checks (e.g., Copilot's Prepare/Agent/Upload/Cleanup)
generate 4+ notifications with no actionable content.

### Solution

`pollChecks` only records and notifies on terminal states (success, failure,
cancelled, skipped, timed_out, neutral). Checks still in `queued` or
`in_progress` are ignored.

- Each check fires at most one notification (when it concludes)
- `ci_complete` fires when all checks reach terminal state (unchanged)
- `initial_status` still reports in-progress checks (snapshot of current state)
- Track seen check names separately from concluded states so `ci_complete`
  knows when all checks are done

## New Tools

### watch_issues(owner, repo, labels?)

Polls `GET /repos/:owner/:repo/issues` with `state=open`, optional `labels`
param, `since` for incremental updates.

**State per watch**:
- `seenIssueIds: Set<number>`
- `issueLabelSnapshots: Map<number, Set<string>>`

**Events**:
- `new_issue` — title, body (truncated), author, labels, assignees
- `issue_labeled` — tracked issue gained a label matching the filter
- `issue_unlabeled` — tracked issue lost matching labels; stop tracking it
- `issue_closed` — stop tracking

**Initial poll**: Seed state, send `initial_status` with count of matching issues.

**Per-issue lifecycle**: Track while labels match filter and issue is open.
Stop tracking on close or label removal. Watch itself runs until `stop_watching`.

### watch_prs(owner, repo, labels?)

Polls `GET /repos/:owner/:repo/pulls` with `state=open`. Label filtering is
client-side (API doesn't support it on pulls endpoint).

**State per PR**:
- `seenPRIds: Set<number>`
- `prReadyState: Map<number, boolean>`

**Ready-to-merge composite**: approved + all checks green + no unresolved
threads + mergeable. Only re-check PRs that changed since last poll to limit
API cost.

**Events**:
- `new_pr` — title, author, branch, labels
- `pr_ready_to_merge` — composite flips to true
- `pr_not_ready` — composite flips back to false, includes reason
- `pr_merged` — stop tracking
- `pr_closed` — stop tracking

**Per-PR lifecycle**: Track while labels match and PR is open. Silently stop
tracking if labels no longer match. Watch runs until `stop_watching`.

**Initial poll**: Seed state, send `initial_status` with open PR count and
how many are ready to merge.

### stop_watching(key)

Stops any active watch by key. Keys:
- `pr:owner/repo#number`
- `ci:owner/repo@ref`
- `issues:owner/repo`
- `prs:owner/repo`

### list_watches()

Returns all active watch keys.

## Configurable Poll Interval

All tools accept an optional `poll_interval` parameter (seconds). Defaults
to 30s. Stored per watch instance.

## Shared Infrastructure

- Add `IssuesWatch` and `PRsWatch` to the `Watch` union type
- `stopWatch` already works generically
- Stay single-file until ~1500 lines

## Implementation Order

1. CI noise fix (terminal-states-only in `pollChecks`)
2. Configurable poll interval
3. `stop_watching` + `list_watches`
4. `watch_issues`
5. `watch_prs`

Each step is independently shippable and testable.

## Out of Scope

- Webhook-based delivery
- Plugin packaging
- Agent definitions (pr-driver.md)
- Debouncing / batching (terminal-states-only fix eliminates the need)
