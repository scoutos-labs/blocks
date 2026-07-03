// ASCII render of a workflow DAG. Gates visibly branch; det/fuzzy visibly differ.

import { parseTemplate, walkStrings } from './bindings.js';

// Rebuild the dep edges the same way the validator does (wires + when + after).
export function collectDeps(node) {
  const deps = new Set();
  for (const value of Object.values(node.in ?? {})) {
    walkStrings(value, (s) => {
      for (const part of parseTemplate(s).parts) {
        if (part.ref?.kind === 'node') deps.add(part.ref.node);
      }
    });
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
    const block = node.block ? library.get(node.block) : null;
    const kind = node.workflow ? 'wf' : block?.kind === 'fuzzy' ? '~fuzzy' : 'det';
    const pin = node.block ?? node.workflow;
    const deps = [...collectDeps(node)];
    const wires = deps.length ? `◀── ${deps.join(', ')}` : '(source)';
    const connector = i === 0 ? '┌─' : i === order.length - 1 ? '└─' : '├─';
    lines.push(`${connector} ${node.workflow ? '◻' : '●'} ${id.padEnd(width)}  ${pin}  [${kind}]  ${wires}`);
    if (node.when) {
      const pad = i === order.length - 1 ? '   ' : '│  ';
      lines.push(`${pad}   ◇ when ${node.when}   (false → skip "${id}" and everything wired to it)`);
    }
  }
  return lines.join('\n');
}
