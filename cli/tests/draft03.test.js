import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseWhen, evalWhen } from '../src/when.js';
import { hashBlock } from '../src/run.js';
import { loadBlock } from '../src/loader.js';
import { loadLibrary } from '../src/loader.js';
import { parseWorkflowFile, validateWorkflow } from '../src/validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'root');
const BIN = join(HERE, '..', 'bin', 'blocks');
const { library } = loadLibrary(ROOT);

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
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'blocks-d03-'));
  cpSync(ROOT, root, { recursive: true });
  return root;
}
const state = (root, f) => JSON.parse(readFileSync(join(root, f), 'utf8'));

// ---------- gates: contains + #ref ----------

test('gate grammar: contains and #ref parse; bans still hold; no ref collision', () => {
  assert.doesNotThrow(() => parseWhen("nodes.x.output.labels contains 'p1'"));
  assert.doesNotThrow(() => parseWhen('#nodes.x.output.text > 40'));
  assert.doesNotThrow(() => parseWhen('#inputs.tags >= 1'));
  // `inputs.contains` is a ref, not the operator
  assert.doesNotThrow(() => parseWhen("inputs.contains == 'x'"));
  // bans unchanged
  assert.throws(() => parseWhen('(nodes.a.output.x == 1)'));
  assert.throws(() => parseWhen('nodes.a.output.x + 1 == 2'));
  assert.throws(() => parseWhen('nodes.a.output.x == nodes.b.output.y'));
  // '#' must hug the ref
  assert.throws(() => parseWhen('# nodes.a.output.x > 1'));
});

test('contains eval: substring, array membership, wrong types false, missing false', () => {
  const ctx = (out) => ({ inputs: {}, nodeOutputs: { a: out } });
  const g = (expr, out) => evalWhen(parseWhen(expr), ctx(out));
  assert.equal(g("nodes.a.output.t contains 'ell'", { t: 'hello' }), true);
  assert.equal(g("nodes.a.output.t contains ''", { t: 'hello' }), true, 'empty substring is true');
  assert.equal(g("nodes.a.output.t contains 'zz'", { t: 'hello' }), false);
  assert.equal(g("nodes.a.output.l contains 'p1'", { l: ['p1', 'p2'] }), true);
  assert.equal(g('nodes.a.output.l contains 2', { l: [1, 2, 3] }), true);
  assert.equal(g('nodes.a.output.l contains true', { l: [true] }), true);
  assert.equal(g("nodes.a.output.l contains 'p9'", { l: ['p1'] }), false);
  assert.equal(g('nodes.a.output.t contains 5', { t: 'x5y' }), false, 'string left + non-string literal false');
  assert.equal(g("nodes.a.output.n contains 'x'", { n: 42 }), false, 'number left false');
  assert.equal(g("nodes.b.output.t contains 'x'", { t: 'x' }), false, 'missing node false');
});

test('#ref eval: code points, array count, wrong types false, missing false', () => {
  const ctx = (out, inputs = {}) => ({ inputs, nodeOutputs: { a: out } });
  const g = (expr, out, inputs) => evalWhen(parseWhen(expr), ctx(out, inputs));
  assert.equal(g('#nodes.a.output.t > 4', { t: 'hello' }), true);
  assert.equal(g('#nodes.a.output.t == 2', { t: '🚀🚀' }), true, 'astral: code points, not UTF-16 units');
  assert.equal(g('#nodes.a.output.l == 3', { l: [1, 2, 3] }), true);
  assert.equal(g('#nodes.a.output.t > 0', { t: '' }), false);
  assert.equal(g('#nodes.a.output.n > 0', { n: 42 }), false, 'length of number false');
  assert.equal(g('#nodes.b.output.t > 0', { t: 'x' }), false, 'missing node false');
  assert.equal(g('#inputs.tags >= 2', {}, { tags: ['a', 'b'] }), true, 'length over inputs refs');
});

test('gate statics: contains needs string/array left; # needs string/array ref; # is number-typed', () => {
  const file = join(ROOT, 'workflows', 'valid.workflow.json');
  const { workflow } = parseWorkflowFile(file);
  const wf = structuredClone(workflow);
  wf.protocol = 3;
  // count.output.count is number: contains and # are static errors
  wf.nodes.push({ id: 'g1', block: 'echo-text@1', when: "nodes.count.output.count contains '1'", in: { text: 'x' } });
  wf.nodes.push({ id: 'g2', block: 'echo-text@1', when: '#nodes.count.output.count > 0', in: { text: 'x' } });
  // string-left contains with non-string literal is a static error
  wf.nodes.push({ id: 'g3', block: 'echo-text@1', when: 'nodes.echo.output.text contains 5', in: { text: 'x' } });
  // #ref composes with ordering (valid), and #ref contains is a static error
  wf.nodes.push({ id: 'g4', block: 'echo-text@1', when: "#nodes.echo.output.text contains 'x'", in: { text: 'x' } });
  const { errors } = validateWorkflow(wf, library, file);
  assert.ok(errors.some((e) => e.pointer.includes('g1') || e.message.includes('contains')), 'number-left contains rejected');
  assert.ok(errors.filter((e) => e.pointer.endsWith('/when')).length >= 4, JSON.stringify(errors.filter(e=>e.pointer.endsWith('/when')).map(e=>e.message)));
});

test('[VER-5]: a protocol-2 workflow using # or contains fails validation with a hint', () => {
  const file = join(ROOT, 'workflows', 'valid.workflow.json');
  const { workflow } = parseWorkflowFile(file);
  const wf = structuredClone(workflow);
  wf.protocol = 2;
  wf.nodes.push({ id: 'g', block: 'echo-text@1', when: '#nodes.echo.output.text > 0', in: { text: 'x' } });
  const { errors } = validateWorkflow(wf, library, file);
  assert.ok(errors.some((e) => e.pointer === '/protocol' && e.message.includes('Draft 3')), JSON.stringify(errors.slice(0, 3)));
});

// ---------- blockHash preimage split ----------

test('hashBlock: det argv = contract only; det entry = contract+entry; fuzzy = skill+contract', async () => {
  const { createHash } = await import('node:crypto');
  const sha = (...b) => `sha256:${b.reduce((h, x) => (h.update(x), h), createHash('sha256')).digest('hex')}`;
  const b = (name) => loadBlock(join(ROOT, 'blocks', name)).block;
  const at = (name, f) => readFileSync(join(ROOT, 'blocks', name, f));
  assert.equal(hashBlock(b('echo-text')), sha(at('echo-text', 'contract.json')), 'argv: contract.json only');
  assert.equal(hashBlock(b('word-count')), sha(at('word-count', 'contract.json'), at('word-count', 'run.mjs')), 'entry: contract ‖ entry');
  assert.equal(hashBlock(b('fx-judge')), sha(at('fx-judge', 'SKILL.md'), at('fx-judge', 'contract.json')), 'fuzzy: skill ‖ contract');
});

test('det prose edits no longer register as drift; fuzzy prose edits still do', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/valid.workflow.json', '--out', 'r.run.json'], { root });
  const before = state(root, 'r.run.json').nodes.echo.blockHash;
  const skill = join(root, 'blocks', 'echo-text', 'SKILL.md');
  writeFileSync(skill, readFileSync(skill, 'utf8') + '\ndoc-only edit\n');
  blocks(['exec', 'workflows/valid.workflow.json', '--out', 'r2.run.json'], { root });
  assert.equal(state(root, 'r2.run.json').nodes.echo.blockHash, before, 'det hash unchanged by prose');
  // fuzzy: prose edit between pause and record is still refused
  const fskill = join(root, 'blocks', 'fx-judge', 'SKILL.md');
  writeFileSync(fskill, readFileSync(fskill, 'utf8') + '\nprose change\n');
  writeFileSync(join(root, 'a.json'), JSON.stringify({ score: 0.5, verdict: 'pass' }));
  const r = blocks(['record', '--state', 'r2.run.json', '--node', 'judge', '--output', 'a.json'], { root, expectFail: true });
  assert.ok(r.stderr.includes('blockHash mismatch'), r.stderr);
});

// ---------- protocol stamping + cross-draft refusal ----------

test('new runs stamp protocol 3, even for protocol-2/unversioned workflows', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/valid.workflow.json', '--out', 'v.run.json'], { root });
  assert.equal(state(root, 'v.run.json').protocol, 3, 'unversioned workflow run stamped 3');
  blocks(['exec', 'workflows/parent.workflow.json', '--out', 'p.run.json'], { root });
  assert.equal(state(root, 'p.run.json').protocol, 3, 'protocol-2 workflow run stamped 3');
});

test('resume/record into a run declaring protocol < 3 is refused', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/valid.workflow.json', '--out', 'v.run.json'], { root });
  const s = state(root, 'v.run.json');
  s.protocol = 2;
  writeFileSync(join(root, 'v.run.json'), JSON.stringify(s, null, 2));
  const r1 = blocks(['exec', 'workflows/valid.workflow.json', '--state', 'v.run.json'], { root, expectFail: true });
  assert.ok(r1.stderr.includes('protocol 2'), r1.stderr);
  writeFileSync(join(root, 'a.json'), JSON.stringify({ score: 0.5, verdict: 'pass' }));
  const r2 = blocks(['record', '--state', 'v.run.json', '--node', 'judge', '--output', 'a.json'], { root, expectFail: true });
  assert.ok(r2.stderr.includes('protocol 2'), r2.stderr);
});

// ---------- capability attestation ----------

function capRoot() {
  const root = freshRoot();
  const cfile = join(root, 'blocks', 'fx-approve', 'contract.json');
  const c = JSON.parse(readFileSync(cfile, 'utf8'));
  c.oracle.capability = 'fixture-judgment-v1';
  writeFileSync(cfile, JSON.stringify(c, null, 2));
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
  return root;
}

test('oracle.capability: loader accepts alongside claims; capability-only oracle legal; empty oracle invalid', async () => {
  const root = capRoot();
  const ok = loadBlock(join(root, 'blocks', 'fx-approve'));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.block.oracle.capability, 'fixture-judgment-v1');

  const cfile = join(root, 'blocks', 'fx-approve', 'contract.json');
  const c = JSON.parse(readFileSync(cfile, 'utf8'));
  c.oracle = { capability: 'solo-cap-v1' };
  writeFileSync(cfile, JSON.stringify(c));
  assert.deepEqual(loadBlock(join(root, 'blocks', 'fx-approve')).errors, [], 'capability-only oracle legal');
  c.oracle = {};
  writeFileSync(cfile, JSON.stringify(c));
  assert.ok(loadBlock(join(root, 'blocks', 'fx-approve')).errors.length > 0, 'empty oracle invalid');
});

test('attestation matrix: missing→2 no burn; mismatch→2 no burn; ok+bad-sig→3 no burn; full-ok+bad-schema→1 burn', () => {
  const root = capRoot();
  const before = state(root, 'a.run.json').nodes.gate;

  const miss = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'ok.json', '--sign', 'keys/k-test.private.json'], { root, expectFail: true });
  assert.equal(miss.code, 2, `missing attest: ${miss.stderr}`);
  assert.ok(miss.stderr.includes('--attest'), miss.stderr);

  const mis = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'ok.json', '--sign', 'keys/k-test.private.json', '--attest', 'wrong-cap-v9'], { root, expectFail: true });
  assert.equal(mis.code, 2, mis.stderr);

  blocks(['new', 'key', 'k-nope', '--claims', 'other-claim'], { root });
  const badsig = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'ok.json', '--sign', 'keys/k-nope.private.json', '--attest', 'fixture-judgment-v1'], { root, expectFail: true });
  assert.equal(badsig.code, 3, 'attest ok, wrong claims → permission class');

  assert.deepEqual(state(root, 'a.run.json').nodes.gate, before, 'no state change, no burn across all refusals');

  writeFileSync(join(root, 'bad.json'), JSON.stringify({ approved: 'yes-ish' }));
  const burn = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'bad.json', '--sign', 'keys/k-test.private.json', '--attest', 'fixture-judgment-v1'], { root, expectFail: true });
  assert.equal(burn.code, 1);
  assert.equal(state(root, 'a.run.json').nodes.gate.attempts, 1, 'valid ceremony + bad schema burns');
});

test('attested happy path: capability recorded beside approval; voluntary attestation recorded', () => {
  const root = capRoot();
  const r = blocks(['record', '--state', 'a.run.json', '--node', 'gate', '--output', 'ok.json', '--sign', 'keys/k-test.private.json', '--attest', 'fixture-judgment-v1'], { root });
  assert.ok(r.stdout.includes('signed by k-test'), r.stdout);
  const rec = state(root, 'a.run.json').nodes.gate;
  assert.equal(rec.capability, 'fixture-judgment-v1');
  assert.equal(rec.approval.keyId, 'k-test');

  // voluntary on a claims/capability-free fuzzy node
  blocks(['exec', 'workflows/valid.workflow.json', '--out', 'v.run.json'], { root });
  writeFileSync(join(root, 'j.json'), JSON.stringify({ score: 0.9, verdict: 'pass' }));
  blocks(['record', '--state', 'v.run.json', '--node', 'judge', '--output', 'j.json', '--attest', 'volunteer-v1'], { root });
  assert.equal(state(root, 'v.run.json').nodes.judge.capability, 'volunteer-v1');
});

test('pause conveys the required capability', () => {
  const root = capRoot();
  const { stdout } = blocks(['exec', 'workflows/appr.workflow.json', '--out', 'b.run.json'], { root });
  assert.ok(stdout.includes('fixture-judgment-v1'), stdout);
  assert.ok(stdout.includes('--attest'), stdout);
});

test('a hand-downgraded CHILD run is refused on parent resume (cross-draft, nested)', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/parent-f.workflow.json', '--out', 'pf.run.json'], { root });
  const childPath = state(root, 'pf.run.json').nodes.sub.childRun;
  const cs = state(root, childPath);
  cs.protocol = 2;
  writeFileSync(join(root, childPath), JSON.stringify(cs, null, 2));
  const r = blocks(['exec', 'workflows/parent-f.workflow.json', '--state', 'pf.run.json'], { root, expectFail: true });
  assert.ok(r.stderr.includes('protocol 2'), r.stderr);
});

test('bare flags (--attest/--sign with no value) are usage errors, not silent drops', () => {
  const root = freshRoot();
  blocks(['exec', 'workflows/valid.workflow.json', '--out', 'v.run.json'], { root });
  writeFileSync(join(root, 'j.json'), JSON.stringify({ score: 0.9, verdict: 'pass' }));
  const r = blocks(['record', '--state', 'v.run.json', '--node', 'judge', '--attest', '--output', 'j.json'], { root, expectFail: true });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('--attest needs a value'), r.stderr);
});
