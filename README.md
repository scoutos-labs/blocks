# Blocks

**Skill-shaped blocks that snap together into workflows an agent can run the
same way every time.**

Agents are great at figuring a task out once — and unreliable at doing it the
same way the fiftieth time. Blocks splits the difference: the repeatable part
of a task becomes a saved DAG of typed blocks that a tiny CLI executes
deterministically, and the parts that genuinely need judgment become **fuzzy**
blocks — prompt contracts the agent answers, schema-checked before the run
accepts them.

Here is a real workflow from this repo (it wrote [CHANGELOG.md](CHANGELOG.md)):

```
changelog-from-git  (v1, 5 nodes)

┌─ ● log      git-log@1          [det]     (source)
├─ ● draft    summarize@1        [~fuzzy]  ◀── log
├─ ● judge    llm-judge@1        [~fuzzy]  ◀── draft, log
├─ ● render   render-template@1  [det]     ◀── judge, draft
│     ◇ when nodes.judge.output.score >= 0.7 and nodes.judge.output.verdict == 'pass'
└─ ● publish  write-file@1       [det]     ◀── render
```

`git-log` runs an exact command. `summarize` and `llm-judge` are answered by
an agent — but their answers must fit a declared JSON schema, and the gate on
`render` is evaluated by the CLI from the recorded score, never by the agent's
mood. If the draft doesn't pass the judge, nothing gets written.

**The design law:** the CLI is the runtime for deterministic nodes; the agent
is the driver, and the oracle for fuzzy nodes. Run a workflow twice — the
deterministic nodes produce byte-identical outputs, and the run-state records
a hash of every block that executed, so you can prove it.

Five words carry the whole system: a **block** does one thing, a **wire**
binds an output to an input, a **gate** decides whether a node runs, a
**run** is a replayable record, and a **grant** is the workflow co-signing a
capability a block declared — a block never touches what the workflow didn't
grant.

## Quickstart

Node ≥ 18, no dependencies.

```sh
cli/bin/blocks list                                          # the block library
cli/bin/blocks validate workflows/changelog-from-git.workflow.json
cli/bin/blocks graph workflows/changelog-from-git.workflow.json
cli/bin/blocks exec workflows/changelog-from-git.workflow.json --input range=HEAD~5..HEAD
```

`exec` runs deterministic nodes and pauses at the first fuzzy one, printing
the block's prompt contract and the exact `blocks record` command that
continues the run. Any agent (or human) can be the oracle:

```sh
echo '{"summary": "..."}' > answer.json
cli/bin/blocks record --state runs/<run>.run.json --node draft --output answer.json
cli/bin/blocks exec workflows/changelog-from-git.workflow.json --state runs/<run>.run.json
```

Invalid answers are rejected with the exact violating field; three strikes
fails the node. Runs resume from their state file at any point.

## Blocks are literally skills

Every block is a directory with a `SKILL.md` (frontmatter + instructions —
loadable by Claude Code) and a `contract.json` (typed inputs/outputs, and for
deterministic blocks the exact command plus a permissions allowlist).
`blocks link <name>` symlinks a block into `.claude/skills/`.

Two agent-facing skills drive the system: **blocks-composer** builds new
workflows from the library (`skills/blocks-composer/`), and **blocks-runner**
executes saved ones (`skills/blocks-runner/`). `blocks new block <name>
--kind <deterministic|fuzzy>` scaffolds a block that already loads.

## Guarantees, honestly stated

- Bindings are filled as whole argv elements — never through a shell. A value
  of `"; rm -rf ."` arrives as those literal bytes (there's a test).
- Effective capability = block declarations ∩ workflow grants; ungranted
  binaries are refused, paths are workspace-fenced at validation and again at
  exec, and entry scripts run under Node's permission model where available.
- `network: false` is a reviewed declaration, not a sandbox — v1 has no
  containers, and says so.
- Fuzzy content is never trusted: schemas bound its shape, gates bound its
  blast radius, and prompt contracts tell the oracle to treat inputs as data,
  not instructions.

Everything normative lives in [SPEC.md](SPEC.md). Tests: `npm test`.
