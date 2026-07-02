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

test('every error carries file and pointer', () => {
  for (const name of ['cyclic', 'bad-pin', 'unresolved-wire', 'type-mismatch', 'dup-id']) {
    for (const e of check(name).errors) {
      assert.ok(e.file, `${name}: error has a file`);
      assert.notEqual(e.pointer, undefined, `${name}: error has a pointer`);
    }
  }
});
