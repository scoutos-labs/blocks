// new: scaffold a block directory that already passes `blocks list`,
// or an Ed25519 signing key pair (public → keys/, private gitignored).

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';

export async function newVerb(args, { root, flag, usage }) {
  if (args[0] === 'key') return newKey(args, { root, flag, usage });
  const kind = flag('--kind');
  const [what, name] = args;
  if (what !== 'block' || !name) usage('usage: blocks new block <name> --kind <deterministic|fuzzy> | blocks new key <id> --claims <a,b>');
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

function newKey(args, { root, flag, usage }) {
  const claimsRaw = flag('--claims');
  const keyId = args[1];
  if (!keyId || !claimsRaw) usage('usage: blocks new key <id> --claims <a,b>');
  if (!/^[a-z][a-z0-9-]*$/.test(keyId)) usage(`key id must be kebab-case, got "${keyId}"`);
  const claims = claimsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (claims.length === 0 || !claims.every((c) => /^[a-z][a-z0-9-]*$/.test(c))) {
    usage('claims must be a comma-separated list of kebab-case names');
  }
  const pubFile = join(root, 'keys', `${keyId}.json`);
  const privFile = join(root, 'keys', `${keyId}.private.json`);
  if (existsSync(pubFile)) usage(`keys/${keyId}.json already exists`);
  mkdirSync(join(root, 'keys'), { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(pubFile, JSON.stringify({
    keyId, publicJwk: publicKey.export({ format: 'jwk' }), claims,
  }, null, 2) + '\n');
  writeFileSync(privFile, JSON.stringify({
    keyId, privateJwk: privateKey.export({ format: 'jwk' }),
  }, null, 2) + '\n', { mode: 0o600 });

  // the private key never belongs in history — make the ignore rule durable
  const gi = join(root, '.gitignore');
  const rule = 'keys/*.private.json';
  const existing = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!existing.split('\n').includes(rule)) appendFileSync(gi, `${rule}\n`);

  console.log(`✓ registered keys/${keyId}.json (claims: ${claims.join(', ')})`);
  console.log(`  private key: keys/${keyId}.private.json (mode 600, gitignored) — sign with: blocks record ... --sign keys/${keyId}.private.json`);
}
