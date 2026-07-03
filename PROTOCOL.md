# The Blocks Skill Protocol

**Draft 02 · 2026-07-02 · status: DRAFT — expect breaking changes · supersedes Draft 01**

---

## 0. Status of this document (informative)

This is Draft 02 of the Blocks Skill Protocol. It is an interoperability
specification: a party who has never read the reference implementation should
be able to build conforming blocks, workflows, runners, oracles, or composers
from this document alone, and have them interoperate with everyone else's.

Draft 02 supersedes Draft 01 in place and is a strict superset: every
conforming Draft-01 document remains conforming, and all changes are
additive — workflow composition (§9.1–§9.2), signed approvals (§12.4), and
the `protocol` version field ([VER-4], [VER-5]).
[§18](#18-changes-from-draft-01-informative) lists every change. One
symmetry carries all of it: grants co-sign a block's capabilities (Draft
01); a parent workflow co-signs an embedded child's grants (§9.2); an
approval co-signs an oracle's judgment (§12.4).

Draft status means exactly what it says. No stability is promised between
drafts, there is no semantic-versioning pledge, and the strict unknown-key
rules in this document are the extension policy: a document that needs a new
key needs a new draft of this protocol, not a vendor prefix.

Relationship to `SPEC.md` (the reference implementation's specification, in
the same repository): this document is normative for everything about
interoperability — formats, grammars, and observable behavior between
parties. `SPEC.md` remains normative for the reference implementation's
internals and repository layout. Where the two disagree about protocol
behavior, this document wins and the disagreement is a defect; every known
divergence at the time of writing is catalogued in
[Appendix D](#appendix-d--clarifications-vs-specmd-v1-informative).

The protocol does not require JavaScript, Node.js, or any particular
language anywhere. A runner written in Python, Rust, or shell is conforming
if it satisfies [§12](#12-the-runner-protocol-normative).

## 1. Introduction and design law (informative)

Agents are good at figuring a task out once and unreliable at doing it the
same way the fiftieth time. The Blocks protocol splits a repeatable task into
a saved DAG of typed **blocks**: deterministic blocks that a runner executes
as code, and fuzzy blocks — prompt contracts whose answers an oracle
produces and a schema check admits. One law organizes every rule in this
document:

> **The runner is the runtime for deterministic nodes; the agent is the
> driver, and the oracle for fuzzy nodes.**

Determinism is a property you can check, not a promise an agent makes: runs
are files, deterministic node records reproduce, and every executed block is
hash-stamped. The interoperability goal is symmetric: any conforming
composer's workflow runs on any conforming runner with any conforming oracle.

## 2. Terminology and conventions (normative)

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, RECOMMENDED, MAY,
and OPTIONAL in this document are to be interpreted as described in RFC 2119
and RFC 8174 when, and only when, they appear in all capitals.

Five words are used in one fixed sense throughout the protocol:

- **block** — the atomic unit of work: a skill-shaped directory with a typed
  contract, of kind `deterministic` or `fuzzy` ([§6](#6-the-block-normative)).
- **wire** — a data binding from a workflow input or a node's output to
  another node's input ([§7](#7-wires-normative)).
- **gate** — a `when` condition on a node, evaluated by the runner from
  recorded outputs ([§8](#8-gates-normative)).
- **run** — one execution of a workflow, persisted as a run document
  ([§11](#11-the-run-document-normative)).
- **grant** — the workflow co-signing a capability a block declared; a node
  receives the intersection ([§10](#10-permissions-and-grants-normative)).

Requirements carry stable identifiers in square brackets, e.g. `[BLK-3]`.
[Appendix C](#appendix-c--conformance-checklist-normative) aggregates all of
them. Sections and appendices are marked (normative) or (informative);
examples are always informative, and every example in this document is a
verbatim artifact from the reference repository — real hashes, real scores.

All protocol documents are strict JSON (RFC 8259), encoded UTF-8. Run
document keys are camelCase; block, workflow, node, and input names are
lowercase kebab or snake per their grammars in [§4](#4-common-syntax-normative).

## 3. Conformance (normative)

The protocol defines three document classes and three actor classes:

| Class | Kind | Conforms when |
| --- | --- | --- |
| **Block** | document | its directory satisfies every requirement in §6 (and §5 for its schemas) |
| **Workflow** | document | its file satisfies every requirement in §9 (and §7, §8, §10 for its wires, gates, and grants) |
| **Run** | document | its file satisfies every requirement in §11 |
| **Runner** | actor | it validates, executes, and records as required by §12 (with §10 enforcement) |
| **Oracle** | actor | its observable behavior satisfies §13 |
| **Composer** | actor | every workflow it emits is a conforming Workflow and it satisfies §14 |

There is no separate validator class: a validate-only tool conforms by
satisfying the static-validation subset of §12 ([RNR-1]–[RNR-4]) and nothing
else. There is no registry, library, or transport class; distribution of
blocks is out of scope ([§17](#17-non-goals-normative)).

## 4. Common syntax (normative)

[SYN-1] An **identifier** (`ident`) MUST match `[a-zA-Z_][a-zA-Z0-9_-]*`.
Identifiers name workflow inputs, block input fields, and output fields.

[SYN-2] A **node id** and a **workflow name** MUST match `[a-z][a-z0-9-]*`.

[SYN-3] A **block name** MUST match `[a-z][a-z0-9-]*` and MUST equal the name
of the directory that contains the block.

[SYN-4] A **pin** MUST take the form `name@version` where `name` satisfies
[SYN-3] and `version` is the decimal representation of a positive integer.
Pins are exact: there are no ranges, prefixes, or wildcards.

[SYN-5] A **hash** MUST take the form `sha256:` followed by exactly 64
lowercase hexadecimal characters, and MUST be the SHA-256 of the preimage
defined where the hash field is specified ([§11](#11-the-run-document-normative)).

[SYN-6] Timestamps MUST be RFC 3339 UTC timestamps (e.g.
`2026-07-02T15:04:05Z` or with fractional seconds).

## 5. Schema-lite (normative)

Schema-lite is the deliberately small JSON-Schema subset used for every
typed surface in the protocol: block inputs, block outputs, and workflow
inputs. It is closed by [SCH-8].

[SCH-1] A field schema MUST be a JSON object whose keys are drawn only from:
`type`, `required`, `enum`, `pattern`, `minimum`, `maximum`, `items`,
`properties`, `default`, `description`, `secret`. A schema containing any
other key is invalid.

[SCH-2] `type` is REQUIRED and MUST be one of `string`, `number`, `boolean`,
`array`, `object`.

[SCH-3] Applicability constraints: `pattern` applies only to `string`;
`minimum` and `maximum` apply only to `number`; `items` applies only to
`array` and is itself a field schema; `properties` applies only to `object`
and maps property names to field schemas; `enum` MUST be a non-empty array
when present. Violations make the schema invalid.

[SCH-4] `required` defaults to `true`. `default` is meaningful only on
workflow inputs ([§9](#9-the-workflow-document-normative)); `secret` is
meaningful only on workflow inputs ([§11](#11-the-run-document-normative)).

[SCH-5] A value **validates against** a field schema when: its JSON type
matches `type` (arrays are `array`, null matches nothing); it is a member of
`enum` when present; it matches `pattern` when present (ECMAScript regular
expression semantics); it is within `minimum`/`maximum` when present; every
array element validates against `items` when present; and, for objects with
`properties`, every declared required property is present and every present
declared property validates recursively.

[SCH-6] **Shape validation** checks a JSON object against a map of field
schemas (a contract's `inputs` or `outputs`): every field whose schema has
`required` other than `false` MUST be present; every present field MUST
validate against its schema; and every field present in the object MUST be
declared in the map. Undeclared fields are a validation error — contracts
are exact, not open-ended.

[SCH-7] Validation errors SHOULD name the exact offending field by JSON
pointer and state the expectation; implementations SHOULD include a fix hint.

[SCH-8] Schema-lite is closed: implementations MUST NOT extend the key set,
the type set, or the validation semantics of this section.

An object schema with `type: "object"` and no `properties` admits any JSON
object. This is the escape hatch for generic blocks (such as an extractor
whose fields are chosen per workflow); its static-typing consequences are
defined in [WIR-8].

## 6. The block (normative)

[BLK-1] A block MUST be a directory containing at least `SKILL.md` and
`contract.json`. The directory name is the block name [SYN-3].

### 6.1 SKILL.md

The skill file makes the block loadable as an agent skill and carries the
human- and oracle-facing instructions.

[BLK-2] `SKILL.md` MUST begin with YAML-style frontmatter delimited by `---`
lines, containing only flat `key: value` pairs — no nesting, no lists. A
full YAML parser is deliberately not required to parse it.

[BLK-3] Frontmatter keys are restricted to exactly `name` and `description`.
Any other key makes the block invalid. Structured, machine-read data belongs
in `contract.json`. When `name` is present it MUST equal the block name.

[BLK-4] For a fuzzy block, the body of `SKILL.md` is the prompt contract.
It SHOULD state the role or judgment the oracle performs, restate the
output schema in prose, and include at least one worked example of valid
output; the machine-checkable floor is [BLK-6]'s declared outputs, which
admit or reject whatever the body elicits. For a deterministic block the
body documents the exact procedure; it is descriptive, and the contract's
`exec` is what executes.

### 6.2 contract.json

[BLK-5] `contract.json` MUST be a JSON object with exactly these keys:
`name` (equal to the block name), `version` (a positive integer), `kind`
(`"deterministic"` or `"fuzzy"`), and OPTIONAL `inputs` and `outputs` (maps
of field name [SYN-1] to field schema, §5) — plus, for deterministic blocks
only, `exec` (REQUIRED) and `permissions` (REQUIRED), and, for fuzzy blocks
only, OPTIONAL `oracle` (demands on the answering oracle,
[§12.4](#124-signed-approvals-normative)). Unknown keys make the contract
invalid.

[BLK-6] A fuzzy block MUST NOT declare `exec` or `permissions`, and MUST
declare at least one output field. The outputs schema is the contract that
admits or rejects an oracle's answer.

[BLK-7] `exec` MUST contain exactly one of:

- `argv`: an array of strings — the command as an argument vector; with
  OPTIONAL `capture`, either `"text"` or `"json"`, defaulting to `"json"`.
- `entry`: the path, relative to the block directory, of an executable entry
  script that exists.

[BLK-8] Placeholders in `argv` use the whole-value binding form
`{{inputs.<key>}}` and MUST each occupy an entire argv element. A
placeholder embedded in a longer string, a placeholder that names an
undeclared input, or a placeholder in `argv[0]` makes the block invalid.
(`argv[0]`, the binary, is always literal.)

[BLK-9] With `capture: "text"`, the block's outputs MUST be exactly
`{ "text": { "type": "string" } }`; the captured standard output becomes
`{"text": "<stdout>"}`. With `capture: "json"`, standard output MUST parse
as a single JSON object, which is the node's output.

[BLK-10] An entry script receives the path of a JSON file holding its
resolved input values as its single argument, runs with the workspace root
as working directory, and MUST print exactly one JSON object (its output) to
standard output.

[BLK-11] `permissions` MUST be an object with `run` (array of binary names),
`read` and `write` (arrays of workspace-relative path globs), and OPTIONAL
`network` (boolean, default `false`). Path globs MUST NOT be absolute and
MUST NOT contain `..` segments. For an argv block, `argv[0]` MUST be a
member of its own `run` list.

[BLK-12] Contracts are closed documents: `contract.json`, its `exec` object
(keys `argv`, `capture`, `entry` only), its `permissions` object (keys
`run`, `read`, `write`, `network` only), and its `oracle` object (key
`claims` only, [SIG-1]) reject unknown keys, and `capture` is valid only in
the argv variant. Validators MUST treat violations as errors — the
strictness is the extension policy [VER-3].

[BLK-13] A deterministic block that accepts filesystem paths among its
inputs MUST itself refuse a resolved path value that is absolute or escapes
the workspace root after normalization, concluding in the permission-refusal
outcome class ([RNR-13]) — an entry script does so by exiting with status 3.
Grants narrow where such a block may act; this rule holds regardless of
grants, because only the block knows which of its inputs are paths.

## 7. Wires (normative)

Wires bind data into node inputs. The grammar:

```ebnf
template     = { text | binding } ;
binding      = "{{", [ws], ref, [ws], "}}" ;
ref          = "inputs.", key
             | "nodes.", node-id, ".output.", keypath ;
key          = ident ;
keypath      = ident, { ".", ident } ;
```

`ident` is [SYN-1]; `node-id` is [SYN-2].

[WIR-9] The two ref forms above are the only ref forms. There is no `env`
ref, and implementations MUST NOT add one — the process environment is not
bindable ([§16](#16-security-considerations-normative)).

Test vectors — these parse as refs: `inputs.range` ·
`nodes.log.output.text` · `nodes.facts.output.data.title`. These do not:
`nodes.log.text` (missing `.output.`) · `inputs.a b` · `env.HOME` ·
`nodes.Log.output.x` (node ids are lowercase).

[WIR-1] A **whole-value** binding — a string that is exactly one binding —
resolves to the referenced value with its type preserved.

[WIR-2] **Interpolation** — one or more bindings embedded in longer text —
is valid only when the target input has `type: "string"`, and each
referenced value MUST be a string, number, or boolean, which is converted to
its string form. Interpolating an array or object is an error.

[WIR-3] A node input MAY be a **literal JSON value** of any type. Bindings
resolve anywhere a string sits inside such a literal, recursively through
arrays and objects (deep resolution). Example: `"values": {"body":
"{{nodes.draft.output.summary}}"}` binds inside a literal object. Inside a
literal, a nested string has no declared target type: [WIR-2]'s
string-target restriction does not apply statically ([WIR-6] checks
nothing for such strings); at run time, whole-value bindings keep their
type [WIR-1], interpolation follows [WIR-2]'s scalar rule, and the fully
resolved literal is checked as a whole by [WIR-7].

[WIR-4] An unterminated `{{` or a ref that does not match the grammar is a
validation error, not literal text.

[WIR-5] Static resolution: `inputs.<key>` MUST name a declared workflow
input; `nodes.<id>.output.<keypath>` MUST name another node in the same
workflow, and the keypath MUST resolve through that node's block's declared
outputs (descending `properties` for objects).

[WIR-6] Static typing: a whole-value wire's source type MUST equal the
target input's declared type. Interpolated sources MUST be statically
`string`, `number`, `boolean`, or unknown ([WIR-8]).

[WIR-7] At execution time, resolved node inputs MUST be shape-validated
[SCH-6] against the block's declared inputs before the node executes or is
offered to an oracle; a violation fails the run.

[WIR-8] Digging a keypath into an object output that declares no
`properties` is statically legal and yields the type **unknown**, which is
exempt from [WIR-6]'s static checks; the value is still checked at run time
by [WIR-7] and, when referenced by a gate, by [GAT-5]. A missing key at
resolution time is an execution error.

## 8. Gates (normative)

A gate is a node's `when` condition. The grammar is deliberately tiny — it
is not an expression language ([GAT-7]):

```ebnf
expr      = clause, { ws, join, ws, clause } ;
join      = "and" | "or" ;
clause    = ref, ws, op, ws, literal ;
op        = "==" | "!=" | ">=" | "<=" | ">" | "<" ;
literal   = number | "true" | "false" | sq-string ;
number    = ["-"], digits, [".", digits] ;
sq-string = "'", { any character except "'" }, "'" ;
```

`ref` is the wire ref form of §7. Single-quoted strings have no escape
mechanism.

Test vectors — these parse:
`nodes.judge.output.score >= 0.7 and nodes.judge.output.verdict == 'pass'` ·
`inputs.dry-run == true` · `nodes.severity.output.label != 'p1'`.
These do not: `(nodes.a.output.x == 1)` · `nodes.a.output.x + 1 == 2` ·
`nodes.a.output.x >= 'high'` (ordering needs a number literal) ·
`nodes.a.output.x == nodes.b.output.y` (literals only on the right).

[GAT-1] The four ordering operators (`>=`, `<=`, `>`, `<`) MUST be rejected
at parse time unless the literal is a number.

[GAT-2] Joins have equal precedence and evaluate left-associatively:
`a or b and c` means `(a or b) and c`.

[GAT-3] Gates MUST be evaluated only by the runner, and only from values
recorded in the run document (workflow inputs and `done` nodes' outputs).
An oracle's opinion of a gate is not an input to anything.

[GAT-4] A clause whose ref names a node with no recorded output (pending,
skipped, or failed), whose keypath is missing from the recorded output, or
whose ref names a workflow input with no resolved value, evaluates to
false. It is not an error.

[GAT-5] A clause with an ordering operator whose resolved left value is not
a number evaluates to false. Equality (`==`) and inequality (`!=`) compare
by strict value equality of JSON scalars.

[GAT-6] Statically, a gate's refs are resolved per [WIR-5], and an ordering
clause whose ref is statically typed non-number (and not unknown) is a
validation error.

[GAT-7] The gate grammar is closed: conforming implementations MUST NOT
extend it — no parentheses, arithmetic, functions, ref-to-ref comparison,
or nesting, in any draft that calls itself this protocol.

## 9. The workflow document (normative)

A workflow is a single JSON file.

[WFL-1] The document MUST contain `name` [SYN-2] and `version` (positive
integer), and a non-empty `nodes` array; it MAY contain `notes` (free
text), `inputs` (a map of input name [SYN-1] to field schema, where
`default` supplies a value when the invocation omits one and `secret` marks
digest-on-persist inputs), `grants` (§10), `outputs` (§9.1), and `protocol`
([VER-4]).

[WFL-2] Each node MUST have a unique `id` [SYN-2] and exactly one of: a
`block` pin [SYN-4] that resolves to a block in the library, or a
`workflow` pin (§9.2) that resolves to a workflow file — in both cases with
name and version matching exactly; a pin to any other version is an error
naming the available version.

[WFL-3] Each node MAY have `in` (a map from the declared input names of its
block — or of its embedded workflow — to wire templates or literal values),
`when` (a gate, §8), `after` (an array of node ids establishing order-only
dependencies), and `notes`. Every declared input that is required (and, for
embedded workflows, has no `default`) MUST be bound in `in`; binding an
undeclared input is an error.

[WFL-4] The dependency edges of a workflow are the union of: the node refs
of all wires in `in` (including those found by deep resolution [WIR-3]),
the node refs of the `when` gate, and the `after` list. The resulting graph
MUST be acyclic; validators MUST report at least one full cycle path when
they reject a cyclic workflow.

[WFL-5] Execution order is a topological order of that graph. Within the
constraints of the graph the order is implementation-defined but MUST be
sequential — one node at a time ([§17](#17-non-goals-normative)).

[WFL-6] Workflows are closed documents: the workflow object (keys of
[WFL-1] only), each node object (keys of [WFL-2]/[WFL-3] only), and the
grants object (`run`, `read`, `write` only) reject unknown keys; validators
MUST treat violations as errors [VER-3].

A workflow whose nodes are all fuzzy blocks is a prompt DAG; mixed
workflows are the common case.

### 9.1 Workflow outputs (normative)

A workflow may declare what it returns — the missing half of the block
interface, and what makes a workflow embeddable (§9.2). Functions get
return values.

```json
"outputs": {
  "changelog": { "from": "{{nodes.render.output.text}}", "type": "string", "required": false }
}
```

[OUT-1] An output declaration is a closed object: `from` (REQUIRED — a wire
template or literal value, §7) plus a schema-lite schema (§5) — `type`
REQUIRED; `default` and `secret` are invalid here (they are input-only).
Output names follow [SYN-1].

[OUT-2] `from` follows the wire rules of §7 verbatim, with the declaration
as the target: a whole-value wire's source type MUST equal the declared
type [WIR-6], interpolation targets MUST be `string`, and unknown-typed
sources [WIR-8] pass statically and are checked at resolution.

[OUT-3] When a run completes, the runner MUST resolve each declaration
against the run's recorded values, validate each resolved value against its
schema [SCH-5], and write the result as a top-level `output` object on the
run document. Node records are untouched ([RUN-6] survives).

[OUT-4] When an output's source cannot be resolved because a gate cut its
path (the source node is `skipped`, or a referenced field is absent): if
the declaration has `required: false`, the key is **omitted** from `output`
— never null; otherwise the run concludes in the validation/contract-failure
outcome class with a message naming the output and the failed resolution,
and no `output` object is written.

[OUT-5] The `output` object is a deterministic derivation of `.nodes` and
the run's inputs: re-invoking a completed run MUST reproduce it exactly.

[OUT-6] Output declarations create no execution edges: a node referenced
only by `outputs` still runs (or skips) on its own dependencies and gates.

[OUT-7] The sanctioned pattern for consuming an *optional* output
downstream is a gate on the output itself (`nodes.child.output.message !=
''` — a missing ref makes the clause false [GAT-4] and the consumer
skips); a data wire to a missing optional output is an execution error
[WIR-8].

### 9.2 Workflow composition (normative)

A node may embed another workflow. Composition is the same co-signing law
one level up: the parent vouches for everything the child may touch.

```json
{ "id": "changelog", "workflow": "changelog-from-git@2",
  "in": { "range": "{{inputs.range}}" } }
```

[NST-1] A node MUST have exactly one of `block` or `workflow`. A `workflow`
pin [SYN-4] resolves against `workflows/<name>.workflow.json` in the same
workspace; the file's declared `version` MUST match the pin exactly.

[NST-2] An embedded workflow's interface is its declared `inputs` (an input
with a `default` is not required of the parent) and its declared `outputs`
(§9.1, minus `from`). Wires and gates resolve against that interface
exactly as against a block's contract ([WIR-5], [GAT-6]).

[NST-3] The inclusion graph over workflow names MUST be acyclic. Validators
MUST reject a cycle reporting the full inclusion path. Nesting is acyclic
composition, not recursion.

[NST-4] Embedded workflows are validated recursively: a workflow whose
embedded child is invalid is itself invalid, and the child's errors are
reported against the child's own file.

[NST-5] A child's inputs come only from the parent's `in` bindings (plus
the child's own defaults). Invocation-level inputs bind the root workflow
only.

[NST-6] **Grant coverage.** The parent MUST cover every grant of an
embedded workflow: each child `run` grant MUST appear in the parent's
`run` grants, and each child path grant MUST be covered [PRM-3] by some
parent grant. Symmetrically, a child's grants count as declarations for
the parent's [PRM-4] check. Consequence: the effective capability of every
leaf node is unchanged by embedding, and the root workflow's `grants` is a
complete statement of everything the whole tree may touch. Runtime
intersection remains as defense in depth; validation makes it a no-op.

[NST-7] One execution of an embedded workflow is an ordinary run document
of its own (§11), stored separately. The parent node's record carries
`childRun` (the child run document's workspace-relative path) and
`workflowHash` (the hash [SYN-5] of the child workflow file's bytes) from
the moment the child run is created.

[NST-8] While the child run is incomplete the parent record stays
`pending`. On child completion the parent record becomes `done` with
`attempts: 1` and `output` = the child's resolved `output` object (copied,
so the parent document stays self-contained for wires, gates, and diffs).
On child failure — a fuzzy node exhausting its budget [RNR-11], or a
required child output unresolvable [OUT-4] — the parent record becomes
`failed` with a reason naming the child run, and is terminal [RNR-12].

[NST-9] A pause at a fuzzy node inside a descendant run bubbles up: the
runner conveys the pause information items of [RNR-8] with the *child* run
document as the submission target — a child run is just a run, and record
needs no nested addressing — plus the parent run's location.

[NST-10] Resume recurses: a parent invocation reaching a `pending` workflow
node with a `childRun` re-enters that child run under [RNR-14]. A child's
live input values are re-resolved from parent state on every entry, so
secrets that flowed through wires need no separate re-supply. A missing
child run file is an invocation error; the parent record is not failed by
it.

[NST-11] In the determinism check [RUN-8], `childRun` embeds run identity
and is exempt from structural comparison exactly as `runId` and `startedAt`
are; `workflowHash`, `status`, `attempts`, and `output` on the same record
are not exempt, and a deterministic-only child's own `.nodes` MUST be
structurally equal across parent runs.

## 10. Permissions and grants (normative)

Capability comes from two signatures: the block declares what it can touch
(§6.2), and the workflow grants what this use of it may touch. Neither alone
suffices.

[PRM-1] The workflow's `grants` object has the same shape as a block's
`permissions` (`run`, `read`, `write` arrays; path-glob validity per
[BLK-11]).

[PRM-2] The **effective capability** of a node is the intersection of its
block's declarations and the workflow's grants, computed per node: for
`run`, exact string membership in both lists; for `read` and `write`,
**cover semantics**: a granted glob is effective if and only if at least one
of the block's declared globs covers it.

[PRM-3] A declared glob **covers** a granted glob when: the declaration is
`**` (covers everything); or the two are string-equal; or the declaration
ends in `/**` and the grant starts with the declaration's prefix up to and
including the `/`. (`triage/**` covers `triage/p1/latest.md`; it does not
cover `triage2/x`.)

[PRM-4] A grant that nothing in the workflow declares is a validation
error: for `run`, the binary MUST appear in some block's `run` list or
some embedded workflow's `run` grants [NST-6]; for paths, some block's
declared glob or embedded workflow's grant MUST cover the grant. Grants
co-sign; they never expand.

[PRM-5] An argv node whose `argv[0]` is not in the workflow's `run` grants
is a validation error (the node could never execute).

[PRM-6] At execution time a runner MUST refuse — with the permission-refusal
outcome ([RNR-13]) — an argv node whose binary is outside the node's
effective `run` set; and every path the runner itself derives or uses
(entry-script paths, input-file paths, filesystem-fence targets computed
from grants) MUST be refused when it escapes the workspace root after
normalization, regardless of grants. A runner cannot know which resolved
*input values* are paths; that half of workspace fencing is the block's
obligation [BLK-13].

[PRM-7] Enforcement is tiered, and implementations MUST NOT claim a higher
tier than they deliver:

| Tier | Meaning | Protocol floor |
| --- | --- | --- |
| **enforced** | violation is mechanically prevented | argv binary allowlist; workspace-escape refusal |
| **audited** | violation is detectable after the fact | filesystem globs where the platform cannot fence a child process; block hashes in the run document |
| **declared** | a reviewed statement, not a mechanism | `network` |

A runner whose platform can fence child-process filesystem access (as the
reference implementation does via Node's permission model) SHOULD promote
filesystem globs to enforced; one that cannot MUST warn that filesystem
enforcement is audit-only.

[PRM-8] `network` is a declaration. A workflow author reads it; no
conforming runner is required to enforce it, and none may advertise it as
sandboxing.

## 11. The run document (normative)

One execution of a workflow persists as one run document.

[RUN-1] The document MUST contain: `workflow` (the workflow's name),
`workflowFile` (the workflow file's path relative to the workspace root),
`workflowHash`, `runId` (an opaque unique string; the form `r-<8 hex>` is
RECOMMENDED), `startedAt` [SYN-6], `inputs` (the resolved workflow inputs as
persisted), and `nodes` (a map from node id to node record). It MAY carry
`protocol` (stamped from the workflow, [VER-4]) and, once complete,
`output` (§9.1).

[RUN-2] `workflowHash` MUST be the hash [SYN-5] of the exact bytes of the
workflow file. A block's hash (`blockHash` below) MUST be the hash of the
concatenation, in order, of the exact bytes of: `SKILL.md`, then
`contract.json`, then — for entry blocks only — the entry script.

[RUN-3] A node record's `status` MUST be one of `pending`, `done`,
`skipped`, `failed`. Only a fuzzy node's exhausted attempt budget [RNR-11]
or a failed embedded child run [NST-8] produces `failed`; a deterministic
node that cannot execute leaves its record `pending` [RNR-17].

[RUN-4] A `done` record MUST carry `blockHash` (or, for a workflow node,
`workflowHash` [NST-7]), `attempts` (see [RNR-11]; always `1` for a
deterministic or workflow node), and `output` (shape-valid against the
block's outputs, or the child's resolved output object [NST-8]). A
`skipped` record MUST carry a human-readable `reason`. A `failed` record
MUST carry `reason` and, for fuzzy nodes, the final `attempts` count. A
fuzzy record carrying a verified approval carries `approval` ([SIG-7]).

[RUN-5] When a run reaches a fuzzy node, the runner MUST persist the node's
resolved input values on the record as `input` before any oracle answers.
The run document — not any printout — is the copy of record for what the
oracle was asked ([RNR-8]).

[RUN-6] Node records MUST NOT contain timestamps. `runId` and `startedAt`
live at the top level only, so that `.nodes` is directly comparable across
runs.

[RUN-7] A workflow input whose schema has `secret: true` MUST be persisted
in `inputs` as the hash [SYN-5] of its JSON encoding, never as its value.
Resuming a run therefore requires the invoker to re-supply secret values;
non-secret inputs are read back from the document.

[RUN-8] **Determinism check.** Given the same workflow bytes, the same
resolved inputs, the same recorded fuzzy outputs, and the same workspace
and external state observable to the blocks (a `git-log` block reads the
repository; rerun it after a commit and the premise fails, not the check),
the records of deterministic nodes across two runs MUST be structurally
equal (equal after JSON parsing) — including `output` and `blockHash`. The
requirement binds the Runner class. For a workflow with no
fuzzy nodes this extends to the entire `.nodes` object. Byte-identical
`.nodes` serialization is RECOMMENDED (the reference implementation uses
two-space indentation, insertion key order, and a trailing newline to make
runs diffable with standard tools).

[RUN-9] Run documents SHOULD NOT be committed to shared history except as
deliberately curated examples; they MAY contain resolved data from any
non-secret input.

## 12. The runner protocol (normative)

A runner drives a workflow from file to completed run document. Its
lifecycle:

```
validate → plan → [execute det | pause at fuzzy → (oracle) → record]* → complete
                      ↑__________________ resume ___________________↓
```

### 12.1 Static validation

[RNR-1] A runner MUST validate before executing anything: workflow shape
(§9), block resolution and contracts (§6, §5), wires (§7), gates (§8),
grants (§10), and acyclicity (§9). A workflow that fails validation MUST
NOT be partially executed.

[RNR-2] Validation errors MUST identify their location (file and, where
applicable, JSON pointer) and SHOULD carry a fix hint.

[RNR-3] A validate-only tool conforms to this section alone (see §3).

[RNR-4] Validation MUST be repeated on every invocation that executes or
resumes a run; a library that changed since the last invocation is
re-validated, and the run document's block hashes expose any drift in what
actually executed.

### 12.2 Execution

[RNR-5] Nodes execute in topological order [WFL-5], one at a time, each
through this fixed sequence: skip propagation [RNR-6], then gate evaluation
(§8; a false gate marks the node `skipped` with a reason and the run
continues), then input resolution (§7), then input shape-validation
[WIR-7], then execution or pause. Inputs of a node whose gate is false are
never resolved.

[RNR-6] **Skip propagation.** A node with a *data* dependency (a wire ref in
`in`) on a `skipped` node MUST itself be marked `skipped` transitively.
Order-only `after` dependencies do not propagate skips; a node whose only
connection to a skipped node is a *gate* ref is not auto-skipped — the
clause simply evaluates false [GAT-4], and the node runs or skips on its
gate's own verdict.

[RNR-7] Deterministic execution: the runner itself executes the block —
argv blocks as an argument vector with no shell interpretation (each
placeholder one whole element, [BLK-8]), entry blocks per [BLK-10] with a
minimal environment. Output is captured per [BLK-9], shape-validated
[SCH-6], and recorded with `blockHash` and `attempts: 1`. The runner MUST
NOT delegate deterministic execution to an agent.

[RNR-8] **The pause interface.** At a fuzzy node, the runner MUST persist
the record per [RUN-5], then convey to the oracle at least: the node id;
the block pin; where to read the block's `SKILL.md`; the resolved input
(or that it is in the run document, which is authoritative); the exact
mechanism for submitting an answer; when the block demands claims
([SIG-1]), that a signed submission is required; and, when the pause is
inside a descendant run [NST-9], which run document is the submission
target. The presentation (text, API response, message) is
implementation-defined; the information items are not.

[RNR-9] **Record.** An answer enters the run only through the runner's
record operation, which MUST shape-validate it [SCH-6] against the block's
declared outputs and MUST reject it, naming the violating fields, when it
does not conform. A rejected answer never touches the run document's
`output`.

[RNR-10] A record operation MUST refuse to overwrite a `done` node, to
record a `skipped` or `failed` node, or to record a node the run has not
yet reached. These refusals conclude in the usage-error outcome class
[RNR-13].

[RNR-11] Each record submission that presents a parseable JSON object
increments the node's `attempts` counter, accepted or not; a submission
that is not parseable JSON is a usage error and does not count against the
budget. When a counted submission is invalid and `attempts` has reached 3,
the node becomes `failed` and the run stops. (One initial submission, at
most two repairs — three counted submissions total.)

[RNR-12] A `failed` node is terminal for its run: record MUST refuse it
[RNR-10] and a resumed run MUST refuse to execute past it. Continuing the
work means starting a new run.

[RNR-13] **Outcome classes.** Every runner operation concludes in one of
four classes: **ok**; **validation/contract failure** (invalid documents,
schema rejection); **usage error** (malformed invocation); **permission
refusal** ([PRM-6]). A runner exposing a command-line interface MUST map
these to process exit codes 0, 1, 2, and 3 respectively — portable oracle
instructions depend on the mapping.

[RNR-14] **Resume.** Given a run document, a runner MUST continue from the
first `pending` node in topological order, using recorded outputs for
everything `done`, re-reading non-secret inputs from the document, and
requiring secret inputs to be re-supplied [RUN-7].

[RNR-15] A runner MUST NOT invoke a language model. The oracle is outside
the runner — that separation is what makes the runner's behavior
reproducible and the oracle replaceable.

[RNR-17] **Deterministic failure.** When a deterministic node cannot
produce a recordable output — the process exits non-zero, standard output
does not parse as required [BLK-9], the output violates the block's
contract, or input resolution fails ([WIR-8] missing key, [WIR-2]
non-scalar interpolation) — the runner MUST NOT record an `output`, MUST
leave the node's record `pending`, and MUST conclude in the
validation/contract-failure outcome class — with one exception: an entry
script exiting with the permission-refusal code (3, [BLK-13]) concludes in
the permission-refusal class. A later invocation may retry the node
(nothing was recorded), and drift between invocations remains auditable via
`blockHash` on whatever does complete.

### 12.3 Optional operations

[RNR-16] A runner MAY offer a pre-validation operation that checks a
candidate answer against a block's outputs without touching any run
(`check-output` in the reference implementation). Record [RNR-9] subsumes
it; offering it does not relax record's obligations.

### 12.4 Signed approvals (normative)

Human-in-the-loop is native to the protocol — a human with a text editor is
already a conforming oracle (§13). What this section adds is *authority*: a
fuzzy block can demand that its answer be signed by a key carrying declared
claims, making approvals non-repudiable and the approver accountable — and
the mechanism is signer-agnostic: a key does not care whether a human or an
agent holds it.

[SIG-1] A fuzzy contract MAY declare `"oracle": { "claims": [...] }` — a
closed object whose `claims` is a non-empty array of claim names matching
`[a-z][a-z0-9-]*`. `oracle` on a deterministic block is invalid.

[SIG-2] The **key registry** is the workspace directory `keys/`. A
registered key is a closed document `keys/<keyId>.json` containing `keyId`
(matching [SYN-2] and the filename), `publicJwk` (an Ed25519 OKP JWK:
`kty`, `crv`, `x`), and `claims` (as in [SIG-1]). A registry document
containing private key material (`d`) is invalid — the registry
mechanically refuses to become a private-key store. Key distribution and
revocation are out-of-band ([§17](#17-non-goals-normative)); deleting the
registry file revokes, and version-control history is the audit log.

[SIG-3] The **canonical approval string** is the domain tag followed by six
fields, newline-joined:

```
blocks-approval-v2
<workflowHash of the run being recorded into>
<blockHash of the block being answered>
<runId>
<nodeId>
<inputDigest>
<answerDigest>
```

where the digests are hashes [SYN-5] of the UTF-8 canonical JSON of the
node's recorded `input` and of the submitted answer. Canonical JSON:
lexicographically sorted object keys, no insignificant whitespace,
ECMAScript number formatting. The leading domain tag prevents cross-protocol
signature reuse; binding `workflowHash`, `blockHash`, `runId`, `nodeId`, and
both digests makes a captured signature unreplayable in any other context
([SEC-9]).

[SIG-4] The signature is Ed25519 (RFC 8032) over the UTF-8 canonical
string, carried base64url. (Ed25519 signing is deterministic — repeated
identical submissions produce identical bytes.)

[SIG-5] **Authenticate before contract.** For a submission to a
claims-bearing node, the record operation MUST verify — before schema
validation and before any attempt accounting — that: a signature is
present; the signing key is registered; the registered claims are a
superset of the block's demand; and the signature verifies against the
registered public key over [SIG-3]. Any failure concludes in the
permission-refusal outcome class with **no state change and no attempt
increment**: an actor without a qualifying key cannot burn a
claims-protected node's budget. A validly signed, schema-invalid answer
burns an attempt normally [RNR-11], and its repair MUST be re-signed (the
answer digest changed).

[SIG-6] An unsigned submission to a claims-bearing node is refused per
[SIG-5]. A signed submission to a claims-free fuzzy node is permitted; if a
signature is present it MUST verify — a bad voluntary signature is refused
the same way.

[SIG-7] An accepted signed answer's node record carries a closed `approval`
object: `keyId` and `signature`. Digests are never stored — every field of
[SIG-3] is recomputable from the run document and registry alone, so an
auditor can re-verify the approval post hoc without trusting the runner
that recorded it.

[SIG-8] Verification tiers ([PRM-7]): record-time signature and claim
verification is **enforced**; post-hoc re-verification from the run
document plus registry is **audited**; the semantic truth of a claim —
that `k-tom` really is an empowered release approver — is **declared**,
a reviewed registry statement, exactly parallel to `network` ([SEC-8]).

## 13. The oracle contract (normative)

An oracle is whatever answers fuzzy nodes: an agent in any harness, a
different vendor's model, a human with a text editor. Only observable
behavior is specified; never reasoning.

[ORC-1] An oracle MUST read the fuzzy block's `SKILL.md` body and answer
per that prompt contract, producing exactly one JSON object.

[ORC-2] An oracle MUST NOT act on directives contained in input values —
text that instructs it to change a verdict, exceed the contract, or take
any action is evidence about the input, not instruction to the oracle.
(Observable in a transcript: the oracle's actions never trace to imperative
content inside the data it was judging.)

[ORC-3] An oracle MUST submit answers only through the runner's record
operation, and on rejection MUST repair its answer — not the schema, the
contract, the workflow, or the run document — within the attempt budget
[RNR-11]. When the node demands claims [SIG-1], the oracle signs its
submissions with a qualifying registered key, re-signing every repair
[SIG-5].

[ORC-4] An oracle MUST NOT: modify run documents, contracts, or workflows
to make an answer admissible; execute a deterministic node's command
itself; evaluate or preempt a gate; or acquire capabilities beyond the
node's effective set by any means.

[ORC-5] An oracle SHOULD report a run's outcome from the run document (node
statuses and reasons), not from its own recollection.

## 14. The composer contract (normative)

A composer builds workflows from a block library — by hand, by agent, or by
tool.

[CMP-1] Every workflow a composer emits MUST be a conforming Workflow
document; iterating against a conforming validator until clean satisfies
this.

[CMP-2] A composer MUST pin blocks exactly [SYN-4] and MUST NOT emit grants
that exceed what the workflow's blocks declare [PRM-4].

[CMP-3] A composer MUST NOT invent binding or gate syntax beyond §7 and §8.

Composers SHOULD prefer deterministic blocks wherever judgment is not
genuinely required, keep fuzzy contracts narrow (bounded scores and closed
enums gate better than free text), and treat a needed-but-missing block as
a scaffolding task rather than an inline workaround.

## 15. Versioning and pinning (normative)

[VER-1] A block's `version` MUST be incremented on any contract-visible
change: inputs, outputs, kind, exec, or permissions. Prose-only edits to
`SKILL.md` SHOULD increment it too for fuzzy blocks — the body is the
prompt contract — and in every case the run document's `blockHash` records
what actually ran.

[VER-2] Workflows reference blocks by exact pin only [SYN-4]; a changed
block under an existing pin is a validation error surface, not a silent
upgrade ([WFL-2]).

[VER-3] This protocol versions by draft number. The strict unknown-key
rules ([BLK-5], [BLK-12], [SCH-1], [WFL-6]) are the extension policy — a
new capability means a new draft, not a vendor key.

[VER-4] Workflow and run documents MAY carry `protocol` (a positive
integer; absent means 1). An implementation MUST reject a document
declaring a protocol draft it does not implement, with a message naming
both numbers. Runners stamp new run documents with the workflow's
effective protocol, omitting the field for protocol-1 workflows so their
runs remain readable by Draft-01 tooling.

[VER-5] A document that uses any construct introduced after Draft 1 —
`outputs` (§9.1), a `workflow` node (§9.2), `oracle` demands via a
protocol-2 workflow — MUST declare `protocol` ≥ the draft that introduced
it. Validators MUST reject Draft-2 constructs under an implicit Draft-1
claim; the check is static.

## 16. Security considerations (normative)

[SEC-1] Injection is prevented structurally by [BLK-8] and [RNR-7]: binding
values reach commands only as whole argv elements, never through a shell.
A value of `"; rm -rf ."` arrives as those literal bytes in one argument.
This section adds no new rule; it names the threat those rules answer.

[SEC-2] Child processes MUST NOT inherit environment variables beyond an
implementation-defined minimal set (RECOMMENDED: `PATH` only, as the
reference implementation does), and the process environment is never
bindable [WIR-9].

[SEC-3] Workspace fencing: resolved path values are normalized and refused
when they escape the workspace root [PRM-6], independent of grants; path
globs are rejected at validation when absolute or containing `..`
([BLK-11], [PRM-1]).

[SEC-4] Fuzzy inputs are hostile until proven otherwise: schemas bound the
shape of what an oracle can inject into a run [RNR-9], gates bound the
blast radius to declared branches [GAT-3], and oracles are instructed to
treat inputs as data [ORC-2]. The residual risk — a poisoned judgment
choosing the wrong declared branch — is real and is why grants exist.

[SEC-5] Secret inputs are digested at rest [RUN-7]. Wiring a secret input
into a fuzzy node persists its resolved value in that node's `input` record
[RUN-5]; workflow authors SHOULD NOT do it, and validators MAY warn.

[SEC-6] Symlinked workspace roots: implementations that fence filesystem
access SHOULD resolve real paths before spawning fenced children, or the
fence itself misfires on symlinked components.

[SEC-7] `network: false` is a declaration [PRM-8]. Anyone requiring network
isolation runs the runner inside their own sandbox; the protocol does not
provide one.

[SEC-8] **Registry trust.** Claims in `keys/<keyId>.json` are self-asserted
by whoever has workspace write access; the registry's trust root is review
and version-control history, not the protocol. The mechanism authenticates
*against* the registry, never *for* it. Equally: anyone with workspace
write access can edit contracts or run documents around the signature
requirement — both moves are audited, not enforced (a contract edit shifts
`blockHash`; a run-document edit breaks post-hoc re-verification [SIG-7])
— so a signed approval protects against unauthorized *submitters*, not
against the workspace's own administrators.

[SEC-9] **Replay.** The [SIG-3] binding makes a captured approval valid
only for the identical workflow bytes, run, node, input, and answer — a
context in which [RNR-10] already forbids a second acceptance. There is no
key expiry or revocation list; a compromised key is revoked by deleting
its registry file, and the exposure window is auditable from history.

## 17. Non-goals (normative)

The following are outside this protocol, deliberately, and a conforming
implementation MUST NOT present them as protocol features: hosted servers,
UIs, daemons, triggers, or schedules; loops, recursion, arithmetic, or
dynamic fan-out in workflows (bounded per-node record attempts are not a
loop, and workflow nesting is acyclic composition [NST-3], not recursion);
parallel node execution; version ranges or block registries; container
sandboxing; model invocation by the runner [RNR-15]; and any PKI — no
certificate chains, key servers, expiry, or revocation infrastructure
([SIG-2], [SEC-9]).

## 18. Changes from Draft 01 (informative)

All changes are additive; no Draft-01 semantics changed.

- **Workflow outputs** (§9.1, [OUT-1..7]): typed, wired return values;
  omitted-not-null optional outputs; deterministic top-level `output`.
- **Workflow composition** (§9.2, [NST-1..11]): `workflow` nodes; acyclic
  cross-file inclusion; parent-covers-child grant coverage; child runs as
  ordinary run documents; pause bubbling; terminal child failure;
  `childRun` determinism carve-out.
- **Signed approvals** (§12.4, [SIG-1..8]): `oracle.claims` demands; the
  `keys/` registry; the domain-separated canonical string;
  authenticate-before-contract with no attempt burn on refusal; the
  `approval` record; post-hoc re-verifiability.
- **Protocol field** ([VER-4..5]): declared drafts with rejection teeth;
  Draft-2 constructs require `protocol: 2`.
- Amended in place (same IDs): [WFL-1..3], [WFL-6 by reference], [BLK-5],
  [BLK-12], [PRM-4], [RUN-1], [RUN-3], [RUN-4], [RNR-8], [ORC-3], §17.
- New security text: [SEC-8] registry trust and the
  administrator-can-always-edit honesty note; [SEC-9] replay binding and
  revocation-by-deletion.

---

## Appendix A — Reference implementation mapping (informative)

The reference implementation is the `blocks` CLI in this repository
(Node ≥ 18, zero dependencies). Verb names are not part of the protocol
(§12 intro; a conforming runner could be an HTTP service), but the mapping
is useful:

| Verb | Protocol section |
| --- | --- |
| `blocks list [--json]` | library inventory (unspecified; informative) |
| `blocks validate <workflow>` | §12.1 static validation |
| `blocks graph <workflow>` | rendering (unspecified) |
| `blocks plan <workflow> [--state f]` | topological order / next pending node [RNR-14] |
| `blocks exec <workflow> [--state f] [--out f] [--input k=v]` | §12.2 execution |
| `blocks check-output <block> <file\|->` | [RNR-16] optional pre-validation |
| `blocks record --state f --node id --output f [--sign keyfile]` | [RNR-9]–[RNR-11] record; `--sign` per §12.4 |
| `blocks link <block> [--check]` | skill installation (outside the protocol) |
| `blocks new block <name> --kind <k>` | scaffolding (outside the protocol) |
| `blocks new key <id> --claims <a,b>` | key-pair scaffolding: public into `keys/`, private gitignored (outside the protocol) |

Exit codes follow [RNR-13]: `0 ok · 1 validation/contract failure · 2 usage
error · 3 permission refusal`.

The pause printout (one realization of [RNR-8]) — note the truncated
`input:` line; the run document holds the authoritative copy:

```
⏸ paused at fuzzy node "judge" (llm-judge@1)
  contract: blocks/llm-judge/SKILL.md
  input: {"candidate":"## Docs\n- Normative SPEC and repository skeleton (37f938b)…
  then:  blocks record --state runs/changelog-from-git-r-269b010f.run.json --node judge --output <answer.json>
  state: runs/changelog-from-git-r-269b010f.run.json
```

Error format: every validation error prints file, JSON pointer, message,
and a fix hint. Quirk: `plan` without `--state` resolves workflow inputs
(and so may demand `--input` for required inputs) as a side effect of
sharing the execution path; this is not protocol behavior.

The repository's test suite (`node --test 'cli/tests/*.test.js'`, 32 tests)
is an informative, partial conformance suite for the Runner class; a
cross-implementation suite is future work (§15).

## Appendix B — Worked example (informative)

The repository's own changelog workflow, verbatim
(`workflows/changelog-from-git.workflow.json`, grants line exact):

```json
"grants": { "run": ["git"], "read": [], "write": ["CHANGELOG.md"] }
```

Its gate, on the `render` node:

```
nodes.judge.output.score >= 0.7 and nodes.judge.output.verdict == 'pass'
```

From the committed run `examples/runs/changelog-from-git-r-269b010f.run.json`:

```json
"log": {
  "status": "done",
  "blockHash": "sha256:17d51bbcd25bca311d25a640057a73fcf5ce15c9c6901eaed42228ebed23c3ea",
  "attempts": 1,
  "output": { "text": "37f938b 2026-07-02 step 1: SPEC.md (normative spec) + repo skeleton\n..." }
},
"judge": {
  "status": "done",
  "attempts": 1,
  "output": { "score": 0.85, "verdict": "pass", "reasons": "All four entries trace to commits in the log..." }
}
```

Hand-evaluating the gate against that record: `0.85 >= 0.7` → true;
`'pass' == 'pass'` → true; `true and true` → true → `render` executed, then
`publish` wrote `CHANGELOG.md` (394 bytes) — the only path the workflow
granted. The repository's `CHANGELOG.md` header still reads
`_range: HEAD~4..HEAD — judged 0.85_`.

The `render` node also demonstrates deep resolution [WIR-3]: its `values`
input is a literal object whose members are wires. Each member —
`"score": "{{nodes.judge.output.score}}"` — is exactly one binding, so it
resolves **whole-value** per [WIR-1]: the number `0.85` lands in the
resolved object as a number. (The stringification a template ultimately
needs happens inside the `render-template` block's own `{key}` mechanism —
a block concern, not a wire concern.)

For the negative path, the committed triage run
(`examples/runs/triage-bug-report-r-e3b8418b.run.json`) records:

```json
"route-backlog": { "status": "skipped", "reason": "gate false: nodes.severity.output.label != 'p1'" }
```

## Appendix C — Conformance checklist (normative)

Every requirement in this draft, one line each. An implementation claims a
class by checking every line of that class's sections.

**Syntax (§4):**
[SYN-1] ident grammar · [SYN-2] node-id/workflow-name grammar ·
[SYN-3] block name = directory name · [SYN-4] exact pins ·
[SYN-5] sha256 hash format + defined preimages · [SYN-6] RFC 3339 UTC.

**Schema-lite (§5):**
[SCH-1] closed key set · [SCH-2] required `type` from the five ·
[SCH-3] key applicability · [SCH-4] `required` default, `default`/`secret`
scope · [SCH-5] value validation · [SCH-6] exact shape validation ·
[SCH-7] pointer-precise errors · [SCH-8] schema-lite is closed.

**Block (§6):**
[BLK-1] directory of SKILL.md + contract.json · [BLK-2] flat frontmatter ·
[BLK-3] only `name`/`description` keys · [BLK-4] fuzzy body is the prompt
contract · [BLK-5] contract fields exact · [BLK-6] fuzzy: no exec/permissions,
≥1 output · [BLK-7] exec = argv xor entry; capture default json ·
[BLK-8] whole-element placeholders; literal argv[0] · [BLK-9] capture
semantics · [BLK-10] entry script I/O contract · [BLK-11] permissions shape;
glob validity; argv[0] self-declared · [BLK-12] contract/exec/permissions
closed; capture argv-only · [BLK-13] path-accepting blocks self-refuse
workspace escapes (exit-3 convention).

**Wires (§7):**
[WIR-1] whole-value preserves type · [WIR-2] interpolation rules ·
[WIR-3] deep resolution in literals · [WIR-4] malformed bindings are errors ·
[WIR-5] static ref resolution · [WIR-6] static type equality ·
[WIR-7] runtime input shape-validation · [WIR-8] unknown-type digging ·
[WIR-9] only two ref forms; no env binding.

**Gates (§8):**
[GAT-1] ordering needs number literal (parse) · [GAT-2] equal precedence,
left-assoc · [GAT-3] runner-only evaluation from recorded values ·
[GAT-4] missing/skipped ref ⇒ clause false · [GAT-5] non-number ordering ⇒
false; strict scalar equality · [GAT-6] static non-number ordering ref is an
error · [GAT-7] the grammar is closed.

**Workflow (§9):**
[WFL-1] document fields · [WFL-2] unique ids; exact pin resolution (block
or workflow) · [WFL-3] node fields; required inputs bound; no undeclared
bindings · [WFL-4] edges = wires ∪ gate refs ∪ after; acyclic; cycles
named · [WFL-5] sequential topological execution · [WFL-6]
workflow/node/grants objects closed.

**Workflow outputs (§9.1):**
[OUT-1] closed declaration: from + schema; no default/secret · [OUT-2]
from follows §7 with the declaration as target · [OUT-3] resolved and
validated into top-level `output` at completion · [OUT-4] optional cut
source ⇒ key omitted; required ⇒ contract failure, no output written ·
[OUT-5] output is a deterministic derivation · [OUT-6] outputs create no
edges · [OUT-7] consume optional outputs through gates.

**Composition (§9.2):**
[NST-1] block xor workflow per node · [NST-2] child interface = inputs +
outputs · [NST-3] acyclic inclusion, cycles named · [NST-4] recursive
validation · [NST-5] child inputs from parent wires only · [NST-6] parent
covers child grants; child grants are declarations · [NST-7] child run is
a separate document; childRun + workflowHash on the parent record ·
[NST-8] done copies child output; child failure ⇒ parent failed, terminal ·
[NST-9] pauses bubble with the child run as submission target · [NST-10]
resume recurses; wire-fed secrets re-resolve · [NST-11] childRun exempt
from the determinism check; nothing else is.

**Permissions (§10):**
[PRM-1] grants shape · [PRM-2] intersection semantics · [PRM-3] cover
algorithm · [PRM-4] grants only co-sign declarations · [PRM-5] ungranted
argv[0] is a validation error · [PRM-6] exec-time refusal: binary + workspace
escape · [PRM-7] enforcement tiers stated honestly · [PRM-8] network is a
declaration.

**Run (§11):**
[RUN-1] document fields · [RUN-2] hash preimages · [RUN-3] status vocabulary ·
[RUN-4] per-status record fields · [RUN-5] fuzzy input persisted before
answers · [RUN-6] no node-level timestamps · [RUN-7] secrets digested;
re-supplied on resume · [RUN-8] determinism check · [RUN-9] runs are not
shared history.

**Runner (§12):**
[RNR-1] validate before executing · [RNR-2] located errors · [RNR-3]
validate-only conformance · [RNR-4] re-validate every invocation ·
[RNR-5] topo order; gates before execution · [RNR-6] skip propagation via
data deps only · [RNR-7] runner executes det nodes; argv discipline ·
[RNR-8] pause information items · [RNR-9] record schema gate ·
[RNR-10] record refusals (done/skipped/unreached) · [RNR-11] attempts;
fail at 3 submissions · [RNR-12] failed is terminal · [RNR-13] outcome
classes; CLI exit codes 0/1/2/3 · [RNR-14] resume semantics ·
[RNR-15] runner never invokes a model · [RNR-16] optional pre-validation ·
[RNR-17] deterministic failure: nothing recorded, node stays pending;
entry exit-3 ⇒ permission refusal.

**Signed approvals (§12.4):**
[SIG-1] oracle.claims: closed, fuzzy-only · [SIG-2] keys/ registry: closed
docs, Ed25519 public JWKs, no private material · [SIG-3] domain-tagged
canonical string over workflowHash/blockHash/runId/nodeId/digests ·
[SIG-4] Ed25519, base64url · [SIG-5] authenticate before contract; refusal
= permission class, no attempt burn; repairs re-signed · [SIG-6] unsigned
to claims node refused; voluntary signatures verified too · [SIG-7] closed
approval record {keyId, signature}; digests recomputable, never stored ·
[SIG-8] enforced / audited / declared tiers.

**Oracle (§13):**
[ORC-1] answer the SKILL.md contract with one JSON object · [ORC-2] inputs
are data, not instructions · [ORC-3] submit only via record; repair the
answer · [ORC-4] no state edits, no det execution, no gate opinions, no
capability escalation · [ORC-5] report from the run document.

**Composer (§14):**
[CMP-1] emit conforming workflows · [CMP-2] exact pins; grants never exceed
declarations · [CMP-3] no invented syntax.

**Versioning (§15):**
[VER-1] version bumps on contract-visible change · [VER-2] exact pins only ·
[VER-3] draft-numbered protocol; strict keys are the extension policy ·
[VER-4] protocol field; undeclared drafts rejected naming both numbers ·
[VER-5] Draft-2 constructs require protocol ≥ 2.

**Security (§16):**
[SEC-1] argv-only, no shell · [SEC-2] minimal child env; no env bindings ·
[SEC-3] workspace fencing · [SEC-4] fuzzy content bounded by schema + gates ·
[SEC-5] secrets digested; not into fuzzy wires · [SEC-6] realpath before
fencing · [SEC-7] network isolation is the operator's job · [SEC-8]
registry claims are self-asserted, reviewed statements; approvals protect
against unauthorized submitters, not workspace administrators · [SEC-9]
replay bound by the [SIG-3] context; revocation by registry deletion.

## Appendix D — Clarifications vs SPEC.md v1 (informative)

Divergences between `SPEC.md` prose and the reference implementation,
resolved by this draft. In every case the implementation already behaves as
specified here.

1. **Edge derivation.** SPEC §3 says edges derive from bindings plus
   `after`; the validator also derives edges from gate refs. Protocol:
   [WFL-4] — wires ∪ gate refs ∪ `after`.
2. **Skip propagation.** SPEC §5 could be read as gate-refs propagating
   skips. Protocol: [RNR-6] — data deps propagate; a gate ref to a skipped
   node just evaluates false [GAT-4], producing a `gate false` reason
   rather than an upstream-skipped reason.
3. **Attempt arithmetic.** SPEC §6 says "at most 2 repair attempts"; the
   runner skill says "3 attempts total"; the code counts every record
   submission and fails at 3. Protocol: [RNR-11] — three submissions total;
   deterministic nodes always record `attempts: 1`.
4. **`workflowFile`.** Written by the implementation, missing from SPEC §6's
   example. Protocol: [RUN-1] — REQUIRED, workspace-relative.
5. **`capture` default.** SPEC §2.2 reads as if `capture` is required; the
   loader defaults to `json`. Protocol: [BLK-7] — OPTIONAL, default `json`.
6. **Secrets on resume.** Digests are one-way, so resumed runs need secret
   values re-supplied; previously unwritten. Protocol: [RUN-7], [RNR-14].
7. **Hash preimages.** SPEC names the inputs loosely. Protocol: [RUN-2] —
   `workflowHash` over the file bytes; `blockHash` over SKILL.md ‖
   contract.json ‖ entry script, in that order.
8. **Determinism scope.** SPEC's "byte-identical" claim is a property of
   one serializer. Protocol: [RUN-8] — structural equality is the MUST;
   byte identity is RECOMMENDED.

Additionally, adversarial review of this draft surfaced two enforcement
gaps in the reference implementation itself, both fixed in the same change
that introduced this document: `record` did not refuse `failed` nodes (a
fourth valid submission could resurrect one, contradicting [RNR-12] — now
refused, with a regression test), and unknown keys in contracts, exec,
permissions, workflows, nodes, and grants were accepted silently
(contradicting [BLK-12]/[WFL-6] — now rejected, with tests). The statement
that the implementation behaves as specified is true as of the commit that
carries this draft.
