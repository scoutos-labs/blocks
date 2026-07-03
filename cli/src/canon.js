// JCS-lite canonical JSON (PROTOCOL §12.4): lexicographically sorted keys,
// no insignificant whitespace, ECMAScript number formatting. Digests over
// this form are recomputable from a run document alone — that post-hoc
// verifiability is the point of an approval trail.

export function canon(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + canon(value[k]))
    .join(',') + '}';
}
