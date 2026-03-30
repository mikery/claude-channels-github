---
description: Watch a repo for new issues and label changes
argument-hint: "[--labels label1,label2] [--interval seconds]"
allowed-tools: mcp__plugin_gh-channels_gh-channels__watch_issues
---

Call the watch_issues tool. Use the repo info from the gh-channel server instructions.
Pass labels as an array if --labels is provided (split on comma).
Pass poll_interval if --interval is provided.
