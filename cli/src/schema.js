// schema-lite: the deliberately small JSON-Schema subset from SPEC.md §2.3.
// Two jobs: check schema *definitions* are legal, and check *values* against them.

const TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);
const KEYS = new Set([
  'type', 'required', 'enum', 'pattern', 'minimum', 'maximum',
  'items', 'properties', 'default', 'description', 'secret',
]);

export function checkSchemaDef(schema, pointer, errors) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push({ pointer, message: 'schema must be an object', hint: 'e.g. {"type": "string"}' });
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!KEYS.has(key)) {
      errors.push({
        pointer: `${pointer}/${key}`,
        message: `unknown schema key "${key}"`,
        hint: `schema-lite allows: ${[...KEYS].join(', ')}`,
      });
    }
  }
  if (!TYPES.has(schema.type)) {
    errors.push({
      pointer: `${pointer}/type`,
      message: `"type" must be one of ${[...TYPES].join(' | ')}, got ${JSON.stringify(schema.type)}`,
      hint: 'every field schema needs an explicit type',
    });
    return;
  }
  if (schema.pattern !== undefined && schema.type !== 'string') {
    errors.push({ pointer: `${pointer}/pattern`, message: '"pattern" only applies to type string' });
  }
  if ((schema.minimum !== undefined || schema.maximum !== undefined) && schema.type !== 'number') {
    errors.push({ pointer, message: '"minimum"/"maximum" only apply to type number' });
  }
  if (schema.items !== undefined) {
    if (schema.type !== 'array') {
      errors.push({ pointer: `${pointer}/items`, message: '"items" only applies to type array' });
    } else {
      checkSchemaDef(schema.items, `${pointer}/items`, errors);
    }
  }
  if (schema.properties !== undefined) {
    if (schema.type !== 'object') {
      errors.push({ pointer: `${pointer}/properties`, message: '"properties" only applies to type object' });
    } else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        checkSchemaDef(sub, `${pointer}/properties/${name}`, errors);
      }
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    errors.push({ pointer: `${pointer}/enum`, message: '"enum" must be a non-empty array' });
  }
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

// Validate one value against one field schema. Returns error objects with
// pointer/message/hint; empty array means valid.
export function validateValue(value, schema, pointer) {
  const errors = [];
  const actual = typeOf(value);
  if (actual !== schema.type) {
    errors.push({
      pointer,
      message: `expected ${schema.type}, got ${actual} (${JSON.stringify(value)?.slice(0, 60)})`,
      hint: `this field is declared "type": "${schema.type}"`,
    });
    return errors;
  }
  if (schema.enum && !schema.enum.some((v) => v === value)) {
    errors.push({
      pointer,
      message: `value ${JSON.stringify(value)} is not in enum`,
      hint: `allowed: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
    });
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    errors.push({ pointer, message: `value does not match pattern ${schema.pattern}` });
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ pointer, message: `${value} is below minimum ${schema.minimum}` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push({ pointer, message: `${value} is above maximum ${schema.maximum}` });
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, i) => errors.push(...validateValue(item, schema.items, `${pointer}/${i}`)));
  }
  if (schema.type === 'object' && schema.properties) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      const required = sub.required !== false;
      if (value[name] === undefined) {
        if (required) errors.push({ pointer: `${pointer}/${name}`, message: `missing required property "${name}"` });
        continue;
      }
      errors.push(...validateValue(value[name], sub, `${pointer}/${name}`));
    }
  }
  return errors;
}

// Validate a flat map of values against a map of field schemas (block
// inputs/outputs, workflow inputs). Unknown fields are errors: contracts are
// exact, not open-ended.
export function validateShape(values, fields, pointer) {
  const errors = [];
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    errors.push({ pointer, message: 'expected a JSON object', hint: 'fuzzy output must be a single JSON object' });
    return errors;
  }
  for (const [name, schema] of Object.entries(fields)) {
    const required = schema.required !== false;
    if (values[name] === undefined) {
      if (required) {
        errors.push({
          pointer: `${pointer}/${name}`,
          message: `missing required field "${name}"`,
          hint: `declared fields: ${Object.keys(fields).join(', ')}`,
        });
      }
      continue;
    }
    errors.push(...validateValue(values[name], schema, `${pointer}/${name}`));
  }
  for (const name of Object.keys(values)) {
    if (!fields[name]) {
      errors.push({
        pointer: `${pointer}/${name}`,
        message: `undeclared field "${name}"`,
        hint: `the contract declares only: ${Object.keys(fields).join(', ')}`,
      });
    }
  }
  return errors;
}
