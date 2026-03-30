# claude-gh-channel

MCP channel server for Claude Code's `--channels` feature (research preview).
Pushes GitHub PR and CI events into a running Claude Code session so Claude
can react to reviews, CI failures, and PR state changes in real time.

## What it does

Six tools exposed over MCP stdio. All poll-based tools accept an optional
`poll_interval` parameter (seconds, default: 30).

- **watch_pr(owner, repo, pr_number)** — polls for:
  - Initial status snapshot (CI state, reviews, threads, mergeability)
  - New reviews (bundled with inline comments + diff hunks)
  - Review thread resolution status (resolved/unresolved via GraphQL)
  - Top-level comments (skips bot comments)
  - CI check status changes with failure annotations
  - Merge conflict detection and resolution (on transition)
  - "Ready to merge" composite signal (approved + green CI + no unresolved threads + mergeable)
  - PR state changes (merged, closed)
  - Auto-stops on: merge + all checks terminal, or PR closed
  - Auto-stops after 5 consecutive poll failures (notifies Claude)

- **watch_ci(owner, repo, ref)** — polls for:
  - Initial CI status snapshot
  - CI check status changes with failure annotations
  - Auto-stops when all checks reach a terminal state
  - Auto-stops after 5 consecutive poll failures (notifies Claude)

- **watch_issues(owner, repo, labels?)** — polls for:
  - New issues (filtered by labels if provided)
  - Label changes on tracked issues
  - Issue closures
  - Long-running — use `stop_watching` to stop

- **watch_prs(owner, repo, labels?)** — polls for:
  - New PRs (filtered by labels if provided)
  - Ready-to-merge state transitions (approved + green CI + no unresolved threads + mergeable)
  - PR merged/closed
  - Long-running — use `stop_watching` to stop

- **stop_watching(key)** — stops any active watch by key

- **list_watches()** — returns all active watch keys

## Stack

- **Runtime**: Bun
- **Dependencies**: `@modelcontextprotocol/sdk`, `@octokit/rest`, `pino`
- **Auth**: `GITHUB_TOKEN` env var, or `GH_CHANNEL_USE_GH_AUTH=1` to use `gh auth token`
- **Logging**: pino (JSON) to stderr + file. `GH_CHANNEL_LOG` (file path), `GH_CHANNEL_LOG_LEVEL` (default: info)
- **Single file**: `gh-channel.ts`

## How to run

```bash
claude --dangerously-load-development-channels server:claude-gh-channel
```

With `.mcp.json`:
```json
{
  "mcpServers": {
    "claude-gh-channel": {
      "command": "bun",
      "args": ["./gh-channel.ts"],
      "env": { "GH_CHANNEL_USE_GH_AUTH": "1" }
    }
  }
}
```

## Testing

See `test-playbook.md` for a 9-step manual test sequence.

## Architecture

- **WatchRunner**: Generic engine that manages lifecycle (polling → paused → stopped), setTimeout-based scheduling (no overlapping polls), error counting with auto-stop, and rate limit pause/resume.
- **Watch definitions**: Each watch type provides `createState()` + `poll(state, initial) → PollResult`. Poll functions return events; the runner handles notification delivery.
- **Rate limit awareness**: Tracks `x-ratelimit-remaining` via Octokit hook. Pauses all polls until reset timestamp when low. Warns Claude at threshold.

## Design decisions

- **Bun + TypeScript, not Python/FastMCP**: Channels require pushing `notifications/claude/channel` proactively from a background poll loop. FastMCP's notification API is gated behind tool handler context — wrong abstraction for event-push servers.
- **Initial poll sends status snapshot**: First poll seeds internal state and sends an `initial_status` notification.
- **One notification per review** (not per comment): Reviews are submitted as a logical unit; inline comments are bundled.
- **CI: terminal states only**: Only notifies when checks reach a conclusion. No queued/in_progress noise.
- **Instructions default to safety**: Claude reports events and proposes actions but always asks before pushing, rebasing, or merging.
- **Merge conflict notified on transition**: Both conflict detection and resolution.
- **Thread resolution is tri-state**: GraphQL errors → `unknown` → treated as not-ready (no false ready-to-merge).
- **Error auto-stop**: After 5 consecutive poll failures, the watch stops and notifies Claude.
