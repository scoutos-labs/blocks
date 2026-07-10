# Blocks — Reference Implementation Specification v2

> Scope: this document describes this repository's Node.js reference implementation and layout. The interoperability protocol is [PROTOCOL.md](PROTOCOL.md) Draft 04; it prevails on protocol behavior. This SPEC summarizes implemented behavior without creating a second protocol.

Vocabulary is fixed: **block** · **wire** · **gate** · **run** · **grant**.

## 1. Repository layout

```text
blocks/                 block library: SKILL.md, contract.json, optional run.mjs
cli/bin/blocks          zero-dependency Node >= 18 CLI
cli/src/                loader, validator, runner, audit, bindings, schema helpers
cli/tests/              node:test suites
workflows/              root curated workflows (*.workflow.json)
examples/workflows/     small example workflows
examples/runs/current/  current committed run ledgers that must audit cleanly
examples/runs/legacy/   historical run ledgers kept for reading, not current audit
keys/                   public approval-key registry only; private keys live outside workspace
runs/                   live local runs; gitignored
skills/                 agent-facing runner/composer skills
```

## 2. Blocks

A block directory contains `SKILL.md` and `contract.json`. `SKILL.md` uses only documented Claude Code skill frontmatter keys (`name`, `description`). Fuzzy block skill bodies are prompt contracts; deterministic block skill bodies are documentation.

`contract.json` is the machine source of truth:

- `name`, `version`, `kind` (`deterministic` or `fuzzy`), `inputs`, `outputs`.
- Deterministic blocks declare exactly one `exec` form: `argv` or `entry`, plus `permissions`.
- Fuzzy blocks declare no `exec` and no `permissions`; optional `oracle.claims` and `oracle.capability` are enforced by `record`.

The schema-lite subset and document closure rules are those in PROTOCOL.md Draft 04. Block outputs may use the protocol-4-only `enumFromInput` relation to require a scalar output to equal one member of a resolved array input; `check-output` then requires `--input <resolved-input.json>`. The validator rejects malformed schemas, invalid identifiers, unknown keys, invalid placeholders, malformed/empty argv, and unsupported protocol drafts with structured errors instead of stack traces.

## 3. Workflows

A workflow is strict JSON. Root workflows in this repository include:

- `workflows/changelog-from-git.workflow.json` — changelog v2, `protocol: 2`, with workflow `outputs`.
- `workflows/release.workflow.json` — release v2, `protocol: 3`, with workflow composition, Draft 03 `#`/`contains` gates, signed approval, and capability attestation.
- `workflows/triage-bug-report.workflow.json` — `protocol: 4`; contextual classifier output plus required-input static planning.

The implementation supports Draft 02 workflow `outputs` and `workflow` nodes. A parent workflow narrows the child workflow grants; child runs are recorded as child ledgers and audited recursively.

Draft 03 gates support:

- `left contains 'literal'` for string substring or array scalar membership.
- `#ref` length for strings and arrays.

Workflows using these constructs must declare `protocol: 3`. A workflow using a block with `enumFromInput` declares `protocol: 4`; Draft-4 gates cannot mix `and` and `or` in one expression.

## 4. CLI verbs

| Verb | Purpose |
| --- | --- |
| `blocks list [--json]` | Inventory blocks. |
| `blocks validate <workflow>` | Static validation: shape, pins, wires, gates, grants, composition. |
| `blocks graph <workflow>` | ASCII DAG render. |
| `blocks plan <workflow> [--state f]` | Static, read-only topo/status plan. It does not resolve runtime inputs, create runs, or mutate state. |
| `blocks exec <workflow> [--state f] [--out f] [--json] [--input k=v ...]` | Create/resume a run; `--json` returns derived complete/paused/failed/pending status. |
| `blocks runs [--json]` | Read-only inventory of derived run status and paused submission targets. |
| `blocks audit <run.json> [--json]` | Read-only protocol-3/4 ledger verifier. |
| `blocks approval --state f --node id --output f [--raw]` | Export the exact candidate-bound detached-signing payload. |
| `blocks check-output <block> <json\|-> [--input resolved.json]` | Validate a fuzzy output candidate; contextual contracts require input. |
| `blocks record --state f --node id --output f [--approval f\|--sign keyfile] [--attest capability]` | Validate/append fuzzy output; detached approval is preferred. |
| `blocks link <block> [--check]` | Link a block into `.claude/skills/`. |
| `blocks new block <name> --kind <deterministic\|fuzzy> [--claims a,b] [--capability name]` | Scaffold a block, optionally with a fuzzy oracle stanza. |
| `blocks new key <id> --claims <a,b> [--private-out f]` | Register a public key; private material is mode 0600 outside the workspace. |

Exit codes: `0` ok · `1` validation/contract/audit finding · `2` usage · `3` permission/authority refusal.

## 5. Run and resume behavior

New runs created by this runner are stamped `protocol: 4`, because the run ledger uses Draft 04 persistence and audit semantics. The runner refuses to resume or record into run documents from older or newer drafts; restamping would create mixed-preimage ledgers.

Run inputs are immutable after creation:

- Non-secret inputs are persisted as values and cannot be overridden on resume.
- Secret inputs are persisted only as `sha256:` digests over `blocks-secret-v1`, the run’s 128-bit public `secretSalt`, and RFC-8785 JSON. Resume may re-supply typed secret values; the salted digest must match, or the run is refused without mutation. Salt prevents cross-run linkage/precomputation, not low-entropy guessing.
- Unknown resume inputs are usage errors.

Static validation rejects secret-tainted workflow data wired into fuzzy node inputs, including transitive flow through deterministic nodes, because fuzzy pauses persist and print resolved input for the oracle. Secret-tainted data may flow into embedded workflow inputs only when the child interface marks that input `secret:true`.

Fuzzy pauses persist resolved node input and block hash before asking the oracle. Repeating the same pause is stable; changed pause input/hash evidence is refused without restamping. Schema-invalid fuzzy submissions burn attempts only after required signing/attestation checks pass.

## 6. Permissions and filesystem enforcement

Effective capability is computed per node as block permissions intersected with workflow grants. For filesystem grants the implementation uses cover semantics: a grant is effective only when the block declaration covers it. Workflows cannot grant capabilities no used block declared.

Runtime enforcement:

- argv blocks may execute only effective `run` binaries, via argv arrays and no shell.
- Entry blocks receive a mode-0600 temporary input file that is cleaned up after success or failure.
- Entry paths are contained in the block directory; traversal or symlink escape is refused.
- `read-file` and `write-file` normalize and realpath-check path inputs, fence symlink escapes, and refuse paths outside the workspace or outside effective grants.
- Where the local Node supports the permission model, entry scripts get Node fs flags narrowed to runtime necessities plus effective grants. On Node without that support, process-level fs sandboxing is unavailable; block-level realpath fencing still applies.
- `network: false` is validated and audited as a declaration, not sandbox-enforced.

## 7. Audit

`blocks audit <run.json> [--json]` never executes blocks and never invokes an oracle. It recomputes or verifies:

- run protocol and basic ledger shape;
- workflow file/hash and static validation;
- current block hashes under the run’s declared Draft 03/04 preimages;
- node output contracts and workflow outputs;
- child run paths, hashes, copied outputs, and recursive audit;
- signed approvals against public keys in `keys/`;
- `oracle.capability` attestations recorded by `record --attest`;
- secret-safe findings that name fields and expectations without dumping raw secrets, fuzzy inputs, signatures, or key material.

Committed current examples are under `examples/runs/current/` and are audited by CI. Historical examples under `examples/runs/legacy/` remain readable evidence; protocol-3 audit is supported, while drifted artifacts still produce findings. RFC-8785 vectors prove the committed Draft-3 approval bytes remain unchanged.

## 8. Draft 04 evidence and custody

Canonical, approval, block-hash, gate, and workflow fixtures live under `conformance/vectors/`. `cli/tests/draft04.test.js` consumes them. Detached approval is the trust path: `blocks approval` exports bytes from the paused ledger plus the candidate answer; an external signer creates `{keyId,signature}`; `record --approval` verifies using `keys/` and never opens private material. `--sign` remains a local convenience but refuses lexical or real paths inside the workspace. State writes use private temporary files plus atomic rename; callers still serialize writers because rename prevents corruption, not lost updates.

## 9. Non-goals

No hosted server, UI, daemon, triggers, schedules, dynamic fan-out, registry, model client, container sandbox, network sandbox, or broader gate language.
