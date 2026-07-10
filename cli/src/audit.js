// Run audit: read-only verifier for protocol-3 run ledgers.
// Recomputes hashes, contracts, approvals, nested workflow copies, and final
// workflow outputs without executing blocks or invoking an oracle.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { isAbsolute, join, relative, resolve, dirname } from 'node:path';
import { loadLibrary } from './loader.js';
import { parseWorkflowFile, validateWorkflow } from './validate.js';
import { validateShape, validateValue } from './schema.js';
import { evalTemplate } from './bindings.js';
import { hashBlock } from './run.js';
import { approvalPayload, sha256 } from './evidence.js';
import { canon } from './canon.js';
import { loadRegistryKey } from './keys.js';

const MIN_PROTOCOL = 3;
const MAX_PROTOCOL = 4;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*$/;
const STATUSES = new Set(['pending', 'done', 'skipped', 'failed']);

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeRel(root, file) {
  const abs = resolve(file);
  const rel = relative(root, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
}

function add(findings, code, path, message, hint) {
  findings.push({ code, path, message, ...(hint ? { hint } : {}) });
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

function inside(realRoot, abs) {
  const rel = relative(realRoot, abs);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

function resolveRecordedPath(root, realRoot, raw, pointer, label, findings) {
  if (typeof raw !== 'string' || raw.length === 0) {
    add(findings, 'malformed-run', pointer, `${label} must be a non-empty workspace-relative path`);
    return null;
  }
  const abs = resolve(root, raw);
  let realExisting;
  try {
    realExisting = realpathSync(existsSync(abs) ? abs : nearestExistingParent(abs));
  } catch (e) {
    add(findings, 'path-unresolved', pointer, `${label} cannot be resolved inside the workspace: ${e.message}`);
    return null;
  }
  if (!inside(realRoot, realExisting)) {
    add(findings, 'path-escape', pointer, `${label} escapes the workspace through a symlink`);
    return null;
  }
  return abs;
}

function loadJsonFile(file, findings, pointer = '') {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    add(findings, 'missing-artifact', pointer, `cannot read run document: ${e.message}`);
    return null;
  }
  try {
    const value = JSON.parse(text);
    if (!isObjectRecord(value)) {
      add(findings, 'malformed-run', pointer, 'run document must be a JSON object');
      return null;
    }
    return value;
  } catch (e) {
    add(findings, 'malformed-run', pointer, `run document is not valid JSON: ${e.message}`);
    return null;
  }
}

function sanitizeSchemaMessage(message) {
  // validateValue includes a short JSON rendering of the offending value, and
  // numeric bounds include the value directly. Audit findings name the field and
  // expectation, never the recorded value.
  return message
    .replace(/ \([^)]*\)/g, '')
    .replace(/^.+ is (below minimum|above maximum) (.+)$/, 'value is $1 $2')
    .replace(/value .+ is not in enum/, 'value is not in enum');
}

function addSchemaFindings(findings, code, path, errors, what) {
  for (const e of errors) {
    add(findings, code, `${path}${e.pointer ?? ''}`, `${what}: ${sanitizeSchemaMessage(e.message)}`, e.hint);
  }
}

function nodeCtx(state, allowedNodeIds = null) {
  const nodeOutputs = {};
  for (const [id, rec] of Object.entries(state.nodes ?? {})) {
    if (rec?.status === 'done' && (!allowedNodeIds || allowedNodeIds.has(id))) nodeOutputs[id] = rec.output;
  }
  return { inputs: state.inputs ?? {}, nodeOutputs };
}

function nodeInputCtx(state, order, nodeId) {
  const index = order.indexOf(nodeId);
  const predecessors = index === -1 ? new Set() : new Set(order.slice(0, index));
  return nodeCtx(state, predecessors);
}

function deepResolve(raw, ctx) {
  if (typeof raw === 'string') return evalTemplate(raw, ctx);
  if (Array.isArray(raw)) return raw.map((v) => deepResolve(v, ctx));
  if (isObjectRecord(raw)) return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, deepResolve(v, ctx)]));
  return raw;
}

function recomputeNodeInput(node, block, state, order) {
  const ctx = nodeInputCtx(state, order, node.id);
  const values = {};
  for (const [name, raw] of Object.entries(node.in ?? {})) {
    values[name] = deepResolve(raw, ctx);
  }
  const errors = validateShape(values, block.inputs, '');
  return { values, errors };
}

function recomputeWorkflowOutput(workflow, state) {
  if (!workflow.outputs) return { ok: true, output: undefined };
  const ctx = nodeCtx(state);
  const out = {};
  for (const [name, decl] of Object.entries(workflow.outputs)) {
    const { from, ...schema } = decl;
    let value;
    try {
      value = deepResolve(from, ctx);
    } catch (e) {
      const cutPath = /no recorded output for node|output has no field/.test(e.message);
      if (cutPath && schema.required === false) continue;
      return { ok: false, message: `${schema.required === false ? '' : 'required '}workflow output "${name}" cannot be resolved: ${e.message}` };
    }
    const errors = validateValue(value, schema, `/output/${name}`);
    if (errors.length) return { ok: false, message: `workflow output "${name}": ${sanitizeSchemaMessage(errors[0].message)}` };
    out[name] = value;
  }
  return { ok: true, output: out };
}

function pseudoBlockFor(pin, childWf) {
  const inputs = Object.fromEntries(Object.entries(childWf.inputs ?? {})
    .map(([k, s]) => [k, s.default !== undefined ? { ...s, required: false } : s]));
  const outputs = Object.fromEntries(Object.entries(childWf.outputs ?? {})
    .map(([k, decl]) => { const { from, ...schema } = decl; return [k, schema]; }));
  const [name, version] = pin.split('@');
  return { name, version: Number(version), kind: 'workflow', inputs, outputs };
}

function verifyApproval({ root, run, rec, node, block, currentBlockHash, findings, path }) {
  const required = block.oracle?.claims;
  const approval = rec.approval;
  if (required && !approval) {
    add(findings, 'approval-missing', path, `node "${node.id}" requires an approval with claims [${required.join(', ')}]`);
    return;
  }
  if (!approval) return;
  if (!isObjectRecord(approval) || typeof approval.keyId !== 'string' || typeof approval.signature !== 'string') {
    add(findings, 'approval-malformed', `${path}/approval`, `node "${node.id}" approval must contain keyId and signature strings`);
    return;
  }
  const { key, errors } = loadRegistryKey(root, approval.keyId);
  if (!key) {
    for (const e of errors) add(findings, 'registry-key-invalid', `${path}/approval/keyId`, e.message, e.hint);
    return;
  }
  if (required && !required.every((claim) => key.claims.includes(claim))) {
    add(findings, 'approval-claim-missing', `${path}/approval/keyId`, `registered key "${approval.keyId}" does not carry every required claim for node "${node.id}"`);
  }
  if (rec.input === undefined || rec.output === undefined) {
    add(findings, 'approval-unverifiable', `${path}/approval`, `node "${node.id}" approval cannot be verified because the run lacks recorded input or output`);
    return;
  }
  let ok = false;
  try {
    const canonical = approvalPayload({
      workflowHash: run.workflowHash,
      blockHash: currentBlockHash,
      runId: run.runId,
      nodeId: node.id,
      input: rec.input,
      answer: rec.output,
    });
    ok = verify(null, Buffer.from(canonical, 'utf8'),
      createPublicKey({ key: key.publicJwk, format: 'jwk' }), Buffer.from(approval.signature, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) {
    add(findings, 'approval-signature-invalid', `${path}/approval/signature`, `approval signature for node "${node.id}" does not verify against the current registry and run evidence`);
  }
}

function verifyCapability({ rec, node, block, findings, path }) {
  const required = block.oracle?.capability;
  if (required !== undefined) {
    if (rec.capability === undefined) {
      add(findings, 'capability-missing', path, `node "${node.id}" requires capability attestation "${required}"`);
      return;
    }
    if (rec.capability !== required) {
      add(findings, 'capability-mismatch', `${path}/capability`, `node "${node.id}" recorded capability does not match the current contract`);
    }
  }
  if (rec.capability !== undefined && (typeof rec.capability !== 'string' || !CAPABILITY_RE.test(rec.capability))) {
    add(findings, 'capability-malformed', `${path}/capability`, `recorded capability for node "${node.id}" must match ${CAPABILITY_RE}`);
  }
}

function completedEnoughForOutputs(workflow, state) {
  return Array.isArray(workflow.nodes) && workflow.nodes.every((node) => {
    const status = state.nodes?.[node.id]?.status;
    return status === 'done' || status === 'skipped';
  });
}

function checkRunShape(run, findings, basePath) {
  if (typeof run.workflow !== 'string') add(findings, 'malformed-run', `${basePath}/workflow`, 'run workflow must be a string');
  if (typeof run.workflowHash !== 'string') add(findings, 'malformed-run', `${basePath}/workflowHash`, 'run workflowHash must be a string');
  if (typeof run.runId !== 'string') add(findings, 'malformed-run', `${basePath}/runId`, 'runId must be a string');
  if (!isObjectRecord(run.inputs)) add(findings, 'malformed-run', `${basePath}/inputs`, 'run inputs must be an object');
  if (!isObjectRecord(run.nodes)) add(findings, 'malformed-run', `${basePath}/nodes`, 'run nodes must be an object');
}

function auditRunFile(file, ctx) {
  const { root, realRoot, library, findings, visited, summary, pointer } = ctx;
  const absFile = resolve(root, file);
  let realFile;
  try { realFile = existsSync(absFile) ? realpathSync(absFile) : absFile; } catch { realFile = absFile; }
  if (visited.has(realFile)) {
    add(findings, 'child-cycle', pointer || '', 'child run graph contains the same run file more than once');
    return null;
  }
  visited.add(realFile);

  const run = loadJsonFile(absFile, findings, pointer || '');
  if (!run) return null;
  summary.runsChecked += 1;
  checkRunShape(run, findings, pointer || '');

  const protocol = run.protocol ?? 1;
  if (protocol < MIN_PROTOCOL || protocol > MAX_PROTOCOL) {
    const legacyOrFuture = protocol < MIN_PROTOCOL ? 'legacy' : 'future';
    add(findings, `${legacyOrFuture}-protocol`, `${pointer}/protocol`, `run document declares protocol ${protocol}; audit supports protocol ${MIN_PROTOCOL} through ${MAX_PROTOCOL}`, legacyOrFuture === 'future' ? `use an auditor that supports protocol ${protocol}` : 'use a historical auditor for this run');
    return run;
  }
  if (protocol >= 4 && (typeof run.secretSalt !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(run.secretSalt))) {
    add(findings, 'malformed-run', `${pointer}/secretSalt`, 'protocol-4 run secretSalt must be 128 random bits encoded as 22 base64url characters');
  }
  if (!isObjectRecord(run.nodes)) return run;

  const wfFile = resolveRecordedPath(root, realRoot, run.workflowFile, `${pointer}/workflowFile`, 'workflowFile', findings);
  if (!wfFile) return run;
  if (!existsSync(wfFile)) {
    add(findings, 'missing-artifact', `${pointer}/workflowFile`, `recorded workflow file is missing: ${safeRel(root, wfFile)}`);
    return run;
  }

  const currentWorkflowHash = sha256(readFileSync(wfFile));
  if (run.workflowHash !== currentWorkflowHash) {
    add(findings, 'workflow-hash-mismatch', `${pointer}/workflowHash`, `workflow file ${safeRel(root, wfFile)} no longer matches the run's recorded workflowHash`);
  }

  const { workflow, errors: parseErrors } = parseWorkflowFile(wfFile);
  if (parseErrors.length) {
    for (const e of parseErrors) add(findings, 'workflow-invalid', `${pointer}/workflowFile`, e.message, e.hint);
    return run;
  }
  if (!isObjectRecord(workflow) || !Array.isArray(workflow.nodes)) {
    add(findings, 'workflow-invalid', `${pointer}/workflowFile`, 'current workflow is not a usable workflow object');
    return run;
  }
  if (run.workflow !== workflow.name) {
    add(findings, 'workflow-name-mismatch', `${pointer}/workflow`, 'run workflow name does not match the current workflow file');
  }

  const { errors: validationErrors, order } = validateWorkflow(workflow, library, wfFile, { root });
  for (const e of validationErrors) {
    add(findings, 'workflow-invalid', `${pointer}/workflowFile${e.pointer ?? ''}`, e.message, e.hint);
  }
  if (validationErrors.length) return run;

  const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const id of Object.keys(run.nodes)) {
    if (!nodeMap.has(id)) add(findings, 'unknown-node-record', `${pointer}/nodes/${id}`, `run records node "${id}" that is not in the current workflow`);
  }

  for (const node of workflow.nodes) {
    const rec = run.nodes[node.id];
    const nodePath = `${pointer}/nodes/${node.id}`;
    if (!isObjectRecord(rec)) {
      add(findings, 'malformed-run', nodePath, `run is missing a node record object for "${node.id}"`);
      continue;
    }
    summary.nodesChecked += 1;
    if (!STATUSES.has(rec.status)) {
      add(findings, 'malformed-run', `${nodePath}/status`, `node "${node.id}" has an invalid status`);
    }

    if (node.workflow !== undefined) {
      if (rec.childRun !== undefined) {
        const childPath = resolveRecordedPath(root, realRoot, rec.childRun, `${nodePath}/childRun`, `childRun for node "${node.id}"`, findings);
        if (!childPath) continue;
        if (!existsSync(childPath)) {
          add(findings, 'missing-child-run', `${nodePath}/childRun`, `child run for node "${node.id}" is missing`);
          continue;
        }
        summary.childRuns += 1;
        const beforeFindings = findings.length;
        const child = auditRunFile(relative(root, childPath), { ...ctx, pointer: `${nodePath}/childRun` });
        if (child) {
          if (rec.workflowHash !== child.workflowHash) {
            add(findings, 'child-workflow-hash-mismatch', `${nodePath}/workflowHash`, `parent node "${node.id}" does not copy the child run's workflowHash`);
          }
          if (rec.status === 'done') {
            const copied = rec.output ?? {};
            const childOutput = child.output ?? {};
            if (canon(copied) !== canon(childOutput)) {
              add(findings, 'child-output-mismatch', `${nodePath}/output`, `parent node "${node.id}" output does not match the child run output`);
            }
            if (isObjectRecord(child.output)) {
              const childWfFile = resolveRecordedPath(root, realRoot, child.workflowFile, `${nodePath}/childRun/workflowFile`, 'child workflowFile', findings);
              if (childWfFile && existsSync(childWfFile)) {
                const { workflow: childWf } = parseWorkflowFile(childWfFile);
                if (isObjectRecord(childWf)) {
                  const pseudo = pseudoBlockFor(node.workflow, childWf);
                  const errors = validateShape(copied, pseudo.outputs, '');
                  addSchemaFindings(findings, 'child-output-contract', `${nodePath}/output`, errors, `copied child output for node "${node.id}" violates the workflow-node contract`);
                }
              }
            }
          }
        } else if (findings.length === beforeFindings) {
          add(findings, 'child-run-unreadable', `${nodePath}/childRun`, `child run for node "${node.id}" could not be audited`);
        }
      }
      continue;
    }

    const block = library.get(node.block);
    if (!block) {
      add(findings, 'block-missing', `${nodePath}/block`, `current library does not contain block ${node.block}`);
      continue;
    }
    const paused = rec.status === 'pending' && (rec.input !== undefined || rec.blockHash !== undefined);
    const needsBlockHash = rec.status === 'done' || paused;
    let currentBlockHash;
    if (needsBlockHash) {
      try {
        currentBlockHash = hashBlock(block);
        if (rec.blockHash !== currentBlockHash) {
          add(findings, 'block-hash-mismatch', `${nodePath}/blockHash`, `block ${node.block} no longer matches the run's recorded blockHash for node "${node.id}"`);
        }
      } catch (e) {
        add(findings, 'block-hash-unavailable', `${nodePath}/blockHash`, `cannot hash current block ${node.block}: ${e.message}`);
      }
    }

    if (rec.status === 'done') {
      const errors = validateShape(rec.output, block.outputs, '', { inputs: rec.input });
      addSchemaFindings(findings, 'output-contract', `${nodePath}/output`, errors, `recorded output for node "${node.id}" violates ${node.block}`);
    }

    if (block.kind === 'fuzzy' && (rec.status === 'done' || paused)) {
      let recomputed;
      try {
        recomputed = recomputeNodeInput(node, block, run, order);
      } catch (e) {
        add(findings, 'fuzzy-input-unresolved', `${nodePath}/input`, `fuzzy node "${node.id}" input cannot be recomputed from recorded workflow inputs and predecessor outputs: ${e.message}`);
      }
      if (recomputed) {
        addSchemaFindings(findings, 'fuzzy-input-contract', `${nodePath}/input`, recomputed.errors, `recomputed input for fuzzy node "${node.id}" violates ${node.block}`);
      }
      if (rec.input === undefined) {
        add(findings, 'fuzzy-input-missing', `${nodePath}/input`, `fuzzy node "${node.id}" lacks its recorded pause input`);
      } else if (recomputed && canon(rec.input) !== canon(recomputed.values)) {
        add(findings, 'fuzzy-input-mismatch', `${nodePath}/input`, `recorded input for fuzzy node "${node.id}" does not match recomputation from workflow bindings and recorded predecessor outputs`);
      }
      if (rec.status === 'done') {
        verifyCapability({ rec, node, block, findings, path: nodePath });
        if (currentBlockHash) verifyApproval({ root, run, rec, node, block, currentBlockHash, findings, path: nodePath });
      }
    }
  }

  if (completedEnoughForOutputs(workflow, run)) {
    const expected = recomputeWorkflowOutput(workflow, run);
    if (!expected.ok) {
      add(findings, 'workflow-output-unresolved', `${pointer}/output`, expected.message);
    } else if (expected.output === undefined) {
      if (run.output !== undefined) add(findings, 'workflow-output-mismatch', `${pointer}/output`, 'run records a top-level output, but the workflow declares none');
    } else if (canon(run.output) !== canon(expected.output)) {
      add(findings, 'workflow-output-mismatch', `${pointer}/output`, 'top-level workflow output does not match recomputation from recorded node outputs');
    }
  } else if (run.output !== undefined) {
    add(findings, 'workflow-output-stale', `${pointer}/output`, 'run is not complete but records a top-level output');
  }

  return run;
}

function renderText(result, runArg) {
  if (result.ok) {
    return `✓ audit ok: ${runArg} (${result.summary.runsChecked} run${result.summary.runsChecked === 1 ? '' : 's'}, ${result.summary.nodesChecked} node${result.summary.nodesChecked === 1 ? '' : 's'} checked)`;
  }
  const lines = [`✗ audit found ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}:`];
  for (const f of result.findings) {
    lines.push(`  - ${f.code} ${f.path}: ${f.message}${f.hint ? ` (hint: ${f.hint})` : ''}`);
  }
  return lines.join('\n');
}

export async function auditVerb(args, { root, boolFlag, usage }) {
  const json = boolFlag('--json');
  const runFile = args[0] ?? usage('audit needs a run.json file');
  if (args.length > 1) usage('audit accepts exactly one run.json file');

  const findings = [];
  let realRoot;
  try { realRoot = realpathSync(root); } catch (e) {
    add(findings, 'workspace-unavailable', '', `workspace root cannot be resolved: ${e.message}`);
    realRoot = resolve(root);
  }

  const { library, errors: libraryErrors } = loadLibrary(root);
  for (const e of libraryErrors) add(findings, 'library-invalid', e.pointer ?? '', e.message, e.hint);

  const summary = { runsChecked: 0, nodesChecked: 0, childRuns: 0 };
  if (libraryErrors.length === 0) {
    auditRunFile(resolve(runFile), { root, realRoot, library, findings, visited: new Set(), summary, pointer: '' });
  }

  const result = { ok: findings.length === 0, findings, summary };
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result, runFile));
  process.exit(result.ok ? 0 : 1);
}
