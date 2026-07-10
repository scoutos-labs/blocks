import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSchemaDef, validateShape, validateValue } from '../src/schema.js';
import { parseTemplate, evalTemplate } from '../src/bindings.js';
import { parseWhen, evalWhen } from '../src/when.js';

test('schema-lite: shape validation names the exact field', () => {
  const fields = {
    score: { type: 'number', minimum: 0, maximum: 1 },
    verdict: { type: 'string', enum: ['pass', 'revise'] },
  };
  assert.deepEqual(validateShape({ score: 0.7, verdict: 'pass' }, fields, ''), []);
  const over = validateShape({ score: 2, verdict: 'pass' }, fields, '');
  assert.equal(over.length, 1);
  assert.equal(over[0].pointer, '/score');
  assert.ok(over[0].message.includes('above maximum 1'));
  const bad = validateShape({ score: 0.5, verdict: 'maybe' }, fields, '');
  assert.ok(bad[0].message.includes('not in enum'));
  const extra = validateShape({ score: 0.5, verdict: 'pass', extra: 1 }, fields, '');
  assert.ok(extra[0].message.includes('undeclared field "extra"'));
  const missing = validateShape({ score: 0.5 }, fields, '');
  assert.ok(missing[0].message.includes('missing required field "verdict"'));
});

test('schema-lite: nested arrays and objects', () => {
  const schema = { type: 'array', items: { type: 'object', properties: { tag: { type: 'string' } } } };
  assert.deepEqual(validateValue([{ tag: 'a' }], schema, ''), []);
  const errs = validateValue([{ tag: 1 }], schema, '');
  assert.equal(errs[0].pointer, '/0/tag');
});

test('schema-lite: bad keyword types, regexes, identifiers, enums, and defaults are definition errors', () => {
  const errors = [];
  checkSchemaDef({
    type: 'object',
    required: 'yes',
    secret: 'no',
    properties: {
      'bad/name': { type: 'string', pattern: '[' },
      n: { type: 'number', minimum: '0', maximum: false, enum: [1, 'two'] },
      d: { type: 'string', default: 5 },
      a: { type: 'array', items: 'string' },
      empty: { type: 'boolean', enum: [] },
    },
  }, '/inputs/root', errors);
  assert.ok(errors.some((e) => e.pointer === '/inputs/root/required' && e.message.includes('boolean')));
  assert.ok(errors.some((e) => e.pointer === '/inputs/root/secret' && e.message.includes('boolean')));
  assert.ok(errors.some((e) => e.pointer === '/inputs/root/properties/bad~1name' && e.message.includes('field identifier')));
  assert.ok(errors.some((e) => e.pointer === '/inputs/root/properties/bad~1name/pattern' && e.message.includes('regular expression')));
  assert.ok(errors.some((e) => e.pointer === '/inputs/root/properties/n/minimum' && e.message.includes('number')));
  assert.ok(errors.some((e) => e.pointer === '/inputs/root/properties/n/enum/1' && e.message.includes('expected number')));
  assert.ok(errors.some((e) => e.pointer === '/inputs/root/properties/d/default' && e.message.includes('expected string')));
  assert.ok(errors.some((e) => e.pointer === '/inputs/root/properties/a/items' && e.message.includes('schema object')));
  assert.ok(errors.some((e) => e.pointer === '/inputs/root/properties/empty/enum' && e.message.includes('non-empty')));
});

test('wires: whole-value bindings preserve type', () => {
  const ctx = { inputs: { n: 3 }, nodeOutputs: { a: { deep: { flag: true } } } };
  assert.equal(evalTemplate('{{inputs.n}}', ctx), 3);
  assert.equal(evalTemplate('{{nodes.a.output.deep.flag}}', ctx), true);
});

test('wires: interpolation stringifies scalars and rejects objects', () => {
  const ctx = { inputs: { who: 'world' }, nodeOutputs: { a: { obj: { x: 1 }, n: 2 } } };
  assert.equal(evalTemplate('hello {{inputs.who}} #{{nodes.a.output.n}}', ctx), 'hello world #2');
  assert.throws(() => evalTemplate('x {{nodes.a.output.obj}}', ctx), /cannot interpolate object/);
});

test('wires: malformed refs are reported, not silently passed through', () => {
  const { parts } = parseTemplate('{{nodes.echo.text}}');
  assert.ok(parts[0].error.includes('invalid binding ref'));
});

test('gates: parse and left-associative eval', () => {
  const ast = parseWhen("nodes.j.output.score >= 0.7 and nodes.j.output.verdict == 'pass'");
  assert.equal(ast.clauses.length, 2);
  const ok = { inputs: {}, nodeOutputs: { j: { score: 0.9, verdict: 'pass' } } };
  const low = { inputs: {}, nodeOutputs: { j: { score: 0.2, verdict: 'pass' } } };
  assert.equal(evalWhen(ast, ok), true);
  assert.equal(evalWhen(ast, low), false);
});

test('gates: skipped/missing upstream output makes the clause false', () => {
  const ast = parseWhen('nodes.j.output.score >= 0.5');
  assert.equal(evalWhen(ast, { inputs: {}, nodeOutputs: {} }), false);
});

test('gates: grammar stays tiny — no parens, no arithmetic, ordering needs numbers', () => {
  assert.throws(() => parseWhen('(nodes.a.output.x == 1)'), /unexpected character/);
  assert.throws(() => parseWhen('nodes.a.output.x + 1 == 2'), /unexpected character|expected/);
  assert.throws(() => parseWhen("nodes.a.output.x >= 'abc'"), /requires a number literal/);
});
