# Blocks

[![CI](https://github.com/scoutos-labs/blocks/actions/workflows/ci.yml/badge.svg)](https://github.com/scoutos-labs/blocks/actions/workflows/ci.yml)

**Skill-shaped blocks that snap together into repeatable agent workflows.**

Blocks puts the predictable parts of an agent task in a typed DAG. The CLI executes deterministic nodes, evaluates gates, and records evidence. An agent or human steps in only for fuzzy judgment.

```text
validate → execute deterministic work → pause for judgment → record → resume → audit
```

Every run is a JSON ledger containing immutable inputs, typed outputs, workflow and block hashes, child runs, approvals, capability attestations, and effective grants.

## Why Blocks

Agent workflows usually mix two very different kinds of work:

- commands that should run exactly the same way every time;
- decisions that require judgment.

Blocks separates them. Deterministic blocks run as code with explicit capabilities. Fuzzy blocks are prompt contracts with typed outputs and bounded repair attempts. The runner never invokes a model, so the oracle can be a human, an agent, or another system.

Five words define the model:

| Term | Meaning |
| --- | --- |
| **block** | One deterministic action or fuzzy judgment. |
| **wire** | A typed binding between workflow inputs and node outputs. |
| **gate** | A runner-evaluated condition over recorded values. |
| **run** | The persisted, auditable execution ledger. |
| **grant** | The workflow co-signing a capability declared by a block. |

## Status

Blocks currently implements **Blocks Skill Protocol Draft 04**.

- Node.js 18 or newer
- zero runtime dependencies
- protocol-4 run ledgers
- read-only audit support for protocol 3 and 4
- RFC 8785 canonical JSON and language-neutral conformance vectors

The protocol is still a draft and may make breaking changes.

## Install from source

```sh
git clone https://github.com/scoutos-labs/blocks.git
cd blocks
npm test

# Run directly
cli/bin/blocks help

# Optional: expose `blocks` on your PATH
npm link
blocks help
```

The package is not published to npm yet.

## Quickstart

Inspect the block library and validate a workflow:

```sh
cli/bin/blocks list
cli/bin/blocks validate workflows/changelog-from-git.workflow.json
cli/bin/blocks graph workflows/changelog-from-git.workflow.json
cli/bin/blocks plan workflows/triage-bug-report.workflow.json
```

`plan` is static. It does not require missing runtime inputs, execute nodes, or create state.

Start a run:

```sh
cli/bin/blocks exec workflows/changelog-from-git.workflow.json \
  --input range=HEAD~5..HEAD
```

The runner executes deterministic nodes and pauses at the first fuzzy node. Follow the printed contract and record command:

```sh
printf '%s\n' '{"summary":"..."}' > answer.json
cli/bin/blocks record \
  --state runs/<run>.run.json \
  --node draft \
  --output answer.json

cli/bin/blocks exec workflows/changelog-from-git.workflow.json \
  --state runs/<run>.run.json
```

Run inputs are fixed at creation. Resume may re-supply typed secret inputs, but unknown inputs, non-secret overrides, and salted digest mismatches are refused without changing the ledger.

## A block

Each block is a directory containing a Claude Code-compatible `SKILL.md` and a closed `contract.json`.

```json
{
  "name": "git-log",
  "version": 2,
  "kind": "deterministic",
  "inputs": {
    "range": { "type": "string" }
  },
  "outputs": {
    "text": { "type": "string" }
  },
  "exec": {
    "argv": ["git", "log", "--oneline", "{{inputs.range}}"],
    "capture": "text"
  },
  "permissions": {
    "run": ["git"],
    "read": ["**"],
    "write": [],
    "network": false
  }
}
```

Bindings occupy whole argv elements. The runner does not interpolate shell fragments.

## A workflow

```json
{
  "name": "review-change",
  "version": 1,
  "protocol": 4,
  "inputs": {
    "range": { "type": "string", "default": "HEAD~5..HEAD" }
  },
  "grants": {
    "run": ["git"],
    "read": ["**"],
    "write": []
  },
  "nodes": [
    {
      "id": "history",
      "block": "git-log@2",
      "in": { "range": "{{inputs.range}}" }
    },
    {
      "id": "judge",
      "block": "llm-judge@1",
      "in": { "candidate": "{{nodes.history.output.text}}" }
    }
  ]
}
```

Workflows can expose typed outputs and embed other saved workflows. Child runs remain separate ledgers and are audited recursively.

## Detached approvals

Approval-bearing fuzzy nodes can be signed without giving the runner a private key.

```sh
cli/bin/blocks approval \
  --state runs/<run>.run.json \
  --node approve \
  --output answer.json \
  --raw > approval.payload

# An external Ed25519 signer creates:
# {"keyId":"release-key","signature":"..."}

cli/bin/blocks record \
  --state runs/<run>.run.json \
  --node approve \
  --output answer.json \
  --approval approval.json \
  --attest release-judgment-v1
```

`blocks new key` writes only the public registry document under `keys/`. Private material goes to a user-local key directory or an explicit path outside the workspace. The local `--sign` convenience refuses private-key paths inside the workspace.

## Discover and audit runs

Get machine-readable status without exposing fuzzy input:

```sh
cli/bin/blocks exec workflows/release.workflow.json --json
cli/bin/blocks runs --json
```

Audit a run without executing blocks or invoking an oracle:

```sh
cli/bin/blocks audit runs/<run>.run.json
cli/bin/blocks audit runs/<run>.run.json --json
```

Audit recomputes workflow and block hashes, output contracts, child runs, workflow outputs, approvals, and capability evidence.

Two committed smoke ledgers demonstrate the current format:

```sh
npm run audit:examples
```

## Security model

Blocks is explicit about what it enforces:

- argv execution uses no shell;
- effective capabilities are the intersection of block declarations and workflow grants;
- path-accepting blocks realpath-check workspace and symlink boundaries;
- Node filesystem permission flags are used when the installed runtime supports them;
- secret-derived values are rejected before they can flow into fuzzy inputs;
- private keys stay outside the workspace;
- `network: false` is a reviewed declaration, not a network sandbox;
- atomic file replacement prevents truncated run JSON, while callers still serialize writers.

Blocks does not provide a container, daemon, hosted service, model client, PKI, dynamic fan-out, or general expression language.

## Repository map

```text
blocks/                 block library
cli/bin/blocks          command-line entry point
cli/src/                loader, validator, runner, audit, evidence helpers
cli/tests/              node:test suites
conformance/vectors/    language-neutral Draft 04 vectors
workflows/              example workflows
examples/runs/          current and historical run ledgers
skills/                 composer and runner skills for agents
PROTOCOL.md             normative interoperability protocol
SPEC.md                 reference implementation specification
blocks-protocol.html    generated protocol publication artifact
```

## Development

```sh
npm test
npm run validate:workflows
npm run audit:examples
npm run check:protocol
npm run ci
```

`npm run ci` currently runs 119 tests, validates all root workflows, checks static planning, audits current examples, verifies all 147 protocol requirement IDs, and confirms that `blocks-protocol.html` is byte-generated from `PROTOCOL.md`.

## Documentation

- [Blocks Skill Protocol Draft 04](PROTOCOL.md)
- [Reference implementation specification](SPEC.md)
- [Protocol HTML artifact](blocks-protocol.html)
- [Changelog](CHANGELOG.md)
