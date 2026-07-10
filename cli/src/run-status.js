// Derived run-level status for machine output and oracle discovery.
// This reads ledger state only; it never executes blocks or exposes fuzzy input.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

function inside(root, path) {
  const rel = relative(root, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function workflowDocument(root, run) {
  const file = resolve(root, run.workflowFile ?? `workflows/${run.workflow}.workflow.json`);
  if (!existsSync(file)) return null;
  const realRoot = realpathSync(root);
  const realFile = realpathSync(file);
  if (!inside(realRoot, realFile)) return null;
  try {
    const workflow = readJson(realFile);
    return workflow && typeof workflow === 'object' && !Array.isArray(workflow) ? workflow : null;
  } catch { return null; }
}

function pauseRequirement(root, node) {
  if (!node?.block) return {};
  const name = node.block.split('@')[0];
  const file = resolve(root, 'blocks', name, 'contract.json');
  if (!inside(root, file) || !existsSync(file)) return {};
  const contract = readJson(file);
  return {
    ...(Array.isArray(contract.oracle?.claims) ? { claims: contract.oracle.claims } : {}),
    ...(typeof contract.oracle?.capability === 'string' ? { capability: contract.oracle.capability } : {}),
  };
}

export function deriveRunStatus(root, runFile, visited = new Set()) {
  const absolute = resolve(runFile);
  const runRef = inside(root, absolute) ? relative(root, absolute) : absolute;
  if (visited.has(absolute)) return { status: 'failed', runFile: runRef, finding: 'child run cycle' };
  visited.add(absolute);
  let run;
  try { run = readJson(absolute); }
  catch (error) { return { status: 'failed', runFile: runRef, finding: `unreadable run: ${error.message}` }; }
  if (!run || typeof run !== 'object' || Array.isArray(run) || !run.nodes || typeof run.nodes !== 'object') {
    return { status: 'failed', runFile: runRef, finding: 'malformed run document' };
  }
  const base = { runId: run.runId, workflow: run.workflow, protocol: run.protocol ?? 1, runFile: runRef };
  const workflow = workflowDocument(root, run);
  if (!workflow) return { ...base, status: 'failed', finding: 'workflow file is missing, invalid, or resolves outside the workspace' };
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const [nodeId, record] of Object.entries(run.nodes)) {
    if (record?.status === 'failed') return { ...base, status: 'failed', nodeId, reason: record.reason ?? 'node failed' };
    if (record?.childRun) {
      const childFile = resolve(root, record.childRun);
      if (!inside(root, childFile)) return { ...base, status: 'failed', nodeId, finding: 'child run path escapes workspace' };
      const child = deriveRunStatus(root, childFile, visited);
      if (child.status === 'failed') return { ...base, status: 'failed', nodeId, child };
      if (child.status === 'paused') return { ...base, status: 'paused', nodeId, child, pause: child.pause };
    }
  }

  for (const [nodeId, record] of Object.entries(run.nodes)) {
    if (record?.status === 'pending' && record.input !== undefined && record.blockHash !== undefined) {
      const node = nodeById.get(nodeId);
      return {
        ...base,
        status: 'paused',
        nodeId,
        pause: {
          submissionTarget: runRef,
          nodeId,
          block: node?.block,
          contract: node?.block ? `blocks/${node.block.split('@')[0]}/SKILL.md` : undefined,
          requires: pauseRequirement(root, node),
        },
      };
    }
  }

  const records = Object.values(run.nodes);
  if (records.length > 0 && records.every((record) => record?.status === 'done' || record?.status === 'skipped')) {
    const outputsResolved = workflow?.outputs === undefined || (run.output !== null && typeof run.output === 'object' && !Array.isArray(run.output));
    if (outputsResolved) return { ...base, status: 'complete' };
  }
  return { ...base, status: 'pending' };
}
