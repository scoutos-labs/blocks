---
name: blocks-composer
description: Compose a new Blocks workflow (*.workflow.json) from the block library for a stated problem. Use when asked to automate a repeatable task with blocks — inventory, wire, gate, validate, render, iterate until clean.
---

# blocks-composer

You turn a stated, repeatable problem into a saved workflow DAG. You never
invent syntax: everything you emit must pass `blocks validate`, and the
validator's error messages are your iteration loop.

Vocabulary: block · wire · gate · run · grant (see SPEC.md).

## Protocol

1. **Inventory.** `blocks list --json` — the library of blocks with their
   kinds, inputs, outputs, and permissions. Read the SKILL.md of any block
   you intend to use.
2. **Shape the DAG on paper first.** Which steps are mechanical
   (deterministic blocks) and which need judgment (fuzzy blocks)? Where does
   a gate belong — typically after an `llm-judge`-style node, deciding
   whether to proceed, branch, or stop.
3. **Write `workflows/<name>.workflow.json`** (SPEC.md §3):
   - pin blocks exactly: `"block": "git-log@1"`;
   - wire with `{{inputs.<key>}}` and `{{nodes.<id>.output.<field>}}` only;
   - gate with the tiny `when` grammar: `ref op literal [and|or ...]`;
   - grant only what the blocks in this workflow declare — grants co-sign,
     they never expand;
   - give every non-obvious node a `notes` line.
4. **Iterate until clean.** `blocks validate workflows/<name>.workflow.json`
   — fix exactly what each error names (every error carries a JSON pointer
   and a hint). Do not suppress or work around a validator finding.
5. **Render for sign-off.** `blocks graph workflows/<name>.workflow.json`
   and show it to the user before the first run.
6. **Missing capability?** If no block fits a step, scaffold one:
   `blocks new block <name> --kind <deterministic|fuzzy>`, fill in its
   SKILL.md and contract.json, confirm with `blocks list`, then use it.
   Prefer one small block per concern over one block that does everything.

## Design taste

- Deterministic wherever possible; fuzzy only where judgment is genuinely
  required. A fuzzy node that could be a `grep` is a bug.
- Keep fuzzy contracts narrow: an enum verdict plus a bounded score beats
  free text; downstream gates need comparable outputs.
- Fewer, clearer nodes beat clever ones. If a workflow needs a loop, the
  problem is not yet block-shaped — split it or rethink (loops are a
  non-goal, SPEC.md §9).
- Secrets: never wire a `secret` input into a fuzzy node, and never add
  `network: true` blocks without flagging it to the user.

## Handoff

Finish by telling the user: the workflow path, the rendered graph, which
nodes are fuzzy (and thus will need an oracle at run time), and the exact
run command: `blocks exec workflows/<name>.workflow.json --input ...`.
Runs are executed with the **blocks-runner** skill.
