# claude-channels-github

You assign an issue. Claude creates a worktree, writes the fix, opens a PR, watches CI, fixes failures, and merges — all without you touching it.

<p align="center">
  <img src="docs/sequence.png" alt="GitHub to Claude lifecycle: issue created, open PR, run checks, fix failures, merge" width="700">
</p>

An MCP channel server + Claude Code plugin that pushes GitHub events (PRs, CI, issues) into your Claude session in real time.

> **Channels are a Claude Code research preview.** The `--dangerously-load-development-channels` flag is required. Expect rough edges.

## Getting started

### Prerequisites

- [Bun](https://bun.sh) (build from source only)
- [gh CLI](https://cli.github.com) authenticated (`gh auth login`)
- Claude Code with channels support

### Install the binary

Download the latest release (macOS arm64):

```bash
curl -fsSL https://github.com/mikery/claude-channels-github/releases/latest/download/claude-channels-github-darwin-arm64 -O
curl -fsSL https://github.com/mikery/claude-channels-github/releases/latest/download/claude-channels-github-darwin-arm64.sha256 -O
shasum -a 256 -c claude-channels-github-darwin-arm64.sha256
install -m 755 claude-channels-github-darwin-arm64 /usr/local/bin/claude-channels-github
rm claude-channels-github-darwin-arm64 claude-channels-github-darwin-arm64.sha256
```

Or build from source:

```bash
git clone https://github.com/mikery/claude-channels-github.git
cd claude-channels-github
bun install
bun build --compile gh-channel.ts --outfile claude-channels-github
install claude-channels-github /usr/local/bin/
```

### Install the plugin

```bash
claude plugin marketplace add mikery/claude-channels-github
claude plugin install gh-channels
```

### Run

```bash
claude --dangerously-load-development-channels plugin:gh-channels@gh-channels
```

### Watch issues and PRs

Watch for new issues with a label and act on them:

```
> /issue-handler
```

Claude will ask which labels to filter on and whether to auto-merge. New issues get picked up, fixed in worktrees, and submitted as PRs.

Watch a specific PR through to merge:

```
> /watch-pr 42
```

Claude polls every 30 seconds and reports reviews, CI changes, comments, and merge readiness.

## How it works

A poll-based MCP server watches GitHub for events (reviews, CI state changes, new issues, merge conflicts) and pushes them into Claude's session as channel notifications. A plugin layer adds slash commands and skills that turn those notifications into autonomous workflows.

**Tools**

| Tool | Watches for | Auto-stops |
|------|------------|------------|
| `watch_pr` | Reviews, CI, comments, conflicts, merge state | On merge or close |
| `watch_ci` | Check run state changes (terminal only) | When all checks finish |
| `watch_issues` | New issues, label changes, closures | Manual (`stop_watching`) |
| `watch_prs` | New PRs, ready-to-merge transitions | Manual (`stop_watching`) |
| `stop_watching` | — | Stops a watch by key |
| `list_watches` | — | Lists active watches |

All poll-based tools accept an optional `poll_interval` (seconds, default: 30).

**Skills**

| Skill | |
|--------|--|
| `pr-handler` | Handle a single PR to merge: respond to reviews, fix CI, resolve conflicts, merge when ready |
| `issue-handler` | Watch for new issues, create worktrees, open PRs, dispatch `pr-handler` for each, merge on green |

## Authentication

| Method | Setup |
|--------|-------|
| **gh CLI** (recommended) | Set `GH_CHANNEL_USE_GH_AUTH=1` in `.mcp.json` env. Requires `gh auth login`. |
| **Token** | Set `GITHUB_TOKEN` env var. Needs `repo` scope. |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | GitHub API token (alternative to gh CLI) |
| `GH_CHANNEL_USE_GH_AUTH` | — | Set to `1` to use `gh auth token` |
| `GH_CHANNEL_LOG_LEVEL` | `info` | Pino log level: `debug`, `info`, `warn`, `error` |
| `GH_CHANNEL_LOG` | `/tmp/gh-channel.log` | Log file path |

## Architecture

Single file (`gh-channel.ts`), compiled to a standalone binary with Bun.

**WatchRunner** is the core abstraction — a generic polling engine that manages watch lifecycle:

- **States**: polling → paused → stopped
- **Scheduling**: `setTimeout`-based, no overlapping polls
- **Error handling**: 5 consecutive failures → auto-stop with notification
- **Rate limits**: Tracks `x-ratelimit-remaining` via Octokit hook. Pauses all polls at 20 remaining, warns at 100, resumes after reset timestamp

Each watch type provides a `createState()` + `poll(state, initial)` function. The runner handles scheduling, error counting, and notification delivery.

## License

MIT
