// new: scaffold a block directory that already passes `blocks list`.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function newVerb(args, { root, flag, usage }) {
  const kind = flag('--kind');
  const [what, name] = args;
  if (what !== 'block' || !name) usage('usage: blocks new block <name> --kind <deterministic|fuzzy>');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) usage(`block name must be kebab-case, got "${name}"`);
  const k = kind === 'det' ? 'deterministic' : kind;
  if (k !== 'deterministic' && k !== 'fuzzy') usage('--kind must be deterministic (det) or fuzzy');
  const dir = join(root, 'blocks', name);
  if (existsSync(dir)) usage(`blocks/${name} already exists`);
  mkdirSync(dir, { recursive: true });

  const fuzzy = k === 'fuzzy';
  const contract = fuzzy
    ? {
        name, version: 1, kind: 'fuzzy',
        inputs: { text: { type: 'string', description: 'what the oracle is asked about' } },
        outputs: { answer: { type: 'string', description: 'replace with your real contract' } },
      }
    : {
        name, version: 1, kind: 'deterministic',
        inputs: { text: { type: 'string' } },
        outputs: { text: { type: 'string' } },
        exec: { argv: ['printf', '%s', '{{inputs.text}}'], capture: 'text' },
        permissions: { run: ['printf'], read: [], write: [], network: false },
      };
  writeFileSync(join(dir, 'contract.json'), JSON.stringify(contract, null, 2) + '\n');

  const body = fuzzy
    ? `# ${name}

Fuzzy block — this body is the prompt contract the agent follows.

## Role
Describe the judgment this block performs, in one tight paragraph.

## Rubric
Spell out what good looks like, what disqualifies, and how to score.

## Output
Return exactly one JSON object matching contract.json:

\`\`\`json
{"answer": "..."}
\`\`\`

## Worked example
Input: ...
Valid output: \`{"answer": "..."}\`
`
    : `# ${name}

Deterministic block — the CLI executes contract.json's \`exec\` exactly; this
body documents the procedure for humans and agents.

## Procedure
What runs, byte for byte, and what the output means.

## Inputs / Outputs
See contract.json — keep this prose in lockstep with it.
`;
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${fuzzy ? 'Fuzzy' : 'Deterministic'} block. TODO — one line the composer can pick it by.\n---\n\n${body}`,
  );
  console.log(`✓ scaffolded blocks/${name} (${k}) — edit SKILL.md and contract.json, then \`blocks list\` to confirm it loads`);
}
