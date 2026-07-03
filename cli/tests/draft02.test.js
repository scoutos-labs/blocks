import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'root');
const BIN = join(HERE, '..', 'bin', 'blocks');

function blocks(args, { root, expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', env: { ...process.env, BLOCKS_ROOT: root }, cwd: root,
    });
    assert.ok(!expectFail, `expected failure but got:\n${stdout}`);
    return { stdout, code: 0 };
  } catch (e) {
    assert.ok(expectFail, `unexpected failure (exit ${e.status}):\n${e.stderr}\n${e.stdout}`);
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status };
  }
}

// each test gets a private copy of the fixture root (runs/ writes, key files)
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'blocks-d02-'));
  cpSync(ROOT, root, { recursive: true });
  return root;
}
const state = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

test('nested det-only workflow runs to completion; child outputs feed parent wires and outputs', () => {
  const root = freshRoot();
  const { stdout } = blocks(['exec', 'workflows/parent.workflow.json', '--out', 'p.run.json'], { root });
  assert.ok(stdout.includes('run complete'), stdout);
  const parent = state(root, 'p.run.json');
  assert.equal(parent.protocol, 2, 'run stamped with protocol 2');
  const sub = parent.nodes.sub;
  assert.equal(sub.status, 'done');
  assert.ok(sub.childRun.startsWith('runs/child-'), sub.childRun);
  assert.ok(sub.workflowHash.startsWith('sha256:'));
  assert.deepEqual(sub.output, { echoed: 'alpha beta', words: 2 });
  assert.equal(parent.nodes.use.output.text, 'alpha beta = 2 words');
  assert.deepEqual(parent.output, { summary: 'alpha beta = 2 words' });
  const child = state(root, sub.childRun);
  assert.equal(child.workflow, 'child');
  assert.deepEqual(child.output, { echoed: 'alpha beta', words: 2 });
});

test('nested determinism: double run identical modulo childRun/runId/startedAt', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/parent.workflow.json', '--out', 'a.run.json'], { root });
  blocks(['exec', 'workflows/parent.workflow.json', '--out', 'b.run.json'], { root });
  const scrub = (s) => JSON.parse(JSON.stringify(s.nodes, (k, v) => (k === 'childRun' ? undefined : v)));
  const a = state(root, 'a.run.json');
  const b = state(root, 'b.run.json');
  assert.deepEqual(scrub(a), scrub(b), 'parent .nodes structurally equal modulo childRun');
  assert.deepEqual(a.output, b.output);
  // the two child runs are themselves structurally equal in .nodes
  const ca = state(root, a.nodes.sub.childRun);
  const cb = state(root, b.nodes.sub.childRun);
  assert.deepEqual(ca.nodes, cb.nodes);
});

test('pause bubbles out of a child run; record targets the child; resume flows through the parent', () => {
  const root = freshRoot();
  const first = blocks(['exec', 'workflows/parent-f.workflow.json', '--out', 'pf.run.json'], { root });
  assert.ok(first.stdout.includes('paused at fuzzy node "judge"'), first.stdout);
  assert.ok(first.stdout.includes('paused inside child run of node "sub"'), first.stdout);
  const childPath = state(root, 'pf.run.json').nodes.sub.childRun;
  assert.ok(first.stdout.includes(childPath), 'record command targets the child run');

  writeFileSync(join(root, 'ans.json'), JSON.stringify({ score: 0.8, verdict: 'pass' }));
  blocks(['record', '--state', childPath, '--node', 'judge', '--output', 'ans.json'], { root });
  const resumed = blocks(['exec', 'workflows/parent-f.workflow.json', '--state', 'pf.run.json'], { root });
  assert.ok(resumed.stdout.includes('run complete'), resumed.stdout);
  const parent = state(root, 'pf.run.json');
  assert.equal(parent.nodes.sub.status, 'done');
  assert.equal(parent.nodes.sub.output.verdict, 'pass');
  assert.equal(parent.nodes.after.status, 'done');
});

test('child fuzzy failure is terminal at the parent', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/parent-f.workflow.json', '--out', 'pf.run.json'], { root });
  const childPath = state(root, 'pf.run.json').nodes.sub.childRun;
  writeFileSync(join(root, 'bad.json'), JSON.stringify({ score: 9, verdict: 'nope' }));
  for (let i = 0; i < 3; i++) {
    blocks(['record', '--state', childPath, '--node', 'judge', '--output', 'bad.json'], { root, expectFail: true });
  }
  const r = blocks(['exec', 'workflows/parent-f.workflow.json', '--state', 'pf.run.json'], { root, expectFail: true });
  assert.equal(r.code, 1);
  const parent = state(root, 'pf.run.json');
  assert.equal(parent.nodes.sub.status, 'failed');
  assert.ok(parent.nodes.sub.reason.includes(childPath));
  // and the failed parent is itself terminal
  const again = blocks(['exec', 'workflows/parent-f.workflow.json', '--state', 'pf.run.json'], { root, expectFail: true });
  assert.ok(again.stderr.includes('terminal'), again.stderr);
});

test('optional output omitted when its source is gate-skipped; gate-on-output pattern works', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/parent-f.workflow.json', '--out', 'pf.run.json'], { root });
  const childPath = state(root, 'pf.run.json').nodes.sub.childRun;
  // low score: child's `final` is gate-skipped, so optional output `message` is omitted
  writeFileSync(join(root, 'low.json'), JSON.stringify({ score: 0.2, verdict: 'revise' }));
  blocks(['record', '--state', childPath, '--node', 'judge', '--output', 'low.json'], { root });
  const resumed = blocks(['exec', 'workflows/parent-f.workflow.json', '--state', 'pf.run.json'], { root });
  const child = state(root, childPath);
  assert.equal(child.nodes.final.status, 'skipped');
  assert.deepEqual(Object.keys(child.output), ['verdict'], 'optional message omitted, never null');
  const parent = state(root, 'pf.run.json');
  assert.equal(parent.nodes.after.status, 'skipped', 'parent gate on missing output is false → skipped');
  assert.ok(parent.nodes.after.reason.includes('gate false'));
});

test('a required output whose source was cut fails the run with a named error', () => {
  const root = freshRoot();
  const wf = JSON.parse(readFileSync(join(root, 'workflows', 'fchild.workflow.json'), 'utf8'));
  wf.outputs.message.required = true;
  writeFileSync(join(root, 'workflows', 'fchild.workflow.json'), JSON.stringify(wf));
  blocks(['exec', 'workflows/fchild.workflow.json', '--out', 'c.run.json'], { root });
  writeFileSync(join(root, 'low.json'), JSON.stringify({ score: 0.2, verdict: 'revise' }));
  blocks(['record', '--state', 'c.run.json', '--node', 'judge', '--output', 'low.json'], { root });
  const r = blocks(['exec', 'workflows/fchild.workflow.json', '--state', 'c.run.json'], { root, expectFail: true });
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('required workflow output "message"'), r.stderr);
  assert.equal(state(root, 'c.run.json').output, undefined, 'no output object written');
});

test('resume with a deleted child run file is a clean error', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/parent-f.workflow.json', '--out', 'pf.run.json'], { root });
  const childPath = state(root, 'pf.run.json').nodes.sub.childRun;
  rmSync(join(root, childPath));
  const r = blocks(['exec', 'workflows/parent-f.workflow.json', '--state', 'pf.run.json'], { root, expectFail: true });
  assert.ok(r.stderr.includes('is missing'), r.stderr);
});

// ---------- signed approvals ----------

function approvalRoot() {
  const root = freshRoot();
  blocks(['new', 'key', 'k-test', '--claims', 'fixture-approver'], { root });
  writeFileSync(join(root, 'workflows', 'appr.workflow.json'), JSON.stringify({
    name: 'appr', version: 1,
    grants: { run: ['printf'], read: [], write: [] },
    nodes: [
      { id: 'echo', block: 'echo-text@1', in: { text: 'ship it?' } },
      { id: 'gate', block: 'fx-approve@1', in: { candidate: '{{nodes.echo.output.text}}' } },
      { id: 'yes', block: 'echo-text@1', when: "nodes.gate.output.approved == true", in: { text: 'shipped' } },
    ],
  }));
  blocks(['exec', 'workflows/appr.workflow.json', '--out', 'a.run.json'], { root });
  writeFileSync(join(root, 'ok.json'), JSON.stringify({ approved: true, reason: 'fixture says yes' }));
  return root;
}

test('new key: public registered with claims, private gitignored and never in registry', () => {
  const root = approvalRoot();
  const pub = JSON.parse(readFileSync(join(root, 'keys', 'k-test.json'), 'utf8'));
  assert.deepEqual(pub.claims, ['fixture-approver']);
  assert.equal(pub.publicJwk.d, undefined);
  assert.ok(existsSync(join(root, 'keys', 'k-test.private.json')));
  assert.ok(readFileSync(join(root, '.gitignore'), 'utf8').includes('keys/*.private.json'));
});

test('unsigned submission to a claims node: exit 3, no state change, no attempt burned', () => {
  const root = approvalRoot();
  const before = state(root, 'a.run.json').nodes.gate;
  const r = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'ok.json'], { root, expectFail: true });
  assert.equal(r.code, 3, r.stderr);
  assert.ok(r.stderr.includes('requires an approval'), r.stderr);
  const after = state(root, 'a.run.json').nodes.gate;
  assert.deepEqual(after, before, 'run document untouched');
  assert.equal(after.attempts, undefined, 'attempt budget not burned');
});

test('a key lacking the required claim is refused with exit 3', () => {
  const root = approvalRoot();
  blocks(['new', 'key', 'k-wrong', '--claims', 'other-claim'], { root });
  const r = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'ok.json', '--sign', 'keys/k-wrong.private.json'], { root, expectFail: true });
  assert.equal(r.code, 3);
  assert.ok(r.stderr.includes('requires [fixture-approver]'), r.stderr);
});

test('a signature not matching the registered public key is refused', () => {
  const root = approvalRoot();
  blocks(['new', 'key', 'k-imposter', '--claims', 'fixture-approver'], { root });
  // graft k-test's registry entry onto k-imposter's private key: sign as k-test without its key
  const imposterPriv = JSON.parse(readFileSync(join(root, 'keys', 'k-imposter.private.json'), 'utf8'));
  writeFileSync(join(root, 'keys', 'k-test.private.json'),
    JSON.stringify({ keyId: 'k-test', privateJwk: imposterPriv.privateJwk }));
  const r = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'ok.json', '--sign', 'keys/k-test.private.json'], { root, expectFail: true });
  assert.equal(r.code, 3);
  assert.ok(r.stderr.includes('does not verify'), r.stderr);
});

test('signed happy path: approval recorded, gate passes, signature is re-verifiable and deterministic', async () => {
  const root = approvalRoot();
  const r1 = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'ok.json', '--sign', 'keys/k-test.private.json'], { root });
  assert.ok(r1.stdout.includes('signed by k-test'), r1.stdout);
  const run = state(root, 'a.run.json');
  const rec = run.nodes.gate;
  assert.equal(rec.status, 'done');
  assert.equal(rec.approval.keyId, 'k-test');

  // re-verify from the run document + registry alone (the audit-trail property)
  const { canon } = await import('../src/canon.js');
  const { createHash, createPublicKey, verify } = await import('node:crypto');
  const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
  const blockDir = join(root, 'blocks', 'fx-approve');
  const blockHash = sha(Buffer.concat([readFileSync(join(blockDir, 'SKILL.md')), readFileSync(join(blockDir, 'contract.json'))]));
  const canonical = ['blocks-approval-v2', run.workflowHash, blockHash, run.runId, 'gate',
    sha(Buffer.from(canon(rec.input), 'utf8')), sha(Buffer.from(canon(rec.output), 'utf8'))].join('\n');
  const pub = JSON.parse(readFileSync(join(root, 'keys', 'k-test.json'), 'utf8')).publicJwk;
  assert.ok(verify(null, Buffer.from(canonical, 'utf8'), createPublicKey({ key: pub, format: 'jwk' }),
    Buffer.from(rec.approval.signature, 'base64url')), 'signature re-verifies from artifacts alone');

  const done = blocks(['exec', 'workflows/appr.workflow.json', '--state', 'a.run.json'], { root });
  assert.ok(done.stdout.includes('run complete'));
  assert.equal(state(root, 'a.run.json').nodes.yes.status, 'done');
});

test('a signed but schema-invalid answer burns an attempt (auth precedes contract, not replaces it)', () => {
  const root = approvalRoot();
  writeFileSync(join(root, 'bad.json'), JSON.stringify({ approved: 'yes-ish' }));
  const r = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'bad.json', '--sign', 'keys/k-test.private.json'], { root, expectFail: true });
  assert.equal(r.code, 1, 'contract failure, not permission refusal');
  assert.ok(r.stderr.includes('attempt 1/3'), r.stderr);
  assert.ok(r.stderr.includes('re-sign'), 'repair guidance mentions re-signing');
  assert.equal(state(root, 'a.run.json').nodes.gate.attempts, 1);
});

test('voluntary signature on a claims-free fuzzy node is verified and recorded', () => {
  const root = freshRoot();
  blocks(['new', 'key', 'k-vol', '--claims', 'anything'], { root });
  blocks(['exec', 'workflows/valid.workflow.json', '--out', 'v.run.json'], { root });
  writeFileSync(join(root, 'j.json'), JSON.stringify({ score: 0.9, verdict: 'pass' }));
  blocks(['record', '--state', 'v.run.json', '--node', 'judge', '--output', 'j.json', '--sign', 'keys/k-vol.private.json'], { root });
  assert.equal(state(root, 'v.run.json').nodes.judge.approval.keyId, 'k-vol');
});
