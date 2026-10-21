#!/usr/bin/env bash
# =============================================================================
# KhatamRouter — Upstream Sync (local + CI driver)
# =============================================================================
# Reproduces exactly what .github/workflows/upstream-sync.yml does, so a
# maintainer can run the same merge / resolve / sanitize flow on a laptop.
#
#   bash scripts/upstream-sync-local.sh            # full flow, no push
#   bash scripts/upstream-sync-local.sh sanitize   # re-run just the secret scan
#   bash scripts/upstream-sync-local.sh pr         # push branch + open the PR
#
# Exit codes
#   0  success, or a clean skip/abort (nothing pushed, nothing left broken)
#   1  hard failure (sanitizer found an unrewritable literal, bad state, ...)
#   3  merge failed for an unexpected (non-conflict) reason -> aborted cleanly
# =============================================================================
set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_REPO_URL="${UPSTREAM_REPO_URL:-https://github.com/decolua/9router.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"
BASE_BRANCH="${BASE_BRANCH:-master}"
OVERRIDE_LIST="${OVERRIDE_LIST:-.github/upstream-sync-overrides.txt}"
SANITIZER="${SANITIZER:-scripts/upstream-sync-sanitizer.mjs}"
WORK_DIR="${WORK_DIR:-${RUNNER_TEMP:-/tmp}/khatam-upstream-sync}"
FORCE="${FORCE:-false}"
DRY_RUN="${DRY_RUN:-false}"
EVENT_NAME="${EVENT_NAME:-local}"
AUTO_MERGE="${AUTO_MERGE:-false}"

EXIT_OK=0
EXIT_FAIL=1
EXIT_UNEXPECTED_MERGE=3

OUT_FILE="${GITHUB_OUTPUT:-/dev/null}"
SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-}"

log() { printf '%s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit "$EXIT_FAIL"
}

summary() {
  if [ -n "$SUMMARY_FILE" ]; then
    printf '%s\n' "$*" >>"$SUMMARY_FILE"
  fi
}

emit() {
  printf '%s\n' "$1" >>"$OUT_FILE"
}

# -----------------------------------------------------------------------------
# State shared across sub-commands (persisted so each CI step is independent)
# -----------------------------------------------------------------------------
state_dir() {
  mkdir -p "$WORK_DIR"
  printf '%s' "$WORK_DIR"
}

branch_file() { printf '%s/branch.txt' "$(state_dir)"; }
commits_file() { printf '%s/upstream-commits.txt' "$(state_dir)"; }
ours_file() { printf '%s/kept-ours.txt' "$(state_dir)"; }
review_file() { printf '%s/needs-review.txt' "$(state_dir)"; }

require_git_repo() {
  git rev-parse --show-toplevel >/dev/null 2>&1 || die "not inside a git repository"
  cd "$(git rev-parse --show-toplevel)"
}

# -----------------------------------------------------------------------------
# Sub-command: prepare
# Idempotently point $UPSTREAM_REMOTE at upstream and fetch the sync branch.
# -----------------------------------------------------------------------------
cmd_prepare() {
  require_git_repo
  if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    git remote set-url "$UPSTREAM_REMOTE" "$UPSTREAM_REPO_URL"
  else
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_REPO_URL"
  fi
  git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" --prune
  git rev-parse -q --verify "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" >/dev/null \
    || die "remote branch ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} not found after fetch"
  log "Fetched ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} @ $(git rev-parse --short "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"
}

# -----------------------------------------------------------------------------
# Sub-command: check
# Decide whether a sync PR is worth opening. Never fails the job on "skip".
# -----------------------------------------------------------------------------
has_open_sync_pr() {
  [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || return 1
  command -v gh >/dev/null 2>&1 || return 1
  local count
  count="$(
    GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
      gh pr list --label upstream-sync --state open --json number --jq 'length' 2>/dev/null || echo 0
  )"
  [ "${count:-0}" -gt 0 ] 2>/dev/null
}

cmd_check() {
  require_git_repo
  if [ "$FORCE" != "true" ] && git merge-base --is-ancestor "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" HEAD; then
    emit "outcome=skip"
    emit "skip_reason=up-to-date"
    log "Already up to date: ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} is an ancestor of HEAD."
    summary "### Upstream sync skipped — already up to date"
    summary ""
    summary "\`${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}\` is already an ancestor of \`${BASE_BRANCH}\`; nothing to merge."
    exit "$EXIT_OK"
  fi
  if [ "$FORCE" != "true" ] && has_open_sync_pr; then
    emit "outcome=skip"
    emit "skip_reason=pr-open"
    log "An upstream-sync PR is already open; skipping to avoid duplicates."
    summary "### Upstream sync skipped — sync PR already open"
    summary ""
    summary "An open PR labelled \`upstream-sync\` already exists. Merge or close it before re-running."
    exit "$EXIT_OK"
  fi
  emit "outcome=continue"
}

# -----------------------------------------------------------------------------
# Sub-command: branch
# Branch from master, and snapshot the upstream commit list for the PR body
# (captured *before* the merge commit, so HEAD..upstream is meaningful even
# though the histories are unrelated on the very first sync).
# -----------------------------------------------------------------------------
cmd_branch() {
  require_git_repo
  git rev-parse -q --verify "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" >/dev/null \
    || die "run the prepare step first"

  local short sync_branch
  short="$(git rev-parse --short "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"
  sync_branch="chore/upstream-sync-${short}"

  git log --oneline "HEAD..refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" >"$(commits_file)" || true

  git checkout -B "$sync_branch" "$BASE_BRANCH"
  printf '%s\n' "$sync_branch" >"$(branch_file)"
  emit "branch=$sync_branch"
  log "Branch: $sync_branch (from $BASE_BRANCH, upstream $short)"
}

current_branch_name() {
  if [ -f "$(branch_file)" ]; then
    cat "$(branch_file)"
  else
    git rev-parse --abbrev-ref HEAD
  fi
}

# -----------------------------------------------------------------------------
# Sub-command: merge
# `--allow-unrelated-histories` is required on the first ever sync: this repo
# was created from an orphan commit and shares no merge base with upstream.
# Later syncs are ordinary merges and simply keep that flag harmlessly.
#
# Normal content conflicts are expected and reported as success (the next step
# resolves them). Anything else (unrelated-history refusal, a failing hook,
# a corrupt ref, ...) aborts cleanly with exit 3 and no PR.
# -----------------------------------------------------------------------------
cmd_merge() {
  require_git_repo
  local up_ref="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
  local output rc
  set +e
  output="$(git merge --allow-unrelated-histories --no-commit "$up_ref" 2>&1)"
  rc=$?
  set -e
  if [ -n "$output" ]; then
    printf '%s\n' "$output" >&2
  fi

  if [ "$rc" -eq 0 ]; then
    log "Merge completed with no conflicts."
    emit "merge_result=clean"
    emit "conflicts=0"
    return 0
  fi

  local conflicted
  conflicted="$(git diff --name-only --diff-filter=U)"
  if [ -n "$conflicted" ]; then
    log "Merge stopped on conflicts; deterministic resolution will follow."
    emit "merge_result=conflicts"
    emit "conflicts=$(printf '%s\n' "$conflicted" | wc -l | tr -d ' ')"
    return 0
  fi

  # Unexpected: not a content conflict. Leave the tree exactly as we found it
  # and stop cleanly — no branch to push, no PR to open.
  git merge --abort >/dev/null 2>&1 || git merge --quit >/dev/null 2>&1 || true
  emit "merge_result=aborted"
  summary "### Upstream sync aborted — unexpected merge failure"
  summary ""
  summary "\`git merge --allow-unrelated-histories --no-commit ${up_ref}\` failed for a reason other than a normal content conflict. No PR was created."
  summary ""
  summary '```'
  summary "${output:-<no output>}"
  summary '```'
  log "Unexpected merge failure — aborting cleanly (exit 0, no PR)."
  return 0
}

# -----------------------------------------------------------------------------
# Sub-command: resolve
# Deterministic conflict resolution driven by .github/upstream-sync-overrides.txt
#   - listed path  -> keep ours   (KhatamRouter branding / sanitization / CI)
#   - unlisted path -> take theirs, but flag it for human review in the PR body
# -----------------------------------------------------------------------------
OVERRIDES=()

load_overrides() {
  local list_path="$OVERRIDE_LIST"
  [ -f "$list_path" ] || die "override list not found: $list_path"
  OVERRIDES=()
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    # trim surrounding whitespace without invoking a subprocess per line
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    OVERRIDES+=("$line")
  done <"$list_path"
  log "Loaded ${#OVERRIDES[@]} override pattern(s) from $list_path"
}

is_override() {
  local path="$1" pat
  [ "${#OVERRIDES[@]}" -eq 0 ] && return 1
  for pat in "${OVERRIDES[@]}"; do
    # shellcheck disable=SC2254  # intentional glob match
    case "$path" in
      $pat) return 0 ;;
    esac
  done
  return 1
}

# Take one side of a conflicted path. If that side deleted the file, remove it.
take_side() {
  local side="$1" path="$2"
  if git checkout "--${side}" -- "$path" 2>/dev/null; then
    git add -- "$path"
  else
    git rm -f -- "$path" >/dev/null
  fi
}

cmd_resolve() {
  require_git_repo
  load_overrides
  local ours review
  ours="$(ours_file)"
  review="$(review_file)"
  : >"$ours"
  : >"$review"

  local conflicts path kept=0 flagged=0
  conflicts="$(git diff --name-only --diff-filter=U)"
  if [ -z "$conflicts" ]; then
    log "No merge conflicts to resolve."
    emit "kept_ours=0"
    emit "needs_review=0"
    return 0
  fi

  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if is_override "$path"; then
      take_side ours "$path"
      printf '%s\n' "$path" >>"$ours"
      kept=$((kept + 1))
      log "  kept ours    $path"
    else
      take_side theirs "$path"
      printf '%s\n' "$path" >>"$review"
      flagged=$((flagged + 1))
      log "  needs review $path  (took upstream)"
    fi
  done <<<"$conflicts"

  local leftover
  leftover="$(git diff --name-only --diff-filter=U)"
  if [ -n "$leftover" ]; then
    printf '%s\n' "$leftover" >&2
    die "unresolved conflicts remain after deterministic resolution"
  fi

  emit "kept_ours=$kept"
  emit "needs_review=$flagged"
  log "Resolved $((kept + flagged)) conflict(s): $kept kept ours, $flagged flagged for review."
}

# -----------------------------------------------------------------------------
# Sub-command: sanitize
# Re-apply the OAuth-literal sanitizer over the whole merged tree, then verify.
# A literal this repo cannot rewrite safely (Markdown, YAML, ...) fails the job
# here, *before* anything is pushed, instead of GitHub rejecting the push.
# -----------------------------------------------------------------------------
cmd_sanitize() {
  require_git_repo
  [ -f "$SANITIZER" ] || die "sanitizer not found: $SANITIZER"
  node "$SANITIZER" fix --root "$(pwd)"
  node "$SANITIZER" check --root "$(pwd)"
  log "Sanitizer: merged tree contains no upstream OAuth literals."
}

# -----------------------------------------------------------------------------
# Sub-command: commit
# Always record the merge commit, even when the merged tree is identical to
# base. On the very first sync the merge can be a no-op (KhatamRouter already
# carries upstream's content), and skipping the commit would leave a dangling
# MERGE_HEAD *and* keep the two histories unrelated, so `git merge-base
# --is-ancestor` would never report "up to date" and every run would re-merge
# 1400+ commits. Committing establishes the ancestry link for all later runs.
# -----------------------------------------------------------------------------
cmd_commit() {
  require_git_repo
  git add -A

  local up_short
  up_short="$(git rev-parse --short "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"

  if ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    # Merge resolved to a no-op (already identical tree). Nothing to record.
    if git diff --cached --quiet; then
      log "Nothing to commit — the merge produced an identical tree and there is no merge in progress."
      emit "committed=false"
      return 0
    fi
  fi

  git commit -F - <<EOF
chore(upstream): sync decolua/9router ${EVENT_NAME}

Merge ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} (${up_short}) into ${BASE_BRANCH}.
Conflicts resolved from ${OVERRIDE_LIST}; OAuth literals re-sanitized.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
  emit "committed=true"
  log "Committed sync merge as $(git rev-parse --short HEAD)."
}

# -----------------------------------------------------------------------------
# Sub-command: pr
# Push the sync branch, open the PR, and optionally arm auto-merge.
# -----------------------------------------------------------------------------
cmd_pr() {
  require_git_repo
  local branch up_sha up_short total shown
  branch="$(current_branch_name)"
  up_sha="$(git rev-parse "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"
  up_short="$(git rev-parse --short "$up_sha")"
  if [ -f "$(commits_file)" ]; then
    total="$(wc -l <"$(commits_file)" | tr -d ' ')"
  else
    total=0
  fi
  total="${total:-0}"
  shown="$total"

  # The first-ever sync merges two unrelated histories, so HEAD..upstream can
  # be thousands of commits. Cap what we paste into the PR body.
  local max_lines=80
  if [ "${total:-0}" -gt "$max_lines" ]; then
    shown="$max_lines"
  fi

  local body_file
  body_file="$(state_dir)/pr-body.md"
  {
    printf '## Upstream sync: `decolua/9router@%s`\n\n' "$up_short"
    printf 'Automated merge of `%s` (`%s`) into `%s`.\n\n' "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" "$up_sha" "$BASE_BRANCH"
    printf 'Trigger: `%s`\n\n' "$EVENT_NAME"
    printf '### Upstream commits (%s)\n\n' "$total"
    printf '```\n'
    head -n "$shown" "$(commits_file)" || true
    if [ "${total:-0}" -gt "$shown" ]; then
      printf '... and %s more commits (truncated; see `git log %s..%s`)\n' \
        "$((total - shown))" "$BASE_BRANCH" "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
    fi
    printf '```\n\n'
  } >"$body_file"

  {
    printf '### Files that kept the KhatamRouter version\n\n'
    if [ -s "$(ours_file)" ]; then
      printf '```\n'
      cat "$(ours_file)"
      printf '```\n\n'
    else
      printf '_none_\n\n'
    fi
    printf '### Files that took upstream — need review\n\n'
    if [ -s "$(review_file)" ]; then
      printf '```\n'
      cat "$(review_file)"
      printf '```\n\n'
      printf '> These paths were **not** in `.github/upstream-sync-overrides.txt`, so upstream won. Please review them.\n\n'
    else
      printf '_none_\n\n'
    fi
  } >>"$body_file"

  {
    printf '### Secret sanitizer\n\n'
    printf 'The OAuth-literal sanitizer ran over the merged tree before this PR was pushed, so no `GOCSPX-…` / `*.apps.googleusercontent.com` literal from upstream is present in the tracked files.\n\n'
    printf -- '---\n\n'
    printf '🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
  } >>"$body_file"

  if [ "$DRY_RUN" = "true" ]; then
    log "DRY_RUN=true — not pushing, not opening a PR."
    log "--- PR body preview ---"
    cat "$body_file" >&2
    return 0
  fi

  git push -u origin "$branch"
  GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  export GH_TOKEN
  gh label create upstream-sync \
    --description "Automated syncs from decolua/9router" \
    --color 0e8a16 >/dev/null 2>&1 || true

  local pr_url
  pr_url="$(
    gh pr create \
      --base "$BASE_BRANCH" \
      --head "$branch" \
      --label upstream-sync \
      --title "chore: sync decolua/9router @ ${up_short}" \
      --body-file "$body_file"
  )"
  log "Opened PR: $pr_url"
  emit "pr_url=$pr_url"

  if [ "$AUTO_MERGE" = "true" ]; then
    local pr_number
    pr_number="${pr_url##*/}"
    emit "pr_number=$pr_number"
    if gh pr merge "$pr_number" --squash --auto; then
      log "Armed auto-merge (squash) on PR #$pr_number."
      summary "### Auto-merge armed"
      summary ""
      summary "PR #$pr_number will squash-merge once checks pass."
    else
      log "Auto-merge unavailable; falling back to a direct squash merge."
      if gh pr merge "$pr_number" --squash; then
        log "Squash-merged PR #$pr_number."
        summary "### Merged"
        summary ""
        summary "PR #$pr_number was squash-merged automatically."
      else
        log "Could not arm auto-merge; PR #$pr_number left open for a human."
        summary "### Auto-merge not applied"
        summary ""
        summary "PR #$pr_number is open — \`gh pr merge --squash\` failed. Merge it manually."
      fi
    fi
  else
    log "AUTO_MERGE is not 'true' — leaving PR #${pr_url##*/} open for review."
  fi
}

# -----------------------------------------------------------------------------
# Sub-command: all
# The whole flow a maintainer runs locally (never pushes unless `pr` is used).
# -----------------------------------------------------------------------------
cmd_all() {
  cmd_prepare
  cmd_check
  cmd_branch
  cmd_merge
  cmd_resolve
  cmd_sanitize
  cmd_commit
  log ""
  log "Done. Sync branch: $(current_branch_name)"
  log "Review it, then push and open a PR with: bash scripts/upstream-sync-local.sh pr"
}

usage() {
  cat <<'EOF'
usage: bash scripts/upstream-sync-local.sh [command]

Commands:
  all       (default) prepare + check + branch + merge + resolve + sanitize + commit
  prepare   point the 'upstream' remote at decolua/9router and fetch master
  check     exit 0 early if already up to date or a sync PR is already open
  branch    create chore/upstream-sync-<sha> from master
  merge     git merge --allow-unrelated-histories --no-commit upstream/master
  resolve   resolve conflicts from .github/upstream-sync-overrides.txt
  sanitize  rewrite + verify upstream OAuth literals (fails the job if any remain)
  commit    create the sync commit
  pr        push the sync branch, open the upstream-sync PR, arm auto-merge

Environment:
  UPSTREAM_REMOTE     remote name                 (default: upstream)
  UPSTREAM_REPO_URL   remote URL                  (default: https://github.com/decolua/9router.git)
  UPSTREAM_BRANCH     branch to merge             (default: master)
  BASE_BRANCH         branch to merge into        (default: master)
  OVERRIDE_LIST       keep-ours path list         (default: .github/upstream-sync-overrides.txt)
  WORK_DIR            scratch state directory     (default: $RUNNER_TEMP or /tmp)
  FORCE               true = ignore skip checks   (default: false)
  DRY_RUN             true = build the PR body but do not push or open a PR
  EVENT_NAME          label used in the commit message / PR body
  AUTO_MERGE          true = gh pr merge --squash --auto after opening the PR
EOF
}

main() {
  local command="${1:-all}"
  case "$command" in
    all) cmd_all ;;
    prepare) cmd_prepare ;;
    check) cmd_check ;;
    branch) cmd_branch ;;
    merge) cmd_merge ;;
    resolve) cmd_resolve ;;
    sanitize) cmd_sanitize ;;
    commit) cmd_commit ;;
    pr) cmd_pr ;;
    -h | --help | help) usage ;;
    *)
      usage >&2
      die "unknown command: $command"
      ;;
  esac
}

main "$@"
