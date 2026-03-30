# State Machine Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace duplicated poll/lifecycle code with a generic `WatchRunner` that manages lifecycle states, and fix 6 correctness bugs identified by Codex review.

**Architecture:** A `WatchRunner<TState, TSnapshot>` handles the shared lifecycle (idle → polling → paused → stopped), setTimeout-based scheduling, error counting, and rate limit pausing. Each watch type provides: `fetchSnapshot(state)`, `diff(state, snapshot)` returning events to emit, and `seed(state, snapshot)` for initial poll. Bug fixes are integrated into the new architecture rather than patched onto the old one.

**Tech Stack:** Bun, TypeScript, pino, @modelcontextprotocol/sdk, @octokit/rest

---

### Task 1: WatchRunner generic engine

**Files:**
- Modify: `gh-channel.ts`

Create the `WatchRunner` that replaces `setInterval` with `setTimeout`-after-completion:

```typescript
interface WatchDef<TState, TSnapshot> {
  key: string
  pollInterval: number
  fetchSnapshot: (state: TState) => Promise<TSnapshot>
  diff: (state: TState, snapshot: TSnapshot, initial: boolean) => Promise<string[]>
  // diff returns event descriptions; runner calls notify() for each
}
```

Runner manages:
- Lifecycle: `polling | paused | stopped`
- setTimeout scheduling (next poll after current completes)
- consecutiveErrors / MAX_CONSECUTIVE_ERRORS auto-stop
- Rate limit pause/resume (check rateLimitReset timestamp, not remaining count)
- WatchHealth tracking (lastSuccessfulPoll, eventsDelivered)
- notify() calls for events returned by diff()

Commit: "add WatchRunner generic engine"

### Task 2: Migrate watch_ci to WatchRunner

Simplest watch — good proving ground for the runner.

- Define `CIState` and `CISnapshot`
- Implement `fetchSnapshot` (listForRef) and `diff` (terminal state detection)
- Remove old `pollCI`, `CIWatch` interface, `setInterval` setup
- Verify build

Commit: "migrate watch_ci to WatchRunner"

### Task 3: Migrate watch_pr to WatchRunner

Most complex watch. Split into:
- `fetchSnapshot`: pulls.get + pollReviews data + pollComments data + pollChecks data + thread resolution + mergeable state
- `diff`: compare snapshot against previous, emit review/comment/ci/conflict/ready events
- Fix: tri-state thread resolution (unknown = not ready)
- Fix: snapshot-based ready-to-merge (no double-fetch)

Commit: "migrate watch_pr to WatchRunner"

### Task 4: Migrate watch_issues to WatchRunner

- `fetchSnapshot`: listForRepo with label filter
- `diff`: detect new/closed/reopened/labeled/unlabeled
- Fix: re-fetch tracked issues individually for label removal detection
- Fix: closedIssueIds tracking for reopened detection

Commit: "migrate watch_issues to WatchRunner"

### Task 5: Migrate watch_prs to WatchRunner

- `fetchSnapshot`: pulls.list + per-PR ready state
- `diff`: detect new/merged/closed/ready/not-ready
- Fix: compute removals before deleting state
- Fix: uses shared checkPRReady from Task 3's evaluator

Commit: "migrate watch_prs to WatchRunner"

### Task 6: Fix rate limit pause/resume

- Runner checks `Date.now() >= rateLimitReset * 1000` to unpause
- Remove `shouldThrottlePoll()` / `checkRateLimit()` globals
- Rate limit state lives in a shared object the runner reads

Commit: "fix rate limit: pause until reset instead of polling-based check"

### Task 7: Clean up old code and update docs

- Remove dead interfaces, functions, globals
- Update CLAUDE.md
- Update list_watches to use runner health
- Verify build

Commit: "clean up post-refactor, update docs"
