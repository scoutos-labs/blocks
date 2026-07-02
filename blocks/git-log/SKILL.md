---
name: git-log
description: Deterministic block. Emit the commit log for a revision range as one line per commit (hash, date, subject), oldest first.
---

# git-log

Runs exactly:

    git log --no-color --reverse --date=short --pretty=format:%h %ad %s <range>

Same repository state + same range → same bytes out. The range arrives as one
literal argument — it is never shell-interpreted.

## Inputs
- `range` (string) — any git revision range: `HEAD~15..HEAD`, `v1.0..v1.1`, a branch name.

## Outputs
- `text` (string) — one commit per line: `abc1234 2026-07-02 subject line`.
