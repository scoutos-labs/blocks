// Wires: the binding grammar from SPEC.md §4.
// {{inputs.key}} | {{nodes.id.output.key.path}} — whole-value or string interpolation.

const REF_RE = /^(?:inputs\.([a-zA-Z_][a-zA-Z0-9_-]*)|nodes\.([a-z][a-z0-9-]*)\.output\.([a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_-]*)*))$/;

export function parseRef(text) {
  const m = REF_RE.exec(text);
  if (!m) return null;
  if (m[1] !== undefined) return { kind: 'input', key: m[1] };
  return { kind: 'node', node: m[2], path: m[3].split('.') };
}

// Split a template string into literal-text and ref parts.
// Returns { parts, whole } where whole=true means the string is exactly one binding.
// Throws-free: malformed refs come back as { error } parts for the validator to report.
export function parseTemplate(text) {
  const parts = [];
  let rest = text;
  let idx;
  while ((idx = rest.indexOf('{{')) !== -1) {
    const end = rest.indexOf('}}', idx);
    if (end === -1) {
      parts.push({ error: `unterminated binding in ${JSON.stringify(text)}` });
      rest = '';
      break;
    }
    if (idx > 0) parts.push({ text: rest.slice(0, idx) });
    const raw = rest.slice(idx + 2, end).trim();
    const ref = parseRef(raw);
    if (ref) parts.push({ ref, raw });
    else parts.push({ error: `invalid binding ref "{{${raw}}}"` });
    rest = rest.slice(end + 2);
  }
  if (rest.length > 0) parts.push({ text: rest });
  const whole = parts.length === 1 && parts[0].ref !== undefined;
  return { parts, whole };
}

// Visit every string inside a JSON value (bindings can sit anywhere).
export function walkStrings(value, fn) {
  if (typeof value === 'string') fn(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, fn));
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((v) => walkStrings(v, fn));
}

// Resolve a keypath into a value; returns { value } or { missing: keypath }.
export function digPath(value, path) {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || cur[key] === undefined) {
      return { missing: path.join('.') };
    }
    cur = cur[key];
  }
  return { value: cur };
}

// Evaluate a template against a context { inputs, nodeOutputs: {id: output} }.
// Whole bindings preserve type; interpolation stringifies string/number/boolean.
export function evalTemplate(text, ctx) {
  const { parts, whole } = parseTemplate(text);
  const lookup = (ref) => {
    if (ref.kind === 'input') {
      if (!(ref.key in ctx.inputs)) throw new Error(`unbound workflow input "${ref.key}"`);
      return ctx.inputs[ref.key];
    }
    const output = ctx.nodeOutputs[ref.node];
    if (output === undefined) throw new Error(`no recorded output for node "${ref.node}"`);
    const dug = digPath(output, ref.path);
    if ('missing' in dug) throw new Error(`node "${ref.node}" output has no field "${dug.missing}"`);
    return dug.value;
  };
  if (whole) return lookup(parts[0].ref);
  let out = '';
  for (const part of parts) {
    if (part.error) throw new Error(part.error);
    if (part.text !== undefined) { out += part.text; continue; }
    const v = lookup(part.ref);
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      throw new Error(`cannot interpolate ${Array.isArray(v) ? 'array' : t} value from {{${part.raw}}} into a string`);
    }
    out += String(v);
  }
  return out;
}
