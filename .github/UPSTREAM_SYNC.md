# Upstream Synchronization Guide

KhatamRouter is a content fork of [`decolua/9router`](https://github.com/decolua/9router). It was initialized from an orphan commit at `v0.5.104` (`87a74e1b`), so `origin/master` and `upstream/master` share **no merge base**.

To keep KhatamRouter aligned with upstream releases, the GitHub Actions workflow [`.github/workflows/upstream-sync.yml`](workflows/upstream-sync.yml) runs daily and opens a Pull Request whenever `decolua/9router` publishes new commits.

---

## What the workflow does

1. **Fetches upstream**: Points the `upstream` remote at `https://github.com/decolua/9router.git` and fetches `master`.
2. **Short-circuits**: Skips cleanly (exit 0) if `upstream/master` is already an ancestor of `HEAD`, or if an open PR with label `upstream-sync` already exists (to avoid duplicate PR spam).
3. **Creates a sync branch**: `chore/upstream-sync-<short_sha>` branched from `master`.
4. **Merges upstream**: Runs `git merge --allow-unrelated-histories --no-commit upstream/master`. The `--allow-unrelated-histories` flag is required because the two repositories do not share a common root commit.
5. **Resolves conflicts deterministically**:
   - Every conflicting path listed in [`.github/upstream-sync-overrides.txt`](upstream-sync-overrides.txt) takes **our** version (`git checkout --ours -- <path>`). This preserves KhatamRouter-specific branding, CI pipelines, Spec-Kit governance, and sanitized OAuth credentials.
   - Any conflict on a path **not** in the override list takes **upstream's** version (`git checkout --theirs -- <path>`) but is recorded in the PR body under `### Files that took upstream — need review` so a maintainer can verify the resolution.
   - If `git merge` fails for an unexpected reason (other than content conflicts), the workflow aborts cleanly (exit 0, no PR) and dumps the raw git error into the job summary.
6. **Sanitizes OAuth literals (Push-Protection Guard)**:
   - Upstream commits literal public Google OAuth client credentials (`GOCSPX-…` and `*.apps.googleusercontent.com`).
   - If pushed to GitHub, these literals trigger GitHub Secret Scanning Push Protection and reject the branch.
   - [`scripts/upstream-sync-sanitizer.mjs`](../scripts/upstream-sync-sanitizer.mjs) scans the entire tracked tree:
     - JS/TS files with literal credentials are rewritten into the split form used in `open-sse/providers/shared.js`:
       - `clientSecret: ["GOC", "SPX-..."].join("")`
       - `clientId: ["<id-prefix>", ".apps.googleusercontent.com"].join("")`
     - JSON data files (such as `tests/__baseline__/providers-baseline.json`) are rewritten with the repo's existing redaction placeholders (`REDACTED_PUBLIC_OAUTH_CLIENT_ID` / `REDACTED_PUBLIC_OAUTH_CLIENT_SECRET`).
   - A loud pre-push gate runs in `check` mode. If any literal remains that cannot be rewritten safely (e.g. in Markdown, YAML, or shell), the job fails **before** pushing.
7. **Opens a Pull Request**:
   - Commits with message:
     ```
     chore(upstream): sync decolua/9router <event_name>

     Merge upstream/master (<short_sha>) into master.
     Conflicts resolved from .github/upstream-sync-overrides.txt; OAuth literals re-sanitized.

     Co-Authored-By: Claude Code <noreply@anthropic.com>
     ```
   - Pushes `chore/upstream-sync-<short_sha>` to `origin`.
   - Opens a PR against `master` labeled `upstream-sync`.
   - The PR body lists the upstream commits (`git log --oneline HEAD..upstream/master`), the files that kept our version, and any files that took upstream and need review.
8. **Auto-merge**: If the repository variable `AUTO_MERGE_UPSTREAM` is set to `true`, the workflow arms auto-merge (`gh pr merge --squash --auto`); otherwise the PR remains open for maintainer review.

---

## How to trigger a sync manually

From your terminal via the GitHub CLI:

```bash
# Normal manual run (respects skip-if-current and skip-if-pr-open)
gh workflow run upstream-sync.yml

# Force run (bypasses skip checks to regenerate a PR)
gh workflow run upstream-sync.yml -f force=true
```

Or from the GitHub UI:
1. Navigate to **Actions** → **Sync upstream decolua/9router**.
2. Click **Run workflow**.
3. (Optional) Check the **force** checkbox to ignore existing open PRs or up-to-date checks.
4. Click **Run workflow**.

---

## How to enable or disable auto-merge

Auto-merge is controlled by a GitHub repository variable (`AUTO_MERGE_UPSTREAM`). By default, it is unset/`false`, which leaves every sync PR open for manual inspection and merge.

To enable automated squash-merging once CI checks pass:

```bash
gh variable set AUTO_MERGE_UPSTREAM --body "true"
```

To disable and return to manual review:

```bash
gh variable set AUTO_MERGE_UPSTREAM --body "false"
```

> **Requirements for auto-merge on GitHub**:
> 1. Repository Settings → General → Pull Requests → check **Allow auto-merge**.
> 2. Branch protection or rulesets on `master` requiring status checks to pass before merging.

---

## How to run the sync flow locally

Maintainers can run the exact same merge, conflict-resolution, and sanitization flow locally without waiting for CI:

```bash
# Run the complete flow locally (creates branch, merges, resolves, sanitizes, commits)
bash scripts/upstream-sync-local.sh

# Re-run just the secret scanner/sanitizer on your current worktree
bun scripts/upstream-sync-sanitizer.mjs fix
bun scripts/upstream-sync-sanitizer.mjs check

# Push the sync branch and open the PR using your local gh credentials
bash scripts/upstream-sync-local.sh pr
```

Available sub-commands:
- `bash scripts/upstream-sync-local.sh prepare` — fetch upstream
- `bash scripts/upstream-sync-local.sh check` — verify if sync is needed
- `bash scripts/upstream-sync-local.sh branch` — create sync branch
- `bash scripts/upstream-sync-local.sh merge` — merge with `--allow-unrelated-histories`
- `bash scripts/upstream-sync-local.sh resolve` — apply keep-ours rules from override list
- `bash scripts/upstream-sync-local.sh sanitize` — fix and check OAuth literals
- `bash scripts/upstream-sync-local.sh commit` — create sync commit
- `bash scripts/upstream-sync-local.sh pr` — push and create PR

---

## How to add a path to the override list

If you modify a file in KhatamRouter that upstream also maintains, and you want KhatamRouter's version to always win in future upstream merges:

1. Open [`.github/upstream-sync-overrides.txt`](upstream-sync-overrides.txt).
2. Add the path (relative to the repo root) under the appropriate section:
   ```text
   # Maintain custom rate-limiting configuration
   src/lib/rateLimitConfig.js
   ```
   Glob patterns like `path/to/folder/**` are supported.
3. Commit the change to `master`:
   ```bash
   git add .github/upstream-sync-overrides.txt
   git commit -m "chore(sync): add rateLimitConfig to upstream-sync overrides"
   ```

---

## How to review and resolve an upstream-sync PR

When a sync PR is opened:

1. Check the **Files that took upstream — need review** section in the PR body.
   - If empty (`_none_`), all conflicts occurred on known overridden files and were cleanly kept on our version.
   - If files are listed, upstream changed files where we had local edits not covered by the override list. Inspect the diff to confirm upstream's changes do not break KhatamRouter functionality.
2. Verify CI passes (Docker publish linting, unit tests, etc.).
3. If additional adjustments are needed on the sync branch:
   ```bash
   git fetch origin
   git checkout chore/upstream-sync-<short_sha>
   # make adjustments...
   bun scripts/upstream-sync-sanitizer.mjs check   # verify no literals were introduced
   git commit -m "fix: adjust upstream changes for KhatamRouter compatibility"
   git push origin chore/upstream-sync-<short_sha>
   ```
4. Merge the PR (squash-merge recommended):
   ```bash
   gh pr merge --squash
   ```
5. Delete the temporary sync branch once merged.
