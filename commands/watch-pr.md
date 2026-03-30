---
description: Watch a GitHub PR for reviews, comments, CI, and state changes
argument-hint: "<pr_number> [poll_interval]"
allowed-tools: mcp__plugin_gh-channels_gh-channels__watch_pr
---

Call the watch_pr tool. Use the repo info from the gh-channel server instructions
(owner and repo are provided at connection time). PR number: $1.
Poll interval: $2 (if provided, otherwise omit).
