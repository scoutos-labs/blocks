// ASCII render of a workflow DAG. Gates visibly branch; det/fuzzy visibly differ.

import { parseTemplate } from './bindings.js';

// Rebuild the dep edges the same way the validator does (wires + when + after).
export function collectDeps(node) {
  const deps = new Set();
  for (const value of Object.values(node.in ?? {})) {
    if (typeof value !== 'string') continue;
    for (const part of parseTemplate(value).parts) {
      if (part.ref?.kind === 'node') deps.add(part.ref.node);
    }
  }
  if (typeof node.when === 'string') {
    for (const m of node.when.matchAll(/nodes\.([a-z][a-z0-9-]*)\.output/g)) deps.add(m[1]);
  }
  for (const dep of node.after ?? []) deps.add(dep);
  return deps;
}

export function renderGraph(workflow, library, order) {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const lines = [];
  lines.push(`${workflow.name}  (v${workflow.version}, ${workflow.nodes.length} nodes)`);
  lines.push('');
  const width = Math.max(...order.map((id) => id.length));
  for (const [i, id] of order.entries()) {
    const node = byId.get(id);
    const block = library.get(node.block);
    const kind = block?.kind === 'fuzzy' ? '~fuzzy' : ' det  ';
    const deps = [...collectDeps(node)];
    const wires = deps.length ? `◀── ${deps.join(', ')}` : '(source)';
    const connector = i === 0 ? '┌─' : i === order.length - 1 ? '└─' : '├─';
    lines.push(`${connector} ● ${id.padEnd(width)}  ${node.block}  [${kind.trim()}]  ${wires}`);
    if (node.when) {
      const pad = i === order.length - 1 ? '   ' : '│  ';
      lines.push(`${pad}   ◇ when ${node.when}   (false → skip "${id}" and everything wired to it)`);
    }
  }
  return lines.join('\n');
}
