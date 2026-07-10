import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'root');
const BIN = join(HERE, '..', 'bin', 'blocks');

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'blocks-audit-'));
  cpSync(ROOT, root, { recursive: true });
  return root;
}

function blocks(args, { root, expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', env: { ...process.env, BLOCKS_ROOT: root, BLOCKS_KEY_HOME: `${root}-keys` }, cwd: root,
    });
    assert.ok(!expectFail, `expected failure but got:\n${stdout}`);
    return { stdout, code: 0 };
  } catch (e) {
    assert.ok(expectFail, `unexpected failure (exit ${e.status}):\n${e.stderr}\n${e.stdout}`);
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status };
  }
}

const state = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const privateKey = (root, id) => join(`${root}-keys`, `${id}.private.json`);
const saveState = (root, file, s) => writeFileSync(join(root, file), JSON.stringify(s, null, 2) + '\n');

function completeFuzzy(root) {
  blocks(['exec', 'workflows/valid.workflow.json', '--out', 'v.run.json'], { root });
  writeFileSync(join(root, 'ans.json'), JSON.stringify({ score: 0.8, verdict: 'pass' }));
  blocks(['record', '--state', 'v.run.json', '--node', 'judge', '--output', 'ans.json'], { root });
  blocks(['exec', 'workflows/valid.workflow.json', '--state', 'v.run.json'], { root });
}

function completeApproval(root) {
  const contractFile = join(root, 'blocks', 'fx-approve', 'contract.json');
  const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
  contract.oracle.capability = 'fixture-judgment-v1';
  writeFileSync(contractFile, JSON.stringify(contract, null, 2));
  blocks(['new', 'key', 'k-test', '--claims', 'fixture-approver'], { root });
  writeFileSync(join(root, 'workflows', 'appr.workflow.json'), JSON.stringify({
    name: 'appr', version: 1,
    grants: { run: ['printf'], read: [], write: [] },
    nodes: [
      { id: 'echo', block: 'echo-text@1', in: { text: 'ship it?' } },
      { id: 'gate', block: 'fx-approve@1', in: { candidate: '{{nodes.echo.output.text}}' } },
    ],
  }));
  blocks(['exec', 'workflows/appr.workflow.json', '--out', 'a.run.json'], { root });
  writeFileSync(join(root, 'ok.json'), JSON.stringify({ approved: true, reason: 'yes' }));
  blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'ok.json', '--sign', privateKey(root, 'k-test'), '--attest', 'fixture-judgment-v1'], { root });
  blocks(['exec', 'workflows/appr.workflow.json', '--state', 'a.run.json'], { root });
}

function assertAuditOk(root, runFile, expected) {
  const text = blocks(['audit', runFile], { root });
  assert.ok(text.stdout.includes('audit ok'), text.stdout);
  const json = JSON.parse(blocks(['audit', runFile, '--json'], { root }).stdout);
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.deepEqual(json.findings, []);
  for (const [key, value] of Object.entries(expected)) assert.equal(json.summary[key], value, key);
}

function assertAuditFinding(root, runFile, code) {
  const text = blocks(['audit', runFile], { root, expectFail: true });
  assert.equal(text.code, 1, text.stdout);
  assert.ok(text.stdout.includes(code), text.stdout);
  const json = JSON.parse(blocks(['audit', runFile, '--json'], { root, expectFail: true }).stdout);
  assert.equal(json.ok, false);
  assert.ok(json.findings.some((f) => f.code === code), JSON.stringify(json.findings));
  return { text, json };
}

test('audit positive: deterministic, fuzzy, signed+attested, and nested current runs pass text and JSON', () => {
  const det = freshRoot();
  blocks(['exec', 'workflows/det-only.workflow.json', '--out', 'd.run.json'], { root: det });
  assertAuditOk(det, 'd.run.json', { runsChecked: 1, nodesChecked: 3, childRuns: 0 });

  const fuzzy = freshRoot();
  completeFuzzy(fuzzy);
  assertAuditOk(fuzzy, 'v.run.json', { runsChecked: 1, nodesChecked: 4, childRuns: 0 });

  const signed = freshRoot();
  completeApproval(signed);
  const watched = [
    join(signed, 'a.run.json'), join(signed, 'workflows/appr.workflow.json'),
    join(signed, 'blocks/fx-approve/contract.json'), join(signed, 'keys/k-test.json'),
    privateKey(signed, 'k-test'),
  ];
  const before = Object.fromEntries(watched.map((file) => [file, readFileSync(file, 'utf8')]));
  assertAuditOk(signed, 'a.run.json', { runsChecked: 1, nodesChecked: 2, childRuns: 0 });
  for (const file of watched) assert.equal(readFileSync(file, 'utf8'), before[file], `audit is read-only for ${file}`);

  const nested = freshRoot();
  blocks(['exec', 'workflows/parent.workflow.json', '--out', 'p.run.json'], { root: nested });
  const childRun = state(nested, 'p.run.json').nodes.sub.childRun;
  const nestedWatched = ['p.run.json', childRun, 'workflows/parent.workflow.json', 'workflows/child.workflow.json', 'blocks/echo-text/contract.json', 'blocks/word-count/contract.json'];
  const nestedBefore = Object.fromEntries(nestedWatched.map((f) => [f, readFileSync(join(nested, f), 'utf8')]));
  assertAuditOk(nested, 'p.run.json', { runsChecked: 2, nodesChecked: 4, childRuns: 1 });
  for (const f of nestedWatched) assert.equal(readFileSync(join(nested, f), 'utf8'), nestedBefore[f], `audit is read-only for nested artifact ${f}`);
});

test('audit negative: workflow drift, block drift, bad node output, and top-level output mismatch are actionable', () => {
  const workflowDrift = freshRoot();
  completeFuzzy(workflowDrift);
  const wfFile = join(workflowDrift, 'workflows', 'valid.workflow.json');
  const wf = JSON.parse(readFileSync(wfFile, 'utf8'));
  wf.notes = 'edited after run';
  writeFileSync(wfFile, JSON.stringify(wf));
  assertAuditFinding(workflowDrift, 'v.run.json', 'workflow-hash-mismatch');

  const blockDrift = freshRoot();
  completeFuzzy(blockDrift);
  const skill = join(blockDrift, 'blocks', 'fx-judge', 'SKILL.md');
  writeFileSync(skill, readFileSync(skill, 'utf8') + '\nchanged contract prose\n');
  assertAuditFinding(blockDrift, 'v.run.json', 'block-hash-mismatch');

  const badOutput = freshRoot();
  blocks(['exec', 'workflows/det-only.workflow.json', '--out', 'd.run.json'], { root: badOutput });
  const d = state(badOutput, 'd.run.json');
  d.inputs.text = 'raw-run-input-marker';
  d.nodes.count.output.count = 'three';
  saveState(badOutput, 'd.run.json', d);
  const badShape = assertAuditFinding(badOutput, 'd.run.json', 'output-contract');
  assert.ok(!badShape.text.stdout.includes('raw-run-input-marker'), 'audit did not print raw run input');
  assert.ok(!badShape.text.stdout.includes('three'), 'audit did not print offending output value');

  const outputMismatch = freshRoot();
  blocks(['exec', 'workflows/parent.workflow.json', '--out', 'p.run.json'], { root: outputMismatch });
  const p = state(outputMismatch, 'p.run.json');
  p.output.summary = 'tampered';
  saveState(outputMismatch, 'p.run.json', p);
  assertAuditFinding(outputMismatch, 'p.run.json', 'workflow-output-mismatch');
});

test('audit negative: paused and completed unsigned fuzzy input tampering fails without leaking markers', () => {
  const pausedRoot = freshRoot();
  blocks(['exec', 'workflows/valid.workflow.json', '--out', 'v.run.json'], { root: pausedRoot });
  const pausedMarker = 'paused-fuzzy-input-marker';
  const pausedRun = state(pausedRoot, 'v.run.json');
  pausedRun.nodes.judge.input.candidate = pausedMarker;
  saveState(pausedRoot, 'v.run.json', pausedRun);
  const pausedFinding = assertAuditFinding(pausedRoot, 'v.run.json', 'fuzzy-input-mismatch');
  assert.ok(!pausedFinding.text.stdout.includes(pausedMarker), 'text audit did not print tampered paused input');
  assert.ok(!JSON.stringify(pausedFinding.json).includes(pausedMarker), 'JSON audit did not print tampered paused input');

  const completedRoot = freshRoot();
  completeFuzzy(completedRoot);
  const completedMarker = 'completed-unsigned-fuzzy-input-marker';
  const completedRun = state(completedRoot, 'v.run.json');
  assert.equal(completedRun.nodes.judge.approval, undefined, 'fixture fuzzy record is unsigned');
  completedRun.nodes.judge.input.candidate = completedMarker;
  saveState(completedRoot, 'v.run.json', completedRun);
  const completedFinding = assertAuditFinding(completedRoot, 'v.run.json', 'fuzzy-input-mismatch');
  assert.ok(!completedFinding.text.stdout.includes(completedMarker), 'text audit did not print tampered completed input');
  assert.ok(!JSON.stringify(completedFinding.json).includes(completedMarker), 'JSON audit did not print tampered completed input');
});

test('audit negative: missing child, child path escape, bad signature, missing claim, and capability mismatch fail without secrets', () => {
  const missingChild = freshRoot();
  blocks(['exec', 'workflows/parent.workflow.json', '--out', 'p.run.json'], { root: missingChild });
  rmSync(join(missingChild, state(missingChild, 'p.run.json').nodes.sub.childRun));
  assertAuditFinding(missingChild, 'p.run.json', 'missing-child-run');

  const pathEscape = freshRoot();
  blocks(['exec', 'workflows/parent.workflow.json', '--out', 'p.run.json'], { root: pathEscape });
  const escaped = state(pathEscape, 'p.run.json');
  escaped.nodes.sub.childRun = '../outside.run.json';
  saveState(pathEscape, 'p.run.json', escaped);
  assertAuditFinding(pathEscape, 'p.run.json', 'path-escape');

  const workflowPathEscape = freshRoot();
  completeFuzzy(workflowPathEscape);
  const wfEscaped = state(workflowPathEscape, 'v.run.json');
  wfEscaped.workflowFile = '../outside.workflow.json';
  saveState(workflowPathEscape, 'v.run.json', wfEscaped);
  assertAuditFinding(workflowPathEscape, 'v.run.json', 'path-escape');

  const badSignature = freshRoot();
  completeApproval(badSignature);
  const sigRun = state(badSignature, 'a.run.json');
  const originalSignature = sigRun.nodes.gate.approval.signature;
  sigRun.nodes.gate.approval.signature = 'not-a-valid-signature';
  saveState(badSignature, 'a.run.json', sigRun);
  const badSig = assertAuditFinding(badSignature, 'a.run.json', 'approval-signature-invalid');
  assert.ok(!badSig.text.stdout.includes(originalSignature), 'audit did not print raw signature');
  assert.ok(!badSig.text.stdout.includes('ship it?'), 'audit did not print fuzzy input');
  assert.ok(!badSig.text.stdout.includes('privateJwk') && !badSig.text.stdout.includes('publicJwk'), 'audit did not print key material');

  const missingClaim = freshRoot();
  completeApproval(missingClaim);
  const key = JSON.parse(readFileSync(join(missingClaim, 'keys', 'k-test.json'), 'utf8'));
  key.claims = ['other-claim'];
  writeFileSync(join(missingClaim, 'keys', 'k-test.json'), JSON.stringify(key, null, 2));
  assertAuditFinding(missingClaim, 'a.run.json', 'approval-claim-missing');

  const badCapability = freshRoot();
  completeApproval(badCapability);
  const capRun = state(badCapability, 'a.run.json');
  capRun.nodes.gate.capability = 'wrong-cap-v1';
  saveState(badCapability, 'a.run.json', capRun);
  assertAuditFinding(badCapability, 'a.run.json', 'capability-mismatch');
});

test('audit negative: malformed and unsupported protocol run documents produce clear findings without crashes', () => {
  const root = freshRoot();
  writeFileSync(join(root, 'bad.run.json'), '{ not json');
  assertAuditFinding(root, 'bad.run.json', 'malformed-run');

  blocks(['exec', 'workflows/det-only.workflow.json', '--out', 'legacy.run.json'], { root });
  const legacy = state(root, 'legacy.run.json');
  legacy.protocol = 2;
  saveState(root, 'legacy.run.json', legacy);
  assertAuditFinding(root, 'legacy.run.json', 'legacy-protocol');

  const future = state(root, 'legacy.run.json');
  future.protocol = 99;
  saveState(root, 'future.run.json', future);
  assertAuditFinding(root, 'future.run.json', 'future-protocol');
});

test('audit negative: copied child output tampering is reported', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/parent.workflow.json', '--out', 'p.run.json'], { root });
  const p = state(root, 'p.run.json');
  assert.ok(existsSync(join(root, p.nodes.sub.childRun)));
  p.nodes.sub.output.echoed = 'tampered child copy';
  saveState(root, 'p.run.json', p);
  assertAuditFinding(root, 'p.run.json', 'child-output-mismatch');
});
