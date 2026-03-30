# Test Playbook

Manual test sequence for claude-gh-channel. Work through these in order —
each test builds on the previous state.

## Prerequisites

- A throwaway GitHub repo (e.g. `youruser/claude-gh-channel-test`)
- `gh` CLI authenticated
- Bun installed
- A second GitHub account or bot token for the approval test (Test 6)

## Setup

```bash
# Create test repo
gh repo create claude-gh-channel-test --public --clone
cd claude-gh-channel-test
echo "hello" > test.txt
git add test.txt && git commit -m "init" && git push
```

Add a CI workflow so we can test check run notifications:

```bash
mkdir -p .github/workflows
cat > .github/workflows/test.yml << 'YAML'
name: test
on: [pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "lint passed"
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: exit 1
YAML
git add .github && git commit -m "add CI" && git push
```

Start Claude with the channel in a separate terminal:

```bash
claude --dangerously-load-development-channels server:claude-gh-channel
```

The `USE_GH_AUTH=1` env var should be set in your `.mcp.json` config,
or set `GITHUB_TOKEN` in your environment.

---

## Test 1: watch_pr — basic setup

```bash
git checkout -b test-1
echo "change" >> test.txt
git add test.txt && git commit -m "test change" && git push -u origin test-1
gh pr create --title "Test PR 1" --body "Testing channel server"
```

In Claude's session, say: "Watch PR youruser/claude-gh-channel-test #1"

**Expected**: Claude calls `watch_pr`. Tool result says "Now watching PR ...".
Initial poll seeds state without producing notifications for existing data.

---

## Test 2: CI failure

The workflow from setup has a deliberate `exit 1` in the test job.
CI should already be running from the PR creation.

**Expected**: Within ~30s, Claude receives a `ci_update` notification.
Should show:
- lint: ✓ success
- test: ✗ failure (with annotations if available)
- Summary: 1 passed, 1 failed

---

## Test 3: Review with inline comments

```bash
gh api repos/youruser/claude-gh-channel-test/pulls/1/reviews \
  -f body="Two issues" \
  -f event="REQUEST_CHANGES" \
  -f 'comments[0][path]=test.txt' \
  -f 'comments[0][position]=2' \
  -f 'comments[0][body]=This line should say goodbye not change'
```

**Expected**: Claude receives a `review` notification containing:
- Reviewer name and "Changes Requested"
- Review body ("Two issues")
- Inline comment with file path, line number, diff hunk, and comment body
- Thread resolution summary (e.g. "0 resolved, 1 unresolved")

---

## Test 4: Top-level comment

```bash
gh pr comment 1 --body "Can you also add a README?"
```

**Expected**: Claude receives a `comment` notification with author and body.

---

## Test 5: Fix CI failure

```bash
cd claude-gh-channel-test
git checkout test-1
sed -i '' 's/exit 1/echo "tests passed"/' .github/workflows/test.yml
git add .github && git commit -m "fix test" && git push
```

**Expected**: Claude receives `ci_update` as checks run, then another update
when all complete. Summary should show all passed.

---

## Test 6: Approve — ready to merge

Requires a different GitHub user or bot token:

```bash
GITHUB_TOKEN=<other-user-token> gh pr review 1 --approve --body "LGTM"
```

Or resolve the review thread from Test 3 first:

```bash
# Get the thread ID via GraphQL, then resolve it — or do it in the GitHub UI
```

**Expected**: If all conditions met (approved, CI green, no unresolved threads,
mergeable), Claude receives `ready_to_merge`.

If there are still unresolved threads from Test 3, the notification won't fire
until they're resolved. This is correct behavior.

---

## Test 7: Merge conflict

In a separate terminal (don't disturb the test-1 branch):

```bash
cd claude-gh-channel-test
git checkout main
echo "conflict" >> test.txt
git add test.txt && git commit -m "create conflict on main" && git push
```

**Expected**: Within ~30s, Claude receives `merge_conflict` notification.
Only fires once (on the transition from mergeable to not mergeable).

---

## Test 8: Merge + auto-stop

Resolve the conflict first if needed, then:

```bash
gh pr merge 1 --squash
```

**Expected**: Claude receives `pr_state` with state "merged".
Watch continues polling CI until all checks on the merge are terminal,
then auto-stops.

---

## Test 9: watch_ci standalone

```bash
cd claude-gh-channel-test
git checkout -b deploy-test
echo "deploy" > deploy.txt
git add deploy.txt && git commit -m "deploy test" && git push -u origin deploy-test
```

This won't trigger the PR workflow (it's `on: [pull_request]`).
Add a push-triggered workflow first if you want CI to run:

```bash
git checkout deploy-test
cat > .github/workflows/deploy.yml << 'YAML'
name: deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "deploying..." && sleep 10 && echo "done"
YAML
git add .github && git commit -m "add deploy workflow" && git push
```

In Claude's session: "Watch CI for youruser/claude-gh-channel-test ref deploy-test"

**Expected**: Claude calls `watch_ci`. CI updates flow in as the deploy job
progresses. Auto-stops when all checks reach a terminal state.

---

## What to look for across all tests

- Notifications arrive within ~30s of the GitHub event
- No duplicate notifications for the same event
- Initial poll doesn't flood with historical data
- CI summaries include pass/fail/running/queued counts
- Failed checks include error annotations when available
- Reviews bundle inline comments with diff hunks
- `merge_conflict` only fires on the transition, not every poll
- `ready_to_merge` only fires once
- Auto-stop works correctly for both PR and CI watches
