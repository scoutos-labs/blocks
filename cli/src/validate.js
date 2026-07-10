// Workflow validation: SPEC.md §3–§5, §7. Every error carries file,
// JSON-pointer, message, and a fix hint — "invalid workflow" is banned output.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { checkSchemaDef, FIELD_IDENT_RE } from './schema.js';
import { parseTemplate, walkStrings } from './bindings.js';
import { parseWhen } from './when.js';
import { coveredBy } from './globs.js';

const ID_RE = /^[a-z][a-z0-9-]*$/;
const PIN_RE = /^([a-z][a-z0-9-]*)@(\d+)$/;
const PATH_GLOB_RE = /^(?!\/)(?!.*\.\.)[^\0]*$/;

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pointerSegment(name) {
  return String(name).replaceAll('~', '~0').replaceAll('/', '~1');
}

// The protocol draft this implementation speaks (PROTOCOL.md [VER-4]).
export const IMPLEMENTED_PROTOCOL = 4;

// Output declarations embed schema-lite minus default/secret, plus `from`.
const OUTPUT_DECL_KEYS = ['from', 'type', 'required', 'enum', 'pattern', 'minimum', 'maximum', 'items', 'properties', 'description'];

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
// ctx: { root, stack, cache } for resolving embedded child workflows.
export function validateWorkflow(workflow, library, file, ctx = {}) {
  const root = ctx.root ?? resolve(dirname(file), '..');
  const stack = ctx.stack ?? [];
  const cache = ctx.cache ?? new Map();
  const errors = [];
  const err = (pointer, message, hint) => errors.push({ file, pointer, message, ...(hint ? { hint } : {}) });

  if (!isObjectRecord(workflow)) {
    err('', 'workflow must be a JSON object');
    return { errors, order: [] };
  }

  // workflows and nodes are closed documents (PROTOCOL [WFL-6])
  const WF_KEYS = ['name', 'version', 'notes', 'inputs', 'grants', 'nodes', 'outputs', 'protocol'];
  for (const key of Object.keys(workflow)) {
    if (!WF_KEYS.includes(key)) err(`/${key}`, `unknown workflow key "${key}"`, `allowed: ${WF_KEYS.join(', ')}`);
  }

  let grants = {};
  if (workflow.grants !== undefined) {
    if (!isObjectRecord(workflow.grants)) {
      err('/grants', '"grants" must be an object', '{"run": [], "read": [], "write": []}');
    } else {
      grants = workflow.grants;
      for (const key of Object.keys(grants)) {
        if (!['run', 'read', 'write'].includes(key)) err(`/grants/${key}`, `unknown grants key "${key}"`, 'allowed: run, read, write');
      }
    }
  }

  const nodesArray = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  if (workflow.nodes !== undefined && !Array.isArray(workflow.nodes)) {
    err('/nodes', '"nodes" must be a non-empty array');
  }
  const NODE_KEYS = ['id', 'block', 'workflow', 'in', 'when', 'after', 'notes'];
  nodesArray.forEach((node, i) => {
    if (!isObjectRecord(node)) {
      err(`/nodes/${i}`, 'node must be an object');
      return;
    }
    for (const key of Object.keys(node)) {
      if (!NODE_KEYS.includes(key)) err(`/nodes/${i}/${key}`, `unknown node key "${key}"`, `allowed: ${NODE_KEYS.join(', ')}`);
    }
    if (node.in !== undefined && !isObjectRecord(node.in)) {
      err(`/nodes/${i}/in`, '"in" must be an object mapping input names to bindings or literal values');
    }
    if (node.after !== undefined && !Array.isArray(node.after)) {
      err(`/nodes/${i}/after`, '"after" must be an array of node ids');
    }
  });

  let wfInputs = {};
  if (workflow.inputs !== undefined) {
    if (!isObjectRecord(workflow.inputs)) {
      err('/inputs', '"inputs" must be an object mapping field names to schemas');
    } else {
      wfInputs = workflow.inputs;
      for (const [name, schema] of Object.entries(wfInputs)) {
        const p = `/inputs/${pointerSegment(name)}`;
        if (!FIELD_IDENT_RE.test(name)) err(p, `field identifier "${name}" must match ${FIELD_IDENT_RE}`);
        const defErrors = [];
        checkSchemaDef(schema, p, defErrors);
        errors.push(...defErrors.map((e) => ({ file, ...e })));
      }
    }
  }

  let workflowOutputs = {};
  if (workflow.outputs !== undefined) {
    if (!isObjectRecord(workflow.outputs)) {
      err('/outputs', '"outputs" must be an object mapping output names to declarations');
    } else {
      workflowOutputs = workflow.outputs;
    }
  }

  // protocol field (PROTOCOL [VER-4], [VER-5])
  const declaredProtocol = workflow.protocol ?? 1;
  if (workflow.protocol !== undefined && (!Number.isInteger(workflow.protocol) || workflow.protocol < 1)) {
    err('/protocol', `"protocol" must be a positive integer, got ${JSON.stringify(workflow.protocol)}`);
  } else if (declaredProtocol > IMPLEMENTED_PROTOCOL) {
    err('/protocol', `document declares protocol ${declaredProtocol}; this implementation speaks protocol ${IMPLEMENTED_PROTOCOL}`, 'a newer runner is required for this workflow');
  }
  const usesDraft2 = workflow.outputs !== undefined
    || nodesArray.some((n) => isObjectRecord(n) && n.workflow !== undefined);
  if (usesDraft2 && declaredProtocol < 2) {
    err('/protocol', 'workflow uses Draft 2 constructs (outputs or workflow nodes) but does not declare "protocol": 2', 'add "protocol": 2 (PROTOCOL [VER-5])');
  }
  let usesDraft3Gates = false; // set while checking gates; judged after the node pass
  let usesDraft4 = false;

  if (typeof workflow.name !== 'string' || !ID_RE.test(workflow.name)) {
    err('/name', `workflow "name" must match ${ID_RE}, got ${JSON.stringify(workflow.name)}`);
  }
  if (!Number.isInteger(workflow.version) || workflow.version < 1) {
    err('/version', '"version" must be a positive integer');
  }

  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    err('/nodes', '"nodes" must be a non-empty array');
    return { errors, order: [] };
  }

  // --- pass 1: ids, pins, gather node -> block (or embedded workflow) ---
  const nodes = new Map();
  nodesArray.forEach((node, i) => {
    const p = `/nodes/${i}`;
    if (!isObjectRecord(node)) return;
    if (typeof node.id !== 'string' || !ID_RE.test(node.id)) {
      err(`${p}/id`, `node id must match ${ID_RE}, got ${JSON.stringify(node.id)}`);
      return;
    }
    if (nodes.has(node.id)) {
      err(`${p}/id`, `duplicate node id "${node.id}"`, 'node ids must be unique within a workflow');
      return;
    }
    if ((node.block === undefined) === (node.workflow === undefined)) {
      err(`${p}`, 'a node must have exactly one of "block" or "workflow"', 'PROTOCOL [NST-1]');
      nodes.set(node.id, { node, i, block: null });
      return;
    }

    if (node.workflow !== undefined) {
      const pin = PIN_RE.exec(node.workflow ?? '');
      if (!pin) {
        err(`${p}/workflow`, `workflow pin must be "name@version", got ${JSON.stringify(node.workflow)}`, 'exact pins only');
        nodes.set(node.id, { node, i, block: null });
        return;
      }
      const [, childName, childVersion] = pin;
      if (stack.includes(childName)) {
        err(`${p}/workflow`, `workflow inclusion cycle: ${[...stack, childName].join(' -> ')}`, 'nesting is acyclic composition, not recursion (PROTOCOL [NST-3])');
        nodes.set(node.id, { node, i, block: null });
        return;
      }
      const childFile = join(root, 'workflows', `${childName}.workflow.json`);
      if (!existsSync(childFile)) {
        err(`${p}/workflow`, `no workflow "${childName}" at workflows/${childName}.workflow.json`);
        nodes.set(node.id, { node, i, block: null });
        return;
      }
      let child = cache.get(childName);
      if (!child) {
        const { workflow: childWf, errors: parseErr } = parseWorkflowFile(childFile);
        if (parseErr.length) {
          errors.push(...parseErr);
          nodes.set(node.id, { node, i, block: null });
          cache.set(childName, { invalid: true });
          return;
        }
        const sub = validateWorkflow(childWf, library, childFile, { root, stack: [...stack, workflow.name], cache });
        child = { workflow: childWf, errors: sub.errors, invalid: sub.errors.length > 0 };
        cache.set(childName, child);
        errors.push(...sub.errors);
      }
      if (child.invalid) {
        err(`${p}/workflow`, `embedded workflow "${childName}" is itself invalid — see its errors above`);
        nodes.set(node.id, { node, i, block: null });
        return;
      }
      if (String(child.workflow.version) !== childVersion) {
        err(`${p}/workflow`, `pin "${node.workflow}" does not match the file's version ${child.workflow.version}`, `workflows/${childName}.workflow.json declares version ${child.workflow.version}`);
      }
      // pseudo-block: the child's interface, shaped like a block for wire resolution
      const childInputs = Object.fromEntries(Object.entries(child.workflow.inputs ?? {})
        .map(([k, s]) => [k, s.default !== undefined ? { ...s, required: false } : s]));
      const childOutputs = Object.fromEntries(Object.entries(child.workflow.outputs ?? {})
        .map(([k, decl]) => { const { from, ...schema } = decl; return [k, schema]; }));
      nodes.set(node.id, {
        node, i,
        block: {
          name: childName, version: child.workflow.version, kind: 'workflow',
          inputs: childInputs, outputs: childOutputs,
          childGrants: child.workflow.grants ?? {},
        },
      });
      return;
    }

    const pin = PIN_RE.exec(node.block ?? '');
    if (!pin) {
      err(`${p}/block`, `block pin must be "name@version", got ${JSON.stringify(node.block)}`, 'exact pins only — no ranges (SPEC §3)');
      nodes.set(node.id, { node, i, block: null });
      return;
    }
    const block = library.get(node.block);
    if (block && Object.values(block.outputs ?? {}).some((schema) => schema.enumFromInput !== undefined)) usesDraft4 = true;
    if (!block) {
      const versions = [...library.keys()].filter((k) => k.startsWith(`${pin[1]}@`));
      err(`${p}/block`, `no block "${node.block}" in the library`, versions.length ? `library has: ${versions.join(', ')}` : `run \`blocks list\` to see available blocks`);
    }
    nodes.set(node.id, { node, i, block: block ?? null });
  });

  // --- pass 2: wires, gates, after ---
  const edges = new Map([...nodes.keys()].map((id) => [id, new Set()])); // id -> deps
  const nodeInputRefs = new Map([...nodes.keys()].map((id) => [id, []])); // id -> refs found under node.in
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
    const depPin = dep.node.block ?? dep.node.workflow;
    let schema = { type: 'object', properties: dep.block.outputs };
    for (const key of ref.path) {
      // A property-less object output (e.g. a generic extract block) can be
      // dug into, but the result is statically unknown — checked at run time.
      if (schema.type === 'object' && schema.properties === undefined) return { type: 'unknown' };
      const props = schema.properties ?? {};
      if (schema.type !== 'object' || !props[key]) {
        err(pointer, `node "${ref.node}" (${depPin}) declares no output "${ref.path.join('.')}"`, `declared outputs: ${Object.keys(dep.block.outputs).join(', ')}`);
        return null;
      }
      schema = props[key];
    }
    return schema;
  };

  for (const { node, i, block } of nodes.values()) {
    const p = `/nodes/${i}`;
    const bound = isObjectRecord(node.in) ? node.in : {};
    for (const name of Object.keys(bound)) {
      if (!FIELD_IDENT_RE.test(name)) err(`${p}/in/${pointerSegment(name)}`, `field identifier "${name}" must match ${FIELD_IDENT_RE}`);
    }
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
        // Literal JSON value: type-checked directly; bindings may still sit
        // inside its strings (deep-resolved at run time), so walk and wire them.
        if (target) {
          const t = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
          if (t !== target.type) err(bp, `literal value has type ${t}, input "${name}" wants ${target.type}`);
        }
        walkStrings(value, (s) => checkTemplate(s, bp, null));
        continue;
      }
      checkTemplate(value, bp, target);

      function checkTemplate(text, bp, target) {
        const { parts, whole } = parseTemplate(text);
        for (const part of parts) if (part.error) err(bp, part.error, 'wire syntax: {{inputs.<key>}} or {{nodes.<id>.output.<field>}} (SPEC §4)');
        const refs = parts.filter((x) => x.ref);
        for (const part of refs) nodeInputRefs.get(node.id)?.push({ ref: part.ref, pointer: bp, inputName: name });
        if (whole) {
          const src = refErrors(refs[0].ref, bp, target, { interpolated: false });
          if (src && target && src.type !== 'unknown' && src.type !== target.type) {
            err(bp, `type mismatch: {{${refs[0].raw}}} is ${src.type}, input "${name}" wants ${target.type}`, 'whole-value wires must match types exactly (SPEC §4)');
          }
          if (refs[0].ref.kind === 'node') edges.get(node.id)?.add(refs[0].ref.node);
        } else {
          if (refs.length > 0 && target && target.type !== 'string') {
            err(bp, `interpolation is only valid into string inputs; "${name}" wants ${target.type}`);
          }
          for (const part of refs) {
            const src = refErrors(part.ref, bp, target, { interpolated: true });
            if (src && !['string', 'number', 'boolean', 'unknown'].includes(src.type)) {
              err(bp, `cannot interpolate ${src.type} value {{${part.raw}}} into a string`);
            }
            if (part.ref.kind === 'node') edges.get(node.id)?.add(part.ref.node);
          }
        }
      }
    }
    if (node.when !== undefined) {
      try {
        const ast = parseWhen(node.when, { rejectMixed: declaredProtocol >= 4 });
        for (const clause of ast.clauses) {
          const src = refErrors(clause.ref, `${p}/when`, null, { interpolated: false });
          if (clause.length || clause.op === 'contains') usesDraft3Gates = true;
          if (clause.length) {
            // [GAT-10]: # applies to string/array refs and yields a number
            if (src && !['string', 'array', 'unknown'].includes(src.type)) {
              err(`${p}/when`, `"#" needs a string or array ref; ${refText(clause.ref)} is ${src.type}`);
            }
          } else if (clause.op === 'contains') {
            if (src && !['string', 'array', 'unknown'].includes(src.type)) {
              err(`${p}/when`, `"contains" needs a string or array left operand; ${refText(clause.ref)} is ${src.type}`);
            }
            if (src?.type === 'string' && typeof clause.literal !== 'string') {
              err(`${p}/when`, `substring "contains" needs a string literal; got ${JSON.stringify(clause.literal)}`);
            }
          } else if (clause.ordering && src && src.type !== 'number' && src.type !== 'unknown') {
            err(`${p}/when`, `ordering comparison needs a number ref; ${refText(clause.ref)} is ${src.type}`);
          }
          if (clause.ref.kind === 'node') edges.get(node.id)?.add(clause.ref.node);
        }
      } catch (e) {
        err(`${p}/when`, `gate does not parse: ${e.message}`, "grammar: [#]ref op literal [and|or ...] — e.g. nodes.judge.output.score >= 0.7 (SPEC §5)");
      }
    }
    const after = Array.isArray(node.after) ? node.after : [];
    for (const [j, dep] of after.entries()) {
      if (typeof dep !== 'string' || !ID_RE.test(dep)) err(`${p}/after/${j}`, `"after" entries must be node ids matching ${ID_RE}, got ${JSON.stringify(dep)}`);
      else if (!nodes.has(dep)) err(`${p}/after/${j}`, `"after" references unknown node "${dep}"`);
      else edges.get(node.id)?.add(dep);
    }
  }

  if (usesDraft3Gates && declaredProtocol < 3) {
    err('/protocol', 'workflow uses Draft 3 gate constructs (contains or #) but does not declare "protocol": 3', 'add "protocol": 3 (PROTOCOL [VER-5])');
  }
  if (usesDraft4 && declaredProtocol < 4) {
    err('/protocol', 'workflow uses a Draft 4 construct (enumFromInput) but does not declare "protocol": 4', 'add "protocol": 4 (PROTOCOL [VER-5])');
  }

  // --- pass 2.5: workflow output declarations (PROTOCOL §9.1) ---
  for (const [name, decl] of Object.entries(workflowOutputs)) {
    const p = `/outputs/${pointerSegment(name)}`;
    if (!FIELD_IDENT_RE.test(name)) err(p, `field identifier "${name}" must match ${FIELD_IDENT_RE}`);
    if (decl === null || typeof decl !== 'object' || Array.isArray(decl)) {
      err(p, 'an output declaration must be an object', '{"from": "{{nodes.x.output.y}}", "type": "string"}');
      continue;
    }
    for (const k of Object.keys(decl)) {
      if (!OUTPUT_DECL_KEYS.includes(k)) {
        err(`${p}/${k}`, `unknown output-declaration key "${k}"`, `allowed: ${OUTPUT_DECL_KEYS.join(', ')} — "default" and "secret" are input-only`);
      }
    }
    if (decl.from === undefined) { err(`${p}/from`, 'output declaration needs "from" (a wire)', 'PROTOCOL [OUT-1]'); continue; }
    const { from, ...schema } = decl;
    const defErrors = [];
    checkSchemaDef(schema, p, defErrors, { allowDefault: false, allowSecret: false });
    errors.push(...defErrors.map((e) => ({ file, ...e })));
    // the declaration is the wire's target: same rules as a node input
    const checkOutWire = (text, target) => {
      const { parts, whole } = parseTemplate(text);
      for (const part of parts) if (part.error) err(`${p}/from`, part.error);
      const refs = parts.filter((x) => x.ref);
      if (whole) {
        const srcT = refErrors(refs[0].ref, `${p}/from`, target, { interpolated: false });
        if (srcT && target?.type && srcT.type !== 'unknown' && srcT.type !== target.type) {
          err(`${p}/from`, `type mismatch: {{${refs[0].raw}}} is ${srcT.type}, output "${name}" declares ${target.type}`);
        }
      } else {
        if (refs.length > 0 && target?.type && target.type !== 'string') {
          err(`${p}/from`, `interpolation is only valid into string outputs; "${name}" declares ${target.type}`);
        }
        for (const part of refs) {
          const srcT = refErrors(part.ref, `${p}/from`, target, { interpolated: true });
          if (srcT && !['string', 'number', 'boolean', 'unknown'].includes(srcT.type)) {
            err(`${p}/from`, `cannot interpolate ${srcT.type} value {{${part.raw}}} into a string`);
          }
        }
      }
    };
    if (typeof from === 'string') checkOutWire(from, schema);
    else walkStrings(from, (s) => checkOutWire(s, null));
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

  // --- pass 3.5: conservative secret-taint validation for fuzzy/embedded nodes ---
  // Fuzzy node inputs are printed and persisted as oracle prompts. Treat every
  // secret workflow input as tainted; any node consuming tainted data taints all
  // of its outputs, so transitive deterministic derivations are rejected too.
  if (order.length === nodes.size) {
    const secretInputs = new Set(Object.entries(wfInputs)
      .filter(([, schema]) => schema?.secret === true)
      .map(([name]) => name));
    const taintedNodes = new Set();
    const taintMessage = 'secret-derived data cannot be wired into fuzzy nodes';
    const isTaintedRef = (ref) => ref.kind === 'input'
      ? secretInputs.has(ref.key)
      : taintedNodes.has(ref.node);

    for (const id of order) {
      const entry = nodes.get(id);
      if (!entry?.block) continue;
      const taintedRefs = (nodeInputRefs.get(id) ?? []).filter(({ ref }) => isTaintedRef(ref));
      if (taintedRefs.length === 0) continue;

      const seen = new Set();
      if (entry.block.kind === 'fuzzy') {
        for (const { pointer } of taintedRefs) {
          if (seen.has(pointer)) continue;
          seen.add(pointer);
          err(pointer, taintMessage, 'route secrets only through deterministic nodes; fuzzy inputs are persisted and shown to the oracle');
        }
      } else if (entry.block.kind === 'workflow') {
        for (const { pointer, inputName } of taintedRefs) {
          if (seen.has(pointer)) continue;
          seen.add(pointer);
          const childInput = entry.block.inputs?.[inputName];
          if (childInput && childInput.secret !== true) {
            err(pointer, 'secret-derived data cannot be wired into a non-secret child workflow input', 'mark the child workflow input secret, or keep this value out of the embedded workflow');
          }
        }
      }

      taintedNodes.add(id);
    }
  }

  // --- pass 4: grants model (SPEC §7) ---
  const grantList = (key) => Array.isArray(grants[key]) ? grants[key] : [];
  for (const key of ['run', 'read', 'write']) {
    if (grants[key] !== undefined && !Array.isArray(grants[key])) {
      err(`/grants/${key}`, `"grants.${key}" must be an array`, 'use [] for none');
    }
    for (const [j, value] of grantList(key).entries()) {
      if (typeof value !== 'string' || value === '') err(`/grants/${key}/${j}`, `"grants.${key}" entries must be non-empty strings`);
    }
  }
  for (const key of ['read', 'write']) {
    for (const [j, glob] of grantList(key).entries()) {
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
    // an embedded workflow's grants count as declarations at the parent (PROTOCOL [NST-6])
    if (block?.childGrants) {
      for (const key of ['run', 'read', 'write']) {
        for (const v of block.childGrants[key] ?? []) declared[key].add(v);
      }
    }
  }
  for (const key of ['run', 'read', 'write']) {
    for (const [j, v] of grantList(key).entries()) {
      const covered = key === 'run'
        ? declared.run.has(v)
        : [...declared[key]].some((blockGlob) => coveredBy(v, blockGlob));
      if (!covered) {
        err(`/grants/${key}/${j}`, `grant "${v}" is not declared by any block in this workflow`, 'grants can only co-sign what blocks declare — remove it or use a block that needs it (SPEC §7)');
      }
    }
  }
  // parent must cover every grant of an embedded workflow (PROTOCOL [NST-6]):
  // effective capability of every leaf node is unchanged by embedding.
  for (const { node, i, block } of nodes.values()) {
    if (block?.kind !== 'workflow') continue;
    for (const bin of block.childGrants.run ?? []) {
      if (!grantList('run').includes(bin)) {
        err('/grants/run', `embedded workflow "${node.workflow}" (node "${node.id}") grants "${bin}" but this workflow does not`, `add "${bin}" to grants.run — parents co-sign everything a child may touch`);
      }
    }
    for (const key of ['read', 'write']) {
      for (const g of block.childGrants[key] ?? []) {
        if (!grantList(key).some((p) => coveredBy(g, p))) {
          err(`/grants/${key}`, `embedded workflow "${node.workflow}" (node "${node.id}") grants "${g}" but no parent grant covers it`, `add a covering glob to grants.${key}`);
        }
      }
    }
  }

  for (const { node, i, block } of nodes.values()) {
    if (block?.kind !== 'deterministic') continue;
    if (block.exec?.argv) {
      const bin = block.exec.argv[0];
      if (!grantList('run').includes(bin)) {
        err(`/grants/run`, `node "${node.id}" (${node.block}) needs to run "${bin}" but the workflow does not grant it`, `add "${bin}" to grants.run`);
      }
    }
    for (const key of ['read', 'write']) {
      for (const glob of block.permissions?.[key] ?? []) {
        if ((block.permissions[key] ?? []).length > 0 && grantList(key).length === 0 && key === 'write') {
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
