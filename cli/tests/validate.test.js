import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLibrary } from '../src/loader.js';
import { parseWorkflowFile, validateWorkflow } from '../src/validate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'root');
const { library, errors: libErrors } = loadLibrary(ROOT);

function check(name) {
  const file = join(ROOT, 'workflows', `${name}.workflow.json`);
  const { workflow, errors: parseErr } = parseWorkflowFile(file);
  if (parseErr.length) return { errors: parseErr, order: [] };
  return validateWorkflow(workflow, library, file);
}

test('fixture library loads cleanly', () => {
  assert.deepEqual(libErrors, []);
  assert.deepEqual([...library.keys()].sort(), ['echo-text@1', 'fx-approve@1', 'fx-judge@1', 'word-count@1']);
});

test('valid workflow passes and yields a topological order', () => {
  const { errors, order } = check('valid');
  assert.deepEqual(errors, []);
  assert.equal(order.length, 4);
  assert.ok(order.indexOf('echo') < order.indexOf('count'), 'deps come before dependents');
  assert.ok(order.indexOf('judge') < order.indexOf('final'));
});

test('cycle is detected and named', () => {
  const { errors } = check('cyclic');
  assert.ok(errors.some((e) => e.message.includes('cycle detected') && e.message.includes('->')));
});

test('bad version pin is rejected with the available versions hinted', () => {
  const { errors } = check('bad-pin');
  const e = errors.find((x) => x.message.includes('echo-text@9'));
  assert.ok(e, 'reports the missing pin');
  assert.ok(e.hint.includes('echo-text@1'), 'hints the library version');
});

test('unresolved wires name both the undeclared input and the unknown output', () => {
  const { errors } = check('unresolved-wire');
  assert.ok(errors.some((e) => e.message.includes('undeclared workflow input "missing"')));
  assert.ok(errors.some((e) => e.message.includes('no output "nope"')));
});

test('whole-value wire type mismatch is rejected', () => {
  const { errors } = check('type-mismatch');
  const e = errors.find((x) => x.message.includes('type mismatch'));
  assert.ok(e);
  assert.ok(e.message.includes('number') && e.message.includes('string'));
});

function validateInline(workflow, extraBlocks = []) {
  const lib = new Map(library);
  for (const [pin, block] of extraBlocks) lib.set(pin, block);
  return validateWorkflow(workflow, lib, join(ROOT, 'workflows', `${workflow.name}.workflow.json`));
}

const SECRET_TAINT_MESSAGE = 'secret-derived data cannot be wired into fuzzy nodes';

function secretWorkflowWith(nodes) {
  return {
    name: 'secret-taint', version: 1,
    inputs: { token: { type: 'string', secret: true } },
    grants: { run: ['printf'], read: [], write: [] },
    nodes,
  };
}

test('secret-taint validation rejects direct, interpolated, and nested secret input bindings into fuzzy nodes', () => {
  for (const [label, workflow, extraBlocks, pointer] of [
    ['direct', secretWorkflowWith([
      { id: 'judge', block: 'fx-judge@1', in: { candidate: '{{inputs.token}}' } },
    ]), [], '/nodes/0/in/candidate'],
    ['interpolated', secretWorkflowWith([
      { id: 'judge', block: 'fx-judge@1', in: { candidate: 'prefix {{inputs.token}}' } },
    ]), [], '/nodes/0/in/candidate'],
    ['nested', secretWorkflowWith([
      { id: 'judge', block: 'fx-object@1', in: { payload: { message: '{{inputs.token}}' } } },
    ]), [[
      'fx-object@1',
      { name: 'fx-object', version: 1, kind: 'fuzzy', inputs: { payload: { type: 'object' } }, outputs: { verdict: { type: 'string' } } },
    ]], '/nodes/0/in/payload'],
  ]) {
    const { errors } = validateInline(workflow, extraBlocks);
    assert.ok(errors.some((e) => e.pointer === pointer && e.message === SECRET_TAINT_MESSAGE), label);
  }
});

test('secret-taint validation rejects transitive deterministic flow into fuzzy nodes', () => {
  const { errors } = validateInline(secretWorkflowWith([
    { id: 'first', block: 'echo-text@1', in: { text: '{{inputs.token}}' } },
    { id: 'second', block: 'echo-text@1', in: { text: '{{nodes.first.output.text}}' } },
    { id: 'judge', block: 'fx-judge@1', in: { candidate: '{{nodes.second.output.text}}' } },
  ]));
  assert.ok(errors.some((e) => e.pointer === '/nodes/2/in/candidate' && e.message === SECRET_TAINT_MESSAGE));
});

test('secret-taint validation allows secret input in deterministic-only workflows', () => {
  const { errors, order } = validateInline(secretWorkflowWith([
    { id: 'echo', block: 'echo-text@1', in: { text: '{{inputs.token}}' } },
  ]));
  assert.deepEqual(errors, []);
  assert.deepEqual(order, ['echo']);
});

test('secret-taint validation rejects tainted parent data wired to non-secret child workflow inputs', () => {
  const file = join(ROOT, 'workflows', 'parent.workflow.json');
  const { workflow } = parseWorkflowFile(file);
  const wf = structuredClone(workflow);
  wf.inputs.text.secret = true;
  const { errors } = validateWorkflow(wf, library, file);
  assert.ok(errors.some((e) => e.pointer === '/nodes/0/in/text' && e.message.includes('non-secret child workflow input')));
});

test('ordering comparison on a string ref fails the gate check', () => {
  const { errors } = check('bad-when');
  assert.ok(errors.some((e) => e.pointer.endsWith('/when')));
});

test('grants exceeding block declarations are rejected', () => {
  const { errors } = check('bad-grants');
  const e = errors.find((x) => x.message.includes('"rm"'));
  assert.ok(e, 'the undeclared rm grant is called out');
  assert.ok(e.pointer.startsWith('/grants/run'));
});

test('a needed grant that is missing is rejected', () => {
  const { errors } = check('missing-grant');
  assert.ok(errors.some((e) => e.message.includes('needs to run "printf"')));
});

test('duplicate node ids are rejected', () => {
  const { errors } = check('dup-id');
  assert.ok(errors.some((e) => e.message.includes('duplicate node id "echo"')));
});

test('missing required input binding is rejected with a fix hint', () => {
  const { errors } = check('missing-input');
  const e = errors.find((x) => x.message.includes('missing binding for required input "text"'));
  assert.ok(e);
  assert.ok(e.hint.includes('"in"'));
});

test('unknown keys are rejected: workflow, node, grants (closed documents)', () => {
  const file = join(ROOT, 'workflows', 'valid.workflow.json');
  const { workflow } = parseWorkflowFile(file);
  const bad = structuredClone(workflow);
  bad.vendorExt = true;
  bad.grants.exec = ['x'];
  bad.nodes[0].retries = 5;
  const { errors } = validateWorkflow(bad, library, file);
  assert.ok(errors.some((e) => e.message.includes('unknown workflow key "vendorExt"')));
  assert.ok(errors.some((e) => e.message.includes('unknown grants key "exec"')));
  assert.ok(errors.some((e) => e.message.includes('unknown node key "retries"')));
});

test('every error carries file and pointer', () => {
  for (const name of ['cyclic', 'bad-pin', 'unresolved-wire', 'type-mismatch', 'dup-id']) {
    for (const e of check(name).errors) {
      assert.ok(e.file, `${name}: error has a file`);
      assert.notEqual(e.pointer, undefined, `${name}: error has a pointer`);
    }
  }
});

test('malformed workflow containers report structured errors instead of throwing', () => {
  assert.doesNotThrow(() => validateWorkflow(null, library, 'bad.workflow.json'));
  const top = validateWorkflow([], library, 'bad.workflow.json');
  assert.ok(top.errors.some((e) => e.pointer === '' && e.message.includes('JSON object')));

  const malformed = {
    name: 'valid',
    version: 1,
    inputs: [],
    grants: 'all',
    nodes: [null, [], { id: 'echo', block: 'echo-text@1', in: [], after: {} }],
    outputs: [],
  };
  const { errors } = validateWorkflow(malformed, library, 'bad.workflow.json');
  assert.ok(errors.some((e) => e.pointer === '/inputs' && e.message.includes('object')));
  assert.ok(errors.some((e) => e.pointer === '/grants' && e.message.includes('object')));
  assert.ok(errors.some((e) => e.pointer === '/nodes/0' && e.message.includes('object')));
  assert.ok(errors.some((e) => e.pointer === '/nodes/2/in' && e.message.includes('object')));
  assert.ok(errors.some((e) => e.pointer === '/nodes/2/after' && e.message.includes('array')));
  assert.ok(errors.some((e) => e.pointer === '/outputs' && e.message.includes('object')));
});

test('unknown contract keys, unknown exec keys, and capture-on-entry are rejected', async () => {
  const { mkdtempSync, cpSync, readFileSync: rf, writeFileSync: wfs } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { loadBlock } = await import('../src/loader.js');
  const dir = join(mkdtempSync(join(tmpdir(), 'blocks-loader-')), 'echo-text');
  cpSync(join(ROOT, 'blocks', 'echo-text'), dir, { recursive: true });
  const cfile = join(dir, 'contract.json');
  const contract = JSON.parse(rf(cfile, 'utf8'));
  contract.vendor = 'x';
  contract.exec.shell = true;
  wfs(cfile, JSON.stringify(contract));
  const { errors } = loadBlock(dir);
  assert.ok(errors.some((e) => e.message.includes('unknown contract key "vendor"')));
  assert.ok(errors.some((e) => e.message.includes('unknown exec key "shell"')));

  const wc = JSON.parse(rf(join(ROOT, 'blocks', 'word-count', 'contract.json'), 'utf8'));
  const dir2 = join(mkdtempSync(join(tmpdir(), 'blocks-loader-')), 'word-count');
  cpSync(join(ROOT, 'blocks', 'word-count'), dir2, { recursive: true });
  wc.exec.capture = 'json';
  wfs(join(dir2, 'contract.json'), JSON.stringify(wc));
  const r2 = loadBlock(dir2);
  assert.ok(r2.errors.some((e) => e.message.includes('"capture" applies only to the argv variant')));
});

test('contract containers and argv are hardened with precise validation errors', async () => {
  const { mkdtempSync, cpSync, readFileSync: rf, writeFileSync: wfs } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { loadBlock } = await import('../src/loader.js');

  const badShape = join(mkdtempSync(join(tmpdir(), 'blocks-contract-')), 'echo-text');
  cpSync(join(ROOT, 'blocks', 'echo-text'), badShape, { recursive: true });
  wfs(join(badShape, 'contract.json'), '[]');
  const shaped = loadBlock(badShape);
  assert.ok(shaped.errors.some((e) => e.pointer === '' && e.message.includes('JSON object')));

  const dir = join(mkdtempSync(join(tmpdir(), 'blocks-argv-')), 'echo-text');
  cpSync(join(ROOT, 'blocks', 'echo-text'), dir, { recursive: true });
  const cfile = join(dir, 'contract.json');
  const contract = JSON.parse(rf(cfile, 'utf8'));
  contract.exec.argv = [];
  wfs(cfile, JSON.stringify(contract));
  const empty = loadBlock(dir);
  assert.ok(empty.errors.some((e) => e.pointer === '/exec/argv' && e.message.includes('non-empty')));

  contract.exec.argv = ['{{inputs.text}}', 'prefix {{inputs.text}}', '{{bad.ref}}', '{{inputs.missing}}'];
  wfs(cfile, JSON.stringify(contract));
  const malformed = loadBlock(dir);
  assert.ok(malformed.errors.some((e) => e.pointer === '/exec/argv/0' && e.message.includes('literal non-empty')));
  assert.ok(malformed.errors.some((e) => e.pointer === '/exec/argv/1' && e.message.includes('whole argv element')));
  assert.ok(malformed.errors.some((e) => e.pointer === '/exec/argv/2' && e.message.includes('invalid binding ref')));
  assert.ok(malformed.errors.some((e) => e.pointer === '/exec/argv/3' && e.message.includes('declared input')));
});

// ---------- Draft 02: composition, outputs, protocol ----------

test('nested workflow: parent validates; child outputs resolve as node outputs', () => {
  const { errors, order } = check('parent');
  assert.deepEqual(errors, []);
  assert.ok(order.indexOf('sub') < order.indexOf('use'));
});

test('workflow inclusion cycle across files is detected with the full path', () => {
  const { errors } = check('cyc-a');
  const e = errors.find((x) => x.message.includes('inclusion cycle'));
  assert.ok(e, JSON.stringify(errors.slice(0, 3)));
  assert.ok(e.message.includes('->'));
});

test('bad nesting: block+workflow on one node; version-mismatched pin', () => {
  const { errors } = check('bad-nest');
  assert.ok(errors.some((e) => e.message.includes('exactly one of "block" or "workflow"')));
  assert.ok(errors.some((e) => e.message.includes('does not match the file\'s version 1')));
  assert.ok(errors.some((e) => e.message.includes('grants "printf"')), 'uncovered child grant reported');
});

test('Draft 2 constructs without protocol: 2 are rejected', () => {
  const { errors } = check('no-protocol');
  assert.ok(errors.some((e) => e.pointer === '/protocol' && e.message.includes('Draft 2 constructs')));
});

test('a protocol newer than implemented is rejected naming both numbers', () => {
  const file = join(ROOT, 'workflows', 'valid.workflow.json');
  const { workflow } = parseWorkflowFile(file);
  const future = structuredClone(workflow);
  future.protocol = 99;
  const { errors } = validateWorkflow(future, library, file);
  const e = errors.find((x) => x.pointer === '/protocol');
  assert.ok(e && e.message.includes('99') && e.message.includes('4'), JSON.stringify(e));
});

test('output declarations: type mismatch, input-only keys, missing from', () => {
  const { errors } = check('out-bad');
  assert.ok(errors.some((e) => e.pointer === '/outputs/wrong/from' && e.message.includes('type mismatch')));
  assert.ok(errors.some((e) => e.pointer.startsWith('/outputs/sneaky/default')));
  assert.ok(errors.some((e) => e.pointer === '/outputs/missing/from'));
});

test('oracle claims: fx-approve loads; oracle on det block rejected', async () => {
  const { loadBlock } = await import('../src/loader.js');
  const ok = loadBlock(join(ROOT, 'blocks', 'fx-approve'));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.block.oracle.claims, ['fixture-approver']);

  const { mkdtempSync, cpSync, readFileSync: rf, writeFileSync: wfs } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = join(mkdtempSync(join(tmpdir(), 'blocks-oracle-')), 'echo-text');
  cpSync(join(ROOT, 'blocks', 'echo-text'), dir, { recursive: true });
  const c = JSON.parse(rf(join(dir, 'contract.json'), 'utf8'));
  c.oracle = { claims: ['x'] };
  wfs(join(dir, 'contract.json'), JSON.stringify(c));
  const bad = loadBlock(dir);
  assert.ok(bad.errors.some((e) => e.message.includes('"oracle" applies only to fuzzy blocks')));
});

test('key registry: valid key loads; private material rejected', async () => {
  const { loadRegistryKey } = await import('../src/keys.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const { mkdtempSync, mkdirSync, writeFileSync: wfs } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'blocks-keys-'));
  mkdirSync(join(root, 'keys'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' });
  wfs(join(root, 'keys', 'k-good.json'), JSON.stringify({ keyId: 'k-good', publicJwk: pub, claims: ['fixture-approver'] }));
  const good = loadRegistryKey(root, 'k-good');
  assert.deepEqual(good.errors, []);

  const priv = privateKey.export({ format: 'jwk' });
  wfs(join(root, 'keys', 'k-leak.json'), JSON.stringify({ keyId: 'k-leak', publicJwk: priv, claims: ['x'] }));
  const leak = loadRegistryKey(root, 'k-leak');
  assert.ok(leak.errors.some((e) => e.message.includes('private material')));

  const missing = loadRegistryKey(root, 'k-none');
  assert.ok(missing.errors.some((e) => e.message.includes('no registered key')));
});
