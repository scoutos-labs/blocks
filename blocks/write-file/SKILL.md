---
name: write-file
description: Deterministic block. Write content to a workspace-relative path, creating parent directories. The workflow's write grants decide where it may land.
---

# write-file

Writes `content` to `path`, creating parent directories. The block declares
`write: ["**"]` — maximally capable — so the **workflow's `grants.write` is the
real fence**: a changelog workflow grants `["CHANGELOG.md"]` and nothing else.
Absolute paths and `..` escapes are refused with exit 3 regardless of grants.

## Inputs
- `path` (string), `content` (string).

## Outputs
- `path` (string) — the path written.
- `bytes` (number) — bytes written.
