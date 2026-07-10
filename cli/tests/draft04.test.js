import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { canon } from '../src/canon.js';
import { approvalPayload, jsonDigest } from '../src/evidence.js';
import { evalWhen, parseWhen } from '../src/when.js';
import { loadBlock } from '../src/loader.js';
import { hashBlock } from '../src/run.js';
import { deriveRunStatus } from '../src/run-status.js';
import { checkSchemaDef } from '../src/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'root');
const BIN = join(HERE, '..', 'bin', 'blocks');
const REPO = join(HERE, '..', '..');
const VECTORS = join(REPO, 'conformance', 'vectors');

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'blocks-d04-'));
  cpSync(ROOT, root, { recursive: true });
  return root;
}

function blocks(args, root, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd: root,
      env: { ...process.env, BLOCKS_ROOT: root, BLOCKS_KEY_HOME: `${root}-keys` },
      encoding: 'utf8',
    });
    assert.equal(expectFail, false, `expected failure but got ${stdout}`);
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    assert.equal(expectFail, true, `unexpected failure ${error.status}: ${error.stderr}`);
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const state = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const privateKey = (root, id) => join(`${root}-keys`, `${id}.private.json`);

test('Draft 04 canonical JSON reproduces the language-neutral RFC 8785 vectors', () => {
  const suite = JSON.parse(readFileSync(join(VECTORS, 'canon.json'), 'utf8'));
  for (const vector of suite.vectors) {
    assert.equal(canon(JSON.parse(vector.inputJson)), vector.canonical, vector.id);
  }
  for (const vector of suite.invalid) {
    assert.throws(() => canon(JSON.parse(vector.inputJson)), /Unicode|surrogate|canonical/i, vector.id);
  }
  assert.throws(() => canon(Number.NaN), /finite|JSON/i);
  assert.throws(() => canon(Number.POSITIVE_INFINITY), /finite|JSON/i);
});



test('Draft 04 block-hash and gate vector packs reproduce', () => {
  const hashes = JSON.parse(readFileSync(join(VECTORS, 'blockhash.json'), 'utf8'));
  for (const vector of hashes.vectors) {
    const { block, errors } = loadBlock(join(REPO, vector.blockDir));
    assert.deepEqual(errors, [], vector.id);
    assert.equal(hashBlock(block), vector.hash, vector.id);
  }
  const gates = JSON.parse(readFileSync(join(VECTORS, 'gates.json'), 'utf8'));
  const context = { inputs: {}, nodeOutputs: {
    a: { ok: true, labels: ['p1', 'p2'] }, b: { ok: true }, c: { ok: true },
  } };
  for (const vector of gates.vectors) {
    assert.equal(evalWhen(parseWhen(vector.expression, { rejectMixed: true }), context), vector.result, vector.id);
  }
  for (const vector of gates.invalid) {
    assert.throws(() => parseWhen(vector.expression, { rejectMixed: true }), /mix/i, vector.id);
  }
});

test('Draft 04 gate grammar refuses mixed and/or joins without adding precedence', () => {
  assert.throws(
    () => parseWhen("nodes.a.output.ok == true or nodes.b.output.ok == true and nodes.c.output.ok == true", { rejectMixed: true }),
    /mix|and.*or|or.*and/i,
  );
  assert.doesNotThrow(() => parseWhen('nodes.a.output.ok == true and nodes.b.output.ok == true'));
  assert.doesNotThrow(() => parseWhen('nodes.a.output.ok == true or nodes.b.output.ok == true'));
});

test('Draft 04 enumFromInput is output-only schema context', () => {
  const accepted = [];
  checkSchemaDef(
    { type: 'string', enumFromInput: 'labels' },
    '/outputs/label',
    accepted,
    { allowDefault: false, allowSecret: false, allowEnumFromInput: true, inputFields: { labels: { type: 'array', items: { type: 'string' } } } },
  );
  assert.deepEqual(accepted, []);

  const rejected = [];
  checkSchemaDef(
    { type: 'string', enumFromInput: 'labels' },
    '/inputs/label',
    rejected,
    { allowEnumFromInput: false },
  );
  assert.ok(rejected.some((e) => /enumFromInput/.test(e.message)));
});

test('new runs stamp protocol 4 and carry a per-run secretSalt', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/det-only.workflow.json', '--out', 'run.json'], root);
  const state = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8'));
  assert.equal(state.protocol, 4);
  assert.match(state.secretSalt, /^[A-Za-z0-9_-]{22}$/);
});


test('historical Draft 03 approval vector is byte-identical under RFC 8785', () => {
  const vector = JSON.parse(readFileSync(join(VECTORS, 'approval.json'), 'utf8'));
  const run = JSON.parse(readFileSync(join(HERE, '..', '..', vector.sourceRun), 'utf8'));
  const record = run.nodes[vector.nodeId];
  assert.equal(jsonDigest(record.input), vector.inputDigest);
  assert.equal(jsonDigest(record.output), vector.answerDigest);
  const payload = approvalPayload({
    workflowHash: run.workflowHash,
    blockHash: record.blockHash,
    runId: run.runId,
    nodeId: vector.nodeId,
    input: record.input,
    answer: record.output,
  });
  assert.equal(payload, vector.payload);
  assert.ok(verify(null, Buffer.from(payload), createPublicKey({ key: vector.publicJwk, format: 'jwk' }), Buffer.from(vector.signature, 'base64url')));
});

test('detached approval signs the exact candidate payload without runner key access', () => {
  const root = freshRoot();
  blocks(['new', 'key', 'k-detached', '--claims', 'fixture-approver'], root);
  assert.equal(existsSync(join(root, 'keys', 'k-detached.private.json')), false);
  assert.ok(existsSync(privateKey(root, 'k-detached')));
  writeFileSync(join(root, 'workflows', 'detached.workflow.json'), JSON.stringify({
    name: 'detached', version: 1, protocol: 4,
    grants: { run: [], read: [], write: [] },
    nodes: [{ id: 'gate', block: 'fx-approve@1', in: { candidate: 'ship it?' } }],
  }));
  writeFileSync(join(root, 'answer.json'), JSON.stringify({ approved: true, reason: 'signed outside the runner' }));
  blocks(['exec', 'workflows/detached.workflow.json', '--out', 'run.json'], root);
  const payload = blocks(['approval', '--state', 'run.json', '--node', 'gate', '--output', 'answer.json', '--raw'], root).stdout;
  assert.ok(payload.startsWith('blocks-approval-v2\n'));
  const privateDoc = JSON.parse(readFileSync(privateKey(root, 'k-detached'), 'utf8'));
  const signature = sign(null, Buffer.from(payload), createPrivateKey({ key: privateDoc.privateJwk, format: 'jwk' })).toString('base64url');
  writeFileSync(join(root, 'approval.json'), JSON.stringify({ keyId: 'k-detached', signature }));
  const beforeKey = readFileSync(privateKey(root, 'k-detached'), 'utf8');
  const recorded = blocks(['record', '--state', 'run.json', '--node', 'gate', '--output', 'answer.json', '--approval', 'approval.json'], root);
  assert.ok(recorded.stdout.includes('signed by k-detached'));
  assert.equal(readFileSync(privateKey(root, 'k-detached'), 'utf8'), beforeKey);
  assert.equal(state(root, 'run.json').nodes.gate.approval.signature, signature);
  assert.ok(blocks(['audit', 'run.json'], root).stdout.includes('audit ok'));
});

test('forged detached approval and in-workspace --sign are refused without attempt burn', () => {
  const root = freshRoot();
  blocks(['new', 'key', 'k-custody', '--claims', 'fixture-approver'], root);
  writeFileSync(join(root, 'workflows', 'custody.workflow.json'), JSON.stringify({
    name: 'custody', version: 1, protocol: 4,
    grants: { run: [], read: [], write: [] },
    nodes: [{ id: 'gate', block: 'fx-approve@1', in: { candidate: 'ship it?' } }],
  }));
  writeFileSync(join(root, 'answer.json'), JSON.stringify({ approved: true, reason: 'test' }));
  blocks(['exec', 'workflows/custody.workflow.json', '--out', 'run.json'], root);
  const before = readFileSync(join(root, 'run.json'), 'utf8');
  writeFileSync(join(root, 'bad-approval.json'), JSON.stringify({ keyId: 'k-custody', signature: 'forged' }));
  const forged = blocks(['record', '--state', 'run.json', '--node', 'gate', '--output', 'answer.json', '--approval', 'bad-approval.json'], root, { expectFail: true });
  assert.equal(forged.code, 3);
  assert.equal(readFileSync(join(root, 'run.json'), 'utf8'), before);

  const inside = join(root, 'keys', 'inside.private.json');
  writeFileSync(inside, readFileSync(privateKey(root, 'k-custody')));
  const refused = blocks(['record', '--state', 'run.json', '--node', 'gate', '--output', 'answer.json', '--sign', inside], root, { expectFail: true });
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /inside the workspace/);
  assert.equal(readFileSync(join(root, 'run.json'), 'utf8'), before);
});


test('salted secret digests are unlinkable across runs and resume against the stored salt', () => {
  const root = freshRoot();
  writeFileSync(join(root, 'workflows', 'secret.workflow.json'), JSON.stringify({
    name: 'secret', version: 1, protocol: 4,
    inputs: { token: { type: 'string', secret: true } },
    grants: { run: ['printf'], read: [], write: [] },
    nodes: [{ id: 'echo', block: 'echo-text@1', in: { text: 'constant' } }],
  }));
  blocks(['exec', 'workflows/secret.workflow.json', '--out', 'a.run.json', '--input', 'token=same-low-entropy-value'], root);
  blocks(['exec', 'workflows/secret.workflow.json', '--out', 'b.run.json', '--input', 'token=same-low-entropy-value'], root);
  const a = state(root, 'a.run.json');
  const b = state(root, 'b.run.json');
  assert.notEqual(a.secretSalt, b.secretSalt);
  assert.notEqual(a.inputs.token, b.inputs.token);
  assert.match(a.inputs.token, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotThrow(() => blocks(['exec', 'workflows/secret.workflow.json', '--state', 'a.run.json', '--input', 'token=same-low-entropy-value'], root));
  const mismatch = blocks(['exec', 'workflows/secret.workflow.json', '--state', 'a.run.json', '--input', 'token=wrong'], root, { expectFail: true });
  assert.equal(mismatch.code, 2);
});

test('classify enumFromInput is enforced by check-output, record, and audit', () => {
  const root = freshRoot();
  cpSync(join(REPO, 'blocks', 'classify'), join(root, 'blocks', 'classify'), { recursive: true });
  writeFileSync(join(root, 'workflows', 'classify.workflow.json'), JSON.stringify({
    name: 'classify-one', version: 1, protocol: 4,
    grants: { run: [], read: [], write: [] },
    nodes: [{ id: 'kind', block: 'classify@1', in: { text: 'x', labels: ['p1', 'p2'] } }],
  }));
  blocks(['exec', 'workflows/classify.workflow.json', '--out', 'run.json'], root);
  const input = state(root, 'run.json').nodes.kind.input;
  writeFileSync(join(root, 'input.json'), JSON.stringify(input));
  writeFileSync(join(root, 'bad.json'), JSON.stringify({ label: 'outside', confidence: 0.9, reason: 'bad' }));
  writeFileSync(join(root, 'good.json'), JSON.stringify({ label: 'p1', confidence: 0.9, reason: 'good' }));

  const contextFree = blocks(['check-output', 'blocks/classify', 'bad.json'], root, { expectFail: true });
  assert.equal(contextFree.code, 2);
  assert.match(contextFree.stderr, /needs --input/);
  const badCheck = blocks(['check-output', 'blocks/classify', 'bad.json', '--input', 'input.json'], root, { expectFail: true });
  assert.equal(badCheck.code, 1);
  assert.match(badCheck.stderr, /not present in input "labels"/);
  assert.ok(blocks(['check-output', 'blocks/classify', 'good.json', '--input', 'input.json'], root).stdout.includes('valid output'));

  const before = state(root, 'run.json').nodes.kind;
  const badRecord = blocks(['record', '--state', 'run.json', '--node', 'kind', '--output', 'bad.json'], root, { expectFail: true });
  assert.equal(badRecord.code, 1);
  assert.equal(state(root, 'run.json').nodes.kind.attempts, 1);
  assert.equal(before.status, 'pending');
  blocks(['record', '--state', 'run.json', '--node', 'kind', '--output', 'good.json'], root);
  const tampered = state(root, 'run.json');
  tampered.nodes.kind.output.label = 'outside';
  writeFileSync(join(root, 'run.json'), JSON.stringify(tampered, null, 2) + '\n');
  const audit = blocks(['audit', 'run.json'], root, { expectFail: true });
  assert.equal(audit.code, 1);
  assert.match(audit.stdout, /output-contract/);
});

test('protocol-4 workflow validation refuses mixed gate joins with an actionable pointer', () => {
  const root = freshRoot();
  writeFileSync(join(root, 'workflows', 'mixed.workflow.json'), JSON.stringify({
    name: 'mixed', version: 1, protocol: 4,
    grants: { run: ['printf'], read: [], write: [] },
    nodes: [
      { id: 'a', block: 'echo-text@1', in: { text: 'a' } },
      { id: 'b', block: 'echo-text@1', in: { text: 'b' } },
      { id: 'c', block: 'echo-text@1', in: { text: 'c' } },
      { id: 'out', block: 'echo-text@1', when: "nodes.a.output.text == 'a' or nodes.b.output.text == 'b' and nodes.c.output.text == 'c'", in: { text: 'x' } },
    ],
  }));
  const result = blocks(['validate', 'workflows/mixed.workflow.json'], root, { expectFail: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must not mix/);
  assert.match(result.stderr, /\/nodes\/3\/when/);
});

test('run-state replacement leaves no temporary file after each successful save', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/det-only.workflow.json', '--out', 'atomic.run.json'], root);
  assert.ok(existsSync(join(root, 'atomic.run.json')));
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('atomic.run.json.tmp-')), []);
});


test('exec --json distinguishes complete and paused without exposing fuzzy input', () => {
  const completeRoot = freshRoot();
  const complete = JSON.parse(blocks(['exec', 'workflows/det-only.workflow.json', '--json'], completeRoot).stdout);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.workflow, 'fixture-det-only');
  writeFileSync(join(completeRoot, 'workflows', 'det-only.workflow.json'), '{ invalid');
  const missingWorkflowStatus = deriveRunStatus(completeRoot, join(completeRoot, complete.runFile));
  assert.equal(missingWorkflowStatus.status, 'failed');
  assert.match(missingWorkflowStatus.finding, /workflow file/);

  const pausedRoot = freshRoot();
  const pausedText = blocks(['exec', 'workflows/valid.workflow.json', '--json'], pausedRoot).stdout;
  const paused = JSON.parse(pausedText);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pause.nodeId, 'judge');
  assert.match(paused.pause.submissionTarget, /\.run\.json$/);
  assert.equal(pausedText.includes('alpha beta'), false, 'structured status omits resolved fuzzy input');
});

test('blocks runs discovers descendant pauses, is read-only, and reports duplicate run ids', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/parent-f.workflow.json'], root);
  const filesBefore = readdirSync(join(root, 'runs')).sort();
  const result = JSON.parse(blocks(['runs', '--json'], root).stdout);
  assert.equal(result.ok, true);
  const parent = result.runs.find((run) => run.workflow === 'parent-f');
  const child = result.runs.find((run) => run.workflow === 'fchild');
  assert.equal(parent.status, 'paused');
  assert.equal(child.status, 'paused');
  assert.equal(parent.pause.submissionTarget, child.pause.submissionTarget);
  assert.equal(JSON.stringify(result).includes('alpha beta'), false, 'inventory does not expose fuzzy input');
  assert.deepEqual(readdirSync(join(root, 'runs')).sort(), filesBefore, 'inventory is read-only');

  const source = join(root, child.runFile);
  cpSync(source, join(root, 'runs', 'duplicate.run.json'));
  const duplicate = blocks(['runs', '--json'], root, { expectFail: true });
  assert.equal(duplicate.code, 1);
  const duplicateJson = JSON.parse(duplicate.stdout);
  assert.ok(duplicateJson.findings.some((finding) => finding.code === 'duplicate-run-id'));
});


test('fuzzy block scaffolding emits a closed oracle stanza when requested', () => {
  const root = freshRoot();
  blocks(['new', 'block', 'review-item', '--kind', 'fuzzy', '--claims', 'reviewer,release-approver', '--capability', 'reasoning-v1'], root);
  const contract = JSON.parse(readFileSync(join(root, 'blocks', 'review-item', 'contract.json'), 'utf8'));
  assert.deepEqual(contract.oracle, { claims: ['reviewer', 'release-approver'], capability: 'reasoning-v1' });
});


test('derived status is not complete when declared workflow outputs are unresolved', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/parent.workflow.json', '--out', 'parent.run.json'], root);
  const run = state(root, 'parent.run.json');
  delete run.output;
  writeFileSync(join(root, 'parent.run.json'), JSON.stringify(run, null, 2) + '\n');
  assert.equal(deriveRunStatus(root, join(root, 'parent.run.json')).status, 'pending');
});
