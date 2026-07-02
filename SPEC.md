# Blocks — Specification v1

Five words, used the same way everywhere: **block**, **wire**, **gate**, **run**, **grant**.

- A **block** is the atomic unit of work, shaped like a Claude Code skill.
- A **wire** is a data binding from one node's output to another node's input.
- A **gate** is a condition on a node that decides whether it executes.
- A **run** is one execution of a workflow, persisted as a run-state file.
- A **grant** is a capability the workflow gives a block; a node gets the *intersection* of what its block declares and what the workflow grants.

**Design law:** the CLI is the runtime for deterministic nodes; the agent is the driver, and the oracle for fuzzy nodes. Determinism is a property you can check — run a workflow twice and diff the run-state — not a promise an agent makes.

---

## 1. Repository layout

```
blocks/                 # the block library, one directory per block
  git-log/
    SKILL.md            # skill-shaped: frontmatter + human/agent instructions
    contract.json       # machine-readable source of truth
    run.mjs             # entry script (deterministic entry blocks only)
skills/
  blocks-runner/SKILL.md    # the agent protocol for executing a saved workflow
  blocks-composer/SKILL.md  # the agent protocol for building a new workflow
cli/
  bin/blocks            # zero-dependency Node >= 18 CLI
  src/                  # one module per concern (loader, validate, exec, ...)
  tests/                # node:test suites + fixtures
workflows/              # saved workflow DAGs (*.workflow.json)
runs/                   # live run-state files (gitignored)
examples/runs/          # curated, committed run-states + artifacts
SPEC.md                 # this document (normative)
README.md
```

## 2. Block format

A block is a directory under `blocks/` containing at minimum `SKILL.md` and `contract.json`.

### 2.1 SKILL.md

YAML frontmatter restricted to **documented Claude Code skill keys only** — `name` and `description`. No custom keys; skill compatibility must never rest on undocumented tolerance. Frontmatter is flat `key: value` lines (no nesting), so a full YAML parser is never required.

```markdown
---
name: git-log
description: Deterministic block. Emit the git commit log for a revision range as structured text.
---

# git-log

...spec-sheet body: what it does, inputs, outputs, worked examples...
```

The body of a **deterministic** block documents the exact procedure. The body of a **fuzzy** block *is the prompt contract*: role, rubric, the output schema restated in prose, and at least one worked example of valid output.

### 2.2 contract.json

The single machine-readable source of truth. Common fields:

```json
{
  "name": "git-log",
  "version": 1,
  "kind": "deterministic",
  "inputs":  { "<field>": <schema> },
  "outputs": { "<field>": <schema> }
}
```

- `name` must equal the directory name and the frontmatter `name`.
- `version` is a positive integer. Workflows pin blocks as `name@version`, exact match only.
- `kind` is `"deterministic"` or `"fuzzy"`.

**Deterministic blocks** add `exec` (exactly one variant) and `permissions`:

```json
"exec": { "argv": ["git", "log", "--reverse", "--pretty=%h %s", "{{inputs.range}}"], "capture": "text" }
```
or
```json
"exec": { "entry": "run.mjs" }
```

- **argv variant**: the CLI fills `{{inputs.*}}` placeholders — each placeholder must occupy a *whole argv element* and is inserted as a single literal argument, never split, never passed through a shell. `capture` is `"text"` (stdout becomes `{"text": "..."}` — the block's outputs must then declare exactly one string field named `text`) or `"json"` (stdout must parse as a JSON object matching `outputs`).
- **entry variant**: the CLI spawns `node <entry> <inputs-file.json>` via `execFile` (argv array, no shell) with `cwd` = workspace root. The script reads its inputs from the JSON file at `argv[2]` and prints a JSON object matching `outputs` to stdout. When the local Node supports the permission model, the CLI adds `--permission --allow-fs-read=<workspace> --allow-fs-write=<granted write paths>`; otherwise it warns that fs enforcement is audit-only.

```json
"permissions": { "run": ["git"], "read": ["**"], "write": [], "network": false }
```

- `run`: allowlisted binary names (argv[0]) this block may execute. Entry blocks that spawn nothing declare `[]`.
- `read` / `write`: workspace-relative path globs. Absolute paths and `..` segments are invalid.
- `network` defaults to `false`. **Honesty note:** `network: false` is validated and audited, not sandbox-enforced in v1 (no containers — see Non-goals). Command allowlists for argv blocks and fs flags for entry blocks are enforced; treat `network` as a reviewed declaration.

**Fuzzy blocks** have no `exec` and no `permissions`. Their outputs schema is the contract the agent's answer must satisfy; `blocks check-output` / `blocks record` enforce it.

### 2.3 Schema-lite

Input/output field schemas use this JSON-Schema subset and nothing more:

`type` (`string | number | boolean | array | object`), `required` (default `true`), `enum`, `pattern` (strings), `minimum` / `maximum` (numbers), `items` (arrays), `properties` (objects), `default` (workflow inputs only), `description`, `secret` (inputs only; see §7).

## 3. Workflow format

A workflow is a JSON file `workflows/<name>.workflow.json`. JSON, not YAML, deliberately: this is a determinism product, and JSON parses identically everywhere.

```json
{
  "name": "changelog-from-git",
  "version": 1,
  "notes": "Generate CHANGELOG.md from the commit log, judge it, write only if it passes.",
  "inputs": { "range": { "type": "string", "default": "HEAD~20..HEAD" } },
  "grants": { "run": ["git"], "read": ["**"], "write": ["CHANGELOG.md"] },
  "nodes": [
    { "id": "log",    "block": "git-log@1",          "in": { "range": "{{inputs.range}}" } },
    { "id": "draft",  "block": "summarize@1",         "in": { "text": "{{nodes.log.output.text}}" } },
    { "id": "judge",  "block": "llm-judge@1",         "in": { "candidate": "{{nodes.draft.output.summary}}" } },
    { "id": "write",  "block": "write-file@1",
      "when": "nodes.judge.output.score >= 0.7",
      "in": { "path": "CHANGELOG.md", "content": "{{nodes.draft.output.summary}}" } }
  ]
}
```

- `nodes[].id`: unique, `[a-z][a-z0-9-]*`.
- `nodes[].block`: exact pin `name@version`. The validator errors if the pin does not match the library copy.
- `nodes[].in`: one binding per declared block input (all required inputs bound).
- `nodes[].when`: optional gate (§5).
- `nodes[].after`: optional list of node ids for order-only dependencies (no data wire).
- `nodes[].notes`: optional free text.
- A workflow whose nodes are all fuzzy blocks is a **prompt DAG**; mixed workflows are the common case.

Edges are derived from bindings plus `after`. The graph must be acyclic.

## 4. Wires (binding grammar)

```
binding      = "{{" ref "}}"                      (whole-value binding)
             | text { "{{" ref "}}" text }        (string interpolation)
ref          = "inputs." key
             | "nodes." nodeId ".output." keypath
key          = ident
keypath      = ident { "." ident }
ident        = [a-zA-Z_][a-zA-Z0-9_-]*
```

- A **whole-value** binding (the entire string is one `{{...}}`) preserves the upstream type.
- **Interpolation** (binding embedded in longer text) is only valid when the target input is `type: string`; bound values must be string, number, or boolean.
- A node input may also be a **literal JSON value** (object, array, number, …). Bindings resolve anywhere a string sits inside it — e.g. `"values": {"body": "{{nodes.draft.output.summary}}"}`.
- `{{env.*}}` does not exist in v1 (see §7).
- The validator resolves every ref: `inputs.*` must be declared workflow inputs; `nodes.X.output.Y` must name an upstream node and a declared output field with a type compatible with the target input. Digging into a property-less `object` output (a generic block like `extract`) is legal but statically unknown — the contract check happens at run time instead.

## 5. Gates (`when` grammar)

A deliberately tiny grammar — not an expression language:

```
expr     = clause { ("and" | "or") clause }       (same precedence, left-associative)
clause   = ref op literal
op       = "==" | "!=" | ">=" | "<=" | ">" | "<"
literal  = number | "true" | "false" | squoted-string
ref      = as in §4
```

- Ordering comparisons (`>= <= > <`) require number refs and number literals.
- If a gate evaluates false, the node's status is `skipped` and every node depending on its outputs is `skipped` transitively (order-only `after` deps still run).
- A ref into a `skipped` node's output makes the gate false.

## 6. Runs (run-state format and protocol)

One execution = one file: `runs/<workflow>-<runId>.run.json`.

```json
{
  "workflow": "changelog-from-git",
  "workflowHash": "sha256:...",
  "runId": "r-...",
  "startedAt": "2026-07-02T15:00:00Z",
  "inputs": { "range": "HEAD~20..HEAD" },
  "nodes": {
    "log": {
      "status": "done",
      "blockHash": "sha256:...",
      "attempts": 1,
      "output": { "text": "..." }
    }
  }
}
```

- `status` ∈ `pending | done | skipped | failed`.
- `blockHash` = sha256 over the block's `SKILL.md` + `contract.json` + entry script, recorded at execution time for drift audit.
- Node records carry **no timestamps** — `runId` and `startedAt` live at the top level only, so the entire `.nodes` object is diffable.
- For a fuzzy node, the resolved input values are persisted on the node record (`"input"`) so the agent and auditors see exactly what the oracle was asked. Do not wire `secret` inputs into fuzzy nodes.
- **Determinism check:** two runs of the same workflow with the same inputs must produce byte-identical `.nodes` objects for all *deterministic* nodes (fuzzy outputs may legitimately vary; a det-only workflow must diff clean across its entire `.nodes`). `runId` and `startedAt` are the only fields allowed to differ.

**Runner protocol** (the runner skill instructs the agent; the CLI enforces):

1. `blocks plan <workflow> [--state <run.json>]` → topologically ordered node list with statuses; with `--state`, returns the next pending node (resumability).
2. Deterministic node → `blocks exec` runs it and appends to run-state. The agent never executes deterministic nodes by hand.
3. Fuzzy node → the agent reads the block's SKILL.md prompt contract, produces output JSON, then `blocks record --state <run.json> --node <id> --output <out.json>`. `record` schema-validates first and refuses invalid output.
4. Schema-invalid fuzzy output → at most **2 repair attempts** (validator errors fed back verbatim), then the node is `failed` and the run stops.
5. Gates are evaluated by the CLI from recorded outputs, never by agent judgment.

## 7. Permission and secrets model

- Effective capability = `block.permissions ∩ workflow.grants`, computed per node. For `run` the intersection is exact binary names; for `read`/`write` it is **cover semantics**: a granted glob is effective only if some block declaration covers it (`**` covers everything, `dir/**` covers `dir/...`, otherwise exact match). A workflow may not grant anything no block declared (a workflow granting `run: ["rm"]` when no block declares `rm` fails validation).
- argv blocks: `argv[0]` must be inside the effective `run` set at exec time, again (defense in depth).
- All paths workspace-relative. Declared path globs (block permissions, workflow grants) are rejected at validation if absolute or containing `..`; runtime path *values* (which may flow from bindings) are resolved, normalized, and rejected at exec time — the validator cannot know which string inputs are paths.
- No `{{env.*}}` bindings; run-state never persists process environment.
- An input schema may set `"secret": true`: its value is passed to the block but stored in run-state as `sha256:<digest>` only.
- `runs/` is gitignored; curated examples are committed under `examples/runs/` after manual review.

## 8. CLI verbs

| Verb | Purpose |
| --- | --- |
| `blocks list [--json]` | Inventory the block library (loader shared with all other verbs). |
| `blocks validate <workflow>` | Full static validation: JSON shape, pins, acyclicity, wire resolution + type compatibility, gate grammar, grants model. Errors carry file, JSON-pointer, expectation, and a fix hint. |
| `blocks graph <workflow>` | ASCII render of the DAG; gates visibly branch. |
| `blocks plan <workflow> [--state f]` | Topo order / next pending node. |
| `blocks exec <workflow> [--state f] [--out f] [--input k=v ...]` | Execute deterministic nodes up to the next fuzzy node or completion; create/update run-state. |
| `blocks check-output <block> <json\|-> ` | Validate candidate fuzzy output against the block's outputs schema. |
| `blocks record --state f --node id --output f` | Validate + append a fuzzy node's output to run-state. |
| `blocks link <block> [--check]` | Symlink a block into `.claude/skills/` so it loads as a live skill; `--check` verifies frontmatter uses only documented skill keys. |
| `blocks new block <name> --kind <k>` | Scaffold a block directory. |

Exit codes: `0` ok · `1` validation/contract failure · `2` usage error · `3` permission refusal.

## 9. Non-goals (v1)

No hosted server, UI, daemon, triggers, or schedules. No loops, recursion, arithmetic, or dynamic fan-out in the DAG (node-local bounded retry is not a loop). No parallel scheduler — topo-sequential. No version ranges, no registry. No container sandboxing — enforcement is argv discipline + allowlists + Node's permission model where available, stated honestly. The CLI never calls a model; the agent is the only fuzzy oracle.
