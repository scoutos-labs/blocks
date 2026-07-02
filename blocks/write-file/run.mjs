import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';

const inputs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rel = relative(process.cwd(), resolve(process.cwd(), inputs.path));
if (isAbsolute(inputs.path) || rel.startsWith('..')) {
  process.stderr.write(`path escapes the workspace: ${inputs.path}\n`);
  process.exit(3);
}
const parent = dirname(resolve(rel));
if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
writeFileSync(rel, inputs.content);
process.stdout.write(JSON.stringify({ path: rel, bytes: Buffer.byteLength(inputs.content) }));
