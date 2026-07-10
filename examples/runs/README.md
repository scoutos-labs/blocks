# examples/runs

Committed run ledgers for review and audit examples.

- `current/` contains current curated runs that must pass `blocks audit` from a clean checkout.
- `legacy/` contains historical protocol-1/2/3 or drifted examples kept for context. They are intentionally excluded from current CI audit and may fail `blocks audit`.

Live local runs belong in `runs/` (gitignored), not here.
