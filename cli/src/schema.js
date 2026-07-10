// schema-lite: the deliberately small JSON-Schema subset from SPEC.md §2.3.
// Two jobs: check schema *definitions* are legal, and check *values* against them.

export const FIELD_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

const TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);
const KEYS = new Set([
  'type', 'required', 'enum', 'pattern', 'minimum', 'maximum',
  'items', 'properties', 'default', 'description', 'secret', 'enumFromInput',
]);

function pointerSegment(name) {
  return String(name).replaceAll('~', '~0').replaceAll('/', '~1');
}

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPattern(value) {
  return typeof value === 'string' || value instanceof RegExp;
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function checkSchemaValue(value, schema, pointer, errors) {
  const actual = typeOf(value);
  if (actual !== schema.type) {
    errors.push({ pointer, message: `default value expected ${schema.type}, got ${actual}` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === value)) {
    errors.push({ pointer, message: `default value ${JSON.stringify(value)} is not in enum` });
  }
  if (schema.type === 'string' && isPattern(schema.pattern) && !new RegExp(schema.pattern).test(value)) {
    errors.push({ pointer, message: `default value does not match pattern ${schema.pattern}` });
  }
  if (schema.type === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ pointer, message: `default value ${value} is below minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ pointer, message: `default value ${value} is above maximum ${schema.maximum}` });
    }
  }
  if (schema.type === 'array' && isObjectRecord(schema.items)) {
    value.forEach((item, i) => checkSchemaValue(item, schema.items, `${pointer}/${i}`, errors));
  }
  if (schema.type === 'object' && isObjectRecord(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (!isObjectRecord(sub)) continue;
      const required = sub.required !== false;
      if (value[name] === undefined) {
        if (required) errors.push({ pointer: `${pointer}/${pointerSegment(name)}`, message: `default value missing required property "${name}"` });
        continue;
      }
      checkSchemaValue(value[name], sub, `${pointer}/${pointerSegment(name)}`, errors);
    }
  }
}

export function checkSchemaDef(schema, pointer, errors, options = {}) {
  const { allowDefault = true, allowSecret = true, allowEnumFromInput = false, inputFields = {} } = options;
  if (!isObjectRecord(schema)) {
    errors.push({ pointer, message: 'schema must be an object', hint: 'e.g. {"type": "string"}' });
    return;
  }

  const start = errors.length;
  for (const key of Object.keys(schema)) {
    if (!KEYS.has(key)) {
      errors.push({
        pointer: `${pointer}/${pointerSegment(key)}`,
        message: `unknown schema key "${key}"`,
        hint: `schema-lite allows: ${[...KEYS].join(', ')}`,
      });
    }
  }

  const typeValid = TYPES.has(schema.type);
  if (!typeValid) {
    errors.push({
      pointer: `${pointer}/type`,
      message: `"type" must be one of ${[...TYPES].join(' | ')}, got ${JSON.stringify(schema.type)}`,
      hint: 'every field schema needs an explicit type',
    });
  }

  if (schema.required !== undefined && typeof schema.required !== 'boolean') {
    errors.push({ pointer: `${pointer}/required`, message: `"required" must be a boolean, got ${JSON.stringify(schema.required)}` });
  }
  if (schema.secret !== undefined) {
    if (!allowSecret) errors.push({ pointer: `${pointer}/secret`, message: '"secret" is not allowed here', hint: 'secret is input-only' });
    if (typeof schema.secret !== 'boolean') errors.push({ pointer: `${pointer}/secret`, message: `"secret" must be a boolean, got ${JSON.stringify(schema.secret)}` });
  }
  if (schema.description !== undefined && typeof schema.description !== 'string') {
    errors.push({ pointer: `${pointer}/description`, message: `"description" must be a string, got ${JSON.stringify(schema.description)}` });
  }
  if (schema.default !== undefined && !allowDefault) {
    errors.push({ pointer: `${pointer}/default`, message: '"default" is not allowed here', hint: 'default is workflow-input only' });
  }
  if (schema.enumFromInput !== undefined) {
    if (!allowEnumFromInput) {
      errors.push({ pointer: `${pointer}/enumFromInput`, message: '"enumFromInput" is allowed only on a top-level block output schema under protocol 4' });
    }
    if (typeof schema.enumFromInput !== 'string' || !FIELD_IDENT_RE.test(schema.enumFromInput)) {
      errors.push({ pointer: `${pointer}/enumFromInput`, message: `"enumFromInput" must name a block input matching ${FIELD_IDENT_RE}` });
    } else if (allowEnumFromInput) {
      const source = inputFields[schema.enumFromInput];
      if (!source) {
        errors.push({ pointer: `${pointer}/enumFromInput`, message: `"enumFromInput" references undeclared input "${schema.enumFromInput}"` });
      } else if (source.type !== 'array' || !isObjectRecord(source.items) || source.items.type !== schema.type || !['string', 'number', 'boolean'].includes(schema.type)) {
        errors.push({ pointer: `${pointer}/enumFromInput`, message: `"enumFromInput" requires an array input whose item type matches this scalar output type` });
      }
    }
    if (schema.enum !== undefined) {
      errors.push({ pointer: `${pointer}/enumFromInput`, message: '"enumFromInput" cannot be combined with a literal "enum"' });
    }
  }

  if (schema.pattern !== undefined) {
    if (schema.type !== 'string') {
      errors.push({ pointer: `${pointer}/pattern`, message: '"pattern" only applies to type string' });
    }
    if (!isPattern(schema.pattern)) {
      errors.push({ pointer: `${pointer}/pattern`, message: `"pattern" must be a string or RegExp, got ${JSON.stringify(schema.pattern)}` });
    } else {
      try {
        new RegExp(schema.pattern);
      } catch (e) {
        errors.push({ pointer: `${pointer}/pattern`, message: `"pattern" is not a valid regular expression: ${e.message}` });
      }
    }
  }

  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined) {
      if (schema.type !== 'number') errors.push({ pointer: `${pointer}/${key}`, message: `"${key}" only applies to type number` });
      if (typeof schema[key] !== 'number' || !Number.isFinite(schema[key])) {
        errors.push({ pointer: `${pointer}/${key}`, message: `"${key}" must be a finite number, got ${JSON.stringify(schema[key])}` });
      }
    }
  }

  if (schema.items !== undefined) {
    if (schema.type !== 'array') {
      errors.push({ pointer: `${pointer}/items`, message: '"items" only applies to type array' });
    } else if (!isObjectRecord(schema.items)) {
      errors.push({ pointer: `${pointer}/items`, message: '"items" must be a schema object' });
    } else {
      checkSchemaDef(schema.items, `${pointer}/items`, errors, { ...options, allowEnumFromInput: false });
    }
  }

  if (schema.properties !== undefined) {
    if (schema.type !== 'object') {
      errors.push({ pointer: `${pointer}/properties`, message: '"properties" only applies to type object' });
    } else if (!isObjectRecord(schema.properties)) {
      errors.push({ pointer: `${pointer}/properties`, message: '"properties" must be an object mapping field names to schemas' });
    } else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        const subPointer = `${pointer}/properties/${pointerSegment(name)}`;
        if (!FIELD_IDENT_RE.test(name)) errors.push({ pointer: subPointer, message: `field identifier "${name}" must match ${FIELD_IDENT_RE}` });
        checkSchemaDef(sub, subPointer, errors, { ...options, allowEnumFromInput: false });
      }
    }
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      errors.push({ pointer: `${pointer}/enum`, message: '"enum" must be a non-empty array' });
    } else if (typeValid) {
      schema.enum.forEach((value, i) => {
        const actual = typeOf(value);
        if (actual !== schema.type) {
          errors.push({ pointer: `${pointer}/enum/${i}`, message: `enum value expected ${schema.type}, got ${actual}` });
        }
      });
    }
  }

  if (schema.default !== undefined && allowDefault && errors.length === start && typeValid) {
    checkSchemaValue(schema.default, schema, `${pointer}/default`, errors);
  }
}

// Validate one value against one field schema. Returns error objects with
// pointer/message/hint; empty array means valid.
export function validateValue(value, schema, pointer, context = {}) {
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
  if (schema.enumFromInput !== undefined) {
    const allowed = context.inputs?.[schema.enumFromInput];
    if (!Array.isArray(allowed)) {
      errors.push({ pointer, message: `cannot enforce enumFromInput without resolved input "${schema.enumFromInput}"`, hint: 'supply the block input context' });
    } else if (!allowed.some((v) => v === value)) {
      errors.push({ pointer, message: `value ${JSON.stringify(value)} is not present in input "${schema.enumFromInput}"`, hint: `choose one of the ${allowed.length} values supplied at pause time` });
    }
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
    value.forEach((item, i) => errors.push(...validateValue(item, schema.items, `${pointer}/${i}`, context)));
  }
  if (schema.type === 'object' && isObjectRecord(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      const required = sub.required !== false;
      if (value[name] === undefined) {
        if (required) errors.push({ pointer: `${pointer}/${pointerSegment(name)}`, message: `missing required property "${name}"` });
        continue;
      }
      errors.push(...validateValue(value[name], sub, `${pointer}/${pointerSegment(name)}`, context));
    }
  }
  return errors;
}

// Validate a flat map of values against a map of field schemas (block
// inputs/outputs, workflow inputs). Unknown fields are errors: contracts are
// exact, not open-ended.
export function validateShape(values, fields, pointer, context = {}) {
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
          pointer: `${pointer}/${pointerSegment(name)}`,
          message: `missing required field "${name}"`,
          hint: `declared fields: ${Object.keys(fields).join(', ')}`,
        });
      }
      continue;
    }
    errors.push(...validateValue(values[name], schema, `${pointer}/${pointerSegment(name)}`, context));
  }
  for (const name of Object.keys(values)) {
    if (!fields[name]) {
      errors.push({
        pointer: `${pointer}/${pointerSegment(name)}`,
        message: `undeclared field "${name}"`,
        hint: `the contract declares only: ${Object.keys(fields).join(', ')}`,
      });
    }
  }
  return errors;
}
