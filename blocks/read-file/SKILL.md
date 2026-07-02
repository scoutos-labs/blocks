---
name: read-file
description: Deterministic block. Read a workspace-relative text file; refuses absolute paths and anything that escapes the workspace.
---

# read-file

Reads one file, workspace-relative, UTF-8. Absolute paths and `..` escapes are
refused with exit 3 — at validation time, in this script, and (where the local
Node supports the permission model) by the OS-level fs fence.

## Inputs
- `path` (string) — e.g. `reports/bug-142.md`.

## Outputs
- `text` (string) — file contents.
- `bytes` (number) — UTF-8 byte length.
