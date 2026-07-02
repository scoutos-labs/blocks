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
  assert.deepEqual([...library.keys()].sort(), ['echo-text@1', 'fx-judge@1', 'word-count@1']);
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
