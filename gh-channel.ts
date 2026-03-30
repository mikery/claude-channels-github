#!/usr/bin/env bun

declare const BUILD_VERSION: string | undefined

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Octokit } from "@octokit/rest"
import pino from "pino"

// --- CLI (check before initializing logger) ---

const _subcommand = process.argv[2]

function printHelp() {
  process.stderr.write(`claude-channels-github ${BUILD_VERSION ?? "dev"} — MCP channel server for GitHub events\n\n`)
  process.stderr.write("Usage:\n")
  process.stderr.write("  claude-channels-github server    Run the MCP server\n")
  process.stderr.write("  claude-channels-github --help    Show this help\n")
}

if (!_subcommand || _subcommand === "--help" || _subcommand === "-h") {
  printHelp()
  process.exit(0)
}

if (_subcommand !== "server") {
  process.stderr.write(`Unknown command: ${_subcommand}\n\n`)
  printHelp()
  process.exit(1)
}

// --- Logging (stderr + file, since stdout is MCP transport) ---

const logLevel = process.env.GH_CHANNEL_LOG_LEVEL ?? "info"
const logFile = pino.destination(process.env.GH_CHANNEL_LOG ?? "/tmp/gh-channel.log")
const log = pino(
  { level: logLevel },
  pino.multistream([
    { stream: pino.destination(2), level: logLevel },
    { stream: logFile, level: logLevel },
  ]),
)

// --- Auth ---

function createOctokit(): Octokit {
  const token = process.env.GITHUB_TOKEN
  if (token) {
    log.info("auth: using GITHUB_TOKEN")
    return new Octokit({ auth: token })
  }

  if (process.env.GH_CHANNEL_USE_GH_AUTH === "true" || process.env.GH_CHANNEL_USE_GH_AUTH === "1") {
    const result = Bun.spawnSync(["gh", "auth", "token"])
    const out = result.stdout.toString().trim()
    if (!out) throw new Error("gh auth token returned empty — is gh authenticated?")
    log.info("auth: using gh CLI token")
    return new Octokit({ auth: out })
  }

  throw new Error(
    "No GitHub auth configured. Set GITHUB_TOKEN or GH_CHANNEL_USE_GH_AUTH=1 (requires gh CLI)."
  )
}

let _octokit: Octokit | null = null
function octokit(): Octokit {
  if (!_octokit) {
    _octokit = createOctokit()
    function parseRateLimitHeaders(headers: any) {
      if (headers?.["x-ratelimit-remaining"] != null) {
        rateLimitRemaining = parseInt(headers["x-ratelimit-remaining"], 10)
        rateLimitReset = parseInt(headers["x-ratelimit-reset"] ?? "0", 10)
      }
    }
    _octokit.hook.after("request", async (_response) => {
      parseRateLimitHeaders((_response as any).headers)
    })
    _octokit.hook.error("request", async (error) => {
      const headers = (error as any).response?.headers
      parseRateLimitHeaders(headers)
      throw error
    })
  }
  return _octokit
}
const DEFAULT_POLL_INTERVAL_MS = 30_000

// --- Repo detection (at startup, from cwd) ---

function detectRepo(): { owner: string; repo: string; defaultBranch: string } | null {
  try {
    const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"]).stdout.toString().trim()
    if (!remote) return null
    const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
    if (!match) return null
    const [, owner, repo] = match

    const branchResult = Bun.spawnSync(["git", "symbolic-ref", "refs/remotes/origin/HEAD"])
    const branchOut = branchResult.stdout.toString().trim()
    const defaultBranch = branchOut.replace("refs/remotes/origin/", "") || "main"

    return { owner, repo, defaultBranch }
  } catch {
    return null
  }
}

const detectedRepo = detectRepo()
const MAX_CONSECUTIVE_ERRORS = 5
const RATE_LIMIT_WARN_THRESHOLD = 100
const RATE_LIMIT_PAUSE_THRESHOLD = 20

// --- Rate limit tracking ---

let rateLimitRemaining = Infinity
let rateLimitReset = 0
let rateLimitWarned = false


// --- Watch Runner ---

interface WatchEvent {
  content: string
  meta: Record<string, string>
}

interface PollResult {
  events: WatchEvent[]
  stop?: boolean
}

interface WatchDef<TState> {
  createState: () => TState
  poll: (state: TState, initial: boolean) => Promise<PollResult>
}

interface RunnerHandle {
  key: string
  pollInterval: number
  status: "polling" | "paused" | "stopped"
  health: {
    lastSuccessfulPoll: string | null
    consecutiveErrors: number
    eventsDelivered: number
  }
  stop: () => void
}

const runners = new Map<string, RunnerHandle>()

function startWatch<TState>(
  key: string,
  def: WatchDef<TState>,
  pollInterval: number,
): RunnerHandle {
  const state = def.createState()
  const handle: RunnerHandle = {
    key,
    pollInterval,
    status: "polling",
    health: {
      lastSuccessfulPoll: null,
      consecutiveErrors: 0,
      eventsDelivered: 0,
    },
    stop: () => {
      handle.status = "stopped"
      log.info({ key }, "stopWatch")
      runners.delete(key)
    },
  }
  runners.set(key, handle)

  async function emitRateLimitWarning() {
    if (rateLimitRemaining <= RATE_LIMIT_WARN_THRESHOLD && !rateLimitWarned) {
      rateLimitWarned = true
      const resetTime = new Date(rateLimitReset * 1000).toISOString().slice(11, 19)
      await emit({
        content: `GitHub API rate limit low: ${rateLimitRemaining} requests remaining. Resets at ${resetTime} UTC.`,
        meta: { event_type: "rate_limit_warning" },
      })
      log.warn({ remaining: rateLimitRemaining, reset: rateLimitReset }, "rate limit low")
    }
    if (rateLimitRemaining > RATE_LIMIT_WARN_THRESHOLD) {
      rateLimitWarned = false
    }
  }

  async function emit(event: WatchEvent) {
    log.info({ event_type: event.meta.event_type, content: event.content.slice(0, 120) }, "notify")
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("notification timed out")), 30_000),
    )
    await Promise.race([
      mcp.notification({
        method: "notifications/claude/channel",
        params: { content: event.content, meta: event.meta },
      }),
      timeout,
    ])
    handle.health.eventsDelivered++
  }

  async function tick() {
    try {
    if (handle.status === "stopped") return

    // Rate limit pause: wait until reset time, then allow a request to refresh the counter
    if (rateLimitRemaining <= RATE_LIMIT_PAUSE_THRESHOLD) {
      const resumeAt = rateLimitReset * 1000
      if (Date.now() < resumeAt) {
        const waitMs = resumeAt - Date.now() + 1000
        handle.status = "paused"
        log.info({ key, waitMs }, "paused for rate limit")
        await emitRateLimitWarning()
        setTimeout(tick, waitMs)
        return
      }
      // Reset time has passed — allow a request through to refresh the counter
      rateLimitRemaining = RATE_LIMIT_PAUSE_THRESHOLD + 1
    }
    handle.status = "polling"

    const initial = handle.health.lastSuccessfulPoll === null

    try {
      const result = await def.poll(state, initial)
      for (const event of result.events) await emit(event)
      handle.health.consecutiveErrors = 0
      handle.health.lastSuccessfulPoll = new Date().toISOString()
      await emitRateLimitWarning()
      if (result.stop) { handle.stop(); return }
    } catch (err) {
      handle.health.consecutiveErrors++
      log.error({ key, errors: handle.health.consecutiveErrors, err }, "poll error")
      if (handle.health.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        try {
          await emit({
            content: `Stopped watching ${key} after ${MAX_CONSECUTIVE_ERRORS} consecutive failures. Last error: ${err instanceof Error ? err.message : String(err)}`,
            meta: { event_type: "error" },
          })
        } catch {}
        handle.stop()
        return
      }
    }

    if (handle.status !== "stopped") {
      setTimeout(tick, handle.pollInterval)
    }
    } catch (fatal) {
      log.error({ key, err: fatal }, "tick crashed — rescheduling")
      if (handle.status !== "stopped") {
        setTimeout(tick, handle.pollInterval)
      }
    }
  }

  tick()
  return handle
}

// --- GitHub helpers ---

async function getFailureAnnotations(
  owner: string,
  repo: string,
  checkRunId: number,
): Promise<Array<{ path: string; start_line: number; message: string }>> {
  try {
    const { data } = await octokit().rest.checks.listAnnotations({
      owner, repo, check_run_id: checkRunId,
    })
    return data
      .filter((a) => a.annotation_level === "failure" || a.annotation_level === "warning")
      .slice(0, 5)
      .map((a) => ({ path: a.path, start_line: a.start_line, message: a.message ?? "" }))
  } catch {
    return []
  }
}

interface ThreadResolution {
  status: "known" | "unknown"
  resolved: number
  unresolved: number
}

async function getThreadResolution(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ThreadResolution> {
  try {
    const result = await octokit().graphql<{
      repository: {
        pullRequest: {
          reviewThreads: { nodes: Array<{ isResolved: boolean }> }
        }
      }
    }>(
      `query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes { isResolved }
            }
          }
        }
      }`,
      { owner, repo, pr: prNumber },
    )
    const threads = result.repository.pullRequest.reviewThreads.nodes
    const resolved = threads.filter((t) => t.isResolved).length
    return { status: "known", resolved, unresolved: threads.length - resolved }
  } catch {
    return { status: "unknown", resolved: 0, unresolved: 0 }
  }
}

function formatThreadResolution(tr: ThreadResolution): string | null {
  if (tr.status === "unknown") return "Review threads: unable to determine (GraphQL error)"
  if (tr.resolved === 0 && tr.unresolved === 0) return null
  return `Review threads: ${tr.resolved} resolved, ${tr.unresolved} unresolved`
}

function formatReviewState(state: string): string {
  const map: Record<string, string> = {
    APPROVED: "Approved",
    CHANGES_REQUESTED: "Changes Requested",
    COMMENTED: "Commented",
    DISMISSED: "Dismissed",
  }
  return map[state] ?? state
}

interface ReadyResult {
  ready: boolean
  state: string
}

async function evaluateReadiness(owner: string, repo: string, pr: any): Promise<ReadyResult> {
  // The pulls.list endpoint doesn't include mergeable_state — fetch individually
  const { data: fullPR } = pr.mergeable_state !== undefined
    ? { data: pr }
    : await octokit().rest.pulls.get({ owner, repo, pull_number: pr.number })
  const state = fullPR.mergeable_state ?? "unknown"
  return { ready: state === "clean", state }
}

// --- CI summary builder ---

async function buildCISummary(
  checkNames: Set<string>,
  checkStates: Map<string, string>,
  checkRuns: Array<{ name: string; id: number; conclusion: string | null }>,
  owner: string,
  repo: string,
  ref: string,
  prLabel = "",
): Promise<WatchEvent> {
  const counts = { success: 0, failure: 0, other: 0 }
  const lines: string[] = []

  for (const [name, conclusion] of checkStates) {
    let icon: string
    if (conclusion === "success") { icon = "✓"; counts.success++ }
    else if (conclusion === "failure") { icon = "✗"; counts.failure++ }
    else { icon = "?"; counts.other++ }

    let line = `  ${icon} ${name}: ${conclusion}`
    if (conclusion === "failure") {
      const check = checkRuns.find(c => c.name === name)
      if (check) {
        const annotations = await getFailureAnnotations(owner, repo, check.id)
        if (annotations.length > 0) {
          line += "\n" + annotations.map(a => `    ${a.path}:${a.start_line}: ${a.message}`).join("\n")
        }
      }
    }
    lines.push(line)
  }

  const pending = checkNames.size - checkStates.size
  if (pending > 0) lines.push(`  ⧖ ${pending} check(s) still running`)

  const summary = [
    counts.success > 0 ? `${counts.success} passed` : null,
    counts.failure > 0 ? `${counts.failure} failed` : null,
    pending > 0 ? `${pending} running` : null,
  ].filter(Boolean).join(", ")

  const refShort = ref.length > 7 ? ref.slice(0, 7) : ref
  const terminal = checkNames.size > 0 && pending === 0
  const eventType = terminal ? "ci_complete" : "ci_update"

  let content = `CI status for ${owner}/${repo}${prLabel} (${refShort}):\n`
  content += lines.join("\n")
  content += `\n\nSummary: ${summary}`

  return { content, meta: { event_type: eventType, ref } }
}

// --- watch_ci ---

interface CIState {
  checkNames: Set<string>
  checkStates: Map<string, string>
}

function ciWatchDef(owner: string, repo: string, ref: string): WatchDef<CIState> {
  return {
    createState: () => ({ checkNames: new Set(), checkStates: new Map() }),
    poll: async (state, initial) => {
      const { data } = await octokit().rest.checks.listForRef({ owner, repo, ref, per_page: 100 })
      for (const check of data.check_runs) state.checkNames.add(check.name)

      let changed = false
      for (const check of data.check_runs) {
        if (!check.conclusion) continue
        if (state.checkStates.get(check.name) !== check.conclusion) {
          changed = true
          state.checkStates.set(check.name, check.conclusion)
        }
      }

      const terminal = state.checkNames.size > 0 && state.checkNames.size === state.checkStates.size

      if (initial) {
        if (state.checkNames.size > 0) {
          const lines: string[] = [`CI status for ${owner}/${repo}@${ref}:`]
          for (const [name, status] of state.checkStates) {
            const icon = status === "success" ? "✓" : status === "failure" ? "✗" : "?"
            lines.push(`  ${icon} ${name}: ${status}`)
          }
          const pending = state.checkNames.size - state.checkStates.size
          if (pending > 0) lines.push(`  ⧖ ${pending} check(s) still running`)
          return { events: [{ content: lines.join("\n"), meta: { event_type: "initial_status", ref } }], stop: terminal }
        }
        return { events: [] }
      }

      if (!changed) return { events: [], stop: terminal }
      return { events: [await buildCISummary(state.checkNames, state.checkStates, data.check_runs, owner, repo, ref)], stop: terminal }
    },
  }
}

// --- watch_pr ---

interface PRState {
  seenReviewIds: Set<number>
  seenCommentIds: Set<number>
  checkNames: Set<string>
  checkStates: Map<string, string>
  lastMergeable: boolean | null
  readyToMergeNotified: boolean
  lastReadyState: string | null
  mergeNotified: boolean
  mergedPollCount: number
}

function prWatchDef(owner: string, repo: string, prNumber: number): WatchDef<PRState> {
  return {
    createState: () => ({
      seenReviewIds: new Set(),
      seenCommentIds: new Set(),
      checkNames: new Set(),
      checkStates: new Map(),
      lastMergeable: null,
      readyToMergeNotified: false,
      lastReadyState: null,
      mergeNotified: false,
      mergedPollCount: 0,
    }),
    poll: async (state, initial) => {
      const events: WatchEvent[] = []
      const meta = (et: string) => ({ event_type: et, pr: String(prNumber) })

      const { data: pr } = await octokit().rest.pulls.get({ owner, repo, pull_number: prNumber })

      // PR merged
      if (pr.merged) {
        if (!state.mergeNotified) {
          events.push({
            content: `PR #${prNumber} was merged by ${pr.merged_by?.login ?? "unknown"}.`,
            meta: { ...meta("pr_state"), state: "merged" },
          })
          state.mergeNotified = true
        }
        // Poll CI on head SHA until terminal
        const { data: ciData } = await octokit().rest.checks.listForRef({ owner, repo, ref: pr.head.sha, per_page: 100 })
        for (const check of ciData.check_runs) state.checkNames.add(check.name)
        for (const check of ciData.check_runs) {
          if (check.conclusion) state.checkStates.set(check.name, check.conclusion)
        }
        state.mergedPollCount++
        const allChecksComplete = state.checkNames.size > 0 && state.checkNames.size === state.checkStates.size
        const noChecksAfterWaiting = state.checkNames.size === 0 && state.mergedPollCount >= 2
        return { events, stop: allChecksComplete || noChecksAfterWaiting }
      }

      // PR closed
      if (pr.state === "closed") {
        events.push({ content: `PR #${prNumber} was closed.`, meta: { ...meta("pr_state"), state: "closed" } })
        return { events, stop: true }
      }

      // Merge conflict detection (on transition, skip initial poll)
      if (!initial && state.lastMergeable !== pr.mergeable) {
        if (pr.mergeable === false) {
          events.push({
            content: `PR #${prNumber} now has merge conflicts with \`${pr.base.ref}\`.`,
            meta: meta("merge_conflict"),
          })
        } else if (state.lastMergeable === false && pr.mergeable === true) {
          events.push({
            content: `PR #${prNumber} merge conflicts have been resolved.`,
            meta: meta("conflict_resolved"),
          })
        }
      }
      state.lastMergeable = pr.mergeable

      // Reviews
      const reviews = await octokit().paginate(octokit().rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 })
      const newReviews = reviews.filter((r) => !state.seenReviewIds.has(r.id))
      for (const r of reviews) state.seenReviewIds.add(r.id)

      if (!initial) {
        const { data: allComments } = newReviews.length > 0
          ? { data: await octokit().paginate(octokit().rest.pulls.listReviewComments, { owner, repo, pull_number: prNumber, per_page: 100 }) }
          : { data: [] }

        for (const review of newReviews) {
          if (review.state === "COMMENTED" && !review.body?.trim()) continue

          const comments = allComments.filter((c) => c.pull_request_review_id === review.id)

          let content = `Review from ${review.user?.login ?? "unknown"}: ${formatReviewState(review.state)}\n`
          if (review.body?.trim()) content += `\n${review.body}\n`

          if (comments.length > 0) {
            content += `\n${comments.length} inline comment(s):\n`
            for (const c of comments) {
              content += `\n--- ${c.path}:${c.line ?? c.original_line ?? "?"} ---\n`
              if (c.diff_hunk) content += `\`\`\`diff\n${c.diff_hunk}\n\`\`\`\n`
              content += `${c.body}\n`
            }
          }

          const tr = await getThreadResolution(owner, repo, prNumber)
          const trStr = formatThreadResolution(tr)
          if (trStr) content += `\n${trStr}`

          events.push({
            content,
            meta: { ...meta("review"), reviewer: review.user?.login ?? "unknown", review_state: review.state },
          })
        }
      }

      // Comments
      const issueComments = await octokit().paginate(octokit().rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 })
      const newComments = issueComments.filter((c) => !state.seenCommentIds.has(c.id))
      for (const c of issueComments) state.seenCommentIds.add(c.id)

      if (!initial) {
        for (const comment of newComments) {
          if (comment.user?.type === "Bot") continue
          events.push({
            content: `Comment from ${comment.user?.login ?? "unknown"}:\n\n${comment.body ?? ""}`,
            meta: { ...meta("comment"), author: comment.user?.login ?? "unknown" },
          })
        }
      }

      // CI checks (terminal states only)
      const { data: ciData2 } = await octokit().rest.checks.listForRef({ owner, repo, ref: pr.head.sha, per_page: 100 })
      for (const check of ciData2.check_runs) state.checkNames.add(check.name)

      let ciChanged = false
      for (const check of ciData2.check_runs) {
        if (!check.conclusion) continue
        if (state.checkStates.get(check.name) !== check.conclusion) {
          ciChanged = true
          state.checkStates.set(check.name, check.conclusion)
        }
      }

      if (!initial && ciChanged) {
        events.push(await buildCISummary(state.checkNames, state.checkStates, ciData2.check_runs, owner, repo, pr.head.sha, ` PR #${prNumber}`))
      }

      // Ready to merge — require two consecutive "clean" to avoid transient states
      if (!state.readyToMergeNotified) {
        const { ready, state: readyState } = await evaluateReadiness(owner, repo, pr)
        if (ready && state.lastReadyState === "clean") {
          state.readyToMergeNotified = true
          events.push({
            content: `PR #${prNumber} is ready to merge.`,
            meta: meta("ready_to_merge"),
          })
        }
        state.lastReadyState = readyState
      }

      // Initial status
      if (initial) {
        const parts: string[] = [`PR #${prNumber}: ${pr.title}`]

        if (state.checkStates.size > 0) {
          const counts = { success: 0, failure: 0, other: 0 }
          for (const [, status] of state.checkStates) {
            if (status === "success") counts.success++
            else if (status === "failure") counts.failure++
            else counts.other++
          }
          const pending = state.checkNames.size - state.checkStates.size
          const summary = [
            counts.success > 0 ? `${counts.success} passed` : null,
            counts.failure > 0 ? `${counts.failure} failed` : null,
            pending > 0 ? `${pending} running` : null,
          ].filter(Boolean).join(", ")
          parts.push(`CI: ${summary}`)
        } else {
          parts.push("CI: no checks found")
        }

        parts.push(`Reviews: ${state.seenReviewIds.size || "none"}`)

        const tr = await getThreadResolution(owner, repo, prNumber)
        const trStr = formatThreadResolution(tr)
        if (trStr) parts.push(trStr)

        if (pr.mergeable === false) parts.push("⚠ Has merge conflicts")
        else if (pr.mergeable === true) parts.push("Mergeable: yes")

        events.push({ content: parts.join("\n"), meta: meta("initial_status") })
      }

      return { events }
    },
  }
}

// --- watch_issues ---

interface IssuesState {
  seenIssueIds: Set<number>
  closedIssueIds: Set<number>
  issueLabelSnapshots: Map<number, Set<string>>
  lastPollTime: string | null
}

function issuesWatchDef(owner: string, repo: string, labels: string[]): WatchDef<IssuesState> {
  return {
    createState: () => ({
      seenIssueIds: new Set(),
      closedIssueIds: new Set(),
      issueLabelSnapshots: new Map(),
      lastPollTime: null,
    }),
    poll: async (state, initial) => {
      const events: WatchEvent[] = []

      const params: Record<string, any> = {
        owner, repo,
        state: state.lastPollTime ? "all" : "open",
        sort: "updated",
        direction: "desc",
        per_page: 100,
      }
      if (labels.length > 0) params.labels = labels.join(",")
      if (state.lastPollTime) params.since = state.lastPollTime

      // Capture timestamp before API call to avoid missing events updated during the request
      const pollTimestamp = new Date().toISOString()

      const issues = await octokit().paginate(octokit().rest.issues.listForRepo, params)
      const realIssues = issues.filter(i => !i.pull_request)

      for (const issue of realIssues) {
        const currentLabels = new Set(
          issue.labels.map(l => typeof l === "string" ? l : l.name ?? ""),
        )

        if (issue.state === "closed") {
          if (state.seenIssueIds.has(issue.number) && !initial) {
            events.push({
              content: `Issue #${issue.number} closed: ${issue.title}`,
              meta: { event_type: "issue_closed", issue: String(issue.number) },
            })
          }
          state.seenIssueIds.delete(issue.number)
          state.closedIssueIds.add(issue.number)
          state.issueLabelSnapshots.delete(issue.number)
          continue
        }

        if (!state.seenIssueIds.has(issue.number)) {
          const reopened = state.closedIssueIds.has(issue.number)
          state.seenIssueIds.add(issue.number)
          state.closedIssueIds.delete(issue.number)
          state.issueLabelSnapshots.set(issue.number, currentLabels)

          if (!initial) {
            const eventType = reopened ? "issue_reopened" : "new_issue"
            const prefix = reopened ? "Reopened" : "New"
            events.push({
              content: `${prefix} issue #${issue.number}: ${issue.title}\n` +
                `Author: ${issue.user?.login ?? "unknown"}\n` +
                `Labels: ${[...currentLabels].join(", ") || "none"}\n` +
                (issue.body ? `\n${issue.body.slice(0, 500)}` : ""),
              meta: { event_type: eventType, issue: String(issue.number) },
            })
          }
          continue
        }

        // Label changes on tracked issues
        const oldLabels = state.issueLabelSnapshots.get(issue.number) ?? new Set()
        const added = [...currentLabels].filter(l => !oldLabels.has(l))

        if (added.length > 0 && !initial) {
          events.push({
            content: `Issue #${issue.number} labeled: ${added.join(", ")}`,
            meta: { event_type: "issue_labeled", issue: String(issue.number) },
          })
        }

        state.issueLabelSnapshots.set(issue.number, currentLabels)

        // No longer matches filter
        if (labels.length > 0 && !labels.some(l => currentLabels.has(l))) {
          if (!initial) {
            events.push({
              content: `Issue #${issue.number} no longer matches label filter, stopped tracking.`,
              meta: { event_type: "issue_unlabeled", issue: String(issue.number) },
            })
          }
          state.seenIssueIds.delete(issue.number)
          state.issueLabelSnapshots.delete(issue.number)
        }
      }

      // Re-fetch tracked issues not in results to detect label removal
      if (state.lastPollTime) {
        const resultIds = new Set(realIssues.map(i => i.number))
        for (const trackedId of state.seenIssueIds) {
          if (resultIds.has(trackedId)) continue
          try {
            const { data: issue } = await octokit().rest.issues.get({ owner, repo, issue_number: trackedId })
            if (issue.state === "closed") {
              if (!initial) {
                events.push({
                  content: `Issue #${trackedId} closed: ${issue.title}`,
                  meta: { event_type: "issue_closed", issue: String(trackedId) },
                })
              }
              state.seenIssueIds.delete(trackedId)
              state.closedIssueIds.add(trackedId)
              state.issueLabelSnapshots.delete(trackedId)
            } else if (labels.length > 0) {
              const currentLabels = new Set(issue.labels.map(l => typeof l === "string" ? l : l.name ?? ""))
              if (!labels.some(l => currentLabels.has(l))) {
                if (!initial) {
                  events.push({
                    content: `Issue #${trackedId} no longer matches label filter, stopped tracking.`,
                    meta: { event_type: "issue_unlabeled", issue: String(trackedId) },
                  })
                }
                state.seenIssueIds.delete(trackedId)
                state.issueLabelSnapshots.delete(trackedId)
              }
            }
          } catch {
            state.seenIssueIds.delete(trackedId)
            state.issueLabelSnapshots.delete(trackedId)
          }
        }
      }

      if (initial) {
        const count = state.seenIssueIds.size
        const labelDesc = labels.length ? ` matching [${labels.join(", ")}]` : ""
        events.push({
          content: `Watching issues for ${owner}/${repo}. ${count} open issue(s)${labelDesc}.`,
          meta: { event_type: "initial_status" },
        })
      }

      state.lastPollTime = pollTimestamp
      return { events }
    },
  }
}

// --- watch_prs ---

interface PRsState {
  seenPRIds: Set<number>
  prReadyState: Map<number, boolean>
  prLastMergeState: Map<number, string>
  prHeadShas: Map<number, string>
}

function prsWatchDef(owner: string, repo: string, labels: string[]): WatchDef<PRsState> {
  return {
    createState: () => ({
      seenPRIds: new Set(),
      prReadyState: new Map(),
      prLastMergeState: new Map(),
      prHeadShas: new Map(),
    }),
    poll: async (state, initial) => {
      const events: WatchEvent[] = []

      const prs = await octokit().paginate(octokit().rest.pulls.list, {
        owner, repo, state: "open", sort: "created", direction: "desc", per_page: 100,
      })

      const matchingPRs = labels.length > 0
        ? prs.filter(pr => pr.labels.some(l => labels.includes(l.name ?? "")))
        : prs

      const currentIds = new Set(matchingPRs.map(pr => pr.number))

      // Detect tracked PRs that disappeared — classify before deleting
      const allOpenIds = new Set(prs.map(pr => pr.number))
      for (const trackedId of state.seenPRIds) {
        if (currentIds.has(trackedId)) continue

        if (!allOpenIds.has(trackedId)) {
          // No longer open — merged or closed
          try {
            const { data: closedPR } = await octokit().rest.pulls.get({ owner, repo, pull_number: trackedId })
            if (!initial) {
              const event = closedPR.merged ? "pr_merged" : "pr_closed"
              events.push({
                content: `PR #${trackedId} ${closedPR.merged ? "merged" : "closed"}.`,
                meta: { event_type: event, pr: String(trackedId) },
              })
            }
          } catch {}
        }
        // Label removed or closed — stop tracking silently
        state.seenPRIds.delete(trackedId)
        state.prReadyState.delete(trackedId)
        state.prHeadShas.delete(trackedId)
      }

      for (const pr of matchingPRs) {
        if (!state.seenPRIds.has(pr.number)) {
          state.seenPRIds.add(pr.number)
          state.prReadyState.set(pr.number, false)
          state.prHeadShas.set(pr.number, pr.head.sha)

          if (!initial) {
            events.push({
              content: `New PR #${pr.number}: ${pr.title}\n` +
                `Author: ${pr.user?.login ?? "unknown"}\n` +
                `Branch: ${pr.head.ref} → ${pr.base.ref}\n` +
                `Labels: ${pr.labels.map(l => l.name).join(", ") || "none"}`,
              meta: { event_type: "new_pr", pr: String(pr.number) },
            })
          }
        }

        state.prHeadShas.set(pr.number, pr.head.sha)

        // Ready-to-merge — require two consecutive "clean" to avoid transient states
        const { ready, state: mergeState } = await evaluateReadiness(owner, repo, pr)
        const wasReady = state.prReadyState.get(pr.number) ?? false
        const lastMergeState = state.prLastMergeState.get(pr.number)

        if (ready && lastMergeState === "clean" && !wasReady && !initial) {
          events.push({
            content: `PR #${pr.number} is ready to merge.`,
            meta: { event_type: "pr_ready_to_merge", pr: String(pr.number) },
          })
        } else if (!ready && wasReady && !initial) {
          events.push({
            content: `PR #${pr.number} is no longer ready to merge (state: ${mergeState}).`,
            meta: { event_type: "pr_not_ready", pr: String(pr.number) },
          })
        }
        state.prLastMergeState.set(pr.number, mergeState)
        state.prReadyState.set(pr.number, ready)
      }

      if (initial) {
        const readyCount = [...state.prReadyState.values()].filter(Boolean).length
        const labelDesc = labels.length ? ` matching [${labels.join(", ")}]` : ""
        events.push({
          content: `Watching PRs for ${owner}/${repo}. ${state.seenPRIds.size} open PR(s)${labelDesc}, ${readyCount} ready to merge.`,
          meta: { event_type: "initial_status" },
        })
      }

      return { events }
    },
  }
}

// --- MCP Server ---

const mcp = new Server(
  { name: "gh-channels", version: BUILD_VERSION ?? "dev" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'Events from GitHub arrive as <channel source="gh-channels" event_type="..."> tags.',
      "",
      "Event types:",
      "",
      "- review: A PR review with inline comments and diff context.",
      "  Read the feedback carefully. If changes are requested, analyze the",
      "  comments and propose fixes. Ask before pushing code.",
      "",
      "- ci_update: CI status changed. Includes pass/fail counts",
      "  and error details for failures. Investigate failures but ask before fixing.",
      "",
      "- ci_complete: All CI checks reached a terminal state. Report the final summary.",
      "",
      "- comment: A top-level PR comment. Summarize and ask if action is needed.",
      "",
      "- merge_conflict: PR has conflicts with the base branch. Ask before rebasing.",
      "",
      "- conflict_resolved: PR merge conflicts have been resolved.",
      "",
      "- initial_status: Snapshot of current state when watching begins.",
      "",
      "- ready_to_merge: Approved, CI green, no unresolved threads, no conflicts.",
      "  Ask the user if they want to merge.",
      "",
      "- pr_state: PR was merged or closed. Acknowledge and stop working on it.",
      "",
      "- new_issue: A new issue matching the label filter was opened.",
      "",
      "- issue_reopened: A previously closed tracked issue was reopened.",
      "",
      "- issue_labeled: A tracked issue had labels added.",
      "",
      "- issue_unlabeled: A tracked issue no longer matches the label filter.",
      "",
      "- issue_closed: A tracked issue was closed.",
      "",
      "- new_pr: A new PR matching the label filter was opened.",
      "",
      "- pr_ready_to_merge: A watched PR is approved, CI green, no conflicts, no unresolved threads.",
      "",
      "- pr_not_ready: A watched PR was ready but is no longer (includes reason).",
      "",
      "- pr_merged: A watched PR was merged.",
      "",
      "- pr_closed: A watched PR was closed without merging.",
      "",
      "- rate_limit_warning: GitHub API rate limit is running low. Reduce activity.",
      "",
      "- error: A watch stopped due to repeated failures.",
      "",
      "Default: Report events and propose actions. Always ask before pushing,",
      "rebasing, merging, or modifying the PR.",
      "",
      detectedRepo
        ? `Current repo: ${detectedRepo.owner}/${detectedRepo.repo} (default branch: ${detectedRepo.defaultBranch}). Use these values when calling watch tools without explicit owner/repo.`
        : "Could not detect repo from git remote. Owner and repo must be specified explicitly.",
    ].join("\n"),
  },
)

// --- Tools ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "watch_pr",
      description: "Watch a pull request for reviews, comments, CI status, and state changes. Auto-stops on merge or close.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          pr_number: { type: "number", description: "Pull request number" },
          poll_interval: { type: "number", description: "Poll interval in seconds (default: 30)" },
        },
        required: ["owner", "repo", "pr_number"],
      },
    },
    {
      name: "watch_ci",
      description: "Watch CI check runs for a git ref. Auto-stops when all checks reach a terminal state.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          ref: { type: "string", description: "Git ref — branch name, commit SHA, or tag" },
          poll_interval: { type: "number", description: "Poll interval in seconds (default: 30)" },
        },
        required: ["owner", "repo", "ref"],
      },
    },
    {
      name: "watch_issues",
      description: "Watch a repository for new issues and label changes. Optionally filter by labels. Long-running — use stop_watching to stop.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          labels: { type: "array", items: { type: "string" }, description: "Only watch issues with these labels" },
          poll_interval: { type: "number", description: "Poll interval in seconds (default: 30)" },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "watch_prs",
      description: "Watch a repository for new PRs and ready-to-merge state changes. Optionally filter by labels. Long-running — use stop_watching to stop.",
      inputSchema: {
        type: "object" as const,
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          labels: { type: "array", items: { type: "string" }, description: "Only watch PRs with these labels" },
          poll_interval: { type: "number", description: "Poll interval in seconds (default: 30)" },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "stop_watching",
      description: "Stop an active watch. Use list_watches to see active watch keys.",
      inputSchema: {
        type: "object" as const,
        properties: {
          key: { type: "string", description: 'Watch key (e.g., "pr:owner/repo#1", "ci:owner/repo@ref")' },
        },
        required: ["key"],
      },
    },
    {
      name: "list_watches",
      description: "List all active watches with health status.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}))

// --- Tool handlers ---

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  // Verify auth before starting any watch
  if (name.startsWith("watch_")) {
    try {
      octokit()
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `GitHub auth not configured. Set up auth before watching:\n` +
            `  1. Set GITHUB_TOKEN env var in the MCP server config, or\n` +
            `  2. Set GH_CHANNEL_USE_GH_AUTH=1 in env (requires gh CLI to be authenticated)\n\n` +
            `Error: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      }
    }
  }

  if (name === "watch_pr") {
    const { owner, repo, pr_number, poll_interval } = args as {
      owner: string; repo: string; pr_number: number; poll_interval?: number
    }
    const key = `pr:${owner}/${repo}#${pr_number}`
    if (runners.has(key)) {
      return { content: [{ type: "text", text: `Already watching ${owner}/${repo}#${pr_number}` }] }
    }
    startWatch(key, prWatchDef(owner, repo, pr_number), (poll_interval ?? 30) * 1000)
    return { content: [{ type: "text", text: `Now watching PR ${owner}/${repo}#${pr_number}` }] }
  }

  if (name === "watch_ci") {
    const { owner, repo, ref, poll_interval } = args as {
      owner: string; repo: string; ref: string; poll_interval?: number
    }
    const key = `ci:${owner}/${repo}@${ref}`
    if (runners.has(key)) {
      return { content: [{ type: "text", text: `Already watching CI for ${owner}/${repo}@${ref}` }] }
    }
    startWatch(key, ciWatchDef(owner, repo, ref), (poll_interval ?? 30) * 1000)
    return { content: [{ type: "text", text: `Now watching CI for ${owner}/${repo}@${ref}` }] }
  }

  if (name === "watch_issues") {
    const { owner, repo, labels, poll_interval } = args as {
      owner: string; repo: string; labels?: string[]; poll_interval?: number
    }
    const key = `issues:${owner}/${repo}`
    if (runners.has(key)) {
      return { content: [{ type: "text", text: `Already watching issues for ${owner}/${repo}` }] }
    }
    startWatch(key, issuesWatchDef(owner, repo, labels ?? []), (poll_interval ?? 30) * 1000)
    const labelDesc = labels?.length ? ` with labels: ${labels.join(", ")}` : ""
    return { content: [{ type: "text", text: `Now watching issues for ${owner}/${repo}${labelDesc}` }] }
  }

  if (name === "watch_prs") {
    const { owner, repo, labels, poll_interval } = args as {
      owner: string; repo: string; labels?: string[]; poll_interval?: number
    }
    const key = `prs:${owner}/${repo}`
    if (runners.has(key)) {
      return { content: [{ type: "text", text: `Already watching PRs for ${owner}/${repo}` }] }
    }
    startWatch(key, prsWatchDef(owner, repo, labels ?? []), (poll_interval ?? 30) * 1000)
    const labelDesc = labels?.length ? ` with labels: ${labels.join(", ")}` : ""
    return { content: [{ type: "text", text: `Now watching PRs for ${owner}/${repo}${labelDesc}` }] }
  }

  if (name === "stop_watching") {
    const { key } = args as { key: string }
    const runner = runners.get(key)
    if (!runner) {
      return { content: [{ type: "text", text: `No active watch with key: ${key}` }] }
    }
    runner.stop()
    return { content: [{ type: "text", text: `Stopped watching: ${key}` }] }
  }

  if (name === "list_watches") {
    if (runners.size === 0) {
      return { content: [{ type: "text", text: "No active watches." }] }
    }
    const lines = Array.from(runners.entries()).map(([key, r]) => {
      const h = r.health
      const health = h.consecutiveErrors > 0 ? `errors: ${h.consecutiveErrors}` : r.status
      return `- ${key} (${health}, ${h.eventsDelivered} events, last poll: ${h.lastSuccessfulPoll ?? "pending"})`
    })
    return { content: [{ type: "text", text: `Active watches:\n${lines.join("\n")}` }] }
  }

  throw new Error(`Unknown tool: ${name}`)
})

// --- CLI ---

// --- Server ---
log.info({ repo: detectedRepo ? `${detectedRepo.owner}/${detectedRepo.repo}` : "none" }, "server starting")
await mcp.connect(new StdioServerTransport())
