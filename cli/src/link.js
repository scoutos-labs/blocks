// link: install a block into .claude/skills/ as a symlink, so "shaped like a
// skill" stays literal — the same directory serves both runtimes.

import { existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { loadBlock, SKILL_KEYS, parseFrontmatter } from './loader.js';
import { readFileSync } from 'node:fs';
import { formatErrors } from './validate.js';

export async function linkVerb(args, { root, boolFlag, usage }) {
  const checkOnly = boolFlag('--check');
  const name = args[0] ?? usage('link needs a block name');
  const dir = join(root, 'blocks', name);
  if (!existsSync(dir)) {
    console.error(`error: no block "${name}" in ${relative(process.cwd(), join(root, 'blocks')) || 'blocks/'}`);
    process.exit(2);
  }
  const { block, errors } = loadBlock(dir);
  if (!block) {
    console.error(formatErrors(errors));
    process.exit(1);
  }
  const fm = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '', []);
  const extra = Object.keys(fm).filter((k) => !SKILL_KEYS.has(k));
  if (extra.length) {
    console.error(`✗ ${name}/SKILL.md frontmatter has non-skill keys: ${extra.join(', ')} — move them into contract.json`);
    process.exit(1);
  }
  if (checkOnly) {
    console.log(`✓ ${name} is skill-compatible (frontmatter keys: ${Object.keys(fm).join(', ')})`);
    return;
  }
  const skillsDir = join(root, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const target = join(skillsDir, name);
  if (existsSync(target) || safeIsLink(target)) {
    const current = safeIsLink(target) ? readlinkSync(target) : '(a real directory)';
    console.error(`error: ${relative(root, target)} already exists → ${current}`);
    process.exit(2);
  }
  symlinkSync(resolve(dir), target);
  console.log(`✓ linked ${relative(root, target)} → blocks/${name} — the block now loads as a live skill`);
}

function safeIsLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
