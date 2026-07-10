import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

function coveredBy(path, glob) {
  if (glob === '**') return true;
  if (glob === path) return true;
  if (glob.endsWith('/**')) return path.startsWith(glob.slice(0, -2));
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

function inside(root, abs) {
  const rel = relative(root, abs);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

const inputs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = process.cwd();
const abs = resolve(root, inputs.path);
const rel = relative(root, abs);
if (isAbsolute(inputs.path) || rel.startsWith('..')) {
  process.stderr.write(`path escapes the workspace: ${inputs.path}\n`);
  process.exit(3);
}
const grants = JSON.parse(process.env.BLOCKS_EFFECTIVE_READ ?? '[]');
if (!grants.some((g) => coveredBy(rel, g))) {
  process.stderr.write(`path is not covered by effective read grants: ${inputs.path}\n`);
  process.exit(3);
}
if (!existsSync(abs)) {
  process.stderr.write(`path does not exist: ${inputs.path}\n`);
  process.exit(1);
}
let real;
try {
  real = realpathSync(abs);
} catch (e) {
  if (e?.code === 'ERR_ACCESS_DENIED') {
    process.stderr.write(`path escapes the workspace or effective read grants: ${inputs.path}\n`);
    process.exit(3);
  }
  throw e;
}
if (!inside(root, real)) {
  process.stderr.write(`path escapes the workspace through a symlink: ${inputs.path}\n`);
  process.exit(3);
}
let text;
try {
  text = readFileSync(real, 'utf8');
} catch (e) {
  if (e?.code === 'ERR_ACCESS_DENIED') {
    process.stderr.write(`path escapes the workspace or effective read grants: ${inputs.path}\n`);
    process.exit(3);
  }
  throw e;
}
process.stdout.write(JSON.stringify({ text, bytes: Buffer.byteLength(text) }));
