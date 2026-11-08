#!/usr/bin/env bash
# Reads changed paths (one per line) on stdin and prints `docs_only=true` only
# when every path is documentation. Anything uncertain prints `docs_only=false`
# so CI falls back to running the container smoke and image publish.
#
# Documentation means: any `*.md` outside runtime source trees, plus the
# `docs/` and `specs/` trees. `src/`, `open-sse/` and `public/` are never docs
# because those trees ship in the image or are served by it.
set -euo pipefail

count=0
while IFS= read -r path || [ -n "$path" ]; do
  [ -z "$path" ] && continue
  count=$((count + 1))
  case "$path" in
    src/* | open-sse/* | public/*)
      echo "docs_only=false"
      exit 0
      ;;
    docs/* | specs/*)
      continue
      ;;
  esac
  lower=$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    *.md) continue ;;
  esac
  echo "docs_only=false"
  exit 0
done

if [ "$count" -eq 0 ]; then
  echo "docs_only=false"
else
  echo "docs_only=true"
fi
