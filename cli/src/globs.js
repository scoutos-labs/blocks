// Path-grant cover semantics (SPEC §7): the effective set is every granted
// glob that the block's own declaration covers — never string equality.

export function coveredBy(grant, blockGlob) {
  if (blockGlob === '**') return true;
  if (blockGlob === grant) return true;
  if (blockGlob.endsWith('/**')) return grant.startsWith(blockGlob.slice(0, -2));
  return false;
}

export function effectiveGlobs(blockGlobs, grantGlobs) {
  return (grantGlobs ?? []).filter((g) => (blockGlobs ?? []).some((b) => coveredBy(g, b)));
}
