// Runs: plan / exec / record / check-output (SPEC §6–§8, PROTOCOL §11–§12).
// The CLI is the runtime for deterministic nodes; the agent is the driver,
// and the oracle for fuzzy nodes — `record` is the only door its answers fit through.
// Draft 02: workflows nest (child runs are ordinary run files) and fuzzy answers
// can be required to carry an Ed25519 approval signed by a registered key.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { validateShape, validateValue } from './schema.js';
import { evalTemplate, parseTemplate, walkStrings } from './bindings.js';
import { effectiveGlobs } from './globs.js';
import { parseWhen, evalWhen } from './when.js';
import { loadBlock } from './loader.js';
import { formatErrors, IMPLEMENTED_PROTOCOL } from './validate.js';
import { canon } from './canon.js';
import { loadRegistryKey, loadPrivateKeyFile } from './keys.js';

// Domain separation for approval signatures (PROTOCOL §12.4 [SIG-3]).
export const APPROVAL_PREFIX = 'blocks-approval-v2';

const sha256 = (...bufs) => {
  const h = createHash('sha256');
  for (const b of bufs) h.update(b);
  return `sha256:${h.digest('hex')}`;
};

export function hashBlock(block) {
  const parts = [readFileSync(join(block.dir, 'SKILL.md')), readFileSync(join(block.dir, 'contract.json'))];
  if (block.exec?.entry) parts.push(readFileSync(join(block.dir, block.exec.entry)));
  return sha256(...parts);
}

function fail(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function refuse(msg) {
  console.error(`refused: ${msg}`);
  process.exit(3);
}

// --- workflow inputs -------------------------------------------------------

function resolveInputs(workflow, kvFlags) {
  const schemas = workflow.inputs ?? {};
  const values = {};
  for (const [key, raw] of kvFlags) {
    const schema = schemas[key];
    if (!schema) fail(`unknown workflow input "${key}" (declared: ${Object.keys(schemas).join(', ') || 'none'})`, 2);
    if (schema.type === 'string') values[key] = raw;
    else {
      try { values[key] = JSON.parse(raw); } catch { fail(`input "${key}" wants ${schema.type}; ${JSON.stringify(raw)} does not parse`, 2); }
    }
  }
  for (const [key, schema] of Object.entries(schemas)) {
    if (values[key] === undefined && schema.default !== undefined) values[key] = schema.default;
    if (values[key] === undefined && schema.required !== false) {
      fail(`workflow input "${key}" is required — pass --input ${key}=<value>`, 2);
    }
  }
  const errors = validateShape(values, schemas, '/inputs');
  if (errors.length) { console.error(formatErrors(errors)); process.exit(1); }
  return values;
}

// Secrets: stored in run-state as digests only (SPEC §7, PROTOCOL [RUN-7]).
function persistedInputs(workflow, inputs) {
  const out = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = workflow.inputs?.[key]?.secret === true ? sha256(JSON.stringify(value)) : value;
  }
  return out;
}

// --- run-state --------------------------------------------------------------

function newState(workflow, workflowFile, inputs, root) {
  const state = {
    workflow: workflow.name,
    workflowFile: relative(root, resolve(workflowFile)),
    workflowHash: sha256(readFileSync(workflowFile)),
    runId: `r-${randomUUID().slice(0, 8)}`,
    startedAt: new Date().toISOString(),
    inputs: persistedInputs(workflow, inputs),
    nodes: Object.fromEntries(workflow.nodes.map((n) => [n.id, { status: 'pending' }])),
  };
  // runs of Draft 2 workflows carry the protocol; Draft 1 runs stay Draft-1 readable
  if ((workflow.protocol ?? 1) >= 2) state.protocol = workflow.protocol;
  return state;
}

function loadState(file) {
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { fail(`cannot load run-state ${file}: ${e.message}`); }
  // PROTOCOL [VER-4]: reject run documents from drafts we do not implement
  if ((state.protocol ?? 1) > IMPLEMENTED_PROTOCOL) {
    fail(`run document declares protocol ${state.protocol}; this implementation speaks protocol ${IMPLEMENTED_PROTOCOL}`);
  }
  return state;
}

// PROTOCOL [RNR-14]: a run's world is the workflow bytes it started from —
// refuse to resume across a mid-run workflow edit (workflowHash drift).
function checkNoDrift(state, workflowFile, what = 'resume') {
  const current = sha256(readFileSync(workflowFile));
  if (current !== state.workflowHash) {
    fail(`${workflowFile} has changed since run ${state.runId} started (workflowHash mismatch) — cannot ${what}; start a new run`);
  }
}

function saveState(file, state) {
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

// --- permissions ------------------------------------------------------------

function effective(list, grants) {
  return (list ?? []).filter((v) => (grants ?? []).includes(v));
}

function insideWorkspace(root, p) {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  // rel === '' is the workspace root itself — inside, by definition.
  return !rel.startsWith('..') && !isAbsolute(rel);
}

let permissionModelSupport; // memoized: does this node support --permission?
function nodeSupportsPermissionModel() {
  if (permissionModelSupport === undefined) {
    const probe = spawnSync(process.execPath, ['--permission', '--allow-fs-read=/', '-e', ''], { encoding: 'utf8' });
    permissionModelSupport = probe.status === 0;
  }
  return permissionModelSupport;
}

// --- node execution ---------------------------------------------------------

function nodeCtx(state, inputs) {
  const nodeOutputs = {};
  for (const [id, rec] of Object.entries(state.nodes)) {
    if (rec.status === 'done') nodeOutputs[id] = rec.output;
  }
  return { inputs, nodeOutputs };
}

function dataDeps(node) {
  const deps = new Set();
  for (const value of Object.values(node.in ?? {})) {
    walkStrings(value, (s) => {
      for (const part of parseTemplate(s).parts) if (part.ref?.kind === 'node') deps.add(part.ref.node);
    });
  }
  return deps;
}

// Bindings resolve anywhere a string sits — including inside literal
// object/array inputs like {"values": {"body": "{{nodes.draft.output.summary}}"}}.
function deepResolve(raw, ctx) {
  if (typeof raw === 'string') return evalTemplate(raw, ctx);
  if (Array.isArray(raw)) return raw.map((v) => deepResolve(v, ctx));
  if (raw !== null && typeof raw === 'object') {
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, deepResolve(v, ctx)]));
  }
  return raw;
}

function resolveNodeInputs(node, block, ctx) {
  const values = {};
  for (const [name, raw] of Object.entries(node.in ?? {})) {
    values[name] = deepResolve(raw, ctx);
  }
  const errors = validateShape(values, block.inputs, `/nodes/${node.id}/in`);
  if (errors.length) {
    console.error(`resolved inputs for node "${node.id}" violate ${block.name}@${block.version}'s contract:`);
    console.error(formatErrors(errors));
    process.exit(1);
  }
  return values;
}

export function execDeterministic(node, block, values, workflow, root) {
  const grants = workflow.grants ?? {};
  if (block.exec.argv) {
    const argv = block.exec.argv.map((arg) => {
      const { whole, parts } = parseTemplate(arg);
      if (!parts.some((p) => p.ref)) return arg;
      const v = whole ? values[parts[0].ref.key] : arg; // validator guarantees whole-element placeholders
      if (typeof v === 'object') fail(`argv placeholder in node "${node.id}" resolved to a non-scalar`);
      return String(v);
    });
    const bin = argv[0];
    const allowed = effective(block.permissions.run, grants.run);
    if (!allowed.includes(bin)) {
      refuse(`node "${node.id}" wants to run "${bin}" but the effective run set is [${allowed.join(', ')}] (block ∩ grants, SPEC §7)`);
    }
    let stdout;
    try {
      stdout = execFileSync(bin, argv.slice(1), {
        cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false,
        env: { PATH: process.env.PATH },
      });
    } catch (e) {
      fail(`node "${node.id}" (${bin}) exited with ${e.status ?? 'a spawn error'}: ${(e.stderr || e.message || '').toString().slice(0, 500)}`);
    }
    return captureOutput(block, stdout, node);
  }

  // entry variant: node script, argv-spawned, fs-fenced when the runtime can.
  const writeGlobs = effectiveGlobs(block.permissions.write, grants.write);
  for (const glob of writeGlobs) {
    if (!insideWorkspace(root, glob.replace(/\*.*$/, '.'))) refuse(`write grant ${glob} escapes the workspace`);
  }
  // Realpath everything before the spawn: Node's permission model stats each
  // path component, and a symlinked component (macOS /var -> /private/var)
  // outside the allow list would be refused mid-walk.
  const realRoot = realpathSync(root);
  const tmpDir = join(realRoot, 'runs');
  mkdirSync(tmpDir, { recursive: true });
  const inputsFile = join(tmpDir, `.in-${node.id}-${process.pid}.json`);
  writeFileSync(inputsFile, JSON.stringify(values));
  const nodeArgs = [];
  if (nodeSupportsPermissionModel()) {
    nodeArgs.push('--permission', `--allow-fs-read=${realRoot}`, `--allow-fs-read=${realRoot}/*`);
    if (writeGlobs.length > 0) {
      // Node's flag takes paths, not globs: for a wildcard grant, allow the
      // static prefix dir (created up front — the CLI is not the fenced party,
      // and Node resolves allow-paths at boot so they must exist) plus its
      // /* recursive form; an exact grant allows just that file.
      const targets = new Set();
      for (const g of writeGlobs) {
        if (g.includes('*')) {
          const prefix = resolve(realRoot, g.split('*')[0] || '.');
          mkdirSync(prefix, { recursive: true });
          targets.add(prefix);
          targets.add(`${prefix}/*`);
        } else {
          targets.add(resolve(realRoot, g));
        }
      }
      nodeArgs.push(...[...targets].map((p) => `--allow-fs-write=${p}`));
    }
  } else {
    console.error('note: this Node lacks the permission model — fs enforcement for entry blocks is audit-only (SPEC §2.2)');
  }
  let stdout;
  let execError;
  try {
    stdout = execFileSync(process.execPath, [...nodeArgs, join(realpathSync(block.dir), block.exec.entry), inputsFile], {
      cwd: realRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false,
      env: { PATH: process.env.PATH },
    });
  } catch (e) {
    execError = e; // fail() exits the process, so clean up first
  } finally {
    try { unlinkSync(inputsFile); } catch {}
  }
  if (execError) {
    const detail = (execError.stderr || execError.message || '').toString().slice(0, 500);
    const escaped = execError.status === 3;
    if (escaped) refuse(`node "${node.id}" entry script: ${detail}`);
    fail(`node "${node.id}" entry script failed: ${detail}`);
  }
  return captureOutput(block, stdout, node);
}

function captureOutput(block, stdout, node) {
  let output;
  if (block.exec.capture === 'text') output = { text: stdout };
  else {
    try { output = JSON.parse(stdout); } catch { fail(`node "${node.id}" must print a JSON object, got: ${stdout.slice(0, 200)}`); }
  }
  const errors = validateShape(output, block.outputs, `/nodes/${node.id}/output`);
  if (errors.length) {
    console.error(`node "${node.id}" output violates ${block.name}@${block.version}'s contract:`);
    console.error(formatErrors(errors));
    process.exit(1);
  }
  return output;
}

// --- workflow outputs (PROTOCOL §9.1) ---------------------------------------

// Returns { ok: true } or { ok: false, detail }. Deterministic derivation of
// state.output from .nodes — recomputable on every complete invocation.
function resolveOutputs(workflow, state, liveInputs, statePath) {
  if (!workflow.outputs) return { ok: true };
  const ctx = nodeCtx(state, liveInputs);
  const out = {};
  for (const [name, decl] of Object.entries(workflow.outputs)) {
    const { from, ...schema } = decl;
    let value;
    try {
      value = deepResolve(from, ctx);
    } catch (e) {
      // only a cut path (skipped source, absent field) triggers optional
      // omission; anything else is a real failure regardless of required
      const cutPath = /no recorded output for node|output has no field/.test(e.message);
      if (cutPath && schema.required === false) continue; // key omitted, never null
      return { ok: false, detail: `${schema.required === false ? '' : 'required '}workflow output "${name}" cannot be resolved: ${e.message}` };
    }
    const errors = validateValue(value, schema, `/outputs/${name}`);
    if (errors.length) return { ok: false, detail: `workflow output "${name}": ${errors[0].message}` };
    out[name] = value;
  }
  state.output = out;
  saveState(statePath, state);
  return { ok: true };
}

// --- the drive loop (PROTOCOL §12.2, recursive for workflow nodes) ----------

function pseudoBlockFor(pin, childWf) {
  const inputs = Object.fromEntries(Object.entries(childWf.inputs ?? {})
    .map(([k, s]) => [k, s.default !== undefined ? { ...s, required: false } : s]));
  const outputs = Object.fromEntries(Object.entries(childWf.outputs ?? {})
    .map(([k, decl]) => { const { from, ...schema } = decl; return [k, schema]; }));
  const [name, version] = pin.split('@');
  return { name, version: Number(version), kind: 'workflow', inputs, outputs };
}

// Returns { status: 'complete' | 'paused' | 'failed' | 'output-failure', detail? }.
function driveRun(wfCtx, state, statePath, liveInputs, deps) {
  const { workflow, lib } = wfCtx;
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));

  for (const id of wfCtx.order) {
    const rec = state.nodes[id];
    if (rec.status === 'done' || rec.status === 'skipped') continue;
    if (rec.status === 'failed') {
      return { status: 'failed', detail: `node "${id}" failed in run ${state.runId} — a failed node is terminal; start a new run` };
    }
    const node = byId.get(id);
    const ctx = nodeCtx(state, liveInputs);

    // skip propagation: any data dependency skipped → this node skips (PROTOCOL [RNR-6])
    const skippedDep = [...dataDeps(node)].find((d) => state.nodes[d]?.status === 'skipped');
    if (skippedDep) {
      rec.status = 'skipped';
      rec.reason = `upstream node "${skippedDep}" was skipped`;
      saveState(statePath, state);
      console.log(`↷ ${id} skipped (upstream "${skippedDep}" skipped)`);
      continue;
    }
    if (node.when !== undefined && !evalWhen(parseWhen(node.when), ctx)) {
      rec.status = 'skipped';
      rec.reason = `gate false: ${node.when}`;
      saveState(statePath, state);
      console.log(`↷ ${id} skipped (gate false: ${node.when})`);
      continue;
    }

    // --- embedded workflow node (PROTOCOL §9.2) ---
    if (node.workflow !== undefined) {
      const childName = node.workflow.split('@')[0];
      const childFile = join(deps.root, 'workflows', `${childName}.workflow.json`);
      const child = deps.loadValidated(childFile);
      const pseudo = pseudoBlockFor(node.workflow, child.workflow);
      const values = resolveNodeInputs(node, pseudo, ctx);

      let childState, childPath;
      if (rec.childRun) {
        childPath = resolve(deps.root, rec.childRun);
        if (!existsSync(childPath)) {
          fail(`child run ${rec.childRun} for node "${id}" is missing — cannot resume it; start a new run`);
        }
        childState = loadState(childPath);
        checkNoDrift(childState, childFile, `resume child run for node "${id}"`);
      } else {
        childState = newState(child.workflow, childFile, values, deps.root);
        mkdirSync(join(deps.root, 'runs'), { recursive: true });
        childPath = join(deps.root, 'runs', `${child.workflow.name}-${childState.runId}.run.json`);
        rec.childRun = relative(deps.root, childPath);
        rec.workflowHash = childState.workflowHash;
        saveState(statePath, state);
      }

      // child live inputs are re-resolved from parent state on every drive —
      // secrets that flowed through wires need no separate re-supply ceremony
      const res = driveRun(child, childState, childPath, values, deps);
      if (res.status === 'paused') {
        console.log(`  ↳ paused inside child run of node "${id}" — parent state: ${relative(deps.root, statePath)}`);
        return res;
      }
      if (res.status === 'failed' || res.status === 'output-failure') {
        rec.status = 'failed';
        rec.reason = `child run ${rec.childRun} failed: ${res.detail}`;
        saveState(statePath, state);
        console.error(`✗ ${id} failed (${node.workflow}) — ${res.detail}`);
        return { status: 'failed', detail: rec.reason };
      }
      rec.status = 'done';
      rec.attempts = 1;
      rec.output = childState.output ?? {};
      saveState(statePath, state);
      console.log(`✓ ${id} done (${node.workflow} → ${rec.childRun})`);
      continue;
    }

    const block = lib.get(node.block);
    const values = resolveNodeInputs(node, block, ctx);
    if (block.kind === 'fuzzy') {
      rec.input = values;
      rec.blockHash = hashBlock(block);
      saveState(statePath, state);
      console.log(`⏸ paused at fuzzy node "${id}" (${node.block})`);
      console.log(`  contract: ${relative(deps.root, block.dir)}/SKILL.md`);
      console.log(`  input: ${JSON.stringify(values).slice(0, 400)}`);
      if (block.oracle?.claims) {
        console.log(`  requires: an approval signed by a key with claims [${block.oracle.claims.join(', ')}] — add --sign <private-keyfile>`);
      }
      console.log(`  then:  blocks record --state ${relative(deps.root, statePath)} --node ${id} --output <answer.json>${block.oracle?.claims ? ' --sign <keyfile>' : ''}`);
      console.log(`  state: ${relative(deps.root, statePath)}`);
      return { status: 'paused' };
    }

    const output = execDeterministic(node, block, values, workflow, deps.root);
    state.nodes[id] = { status: 'done', blockHash: hashBlock(block), attempts: 1, output };
    saveState(statePath, state);
    console.log(`✓ ${id} done (${node.block})`);
  }

  const outs = resolveOutputs(workflow, state, liveInputs, statePath);
  if (!outs.ok) return { status: 'output-failure', detail: outs.detail };
  return { status: 'complete' };
}

// --- verbs -------------------------------------------------------------------

export async function runVerb(verb, args, { root, loadValidated, flag, usage }) {
  if (verb === 'record') return recordVerb(args, { root, flag, usage });

  const stateFile = flag('--state');
  const outFile = flag('--out');
  const kvFlags = [];
  let i;
  while ((i = args.indexOf('--input')) !== -1) {
    const kv = args[i + 1] ?? '';
    const eq = kv.indexOf('=');
    if (eq === -1) usage('--input needs key=value');
    kvFlags.push([kv.slice(0, eq), kv.slice(eq + 1)]);
    args.splice(i, 2);
  }
  const file = args[0] ?? usage(`${verb} needs a workflow file`);
  const wfCtx = loadValidated(file);
  const { workflow, lib, order } = wfCtx;

  let state;
  let statePath;
  if (stateFile) {
    state = loadState(stateFile);
    statePath = resolve(stateFile);
    if (state.workflow !== workflow.name) fail(`run-state is for workflow "${state.workflow}", not "${workflow.name}"`, 2);
    checkNoDrift(state, file);
    // PROTOCOL [RUN-7]/[RNR-14]: digests are one-way — secrets are re-supplied, never read back
    for (const [key, schema] of Object.entries(workflow.inputs ?? {})) {
      if (schema.secret === true && !kvFlags.some(([k]) => k === key)) {
        fail(`secret input "${key}" must be re-supplied on resume: --input ${key}=<value> (secrets are digested at rest)`, 2);
      }
    }
  } else {
    const inputs = resolveInputs(workflow, kvFlags);
    state = newState(workflow, file, inputs, root);
    mkdirSync(join(root, 'runs'), { recursive: true });
    statePath = outFile ?? join(root, 'runs', `${workflow.name}-${state.runId}.run.json`);
    state._liveInputs = inputs; // in-memory only, stripped before save
  }

  // Live inputs: secrets are digested in persisted state, so a resumed run
  // re-reads them from --input flags; non-secret inputs come from the state.
  const liveInputs = state._liveInputs ?? { ...state.inputs, ...Object.fromEntries(kvFlags) };
  delete state._liveInputs;

  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));

  if (verb === 'plan') {
    console.log(`${workflow.name}  run order:`);
    let next = null;
    for (const id of order) {
      const status = state.nodes[id]?.status ?? 'pending';
      const node = byId.get(id);
      const pin = node.block ?? node.workflow;
      const block = node.block ? lib.get(node.block) : null;
      const kind = node.workflow ? 'wf' : block.kind === 'fuzzy' ? '~fuzzy' : 'det';
      if (!next && status === 'pending') next = { id, node, block };
      console.log(`  ${status === 'done' ? '✓' : status === 'skipped' ? '↷' : status === 'failed' ? '✗' : '·'} ${id}  ${pin} [${kind}] ${status}`);
    }
    if (next) {
      const kind = next.node.workflow ? 'workflow' : next.block.kind;
      console.log(`next: ${next.id} (${kind})${kind === 'fuzzy' ? ` — read ${relative(root, next.block.dir)}/SKILL.md, produce output JSON, then: blocks record --state ${statePath} --node ${next.id} --output <file>` : ''}`);
    } else {
      console.log('next: nothing pending — run complete');
    }
    return;
  }

  const res = driveRun(wfCtx, state, statePath, liveInputs, { root, loadValidated });
  if (res.status === 'complete') {
    saveState(statePath, state);
    console.log(`run complete → ${relative(process.cwd(), statePath)}`);
  } else if (res.status === 'failed') {
    fail(res.detail);
  } else if (res.status === 'output-failure') {
    fail(res.detail); // nothing recorded; deterministic re-failure until the workflow is fixed
  }
  // paused: messages already printed, exit 0 — the run legitimately awaits its oracle
}

export async function checkOutputVerb(args, { root, usage }) {
  const [blockRef, source] = args;
  if (!blockRef || !source) usage('check-output needs <block> and <json-file|->');
  const dir = existsSync(join(root, 'blocks', blockRef)) ? join(root, 'blocks', blockRef) : blockRef;
  const { block, errors: blockErrors } = loadBlock(dir);
  if (!block) { console.error(formatErrors(blockErrors)); process.exit(1); }
  const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  let candidate;
  try { candidate = JSON.parse(raw); } catch (e) { fail(`candidate output is not valid JSON: ${e.message}`); }
  const errors = validateShape(candidate, block.outputs, '');
  if (errors.length) {
    console.error(`✗ candidate output violates ${block.name}@${block.version}'s contract:`);
    console.error(formatErrors(errors));
    process.exit(1);
  }
  console.log(`✓ valid output for ${block.name}@${block.version}`);
}

const MAX_ATTEMPTS = 3; // 1 initial + 2 repairs (SPEC §6, PROTOCOL [RNR-11])

function recordVerb(args, { root, flag, usage }) {
  const stateFile = flag('--state') ?? usage('record needs --state <run.json>');
  const nodeId = flag('--node') ?? usage('record needs --node <id>');
  const outputFile = flag('--output') ?? usage('record needs --output <file>');
  const signPath = flag('--sign');
  const state = loadState(stateFile);
  const rec = state.nodes?.[nodeId];
  if (!rec) fail(`run-state has no node "${nodeId}" (nodes: ${Object.keys(state.nodes ?? {}).join(', ')})`, 2);
  if (rec.status === 'done') fail(`node "${nodeId}" is already done — record refuses to overwrite`, 2);
  if (rec.status === 'skipped') fail(`node "${nodeId}" was skipped by its gate`, 2);
  if (rec.status === 'failed') fail(`node "${nodeId}" has failed in this run — a failed node is terminal; start a new run`, 2);
  if (rec.input === undefined) fail(`node "${nodeId}" has not been reached yet — run \`blocks exec --state ${stateFile}\` first`, 2);

  // find the block via the workflow file recorded in state — and refuse a
  // workflow that drifted since the run started (closes the pin-swap path)
  const wfFile = [
    state.workflowFile && resolve(root, state.workflowFile),
    join(root, 'workflows', `${state.workflow}.workflow.json`),
  ].filter(Boolean).find(existsSync);
  let block = null;
  if (wfFile) {
    checkNoDrift(state, wfFile, 'record into this run');
    const wf = JSON.parse(readFileSync(wfFile, 'utf8'));
    const pin = wf.nodes.find((n) => n.id === nodeId)?.block;
    if (pin) {
      const { block: loaded } = loadBlock(join(root, 'blocks', pin.split('@')[0]));
      if (loaded) block = loaded;
    }
  }
  if (!block) fail(`cannot resolve the block contract for node "${nodeId}" — is ${state.workflowFile ?? `workflows/${state.workflow}.workflow.json`} present?`);
  // the block itself may not drift between pause and record ([RNR-9])
  if (rec.blockHash && rec.blockHash !== hashBlock(block)) {
    fail(`block for node "${nodeId}" has changed since the run paused (blockHash mismatch) — start a new run`);
  }

  let candidate;
  try { candidate = JSON.parse(readFileSync(outputFile, 'utf8')); } catch (e) { fail(`output file is not valid JSON: ${e.message}`, 2); }

  // --- authenticate before contract (PROTOCOL [SIG-5]): auth failures are
  // permission refusals and never count against the attempt budget ---
  let approval = null;
  const required = block.oracle?.claims;
  if (required || signPath) {
    if (!signPath) {
      refuse(`node "${nodeId}" requires an approval signed by a key with claims [${required.join(', ')}] — pass --sign <private-keyfile>`);
    }
    const { key: priv, errors: privErr } = loadPrivateKeyFile(signPath);
    if (!priv) { console.error(formatErrors(privErr)); process.exit(3); }
    const { key: reg, errors: regErr } = loadRegistryKey(root, priv.keyId);
    if (!reg) { console.error(formatErrors(regErr)); process.exit(3); }
    if (required && !required.every((c) => reg.claims.includes(c))) {
      refuse(`key "${priv.keyId}" carries claims [${reg.claims.join(', ')}] but node "${nodeId}" requires [${required.join(', ')}]`);
    }
    const canonical = [
      APPROVAL_PREFIX,
      state.workflowHash,
      hashBlock(block),
      state.runId,
      nodeId,
      sha256(Buffer.from(canon(rec.input), 'utf8')),
      sha256(Buffer.from(canon(candidate), 'utf8')),
    ].join('\n');
    const signature = sign(null, Buffer.from(canonical, 'utf8'),
      createPrivateKey({ key: priv.privateJwk, format: 'jwk' })).toString('base64url');
    const ok = verify(null, Buffer.from(canonical, 'utf8'),
      createPublicKey({ key: reg.publicJwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
    if (!ok) {
      refuse(`signature by "${priv.keyId}" does not verify against the registered public key keys/${priv.keyId}.json`);
    }
    approval = { keyId: priv.keyId, signature };
  }

  rec.attempts = (rec.attempts ?? 0) + 1;
  const errors = validateShape(candidate, block.outputs, '');
  if (errors.length) {
    if (rec.attempts >= MAX_ATTEMPTS) {
      rec.status = 'failed';
      rec.reason = `output failed contract validation ${rec.attempts} times`;
      saveState(stateFile, state);
      console.error(`✗ node "${nodeId}" FAILED after ${rec.attempts} attempts. Findings:`);
      console.error(formatErrors(errors));
      process.exit(1);
    }
    saveState(stateFile, state);
    console.error(`✗ attempt ${rec.attempts}/${MAX_ATTEMPTS}: output violates the contract — repair and record again${approval ? ' (and re-sign the repaired answer)' : ''}:`);
    console.error(formatErrors(errors));
    process.exit(1);
  }
  rec.status = 'done';
  rec.output = candidate;
  rec.blockHash = hashBlock(block);
  if (approval) rec.approval = approval;
  saveState(stateFile, state);
  console.log(`✓ recorded${approval ? ` (signed by ${approval.keyId})` : ''} output for "${nodeId}" (attempt ${rec.attempts}) — continue with: blocks exec ${wfFile ? relative(root, wfFile) : '<workflow>'} --state ${stateFile}`);
}
