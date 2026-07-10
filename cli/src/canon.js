// RFC 8785 JSON Canonicalization Scheme (JCS).
// Object property names sort by UTF-16 code units, matching ECMAScript's
// default Array#sort. Number and string serialization use JSON.stringify,
// which supplies the ECMAScript forms required by JCS (including -0 -> 0).
// Inputs must already be JSON-domain values; unsupported values, non-finite
// numbers, sparse arrays, and lone UTF-16 surrogates are refused.

function assertUnicodeScalarString(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('canonical JSON cannot encode a lone high Unicode surrogate');
      }
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('canonical JSON cannot encode a lone low Unicode surrogate');
    }
  }
}

export function canon(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new TypeError('canonical JSON arrays must not be sparse');
      parts.push(canon(value[i]));
    }
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    for (const key of keys) assertUnicodeScalarString(key);
    keys.sort();
    return '{' + keys.map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',') + '}';
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}
