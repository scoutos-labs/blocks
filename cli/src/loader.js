// Block library loader: shared by every verb, so a block that loads for
// `blocks list` loads identically for validate/exec/link.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { checkSchemaDef } from './schema.js';
import { parseTemplate } from './bindings.js';

// Documented Claude Code skill frontmatter keys. Blocks may use ONLY these
// (SPEC §2.1) — skill compatibility must never rest on tolerance of extras.
export const SKILL_KEYS = new Set(['name', 'description']);

// Flat `key: value` frontmatter — deliberately not a YAML parser (SPEC §2.1).
export function parseFrontmatter(text, file, errors) {
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text);
  if (!m) {
    errors.push({ file, pointer: '', message: 'SKILL.md must start with `---` frontmatter', hint: 'first line must be ---' });
    return {};
  }
  const fm = {};
  for (const line of m[1].split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1 || /^\s/.test(line)) {
      errors.push({ file, pointer: '', message: `frontmatter must be flat "key: value" lines, got ${JSON.stringify(line)}`, hint: 'no nesting, no lists' });
      continue;
    }
    fm[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return fm;
}

function checkFields(fields, pointer, errors, file) {
  if (fields === undefined) return;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    errors.push({ file, pointer, message: 'must be an object mapping field names to schemas' });
    return;
  }
  for (const [name, schema] of Object.entries(fields)) {
    const errs = [];
    checkSchemaDef(schema, `${pointer}/${name}`, errs);
    errors.push(...errs.map((e) => ({ file, ...e })));
  }
}

const PATH_GLOB_RE = /^(?!\/)(?!.*\.\.)[^\0]*$/; // relative, no `..` segments

function checkPermissions(perms, file, errors) {
  if (perms === null || typeof perms !== 'object' || Array.isArray(perms)) {
    errors.push({ file, pointer: '/permissions', message: 'deterministic blocks must declare a "permissions" object', hint: '{"run": [], "read": [], "write": [], "network": false}' });
    return;
  }
  for (const key of ['run', 'read', 'write']) {
    const list = perms[key];
    if (!Array.isArray(list)) {
      errors.push({ file, pointer: `/permissions/${key}`, message: `"${key}" must be an array`, hint: 'use [] for none' });
      continue;
    }
    if (key !== 'run') {
      for (const [i, glob] of list.entries()) {
        if (typeof glob !== 'string' || !PATH_GLOB_RE.test(glob)) {
          errors.push({ file, pointer: `/permissions/${key}/${i}`, message: `path glob ${JSON.stringify(glob)} is invalid`, hint: 'workspace-relative, no absolute paths, no ".."' });
        }
      }
    }
  }
  if (perms.network !== undefined && typeof perms.network !== 'boolean') {
    errors.push({ file, pointer: '/permissions/network', message: '"network" must be a boolean' });
  }
}

export function loadBlock(dir) {
  const errors = [];
  const dirName = basename(dir);
  const skillFile = join(dir, 'SKILL.md');
  const contractFile = join(dir, 'contract.json');
  if (!existsSync(skillFile)) errors.push({ file: skillFile, pointer: '', message: 'missing SKILL.md' });
  if (!existsSync(contractFile)) errors.push({ file: contractFile, pointer: '', message: 'missing contract.json' });
  if (errors.length) return { errors };

  const skillText = readFileSync(skillFile, 'utf8');
  const fm = parseFrontmatter(skillText, skillFile, errors);
  for (const key of Object.keys(fm)) {
    if (!SKILL_KEYS.has(key)) {
      errors.push({ file: skillFile, pointer: '', message: `frontmatter key "${key}" is not a documented skill key`, hint: `allowed: ${[...SKILL_KEYS].join(', ')} — structured data belongs in contract.json` });
    }
  }

  let contract;
  try {
    contract = JSON.parse(readFileSync(contractFile, 'utf8'));
  } catch (e) {
    errors.push({ file: contractFile, pointer: '', message: `contract.json is not valid JSON: ${e.message}` });
    return { errors };
  }

  const cf = contractFile;
  // contracts are closed documents: unknown keys are invalid (PROTOCOL [BLK-5], [BLK-12])
  const CONTRACT_KEYS = ['name', 'version', 'kind', 'inputs', 'outputs', 'exec', 'permissions', 'oracle'];
  for (const key of Object.keys(contract)) {
    if (!CONTRACT_KEYS.includes(key)) {
      errors.push({ file: cf, pointer: `/${key}`, message: `unknown contract key "${key}"`, hint: `allowed: ${CONTRACT_KEYS.join(', ')}` });
    }
  }
  if (contract.exec && typeof contract.exec === 'object' && !Array.isArray(contract.exec)) {
    for (const key of Object.keys(contract.exec)) {
      if (!['argv', 'capture', 'entry'].includes(key)) {
        errors.push({ file: cf, pointer: `/exec/${key}`, message: `unknown exec key "${key}"`, hint: 'allowed: argv, capture, entry' });
      }
    }
    if (contract.exec.entry !== undefined && contract.exec.capture !== undefined) {
      errors.push({ file: cf, pointer: '/exec/capture', message: '"capture" applies only to the argv variant', hint: 'entry scripts always print a JSON object' });
    }
  }
  if (contract.permissions && typeof contract.permissions === 'object' && !Array.isArray(contract.permissions)) {
    for (const key of Object.keys(contract.permissions)) {
      if (!['run', 'read', 'write', 'network'].includes(key)) {
        errors.push({ file: cf, pointer: `/permissions/${key}`, message: `unknown permissions key "${key}"`, hint: 'allowed: run, read, write, network' });
      }
    }
  }
  if (contract.name !== dirName) {
    errors.push({ file: cf, pointer: '/name', message: `contract name ${JSON.stringify(contract.name)} must equal directory name "${dirName}"` });
  }
  if (fm.name !== undefined && fm.name !== dirName) {
    errors.push({ file: skillFile, pointer: '', message: `frontmatter name "${fm.name}" must equal directory name "${dirName}"` });
  }
  if (!Number.isInteger(contract.version) || contract.version < 1) {
    errors.push({ file: cf, pointer: '/version', message: `"version" must be a positive integer, got ${JSON.stringify(contract.version)}` });
  }
  if (contract.kind !== 'deterministic' && contract.kind !== 'fuzzy') {
    errors.push({ file: cf, pointer: '/kind', message: `"kind" must be "deterministic" or "fuzzy", got ${JSON.stringify(contract.kind)}` });
  }
  checkFields(contract.inputs ?? {}, '/inputs', errors, cf);
  checkFields(contract.outputs ?? {}, '/outputs', errors, cf);

  if (contract.kind === 'deterministic') {
    const exec = contract.exec;
    const hasArgv = Array.isArray(exec?.argv);
    const hasEntry = typeof exec?.entry === 'string';
    if (!exec || hasArgv === hasEntry) {
      errors.push({ file: cf, pointer: '/exec', message: 'deterministic blocks need "exec" with exactly one of "argv" or "entry"', hint: '{"argv": [...], "capture": "text"|"json"} or {"entry": "run.mjs"}' });
    }
    if (hasArgv) {
      const capture = exec.capture ?? 'json';
      if (capture !== 'text' && capture !== 'json') {
        errors.push({ file: cf, pointer: '/exec/capture', message: `"capture" must be "text" or "json", got ${JSON.stringify(exec.capture)}` });
      }
      if (capture === 'text') {
        const outs = Object.keys(contract.outputs ?? {});
        if (outs.length !== 1 || outs[0] !== 'text' || contract.outputs.text.type !== 'string') {
          errors.push({ file: cf, pointer: '/outputs', message: 'capture "text" requires outputs to be exactly {"text": {"type": "string"}}' });
        }
      }
      exec.argv.forEach((arg, i) => {
        if (typeof arg !== 'string') {
          errors.push({ file: cf, pointer: `/exec/argv/${i}`, message: 'argv elements must be strings' });
          return;
        }
        const { parts, whole } = parseTemplate(arg);
        const refs = parts.filter((p) => p.ref);
        if (refs.length === 0) return;
        if (!whole) {
          errors.push({ file: cf, pointer: `/exec/argv/${i}`, message: `placeholder must occupy a whole argv element, got ${JSON.stringify(arg)}`, hint: 'split the argument so the binding stands alone (injection safety, SPEC §2.2)' });
        }
        for (const p of refs) {
          if (p.ref.kind !== 'input' || !(contract.inputs ?? {})[p.ref.key]) {
            errors.push({ file: cf, pointer: `/exec/argv/${i}`, message: `argv placeholder must reference a declared input, got "{{${p.raw}}}"`, hint: `declared inputs: ${Object.keys(contract.inputs ?? {}).join(', ') || '(none)'}` });
          }
        }
      });
      if (i0(exec.argv)) {
        errors.push({ file: cf, pointer: '/exec/argv/0', message: 'argv[0] (the binary) must be a literal, not a placeholder' });
      }
    }
    if (hasEntry) {
      if (!existsSync(join(dir, exec.entry))) {
        errors.push({ file: cf, pointer: '/exec/entry', message: `entry script "${exec.entry}" not found in block directory` });
      }
    }
    checkPermissions(contract.permissions, cf, errors);
    if (hasArgv && Array.isArray(contract.permissions?.run) && typeof exec.argv[0] === 'string' && !contract.permissions.run.includes(exec.argv[0])) {
      errors.push({ file: cf, pointer: '/permissions/run', message: `argv binary "${exec.argv[0]}" is not in the block's own run allowlist`, hint: `add "${exec.argv[0]}" to permissions.run` });
    }
  } else if (contract.kind === 'fuzzy') {
    if (contract.exec !== undefined) {
      errors.push({ file: cf, pointer: '/exec', message: 'fuzzy blocks must not declare "exec" — the agent is the oracle (SPEC §2.2)' });
    }
    if (contract.permissions !== undefined) {
      errors.push({ file: cf, pointer: '/permissions', message: 'fuzzy blocks must not declare "permissions"' });
    }
    if (!contract.outputs || Object.keys(contract.outputs).length === 0) {
      errors.push({ file: cf, pointer: '/outputs', message: 'fuzzy blocks must declare at least one output field', hint: 'the outputs schema is the prompt contract' });
    }
    if (contract.oracle !== undefined) {
      const o = contract.oracle;
      if (o === null || typeof o !== 'object' || Array.isArray(o)) {
        errors.push({ file: cf, pointer: '/oracle', message: '"oracle" must be an object', hint: '{"claims": ["release-approver"], "capability": "reasoning-v1"}' });
      } else {
        for (const k of Object.keys(o)) {
          if (k !== 'claims' && k !== 'capability') errors.push({ file: cf, pointer: `/oracle/${k}`, message: `unknown oracle key "${k}"`, hint: 'allowed: claims, capability' });
        }
        if (o.claims === undefined && o.capability === undefined) {
          errors.push({ file: cf, pointer: '/oracle', message: '"oracle" must declare at least one of "claims" or "capability"' });
        }
        if (o.claims !== undefined && (!Array.isArray(o.claims) || o.claims.length === 0 || !o.claims.every((c) => typeof c === 'string' && /^[a-z][a-z0-9-]*$/.test(c)))) {
          errors.push({ file: cf, pointer: '/oracle/claims', message: '"claims" must be a non-empty array of claim names ([a-z][a-z0-9-]*)' });
        }
        if (o.capability !== undefined && (typeof o.capability !== 'string' || !/^[a-z][a-z0-9-]*$/.test(o.capability))) {
          errors.push({ file: cf, pointer: '/oracle/capability', message: '"capability" must be a name matching [a-z][a-z0-9-]*', hint: 'e.g. "reasoning-v1"' });
        }
      }
    }
  }
  if (contract.kind === 'deterministic' && contract.oracle !== undefined) {
    errors.push({ file: cf, pointer: '/oracle', message: '"oracle" applies only to fuzzy blocks', hint: 'deterministic blocks have no oracle to make demands of' });
  }

  if (errors.length) return { errors };
  return {
    block: {
      name: contract.name,
      version: contract.version,
      kind: contract.kind,
      inputs: contract.inputs ?? {},
      outputs: contract.outputs ?? {},
      exec: contract.exec,
      permissions: contract.permissions,
      oracle: contract.oracle,
      dir,
      description: fm.description ?? '',
    },
    errors: [],
  };

  function i0(argv) {
    return typeof argv[0] === 'string' && argv[0].includes('{{');
  }
}

// Load every block under <root>/blocks. Returns { library: Map, errors }.
export function loadLibrary(root, { blocksDir = 'blocks' } = {}) {
  const base = join(root, blocksDir);
  const library = new Map();
  const errors = [];
  if (!existsSync(base)) return { library, errors };
  for (const entry of readdirSync(base).sort()) {
    const dir = join(base, entry);
    if (!statSync(dir).isDirectory()) continue;
    const { block, errors: blockErrors } = loadBlock(dir);
    errors.push(...blockErrors);
    if (block) library.set(`${block.name}@${block.version}`, block);
  }
  return { library, errors };
}
