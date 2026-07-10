// new: scaffold a block directory that already passes `blocks list`,
// or an Ed25519 signing key pair (public → keys/, private gitignored).

import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export async function newVerb(args, { root, flag, usage }) {
  if (args[0] === 'key') return newKey(args, { root, flag, usage });
  const kind = flag('--kind');
  const claimsRaw = flag('--claims');
  const capability = flag('--capability');
  const [what, name] = args;
  if (what !== 'block' || !name) usage('usage: blocks new block <name> --kind <deterministic|fuzzy> | blocks new key <id> --claims <a,b>');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) usage(`block name must be kebab-case, got "${name}"`);
  const k = kind === 'det' ? 'deterministic' : kind;
  if (k !== 'deterministic' && k !== 'fuzzy') usage('--kind must be deterministic (det) or fuzzy');
  const dir = join(root, 'blocks', name);
  if (existsSync(dir)) usage(`blocks/${name} already exists`);
  mkdirSync(dir, { recursive: true });

  const fuzzy = k === 'fuzzy';
  if (!fuzzy && (claimsRaw || capability)) usage('--claims and --capability apply only to fuzzy blocks');
  const claims = claimsRaw?.split(',').map((value) => value.trim()).filter(Boolean);
  if (claimsRaw && (!claims.length || !claims.every((claim) => /^[a-z][a-z0-9-]*$/.test(claim)))) usage('--claims must be comma-separated kebab-case names');
  if (capability && !/^[a-z][a-z0-9-]*$/.test(capability)) usage('--capability must be a kebab-case name');
  const oracle = fuzzy && (claims || capability) ? { ...(claims ? { claims } : {}), ...(capability ? { capability } : {}) } : undefined;
  const contract = fuzzy
    ? {
        name, version: 1, kind: 'fuzzy',
        inputs: { text: { type: 'string', description: 'what the oracle is asked about' } },
        outputs: { answer: { type: 'string', description: 'replace with your real contract' } },
        ...(oracle ? { oracle } : {}),
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

function nearestExistingParent(path) {
  let current = path;
  while (!existsSync(current)) {
    const next = dirname(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function isInside(root, path) {
  const rel = relative(root, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

function newKey(args, { root, flag, usage }) {
  const claimsRaw = flag('--claims');
  const privateOut = flag('--private-out');
  const keyId = args[1];
  if (!keyId || !claimsRaw) usage('usage: blocks new key <id> --claims <a,b> [--private-out <outside-workspace-file>]');
  if (!/^[a-z][a-z0-9-]*$/.test(keyId)) usage(`key id must be kebab-case, got "${keyId}"`);
  const claims = claimsRaw.split(',').map((value) => value.trim()).filter(Boolean);
  if (claims.length === 0 || !claims.every((claim) => /^[a-z][a-z0-9-]*$/.test(claim))) {
    usage('claims must be a comma-separated list of kebab-case names');
  }
  const pubFile = join(root, 'keys', `${keyId}.json`);
  const keyHome = process.env.BLOCKS_KEY_HOME ?? join(homedir(), '.blocks', 'keys');
  const privFile = resolve(privateOut ?? join(keyHome, `${keyId}.private.json`));
  if (existsSync(pubFile)) usage(`keys/${keyId}.json already exists`);
  if (existsSync(privFile)) usage(`private key output already exists: ${privFile}`);

  const realRoot = realpathSync(root);
  const lexicalRoot = resolve(root);
  const lexicalInside = isInside(lexicalRoot, privFile);
  const realParent = realpathSync(nearestExistingParent(privFile));
  if (lexicalInside || isInside(realRoot, realParent)) {
    usage('private key output must be outside the workspace; use --private-out or BLOCKS_KEY_HOME');
  }

  mkdirSync(join(root, 'keys'), { recursive: true });
  mkdirSync(dirname(privFile), { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(pubFile, JSON.stringify({
    keyId, publicJwk: publicKey.export({ format: 'jwk' }), claims,
  }, null, 2) + '\n');
  writeFileSync(privFile, JSON.stringify({
    keyId, privateJwk: privateKey.export({ format: 'jwk' }),
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

  console.log(`✓ registered keys/${keyId}.json (claims: ${claims.join(', ')})`);
  console.log(`  private key: ${privFile} (mode 600, outside workspace)`);
  console.log(`  prefer detached approval: blocks approval ... --raw | <external Ed25519 signer>`);
}
