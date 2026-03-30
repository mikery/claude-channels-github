# CI Noise Fix + Repo Watching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce CI notification noise to terminal-states-only, add configurable poll interval, add `stop_watching`/`list_watches` tools, and add `watch_issues`/`watch_prs` tools for repo-level monitoring.

**Architecture:** All changes in `gh-channel.ts`. New watch types (`IssuesWatch`, `PRsWatch`) follow the same pattern as existing `PRWatch`/`CIWatch`: interface, poll function, state tracking, notify helper. Shared `pollInterval` field on all watch types replaces the global constant.

**Tech Stack:** Bun, TypeScript, `@modelcontextprotocol/sdk`, `@octokit/rest`

---

### Task 1: CI noise fix — terminal states only

**Files:**
- Modify: `gh-channel.ts:472-490` (`pollChecks` function)
- Modify: `gh-channel.ts:47-61` (`PRWatch` and `CIWatch` interfaces)

**Step 1: Add `checkNames` to track all seen check names**

Add a `checkNames: Set<string>` field to both `PRWatch` and `CIWatch` interfaces. This tracks every check name we've ever seen, regardless of whether it has concluded. `checkStates` continues to only hold concluded checks.

```typescript
// In PRWatch interface, after checkStates:
checkNames: Set<string>

// In CIWatch interface, after checkStates:
checkNames: Set<string>
```

Initialize in both state constructors (lines ~183 and ~221):

```typescript
checkNames: new Set(),
```

**Step 2: Modify `pollChecks` to skip non-terminal checks**

Replace the current `pollChecks` loop (lines 478-486):

```typescript
async function pollChecks(state: Watch, ref: string) {
  const { owner, repo } = state

  const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref })
  const checks = data.check_runs

  // Track all check names we've ever seen
  for (const check of checks) state.checkNames.add(check.name)

  // Only record checks that have concluded
  let changed = false
  for (const check of checks) {
    if (!check.conclusion) continue
    if (state.checkStates.get(check.name) !== check.conclusion) {
      log(`check ${check.name}: ${state.checkStates.get(check.name) ?? "(new)"} -> ${check.conclusion}`)
      changed = true
      state.checkStates.set(check.name, check.conclusion)
    }
  }

  if (!changed || !state.initialPollDone) {
    log(`pollChecks skip: changed=${changed} initialPollDone=${state.initialPollDone}`)
    return
  }

  // ... rest of notification building stays the same, but use check.conclusion
  // directly instead of check.conclusion ?? check.status
```

**Step 3: Fix `allCheckStatesTerminal` to use `checkNames`**

The function needs to know if all *known* checks have concluded, not just the ones in `checkStates`. Update the auto-stop logic in `pollPR` (line ~279) and `pollChecks` (line ~545):

```typescript
function allChecksComplete(state: Watch): boolean {
  if (state.checkNames.size === 0) return false
  return state.checkNames.size === state.checkStates.size
}
```

Rename from `allCheckStatesTerminal` to `allChecksComplete` throughout. Remove the old `terminal` set check — if it's in `checkStates`, it already has a conclusion.

**Step 4: Update the notification builder in `pollChecks`**

The summary loop (lines ~497-520) currently reads `check.conclusion ?? check.status`. Since we only notify when checks conclude, iterate over `state.checkStates` instead of `checks`:

```typescript
  const counts = { success: 0, failure: 0, other: 0 }
  const lines: string[] = []

  for (const [name, conclusion] of state.checkStates) {
    let icon: string
    if (conclusion === "success") { icon = "✓"; counts.success++ }
    else if (conclusion === "failure") { icon = "✗"; counts.failure++ }
    else { icon = "?"; counts.other++ }

    let line = `  ${icon} ${name}: ${conclusion}`

    if (conclusion === "failure") {
      // Find the check_run ID for annotations
      const check = checks.find(c => c.name === name)
      if (check) {
        const annotations = await getFailureAnnotations(owner, repo, check.id)
        if (annotations.length > 0) {
          line += "\n" + annotations
            .map((a) => `    ${a.path}:${a.start_line}: ${a.message}`)
            .join("\n")
        }
      }
    }

    lines.push(line)
  }

  // Add count of still-running checks
  const pending = state.checkNames.size - state.checkStates.size
  if (pending > 0) lines.push(`  ⧖ ${pending} check(s) still running`)

  const summary = [
    counts.success > 0 ? `${counts.success} passed` : null,
    counts.failure > 0 ? `${counts.failure} failed` : null,
    pending > 0 ? `${pending} running` : null,
  ].filter(Boolean).join(", ")

  const terminal = state.checkNames.size > 0 && pending === 0
  const eventType = terminal ? "ci_complete" : "ci_update"
```

**Step 5: Test manually**

Create a new PR on `mikery/claude-gh-channel-test` with the failing CI workflow. Watch it. Verify:
- No notifications while checks are queued/in_progress
- One notification when lint concludes (success), mentioning test still running
- One notification when test concludes (failure), with summary
- `ci_complete` fires when both are done

**Step 6: Commit**

```bash
git add gh-channel.ts
git commit -m "CI noise fix: only notify on terminal check states"
```

---

### Task 2: Configurable poll interval

**Files:**
- Modify: `gh-channel.ts:42` (remove global constant)
- Modify: `gh-channel.ts:47-72` (add `pollInterval` to all watch interfaces)
- Modify: `gh-channel.ts:120-155` (add `poll_interval` to tool schemas)
- Modify: `gh-channel.ts:157-230` (use per-watch interval in `setInterval` calls)

**Step 1: Add `pollInterval` to watch interfaces**

Replace `const POLL_INTERVAL_MS = 30_000` with:

```typescript
const DEFAULT_POLL_INTERVAL_MS = 30_000
```

Add `pollInterval: number` to both `PRWatch` and `CIWatch` interfaces.

**Step 2: Add `poll_interval` param to tool schemas**

In `ListToolsRequestSchema` handler, add to both `watch_pr` and `watch_ci` input schemas:

```typescript
poll_interval: {
  type: "number",
  description: "Poll interval in seconds (default: 30)",
},
```

**Step 3: Use `pollInterval` in state initialization**

In `CallToolRequestSchema` handler, read from args and use in `setInterval`:

```typescript
const pollInterval = ((args as any).poll_interval ?? 30) * 1000

const state: PRWatch = {
  // ...existing fields...
  pollInterval,
  timer: setInterval(() => pollPR(state), pollInterval),
}
```

Same for `watch_ci`.

**Step 4: Update tool descriptions**

Change "Polls every 30s" to "Polls every N seconds (default: 30)" in both tool descriptions.

**Step 5: Test manually**

Start a watch with `poll_interval: 5`, verify it polls every 5s in the log.

**Step 6: Commit**

```bash
git add gh-channel.ts
git commit -m "add configurable poll_interval param to all watch tools"
```

---

### Task 3: `stop_watching` and `list_watches` tools

**Files:**
- Modify: `gh-channel.ts` — tool schemas and handler

**Step 1: Add tool schemas**

In `ListToolsRequestSchema` handler, add:

```typescript
{
  name: "stop_watching",
  description: "Stop an active watch. Use list_watches to see active watch keys.",
  inputSchema: {
    type: "object" as const,
    properties: {
      key: {
        type: "string",
        description: 'Watch key (e.g., "pr:owner/repo#1", "ci:owner/repo@ref", "issues:owner/repo", "prs:owner/repo")',
      },
    },
    required: ["key"],
  },
},
{
  name: "list_watches",
  description: "List all active watches and their keys.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
},
```

**Step 2: Add handlers in `CallToolRequestSchema`**

```typescript
if (name === "stop_watching") {
  const { key } = args as { key: string }
  const watch = watches.get(key)
  if (!watch) {
    return { content: [{ type: "text", text: `No active watch with key: ${key}` }] }
  }
  stopWatch(watch)
  return { content: [{ type: "text", text: `Stopped watching: ${key}` }] }
}

if (name === "list_watches") {
  if (watches.size === 0) {
    return { content: [{ type: "text", text: "No active watches." }] }
  }
  const lines = Array.from(watches.keys()).map(k => `- ${k}`)
  return { content: [{ type: "text", text: `Active watches:\n${lines.join("\n")}` }] }
}
```

**Step 3: Test manually**

Start a `watch_pr`, call `list_watches`, call `stop_watching` with the key, verify log shows `stopWatch` and polling stops.

**Step 4: Commit**

```bash
git add gh-channel.ts
git commit -m "add stop_watching and list_watches tools"
```

---

### Task 4: `watch_issues` tool

**Files:**
- Modify: `gh-channel.ts` — new interface, tool schema, handler, poll function

**Step 1: Add `IssuesWatch` interface**

After the `CIWatch` interface:

```typescript
interface IssuesWatch {
  type: "issues"
  owner: string
  repo: string
  labels: string[]
  pollInterval: number
  timer: ReturnType<typeof setInterval>
  seenIssueIds: Set<number>
  issueLabelSnapshots: Map<number, Set<string>>
  lastPollTime: string | null
  initialPollDone: boolean
  consecutiveErrors: number
}
```

Add `IssuesWatch` to the `Watch` union: `type Watch = PRWatch | CIWatch | IssuesWatch`

**Step 2: Add tool schema**

```typescript
{
  name: "watch_issues",
  description:
    "Watch a repository for new issues and label changes. Optionally filter by labels. Long-running — use stop_watching to stop.",
  inputSchema: {
    type: "object" as const,
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Only watch issues with these labels (optional, watches all if omitted)",
      },
      poll_interval: {
        type: "number",
        description: "Poll interval in seconds (default: 30)",
      },
    },
    required: ["owner", "repo"],
  },
},
```

**Step 3: Add handler in `CallToolRequestSchema`**

```typescript
if (name === "watch_issues") {
  const { owner, repo, labels, poll_interval } = args as {
    owner: string
    repo: string
    labels?: string[]
    poll_interval?: number
  }
  const key = `issues:${owner}/${repo}`
  if (watches.has(key)) {
    return { content: [{ type: "text", text: `Already watching issues for ${owner}/${repo}` }] }
  }

  const pollInterval = (poll_interval ?? 30) * 1000
  const state: IssuesWatch = {
    type: "issues",
    owner,
    repo,
    labels: labels ?? [],
    pollInterval,
    timer: setInterval(() => pollIssues(state), pollInterval),
    seenIssueIds: new Set(),
    issueLabelSnapshots: new Map(),
    lastPollTime: null,
    initialPollDone: false,
    consecutiveErrors: 0,
  }
  watches.set(key, state)
  await pollIssues(state)

  const labelDesc = labels?.length ? ` with labels: ${labels.join(", ")}` : ""
  return { content: [{ type: "text", text: `Now watching issues for ${owner}/${repo}${labelDesc}` }] }
}
```

**Step 4: Write `pollIssues` function**

```typescript
async function pollIssues(state: IssuesWatch) {
  const { owner, repo, labels } = state
  log(`pollIssues ${owner}/${repo} initialPollDone=${state.initialPollDone}`)

  try {
    const params: Record<string, any> = {
      owner,
      repo,
      state: "open" as const,
      sort: "updated" as const,
      direction: "desc" as const,
      per_page: 100,
    }
    if (labels.length > 0) params.labels = labels.join(",")
    if (state.lastPollTime) params.since = state.lastPollTime

    const { data: issues } = await octokit.rest.issues.listForRepo(params)

    // Filter out pull requests (GitHub API returns PRs in issues endpoint)
    const realIssues = issues.filter(i => !i.pull_request)

    // Track current matching issue IDs for detecting removals
    const currentIds = new Set(realIssues.map(i => i.number))

    for (const issue of realIssues) {
      const currentLabels = new Set(issue.labels.map(l =>
        typeof l === "string" ? l : l.name ?? ""
      ))

      if (!state.seenIssueIds.has(issue.number)) {
        // New issue
        state.seenIssueIds.add(issue.number)
        state.issueLabelSnapshots.set(issue.number, currentLabels)

        if (state.initialPollDone) {
          await notify(
            `New issue #${issue.number}: ${issue.title}\n` +
            `Author: ${issue.user?.login ?? "unknown"}\n` +
            `Labels: ${[...currentLabels].join(", ") || "none"}\n` +
            (issue.body ? `\n${issue.body.slice(0, 500)}` : ""),
            { event_type: "new_issue", issue: String(issue.number) },
          )
        }
      } else {
        // Existing issue — check for label changes
        const oldLabels = state.issueLabelSnapshots.get(issue.number) ?? new Set()
        const added = [...currentLabels].filter(l => !oldLabels.has(l))
        const removed = [...oldLabels].filter(l => !currentLabels.has(l))

        if (added.length > 0 && state.initialPollDone) {
          await notify(
            `Issue #${issue.number} labeled: ${added.join(", ")}`,
            { event_type: "issue_labeled", issue: String(issue.number) },
          )
        }

        state.issueLabelSnapshots.set(issue.number, currentLabels)

        // If labels no longer match filter, stop tracking
        if (labels.length > 0 && !labels.some(l => currentLabels.has(l))) {
          if (state.initialPollDone) {
            await notify(
              `Issue #${issue.number} no longer matches label filter, stopped tracking.`,
              { event_type: "issue_unlabeled", issue: String(issue.number) },
            )
          }
          state.seenIssueIds.delete(issue.number)
          state.issueLabelSnapshots.delete(issue.number)
        }
      }

      // Check for closed issues
      if (issue.state === "closed") {
        if (state.initialPollDone) {
          await notify(
            `Issue #${issue.number} closed.`,
            { event_type: "issue_closed", issue: String(issue.number) },
          )
        }
        state.seenIssueIds.delete(issue.number)
        state.issueLabelSnapshots.delete(issue.number)
      }
    }

    if (!state.initialPollDone) {
      const count = state.seenIssueIds.size
      const labelDesc = labels.length ? ` matching [${labels.join(", ")}]` : ""
      await notify(
        `Watching issues for ${owner}/${repo}. ${count} open issue(s)${labelDesc}.`,
        { event_type: "initial_status" },
      )
    }

    state.lastPollTime = new Date().toISOString()
    state.initialPollDone = true
    state.consecutiveErrors = 0
  } catch (err) {
    state.consecutiveErrors++
    log(`pollIssues error ${owner}/${repo} (${state.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err)
    if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      await notify(
        `Stopped watching issues for ${owner}/${repo} after ${MAX_CONSECUTIVE_ERRORS} consecutive failures. Last error: ${err instanceof Error ? err.message : String(err)}`,
        { event_type: "error" },
      ).catch(() => {})
      stopWatch(state)
    }
  }
}
```

**Step 5: Update `stopWatch` key generation**

`stopWatch` currently computes keys for `pr` and `ci` types. Add `issues`:

```typescript
function stopWatch(watch: Watch) {
  clearInterval(watch.timer)
  let key: string
  switch (watch.type) {
    case "pr": key = `pr:${watch.owner}/${watch.repo}#${watch.prNumber}`; break
    case "ci": key = `ci:${watch.owner}/${watch.repo}@${watch.ref}`; break
    case "issues": key = `issues:${watch.owner}/${watch.repo}`; break
    case "prs": key = `prs:${watch.owner}/${watch.repo}`; break
  }
  log("stopWatch", key)
  watches.delete(key)
}
```

**Step 6: Add event types to instructions**

Add to the instructions array:

```typescript
"- new_issue: A new issue matching the label filter was opened.",
"",
"- issue_labeled: A tracked issue had labels added.",
"",
"- issue_unlabeled: A tracked issue no longer matches the label filter.",
"",
"- issue_closed: A tracked issue was closed.",
```

**Step 7: Test manually**

In `mikery/claude-gh-channel-test`:
- Start `watch_issues` with label filter `claude-task`
- Create an issue with that label — should get `new_issue`
- Add another label — should get `issue_labeled`
- Remove the `claude-task` label — should get `issue_unlabeled`
- Close the issue — should get `issue_closed`

**Step 8: Commit**

```bash
git add gh-channel.ts
git commit -m "add watch_issues tool for repo-level issue monitoring"
```

---

### Task 5: `watch_prs` tool

**Files:**
- Modify: `gh-channel.ts` — new interface, tool schema, handler, poll function

**Step 1: Add `PRsWatch` interface**

```typescript
interface PRsWatch {
  type: "prs"
  owner: string
  repo: string
  labels: string[]
  pollInterval: number
  timer: ReturnType<typeof setInterval>
  seenPRIds: Set<number>
  prReadyState: Map<number, boolean>
  prHeadShas: Map<number, string>
  initialPollDone: boolean
  consecutiveErrors: number
}
```

Add to `Watch` union: `type Watch = PRWatch | CIWatch | IssuesWatch | PRsWatch`

**Step 2: Add tool schema**

```typescript
{
  name: "watch_prs",
  description:
    "Watch a repository for new pull requests and ready-to-merge state changes. Optionally filter by labels. Long-running — use stop_watching to stop.",
  inputSchema: {
    type: "object" as const,
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Only watch PRs with these labels (optional, watches all if omitted)",
      },
      poll_interval: {
        type: "number",
        description: "Poll interval in seconds (default: 30)",
      },
    },
    required: ["owner", "repo"],
  },
},
```

**Step 3: Add handler**

Same pattern as `watch_issues`. Key is `prs:${owner}/${repo}`. Initialize state, call `pollPRs(state)`.

**Step 4: Write `pollPRs` function**

```typescript
async function pollPRs(state: PRsWatch) {
  const { owner, repo, labels } = state
  log(`pollPRs ${owner}/${repo} initialPollDone=${state.initialPollDone}`)

  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      sort: "created",
      direction: "desc",
      per_page: 100,
    })

    // Client-side label filter
    const matchingPRs = labels.length > 0
      ? prs.filter(pr => pr.labels.some(l => labels.includes(l.name ?? "")))
      : prs

    const currentIds = new Set(matchingPRs.map(pr => pr.number))

    // Detect PRs that disappeared from filter (label removed or closed)
    for (const trackedId of state.seenPRIds) {
      if (!currentIds.has(trackedId)) {
        state.seenPRIds.delete(trackedId)
        state.prReadyState.delete(trackedId)
        state.prHeadShas.delete(trackedId)
        // Silent removal — don't notify
      }
    }

    for (const pr of matchingPRs) {
      if (!state.seenPRIds.has(pr.number)) {
        // New PR
        state.seenPRIds.add(pr.number)
        state.prReadyState.set(pr.number, false)
        state.prHeadShas.set(pr.number, pr.head.sha)

        if (state.initialPollDone) {
          await notify(
            `New PR #${pr.number}: ${pr.title}\n` +
            `Author: ${pr.user?.login ?? "unknown"}\n` +
            `Branch: ${pr.head.ref} → ${pr.base.ref}\n` +
            `Labels: ${pr.labels.map(l => l.name).join(", ") || "none"}`,
            { event_type: "new_pr", pr: String(pr.number) },
          )
        }
      }

      // Check for merged/closed
      if (pr.state !== "open") {
        const event = pr.merged_at ? "pr_merged" : "pr_closed"
        if (state.initialPollDone) {
          await notify(
            `PR #${pr.number} ${event === "pr_merged" ? "merged" : "closed"}.`,
            { event_type: event, pr: String(pr.number) },
          )
        }
        state.seenPRIds.delete(pr.number)
        state.prReadyState.delete(pr.number)
        state.prHeadShas.delete(pr.number)
        continue
      }

      // Ready-to-merge check — only for PRs whose head SHA changed or
      // that we haven't checked yet
      const oldSha = state.prHeadShas.get(pr.number)
      const shaChanged = oldSha !== pr.head.sha
      state.prHeadShas.set(pr.number, pr.head.sha)

      // Always check ready state (reviews/CI can change without new commits)
      const ready = await checkPRReady(owner, repo, pr)
      const wasReady = state.prReadyState.get(pr.number) ?? false

      if (ready && !wasReady && state.initialPollDone) {
        await notify(
          `PR #${pr.number} is ready to merge.\n` +
          `Approved, all checks passed, no unresolved threads, no conflicts.`,
          { event_type: "pr_ready_to_merge", pr: String(pr.number) },
        )
      } else if (!ready && wasReady && state.initialPollDone) {
        const reason = await getNotReadyReason(owner, repo, pr)
        await notify(
          `PR #${pr.number} is no longer ready to merge.\nReason: ${reason}`,
          { event_type: "pr_not_ready", pr: String(pr.number) },
        )
      }
      state.prReadyState.set(pr.number, ready)
    }

    if (!state.initialPollDone) {
      const readyCount = [...state.prReadyState.values()].filter(Boolean).length
      const labelDesc = labels.length ? ` matching [${labels.join(", ")}]` : ""
      await notify(
        `Watching PRs for ${owner}/${repo}. ${state.seenPRIds.size} open PR(s)${labelDesc}, ${readyCount} ready to merge.`,
        { event_type: "initial_status" },
      )
    }

    state.initialPollDone = true
    state.consecutiveErrors = 0
  } catch (err) {
    state.consecutiveErrors++
    log(`pollPRs error ${owner}/${repo} (${state.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err)
    if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      await notify(
        `Stopped watching PRs for ${owner}/${repo} after ${MAX_CONSECUTIVE_ERRORS} consecutive failures. Last error: ${err instanceof Error ? err.message : String(err)}`,
        { event_type: "error" },
      ).catch(() => {})
      stopWatch(state)
    }
  }
}
```

**Step 5: Extract `checkPRReady` and `getNotReadyReason` helpers**

Refactor the ready-to-merge logic from `checkReadyToMerge` (lines ~550-590) into reusable functions:

```typescript
async function checkPRReady(owner: string, repo: string, pr: any): Promise<boolean> {
  if (!pr.mergeable) return false

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner, repo, pull_number: pr.number,
  })
  const latestByReviewer = new Map<string, string>()
  for (const r of reviews) {
    if (r.user?.login && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")) {
      latestByReviewer.set(r.user.login, r.state)
    }
  }
  const reviewStates = Array.from(latestByReviewer.values())
  if (!reviewStates.some(s => s === "APPROVED")) return false
  if (reviewStates.some(s => s === "CHANGES_REQUESTED")) return false

  const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref: pr.head.sha })
  const allGreen = data.check_runs.length > 0 &&
    data.check_runs.every(c => c.conclusion === "success")
  if (!allGreen) return false

  const resolution = await getThreadResolution(owner, repo, pr.number)
  if (resolution) {
    const match = resolution.match(/(\d+) unresolved/)
    if (match?.[1] && parseInt(match[1]) > 0) return false
  }

  return true
}

async function getNotReadyReason(owner: string, repo: string, pr: any): Promise<string> {
  const reasons: string[] = []
  if (!pr.mergeable) reasons.push("merge conflicts")

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner, repo, pull_number: pr.number,
  })
  const latestByReviewer = new Map<string, string>()
  for (const r of reviews) {
    if (r.user?.login && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")) {
      latestByReviewer.set(r.user.login, r.state)
    }
  }
  const states = Array.from(latestByReviewer.values())
  if (!states.some(s => s === "APPROVED")) reasons.push("no approval")
  if (states.some(s => s === "CHANGES_REQUESTED")) reasons.push("changes requested")

  const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref: pr.head.sha })
  if (data.check_runs.some(c => c.conclusion === "failure")) reasons.push("CI failure")
  if (data.check_runs.some(c => !c.conclusion)) reasons.push("CI still running")

  const resolution = await getThreadResolution(owner, repo, pr.number)
  if (resolution) {
    const match = resolution.match(/(\d+) unresolved/)
    if (match?.[1] && parseInt(match[1]) > 0) reasons.push("unresolved threads")
  }

  return reasons.join(", ") || "unknown"
}
```

Also refactor `checkReadyToMerge` in `watch_pr` to use `checkPRReady` to eliminate duplication.

**Step 6: Add event types to instructions**

```typescript
"- new_pr: A new PR matching the label filter was opened.",
"",
"- pr_ready_to_merge: A watched PR is approved, CI green, no conflicts, no unresolved threads.",
"",
"- pr_not_ready: A watched PR was ready but is no longer (includes reason).",
"",
"- pr_merged: A watched PR was merged.",
"",
"- pr_closed: A watched PR was closed without merging.",
```

**Step 7: Update CLAUDE.md**

Add `watch_issues` and `watch_prs` to the "What it does" section.

**Step 8: Test manually**

In `mikery/claude-gh-channel-test`:
- Start `watch_prs`
- Create a new PR — should get `new_pr`
- Push until CI is green + approve — should get `pr_ready_to_merge`
- Push a breaking commit — should get `pr_not_ready` with "CI failure"
- Merge — should get `pr_merged`

**Step 9: Commit**

```bash
git add gh-channel.ts CLAUDE.md
git commit -m "add watch_prs tool for repo-level PR monitoring"
```
