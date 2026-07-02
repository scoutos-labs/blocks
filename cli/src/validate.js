// Workflow validation: SPEC.md §3–§5, §7. Every error carries file,
// JSON-pointer, message, and a fix hint — "invalid workflow" is banned output.

import { readFileSync } from 'node:fs';
import { checkSchemaDef } from './schema.js';
import { parseTemplate } from './bindings.js';
import { parseWhen } from './when.js';

const ID_RE = /^[a-z][a-z0-9-]*$/;
const PIN_RE = /^([a-z][a-z0-9-]*)@(\d+)$/;
const PATH_GLOB_RE = /^(?!\/)(?!.*\.\.)[^\0]*$/;

export function parseWorkflowFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { errors: [{ file, pointer: '', message: `cannot read workflow file: ${e.message}` }] };
  }
  try {
    return { workflow: JSON.parse(text), errors: [] };
  } catch (e) {
    return { errors: [{ file, pointer: '', message: `not valid JSON: ${e.message}`, hint: 'workflows are strict JSON (SPEC §3) — check trailing commas and quoting' }] };
  }
}

// Returns { errors, order } — order is the topological node order when acyclic.
export function validateWorkflow(workflow, library, file) {
  const errors = [];
  const err = (pointer, message, hint) => errors.push({ file, pointer, message, ...(hint ? { hint } : {}) });

  if (typeof workflow.name !== 'string' || !ID_RE.test(workflow.name)) {
    err('/name', `workflow "name" must match ${ID_RE}, got ${JSON.stringify(workflow.name)}`);
  }
  if (!Number.isInteger(workflow.version) || workflow.version < 1) {
    err('/version', '"version" must be a positive integer');
  }

  const wfInputs = workflow.inputs ?? {};
  for (const [name, schema] of Object.entries(wfInputs)) {
    const defErrors = [];
    checkSchemaDef(schema, `/inputs/${name}`, defErrors);
    errors.push(...defErrors.map((e) => ({ file, ...e })));
  }

  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    err('/nodes', '"nodes" must be a non-empty array');
    return { errors, order: [] };
  }

  // --- pass 1: ids, pins, gather node -> block ---
  const nodes = new Map();
  workflow.nodes.forEach((node, i) => {
    const p = `/nodes/${i}`;
    if (typeof node.id !== 'string' || !ID_RE.test(node.id)) {
      err(`${p}/id`, `node id must match ${ID_RE}, got ${JSON.stringify(node.id)}`);
      return;
    }
    if (nodes.has(node.id)) {
      err(`${p}/id`, `duplicate node id "${node.id}"`, 'node ids must be unique within a workflow');
      return;
    }
    const pin = PIN_RE.exec(node.block ?? '');
    if (!pin) {
      err(`${p}/block`, `block pin must be "name@version", got ${JSON.stringify(node.block)}`, 'exact pins only — no ranges (SPEC §3)');
      nodes.set(node.id, { node, i, block: null });
      return;
    }
    const block = library.get(node.block);
    if (!block) {
      const versions = [...library.keys()].filter((k) => k.startsWith(`${pin[1]}@`));
      err(`${p}/block`, `no block "${node.block}" in the library`, versions.length ? `library has: ${versions.join(', ')}` : `run \`blocks list\` to see available blocks`);
    }
    nodes.set(node.id, { node, i, block: block ?? null });
  });

  // --- pass 2: wires, gates, after ---
  const edges = new Map([...nodes.keys()].map((id) => [id, new Set()])); // id -> deps
  const refErrors = (ref, pointer, targetSchema, { interpolated }) => {
    if (ref.kind === 'input') {
      const schema = wfInputs[ref.key];
      if (!schema) {
        err(pointer, `binding references undeclared workflow input "${ref.key}"`, `declared inputs: ${Object.keys(wfInputs).join(', ') || '(none)'}`);
        return null;
      }
      return schema;
    }
    const dep = nodes.get(ref.node);
    if (!dep) {
      err(pointer, `binding references unknown node "${ref.node}"`, `nodes: ${[...nodes.keys()].join(', ')}`);
      return null;
    }
    if (!dep.block) return null; // pin error already reported
    let schema = { type: 'object', properties: dep.block.outputs };
    for (const key of ref.path) {
      const props = schema.properties ?? {};
      if (schema.type !== 'object' || !props[key]) {
        err(pointer, `node "${ref.node}" (${dep.node.block}) declares no output "${ref.path.join('.')}"`, `declared outputs: ${Object.keys(dep.block.outputs).join(', ')}`);
        return null;
      }
      schema = props[key];
    }
    return schema;
  };

  for (const { node, i, block } of nodes.values()) {
    const p = `/nodes/${i}`;
    const bound = node.in ?? {};
    if (block) {
      for (const name of Object.keys(block.inputs)) {
        if (block.inputs[name].required !== false && bound[name] === undefined) {
          err(`${p}/in`, `missing binding for required input "${name}" of ${node.block}`, `bind it: "in": {"${name}": "{{...}}" }`);
        }
      }
      for (const name of Object.keys(bound)) {
        if (!block.inputs[name]) {
          err(`${p}/in/${name}`, `${node.block} declares no input "${name}"`, `declared inputs: ${Object.keys(block.inputs).join(', ') || '(none)'}`);
        }
      }
    }
    for (const [name, value] of Object.entries(bound)) {
      const bp = `${p}/in/${name}`;
      const target = block?.inputs?.[name];
      if (typeof value !== 'string') {
        // literal non-string JSON value: allowed, type-checked directly
        if (target) {
          const t = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
          if (t !== target.type) err(bp, `literal value has type ${t}, input "${name}" wants ${target.type}`);
        }
        continue;
      }
      const { parts, whole } = parseTemplate(value);
      for (const part of parts) if (part.error) err(bp, part.error, 'wire syntax: {{inputs.<key>}} or {{nodes.<id>.output.<field>}} (SPEC §4)');
      const refs = parts.filter((x) => x.ref);
      if (whole) {
        const src = refErrors(refs[0].ref, bp, target, { interpolated: false });
        if (src && target && src.type !== target.type) {
          err(bp, `type mismatch: {{${refs[0].raw}}} is ${src.type}, input "${name}" wants ${target.type}`, 'whole-value wires must match types exactly (SPEC §4)');
        }
        if (refs[0].ref.kind === 'node') edges.get(node.id)?.add(refs[0].ref.node);
      } else {
        if (refs.length > 0 && target && target.type !== 'string') {
          err(bp, `interpolation is only valid into string inputs; "${name}" wants ${target.type}`);
        }
        for (const part of refs) {
          const src = refErrors(part.ref, bp, target, { interpolated: true });
          if (src && !['string', 'number', 'boolean'].includes(src.type)) {
            err(bp, `cannot interpolate ${src.type} value {{${part.raw}}} into a string`);
          }
          if (part.ref.kind === 'node') edges.get(node.id)?.add(part.ref.node);
        }
      }
    }
    if (node.when !== undefined) {
      try {
        const ast = parseWhen(node.when);
        for (const clause of ast.clauses) {
          const src = refErrors(clause.ref, `${p}/when`, null, { interpolated: false });
          if (src && clause.ordering && src.type !== 'number') {
            err(`${p}/when`, `ordering comparison needs a number ref; ${refText(clause.ref)} is ${src.type}`);
          }
          if (clause.ref.kind === 'node') edges.get(node.id)?.add(clause.ref.node);
        }
      } catch (e) {
        err(`${p}/when`, `gate does not parse: ${e.message}`, "grammar: ref op literal [and|or ...] — e.g. nodes.judge.output.score >= 0.7 (SPEC §5)");
      }
    }
    for (const [j, dep] of (node.after ?? []).entries()) {
      if (!nodes.has(dep)) err(`${p}/after/${j}`, `"after" references unknown node "${dep}"`);
      else edges.get(node.id)?.add(dep);
    }
  }

  // --- pass 3: acyclicity (DFS with cycle path reporting) ---
  const order = [];
  const state = new Map(); // 0 visiting, 1 done
  const visit = (id, stack) => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 0) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(' -> ');
      err('/nodes', `cycle detected: ${cycle}`, 'a workflow is a DAG — break the cycle by removing one of these wires (SPEC §3)');
      return false;
    }
    state.set(id, 0);
    for (const dep of edges.get(id) ?? []) {
      if (nodes.has(dep) && !visit(dep, [...stack, id])) return false;
    }
    state.set(id, 1);
    order.push(id);
    return true;
  };
  for (const id of nodes.keys()) if (!visit(id, [])) break;

  // --- pass 4: grants model (SPEC §7) ---
  const grants = workflow.grants ?? {};
  for (const key of ['read', 'write']) {
    for (const [j, glob] of (grants[key] ?? []).entries()) {
      if (typeof glob !== 'string' || !PATH_GLOB_RE.test(glob)) {
        err(`/grants/${key}/${j}`, `grant path glob ${JSON.stringify(glob)} is invalid`, 'workspace-relative, no absolute paths, no ".."');
      }
    }
  }
  const declared = { run: new Set(), read: new Set(), write: new Set() };
  for (const { block } of nodes.values()) {
    if (block?.permissions) {
      for (const key of ['run', 'read', 'write']) {
        for (const v of block.permissions[key] ?? []) declared[key].add(v);
      }
    }
  }
  for (const key of ['run', 'read', 'write']) {
    for (const [j, v] of (grants[key] ?? []).entries()) {
      if (!declared[key].has(v)) {
        err(`/grants/${key}/${j}`, `grant "${v}" is not declared by any block in this workflow`, 'grants can only co-sign what blocks declare — remove it or use a block that needs it (SPEC §7)');
      }
    }
  }
  for (const { node, i, block } of nodes.values()) {
    if (block?.kind !== 'deterministic') continue;
    if (block.exec?.argv) {
      const bin = block.exec.argv[0];
      if (!(grants.run ?? []).includes(bin)) {
        err(`/grants/run`, `node "${node.id}" (${node.block}) needs to run "${bin}" but the workflow does not grant it`, `add "${bin}" to grants.run`);
      }
    }
    for (const key of ['read', 'write']) {
      for (const glob of block.permissions?.[key] ?? []) {
        if ((block.permissions[key] ?? []).length > 0 && (grants[key] ?? []).length === 0 && key === 'write') {
          err(`/grants/write`, `node "${node.id}" (${node.block}) declares write access but the workflow grants none`, `add the intended paths to grants.write`);
          break;
        }
      }
    }
  }

  // DFS postorder pushes dependencies before dependents — already topological.
  return { errors, order: errors.length ? [] : order };
}

function refText(ref) {
  return ref.kind === 'input' ? `inputs.${ref.key}` : `nodes.${ref.node}.output.${ref.path.join('.')}`;
}

export function formatErrors(errors) {
  return errors
    .map((e) => {
      const loc = [e.file, e.pointer].filter(Boolean).join(' ');
      return `  ✗ ${loc}\n    ${e.message}${e.hint ? `\n    hint: ${e.hint}` : ''}`;
    })
    .join('\n');
}
