#!/usr/bin/env bash
# Publish one generated file into the orphan `wx-data` branch (as wx/<name>), keeping the other files there.
# Safe next to the forecast and NOTAM publishers: the push only replaces the branch if it is still the one we
# read (--force-with-lease); otherwise it reads again and retries.
# usage: scripts/publish-wx-file.sh <local file> <commit message> [remote, default origin]
set -u
file="$1"; msg="$2"; remote="${3:-origin}"
name="$(basename "$file")"
tmp="$(mktemp -d)"; cp "$file" "$tmp/$name"
git config user.name "xc-gpt-bot"
git config user.email "actions@users.noreply.github.com"
for attempt in 1 2 3 4 5; do
  git checkout -q --detach 2>/dev/null || true
  git branch -D wx-data-tmp >/dev/null 2>&1 || true
  if git fetch -q --depth=1 "$remote" wx-data 2>/dev/null; then
    base="$(git rev-parse FETCH_HEAD)"
    git checkout -q --orphan wx-data-tmp "$base"
    lease="--force-with-lease=wx-data:$base"
  else
    base=""
    git checkout -q --orphan wx-data-tmp
    git rm -rq --ignore-unmatch . >/dev/null 2>&1
    lease=""
  fi
  mkdir -p wx
  cp "$tmp/$name" "wx/$name"
  git add wx
  git commit -q -m "$msg"
  if git push -q $lease "$remote" HEAD:wx-data; then echo "published wx/$name (attempt $attempt)"; exit 0; fi
  echo "push lost a race, trying again ($attempt)"; sleep $((attempt * 3))
done
echo "could not publish wx/$name" >&2
exit 1
