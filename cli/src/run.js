// Runs: plan / exec / record / check-output (SPEC §6–§8, PROTOCOL §11–§12).
// The CLI is the runtime for deterministic nodes; the agent is the driver,
// and the oracle for fuzzy nodes — `record` is the only door its answers fit through.
// Draft 02: workflows nest (child runs are ordinary run files) and fuzzy answers
// can be required to carry an Ed25519 approval signed by a registered key.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, realpathSync, mkdtempSync, rmSync, chmodSync, renameSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { validateShape, validateValue } from './schema.js';
import { evalTemplate, parseTemplate, walkStrings } from './bindings.js';
import { effectiveGlobs } from './globs.js';
import { parseWhen, evalWhen } from './when.js';
import { loadBlock } from './loader.js';
import { formatErrors, IMPLEMENTED_PROTOCOL } from './validate.js';
import { canon } from './canon.js';
import { APPROVAL_PREFIX, approvalPayload, secretDigest, sha256 } from './evidence.js';
import { loadRegistryKey, loadPrivateKeyFile } from './keys.js';
import { deriveRunStatus } from './run-status.js';

export { APPROVAL_PREFIX, sha256 } from './evidence.js';

// Draft 03 preimage split (PROTOCOL [RUN-2]): a deterministic block's prose is
// descriptive [BLK-4], so its hash covers only the executable surface; a fuzzy
// block's prose IS the contract, so it stays in.
export function hashBlock(block) {
  const parts = block.kind === 'deterministic'
    ? [readFileSync(join(block.dir, 'contract.json'))]
    : [readFileSync(join(block.dir, 'SKILL.md')), readFileSync(join(block.dir, 'contract.json'))];
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

function parseInputValue(key, raw, schema) {
  if (schema.type === 'string') return raw;
  try { return JSON.parse(raw); } catch { fail(`input "${key}" wants ${schema.type}; ${JSON.stringify(raw)} does not parse`, 2); }
}

function resolveInputs(workflow, kvFlags) {
  const schemas = workflow.inputs ?? {};
  const values = {};
  for (const [key, raw] of kvFlags) {
    const schema = schemas[key];
    if (!schema) fail(`unknown workflow input "${key}" (declared: ${Object.keys(schemas).join(', ') || 'none'})`, 2);
    values[key] = parseInputValue(key, raw, schema);
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

function resolveResumeInputs(workflow, kvFlags, state) {
  const schemas = workflow.inputs ?? {};
  const live = { ...state.inputs };
  const providedSecrets = new Set();
  for (const [key, raw] of kvFlags) {
    const schema = schemas[key];
    if (!schema) fail(`unknown workflow input "${key}" (declared: ${Object.keys(schemas).join(', ') || 'none'})`, 2);
    if (schema.secret !== true) fail(`cannot override non-secret workflow input "${key}" on resume — run inputs are immutable`, 2);
    const value = parseInputValue(key, raw, schema);
    const errors = validateValue(value, schema, `/inputs/${key}`);
    if (errors.length) { console.error(formatErrors(errors)); process.exit(2); }
    const expected = state.inputs?.[key];
    const actual = secretDigest(state.secretSalt, value);
    if (expected !== actual) fail(`secret input "${key}" does not match the digest recorded in run ${state.runId}`, 2);
    live[key] = value;
    providedSecrets.add(key);
  }
  for (const [key, schema] of Object.entries(schemas)) {
    if (schema.secret === true && !providedSecrets.has(key)) {
      fail(`secret input "${key}" must be re-supplied on resume: --input ${key}=<value> (secrets are digested at rest)`, 2);
    }
  }
  return live;
}

// Secrets: stored in run-state as digests only (SPEC §7, PROTOCOL [RUN-7]).
function persistedInputs(workflow, inputs, secretSalt) {
  const out = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = workflow.inputs?.[key]?.secret === true ? secretDigest(secretSalt, value) : value;
  }
  return out;
}

// --- run-state --------------------------------------------------------------

function newState(workflow, workflowFile, inputs, root) {
  const state = {
    workflow: workflow.name,
    workflowFile: relative(realpathSync(root), realpathSync(workflowFile)),
    workflowHash: sha256(readFileSync(workflowFile)),
    runId: `r-${randomUUID().slice(0, 8)}`,
    startedAt: new Date().toISOString(),
    secretSalt: randomBytes(16).toString('base64url'),
    inputs: {},
    nodes: Object.fromEntries(workflow.nodes.map((n) => [n.id, { status: 'pending' }])),
  };
  state.inputs = persistedInputs(workflow, inputs, state.secretSalt);
  // Every run this runner creates embodies the current runner's ledger
  // semantics, so it is stamped with this implementation's protocol draft
  // regardless of the workflow's older construct set (PROTOCOL [VER-4]).
  state.protocol = Math.max(IMPLEMENTED_PROTOCOL, workflow.protocol ?? 1);
  return state;
}

function loadState(file) {
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { fail(`cannot load run-state ${file}: ${e.message}`); }
  // PROTOCOL [VER-4]: reject run documents from drafts we do not implement,
  // and refuse to continue runs from earlier drafts — restamping would mint
  // mixed-preimage documents nobody can audit honestly.
  if ((state.protocol ?? 1) > IMPLEMENTED_PROTOCOL) {
    fail(`run document declares protocol ${state.protocol}; this implementation speaks protocol ${IMPLEMENTED_PROTOCOL}`);
  }
  if ((state.protocol ?? 1) < IMPLEMENTED_PROTOCOL) {
    fail(`run document declares protocol ${state.protocol ?? 1}; this runner writes protocol-${IMPLEMENTED_PROTOCOL} runs and cannot continue an earlier draft's run — start a new run`);
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
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
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

function insideRealWorkspace(realRoot, abs) {
  const rel = relative(realRoot, abs);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

function nearestExistingParent(abs) {
  let cur = abs;
  while (!existsSync(cur)) {
    const next = dirname(cur);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

function ensurePotentialPathInside(realRoot, abs, label) {
  const existing = existsSync(abs) ? abs : nearestExistingParent(abs);
  let real;
  try { real = realpathSync(existing); } catch (e) { refuse(`${label} cannot be resolved: ${e.message}`); }
  if (!insideRealWorkspace(realRoot, real)) refuse(`${label} escapes the workspace`);
  return real;
}

function ensureWorkspacePathValue(realRoot, inputPath, access) {
  const abs = resolve(realRoot, inputPath);
  const rel = relative(realRoot, abs);
  if (isAbsolute(inputPath) || rel.startsWith('..')) refuse(`${access} path escapes the workspace: ${inputPath}`);
  const existing = existsSync(abs) ? abs : nearestExistingParent(abs);
  let real;
  try { real = realpathSync(existing); } catch (e) { refuse(`${access} path cannot be resolved: ${e.message}`); }
  if (!insideRealWorkspace(realRoot, real)) refuse(`${access} path escapes the workspace through a symlink: ${inputPath}`);
}

function effectiveFsTargets(realRoot, globs, access) {
  const targets = new Set();
  for (const glob of globs) {
    if (!insideWorkspace(realRoot, glob.replace(/\*.*$/, '.'))) refuse(`${access} grant ${glob} escapes the workspace`);
    const wildcard = glob.includes('*');
    const prefix = wildcard ? (glob.split('*')[0] || '.') : glob;
    const abs = resolve(realRoot, prefix || '.');
    ensurePotentialPathInside(realRoot, abs, `${access} grant ${glob}`);
    if (access === 'write' && wildcard) mkdirSync(abs, { recursive: true });
    const target = existsSync(abs) ? realpathSync(abs) : abs;
    if (!insideRealWorkspace(realRoot, target)) refuse(`${access} grant ${glob} escapes the workspace`);
    targets.add(target);
    if (wildcard) targets.add(`${target}/*`);
  }
  return targets;
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
    return captureOutput(block, stdout, node, values);
  }

  // entry variant: node script, argv-spawned, fs-fenced when the runtime can.
  const readGlobs = effectiveGlobs(block.permissions.read, grants.read);
  const writeGlobs = effectiveGlobs(block.permissions.write, grants.write);
  // Realpath everything before the spawn: Node's permission model stats each
  // path component, and a symlinked component (macOS /var -> /private/var)
  // outside the allow list would be refused mid-walk.
  const realRoot = realpathSync(root);
  if (block.name === 'write-file' && typeof values.path === 'string') ensureWorkspacePathValue(realRoot, values.path, 'write');
  const entryFile = realpathSync(join(block.dir, block.exec.entry));
  if (!insideRealWorkspace(realpathSync(block.dir), entryFile)) refuse(`entry script ${block.exec.entry} escapes its block directory`);
  const permissionSupported = nodeSupportsPermissionModel();
  const grantReadTargets = permissionSupported ? effectiveFsTargets(realRoot, readGlobs, 'read') : new Set();
  const grantWriteTargets = permissionSupported ? effectiveFsTargets(realRoot, writeGlobs, 'write') : new Set();
  let tmpDir;
  let inputsFile;
  let realInputsFile;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'blocks-input-'));
    inputsFile = join(tmpDir, `input-${randomUUID()}.json`);
    writeFileSync(inputsFile, JSON.stringify(values), { mode: 0o600, flag: 'wx' });
    chmodSync(inputsFile, 0o600);
    realInputsFile = realpathSync(inputsFile);
  } catch (e) {
    if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
  const nodeArgs = [];
  if (permissionSupported) {
    const readTargets = new Set([entryFile, realInputsFile, ...grantReadTargets]);
    nodeArgs.push('--permission', ...[...readTargets].map((p) => `--allow-fs-read=${p}`));
    if (grantWriteTargets.size > 0) {
      nodeArgs.push(...[...grantWriteTargets].map((p) => `--allow-fs-write=${p}`));
    }
  } else {
    console.error('note: this Node lacks the permission model — fs enforcement for entry blocks depends on block-level checks (SPEC §2.2)');
  }
  let stdout;
  let execError;
  try {
    stdout = execFileSync(process.execPath, [...nodeArgs, entryFile, realInputsFile], {
      cwd: realRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false,
      env: {
        PATH: process.env.PATH,
        BLOCKS_EFFECTIVE_READ: JSON.stringify(readGlobs),
        BLOCKS_EFFECTIVE_WRITE: JSON.stringify(writeGlobs),
      },
    });
  } catch (e) {
    execError = e; // fail() exits the process, so clean up first
  } finally {
    try { unlinkSync(inputsFile); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  if (execError) {
    const detail = (execError.stderr || execError.message || '').toString().slice(0, 500);
    const escaped = execError.status === 3;
    if (escaped) refuse(`node "${node.id}" entry script: ${detail}`);
    fail(`node "${node.id}" entry script failed: ${detail}`);
  }
  return captureOutput(block, stdout, node, values);
}

function captureOutput(block, stdout, node, inputValues) {
  let output;
  if (block.exec.capture === 'text') output = { text: stdout };
  else {
    try { output = JSON.parse(stdout); } catch { fail(`node "${node.id}" must print a JSON object, got: ${stdout.slice(0, 200)}`); }
  }
  const errors = validateShape(output, block.outputs, `/nodes/${node.id}/output`, { inputs: inputValues });
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
      const currentBlockHash = hashBlock(block);
      if (rec.input !== undefined || rec.blockHash !== undefined) {
        if (rec.blockHash !== currentBlockHash) {
          fail(`block for node "${id}" has changed since the run paused (blockHash mismatch) — start a new run`);
        }
        if (rec.input === undefined || canon(rec.input) !== canon(values)) {
          fail(`resolved input for fuzzy node "${id}" has changed since the run paused (input mismatch) — start a new run`);
        }
      } else {
        rec.input = values;
        rec.blockHash = currentBlockHash;
        saveState(statePath, state);
      }
      console.log(`⏸ paused at fuzzy node "${id}" (${node.block})`);
      console.log(`  contract: ${relative(deps.root, block.dir)}/SKILL.md`);
      console.log(`  input: ${JSON.stringify(values).slice(0, 400)}`);
      if (block.oracle?.claims) {
        console.log(`  requires: detached approval by a key with claims [${block.oracle.claims.join(', ')}] — export bytes with: blocks approval --state ${relative(deps.root, statePath)} --node ${id} --output <answer.json> --raw`);
      }
      if (block.oracle?.capability) {
        console.log(`  calibrated: this contract assumes capability "${block.oracle.capability}" — record requires --attest ${block.oracle.capability} (self-attested, PROTOCOL [CAP-2])`);
      }
      console.log(`  then:  blocks record --state ${relative(deps.root, statePath)} --node ${id} --output <answer.json>${block.oracle?.claims ? ' --approval <approval.json>' : ''}${block.oracle?.capability ? ` --attest ${block.oracle.capability}` : ''}`);
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

const PLAN_STATUSES = new Set(['pending', 'done', 'skipped', 'failed']);

function verifyPlanState(workflow, state) {
  if (state.nodes === null || typeof state.nodes !== 'object' || Array.isArray(state.nodes)) {
    fail('run-state nodes must be an object of node records', 2);
  }
  for (const node of workflow.nodes) {
    const rec = state.nodes[node.id];
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      fail(`run-state is missing node "${node.id}"`, 2);
    }
    if (!PLAN_STATUSES.has(rec.status)) {
      fail(`run-state node "${node.id}" has invalid status ${JSON.stringify(rec.status)}`, 2);
    }
  }
}

function renderPlan(wfCtx, { root, file, state, statePath }) {
  const { workflow, lib, order } = wfCtx;
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const workflowRef = relative(root, resolve(file));
  console.log(`${workflow.name}  run order:`);
  let next = null;
  for (const id of order) {
    const rec = state?.nodes?.[id];
    const status = rec?.status ?? 'pending';
    const node = byId.get(id);
    const pin = node.block ?? node.workflow;
    const block = node.block ? lib.get(node.block) : null;
    const label = node.workflow ? 'wf' : block.kind === 'fuzzy' ? '~fuzzy' : 'det';
    if (!next && status === 'pending') next = { id, node, block, rec };
    console.log(`  ${status === 'done' ? '✓' : status === 'skipped' ? '↷' : status === 'failed' ? '✗' : '·'} ${id}  ${pin} [${label}] ${status}`);
  }
  if (!next) {
    console.log('next: nothing pending — run complete');
    return;
  }
  const kind = next.node.workflow ? 'workflow' : next.block.kind;
  let guidance;
  if (!state) {
    guidance = `start a run: blocks exec ${workflowRef}`;
  } else if (kind === 'fuzzy' && next.rec?.input !== undefined) {
    guidance = `read ${relative(root, next.block.dir)}/SKILL.md, produce output JSON, then: blocks record --state ${statePath} --node ${next.id} --output <file>`;
  } else {
    guidance = `continue the run: blocks exec ${workflowRef} --state ${statePath}`;
  }
  console.log(`next: ${next.id} (${kind}) — ${guidance}`);
}

export async function runVerb(verb, args, { root, loadValidated, flag, boolFlag, usage }) {
  if (verb === 'record') return recordVerb(args, { root, flag, usage });

  const json = verb === 'exec' ? boolFlag('--json') : false;
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
  const { workflow } = wfCtx;

  if (verb === 'plan') {
    let state;
    let statePath;
    if (stateFile) {
      state = loadState(stateFile);
      statePath = resolve(stateFile);
      if (state.workflow !== workflow.name) fail(`run-state is for workflow "${state.workflow}", not "${workflow.name}"`, 2);
      checkNoDrift(state, file, 'plan this run');
      verifyPlanState(workflow, state);
    }
    renderPlan(wfCtx, { root, file, state, statePath });
    return;
  }

  let state;
  let statePath;
  if (stateFile) {
    state = loadState(stateFile);
    statePath = resolve(stateFile);
    if (state.workflow !== workflow.name) fail(`run-state is for workflow "${state.workflow}", not "${workflow.name}"`, 2);
    checkNoDrift(state, file);
  } else {
    const inputs = resolveInputs(workflow, kvFlags);
    state = newState(workflow, file, inputs, root);
    mkdirSync(join(root, 'runs'), { recursive: true });
    statePath = outFile ?? join(root, 'runs', `${workflow.name}-${state.runId}.run.json`);
    state._liveInputs = inputs; // in-memory only, stripped before save
  }

  // Live inputs: secrets are digested in persisted state, so a resumed run
  // re-reads schema-typed values from --input flags after digest comparison;
  // non-secret inputs are immutable and come only from the state.
  const liveInputs = state._liveInputs ?? resolveResumeInputs(workflow, kvFlags, state);
  delete state._liveInputs;

  const originalLog = console.log;
  if (json) console.log = () => {};
  let res;
  try { res = driveRun(wfCtx, state, statePath, liveInputs, { root, loadValidated }); }
  finally { console.log = originalLog; }
  if (res.status === 'complete') saveState(statePath, state);
  const derived = deriveRunStatus(root, statePath);
  if (json) console.log(JSON.stringify(derived));
  else if (res.status === 'complete') console.log(`run complete → ${relative(process.cwd(), statePath)}`);
  if (res.status === 'failed') {
    if (json) process.exit(1);
    fail(res.detail);
  } else if (res.status === 'output-failure') {
    if (json) process.exit(1);
    fail(res.detail); // nothing recorded; deterministic re-failure until the workflow is fixed
  }
  // paused: structured status or human pause instructions already emitted, exit 0
}

function pausedTarget(root, stateFile, nodeId, action) {
  const state = loadState(stateFile);
  const rec = state.nodes?.[nodeId];
  if (!rec) fail(`run-state has no node "${nodeId}" (nodes: ${Object.keys(state.nodes ?? {}).join(', ')})`, 2);
  if (rec.status === 'done') fail(`node "${nodeId}" is already done — ${action} refuses to overwrite`, 2);
  if (rec.status === 'skipped') fail(`node "${nodeId}" was skipped by its gate`, 2);
  if (rec.status === 'failed') fail(`node "${nodeId}" has failed in this run — a failed node is terminal; start a new run`, 2);
  if (rec.input === undefined) fail(`node "${nodeId}" has not been reached yet — run blocks exec first`, 2);
  const wfFile = [
    state.workflowFile && resolve(root, state.workflowFile),
    join(root, 'workflows', `${state.workflow}.workflow.json`),
  ].filter(Boolean).find(existsSync);
  let block = null;
  if (wfFile) {
    checkNoDrift(state, wfFile, action);
    const wf = JSON.parse(readFileSync(wfFile, 'utf8'));
    const pin = wf.nodes.find((node) => node.id === nodeId)?.block;
    if (pin) block = loadBlock(join(root, 'blocks', pin.split('@')[0])).block ?? null;
  }
  if (!block) fail(`cannot resolve the block contract for node "${nodeId}" — is ${state.workflowFile ?? `workflows/${state.workflow}.workflow.json`} present?`);
  const currentBlockHash = hashBlock(block);
  if (rec.blockHash && rec.blockHash !== currentBlockHash) {
    fail(`block for node "${nodeId}" has changed since the run paused (blockHash mismatch) — start a new run`);
  }
  return { state, rec, wfFile, block, currentBlockHash };
}

function readCandidate(outputFile) {
  try { return JSON.parse(readFileSync(outputFile, 'utf8')); }
  catch (e) { fail(`output file is not valid JSON: ${e.message}`, 2); }
}

function approvalBytes(state, rec, nodeId, blockHash, candidate) {
  return approvalPayload({
    workflowHash: state.workflowHash,
    blockHash,
    runId: state.runId,
    nodeId,
    input: rec.input,
    answer: candidate,
  });
}

function privateKeyPathInsideWorkspace(root, keyPath) {
  const realRoot = realpathSync(root);
  const absolute = resolve(keyPath);
  const lexical = relative(resolve(root), absolute);
  if (!lexical.startsWith('..') && !isAbsolute(lexical)) return true;
  const existing = existsSync(absolute) ? absolute : nearestExistingParent(absolute);
  const real = realpathSync(existing);
  return insideRealWorkspace(realRoot, real);
}

export async function approvalVerb(args, { root, flag, boolFlag, usage }) {
  const stateFile = flag('--state') ?? usage('approval needs --state <run.json>');
  const nodeId = flag('--node') ?? usage('approval needs --node <id>');
  const outputFile = flag('--output') ?? usage('approval needs --output <candidate.json>');
  const raw = boolFlag('--raw');
  if (args.length) usage(`approval does not recognize: ${args.join(' ')}`);
  const { state, rec, block, currentBlockHash } = pausedTarget(root, stateFile, nodeId, 'export an approval payload');
  const candidate = readCandidate(outputFile);
  const errors = validateShape(candidate, block.outputs, '', { inputs: rec.input });
  if (errors.length) {
    console.error(`candidate output violates ${block.name}@${block.version}'s contract; refusing to export a signing payload:`);
    console.error(formatErrors(errors));
    process.exit(1);
  }
  const payload = approvalBytes(state, rec, nodeId, currentBlockHash, candidate);
  if (raw) process.stdout.write(payload);
  else console.log(JSON.stringify({
    algorithm: 'Ed25519',
    encoding: 'utf8',
    payload,
    inputDigest: sha256(Buffer.from(canon(rec.input), 'utf8')),
    answerDigest: sha256(Buffer.from(canon(candidate), 'utf8')),
  }, null, 2));
}

export async function checkOutputVerb(args, { root, usage }) {
  let inputFile;
  const inputIndex = args.indexOf('--input');
  if (inputIndex !== -1) {
    inputFile = args[inputIndex + 1] ?? usage('--input needs a resolved-input JSON file');
    args.splice(inputIndex, 2);
  }
  const [blockRef, source] = args;
  if (!blockRef || !source || args.length !== 2) usage('check-output needs <block> <json-file|-> [--input resolved-input.json]');
  const dir = existsSync(join(root, 'blocks', blockRef)) ? join(root, 'blocks', blockRef) : blockRef;
  const { block, errors: blockErrors } = loadBlock(dir);
  if (!block) { console.error(formatErrors(blockErrors)); process.exit(1); }
  const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  let candidate;
  try { candidate = JSON.parse(raw); } catch (e) { fail(`candidate output is not valid JSON: ${e.message}`); }
  const contextual = Object.values(block.outputs).some((schema) => schema.enumFromInput !== undefined);
  let resolvedInputs;
  if (inputFile) {
    try { resolvedInputs = JSON.parse(readFileSync(inputFile, 'utf8')); } catch (e) { fail(`resolved input file is not valid JSON: ${e.message}`, 2); }
  }
  if (contextual && !resolvedInputs) usage(`check-output for ${block.name}@${block.version} needs --input <resolved-input.json> to enforce enumFromInput`);
  const errors = validateShape(candidate, block.outputs, '', { inputs: resolvedInputs });
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
  const approvalFile = flag('--approval');
  const attest = flag('--attest');
  if (signPath && approvalFile) usage('record accepts exactly one of --sign or --approval');
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

  // capability attestation ([CAP-2]): checked before parse, auth, and attempt
  // accounting — a missing/mismatched attestation is an incomplete submission
  // (usage class), not an authority failure; nothing verifies its truth.
  const requiredCap = block.oracle?.capability;
  const requiredClaims = block.oracle?.claims;
  const missingCap = requiredCap !== undefined && attest === undefined;
  const missingApproval = requiredClaims !== undefined && !signPath && !approvalFile;
  if (missingCap && missingApproval) {
    fail(`node "${nodeId}" is missing required ceremony: --attest ${requiredCap}; and --approval <file> or --sign <outside-workspace-keyfile> for claims [${requiredClaims.join(', ')}]`, 2);
  }
  if (missingCap) fail(`node "${nodeId}" is calibrated for capability "${requiredCap}" — self-attest with --attest ${requiredCap}`, 2);
  if (missingApproval) refuse(`node "${nodeId}" requires an approval signed by a key with claims [${requiredClaims.join(', ')}] — pass --approval <file> or --sign <outside-workspace-keyfile>`);
  if (requiredCap !== undefined || attest !== undefined) {
    if (!/^[a-z][a-z0-9-]*$/.test(attest ?? '')) {
      fail(`--attest must be a capability name matching [a-z][a-z0-9-]*, got ${JSON.stringify(attest)}`, 2);
    }
    if (requiredCap !== undefined && attest !== requiredCap) {
      fail(`attestation "${attest}" does not match the contract's declared capability "${requiredCap}"`, 2);
    }
  }

  const candidate = readCandidate(outputFile);

  // --- authenticate before contract (PROTOCOL [SIG-5]): auth failures are
  // permission refusals and never count against the attempt budget ---
  let approval = null;
  const required = requiredClaims;
  if (required || signPath || approvalFile) {
    if (!signPath && !approvalFile) {
      refuse(`node "${nodeId}" requires an approval signed by a key with claims [${required.join(', ')}] — pass --approval <file> or --sign <outside-workspace-keyfile>`);
    }
    let keyId;
    let signature;
    const canonical = approvalBytes(state, rec, nodeId, hashBlock(block), candidate);
    if (approvalFile) {
      let detached;
      try { detached = JSON.parse(readFileSync(approvalFile, 'utf8')); }
      catch (e) { refuse(`cannot read detached approval: ${e.message}`); }
      if (!detached || typeof detached !== 'object' || Array.isArray(detached)
          || Object.keys(detached).sort().join(',') !== 'keyId,signature'
          || typeof detached.keyId !== 'string' || typeof detached.signature !== 'string') {
        refuse('detached approval must be the closed object {"keyId": string, "signature": base64url string}');
      }
      ({ keyId, signature } = detached);
    } else {
      if (privateKeyPathInsideWorkspace(root, signPath)) {
        refuse('private key path is inside the workspace; use detached --approval or move the key to a user-local key directory');
      }
      const { key: priv, errors: privErr } = loadPrivateKeyFile(signPath);
      if (!priv) { console.error(formatErrors(privErr)); process.exit(3); }
      keyId = priv.keyId;
      signature = sign(null, Buffer.from(canonical, 'utf8'),
        createPrivateKey({ key: priv.privateJwk, format: 'jwk' })).toString('base64url');
    }
    const { key: reg, errors: regErr } = loadRegistryKey(root, keyId);
    if (!reg) { console.error(formatErrors(regErr)); process.exit(3); }
    if (required && !required.every((claim) => reg.claims.includes(claim))) {
      refuse(`key "${keyId}" carries claims [${reg.claims.join(', ')}] but node "${nodeId}" requires [${required.join(', ')}]`);
    }
    let ok = false;
    try {
      ok = verify(null, Buffer.from(canonical, 'utf8'),
        createPublicKey({ key: reg.publicJwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
    } catch { ok = false; }
    if (!ok) refuse(`signature by "${keyId}" does not verify against the registered public key keys/${keyId}.json`);
    approval = { keyId, signature };
  }

  rec.attempts = (rec.attempts ?? 0) + 1;
  const errors = validateShape(candidate, block.outputs, '', { inputs: rec.input });
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
  if (attest !== undefined) rec.capability = attest;
  saveState(stateFile, state);
  console.log(`✓ recorded${approval ? ` (signed by ${approval.keyId})` : ''} output for "${nodeId}" (attempt ${rec.attempts}) — continue with: blocks exec ${wfFile ? relative(root, wfFile) : '<workflow>'} --state ${stateFile}`);
}
