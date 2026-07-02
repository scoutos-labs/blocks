import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

const inputs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rel = relative(process.cwd(), resolve(process.cwd(), inputs.path));
if (isAbsolute(inputs.path) || rel.startsWith('..')) {
  process.stderr.write(`path escapes the workspace: ${inputs.path}\n`);
  process.exit(3);
}
const text = readFileSync(rel, 'utf8');
process.stdout.write(JSON.stringify({ text, bytes: Buffer.byteLength(text) }));
