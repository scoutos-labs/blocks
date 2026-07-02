---
name: render-template
description: Deterministic block. Fill {key} slots in a template string from a values object. Slots use single braces; workflow wires use double.
---

# render-template

Pure transform: `{key}` slots (single braces — deliberately distinct from the
`{{...}}` wire syntax) are replaced from `values`. A slot with no value or a
non-scalar value fails loudly rather than rendering garbage.

## Inputs
- `template` (string) — e.g. `# {title}\n\nseverity: {label}`.
- `values` (object) — wire upstream outputs into its members:
  `"values": {"title": "{{nodes.facts.output.data.title}}", "label": "{{nodes.severity.output.label}}"}`.

## Outputs
- `text` (string) — the rendered result.
