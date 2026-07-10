import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';

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

function nearestExistingParent(abs) {
  let cur = abs;
  while (!existsSync(cur)) {
    const next = dirname(cur);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

const inputs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = process.cwd();
const abs = resolve(root, inputs.path);
const rel = relative(root, abs);
if (isAbsolute(inputs.path) || rel.startsWith('..')) {
  process.stderr.write(`path escapes the workspace: ${inputs.path}\n`);
  process.exit(3);
}
const grants = JSON.parse(process.env.BLOCKS_EFFECTIVE_WRITE ?? '[]');
if (!grants.some((g) => coveredBy(rel, g))) {
  process.stderr.write(`path is not covered by effective write grants: ${inputs.path}\n`);
  process.exit(3);
}
const parent = dirname(abs);
if (process.permission?.has) {
  try {
    mkdirSync(parent, { recursive: true });
    writeFileSync(abs, inputs.content);
  } catch (e) {
    if (e?.code === 'ERR_ACCESS_DENIED') {
      process.stderr.write(`path escapes the workspace or effective write grants: ${inputs.path}\n`);
      process.exit(3);
    }
    throw e;
  }
} else {
  const existing = existsSync(abs) ? abs : nearestExistingParent(abs);
  const realExisting = realpathSync(existing);
  if (!inside(root, realExisting)) {
    process.stderr.write(`path escapes the workspace through a symlink: ${inputs.path}\n`);
    process.exit(3);
  }
  const realParentBase = realpathSync(nearestExistingParent(parent));
  if (!inside(root, realParentBase)) {
    process.stderr.write(`path escapes the workspace through a symlink: ${inputs.path}\n`);
    process.exit(3);
  }
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (existsSync(abs) && !inside(root, realpathSync(abs))) {
    process.stderr.write(`path escapes the workspace through a symlink: ${inputs.path}\n`);
    process.exit(3);
  }
  writeFileSync(abs, inputs.content);
}
process.stdout.write(JSON.stringify({ path: rel, bytes: Buffer.byteLength(inputs.content) }));
