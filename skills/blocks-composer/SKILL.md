---
name: blocks-composer
description: Compose a new Blocks workflow (*.workflow.json) from the block library for a stated problem. Use when asked to automate a repeatable task with blocks — inventory, wire, gate, validate, render, iterate until clean.
---

# blocks-composer

You turn a stated, repeatable problem into a saved workflow DAG. Emit only workflow JSON the current validator accepts. The validator is your iteration loop; do not invent syntax.

Vocabulary: block · wire · gate · run · grant (see SPEC.md and PROTOCOL.md Draft 04).

## Protocol

1. **Inventory.** `cli/bin/blocks list --json`. Read `SKILL.md` for every block you plan to use.
2. **Shape the DAG before writing JSON.** Mark deterministic nodes, fuzzy nodes, gates, workflow outputs, and any child workflows.
3. **Write `*.workflow.json`.**
   - Pin blocks exactly, e.g. `"block": "git-log@2"`.
   - Wire only with `{{inputs.<key>}}` and `{{nodes.<id>.output.<field>}}`.
   - Use literals when a value is constant; whole-value bindings preserve type.
   - Grant only capabilities declared by blocks in the workflow. Grants co-sign and narrow; they never expand.
   - Add `outputs` when the workflow should expose a final value to a parent workflow or audit. Design reusable child workflows with declared outputs and parameterized inputs instead of baked-in paths/labels.
   - Use `"workflow": "child-name@version"` nodes only for saved child workflows whose own outputs satisfy the parent wire.
   - Declare `"protocol": 3` when using Draft 03 gates (`contains` or `#`). Declare `"protocol": 4` when a block output uses `enumFromInput`; Draft-4 gates must not mix `and` and `or` in one expression.
4. **Gate carefully.** The grammar is deliberately tiny: `ref op literal` clauses joined by `and`/`or`. Draft 03 adds `contains` and `#ref` length gates. Under protocol 4 use only one join kind per gate. Do not add parentheses, precedence assumptions, arithmetic, functions, dynamic fan-out, or ref-to-ref comparisons.
5. **Validate and iterate.** `cli/bin/blocks validate <workflow.json>`; fix exactly what each finding names.
6. **Plan without values when useful.** `cli/bin/blocks plan <workflow.json>` is static and non-mutating, so it is safe for required-input workflows.
7. **Render for sign-off.** `cli/bin/blocks graph <workflow.json>` and show the user the DAG before first execution.
8. **Missing capability?** Scaffold a small block with `cli/bin/blocks new block <name> --kind <deterministic|fuzzy>`, fill `SKILL.md` and `contract.json`, confirm with `blocks list`, then use it. Prefer one concern per block.

## Design taste

- Deterministic wherever possible; fuzzy only for real judgment.
- Keep fuzzy outputs narrow and typed; downstream gates need comparable values.
- Do not route secrets into fuzzy nodes. Secret workflow inputs are for deterministic execution and resume digest checks.
- For filesystem work, prefer specific read/write grants. Remember effective access is block declaration intersected with workflow grant, and read/write blocks also enforce symlink-fenced workspace paths.
- `network: false` is a reviewed declaration, not a sandbox.
- If a release-style fuzzy block requires `oracle.claims` or `oracle.capability`, scaffold with `new block ... --kind fuzzy --claims ... --capability ...`; document detached `record --approval ... --attest ...`. Private keys stay outside the workspace.

## Handoff

Finish by telling the user: workflow path, rendered graph, protocol version, workflow outputs, required inputs, grants, fuzzy nodes and any signing/attestation needs, and the exact run command. Runs are executed with the **blocks-runner** skill.
