// Key registry (PROTOCOL §12.4): keys/<keyId>.json — public keys with
// self-asserted claims. Trust root is workspace review + git history, not
// the protocol. The registry mechanically refuses to hold private material.

import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const KEY_ID_RE = /^[a-z][a-z0-9-]*$/;
const CLAIM_RE = /^[a-z][a-z0-9-]*$/;

export function loadRegistryKey(root, keyId) {
  const file = join(root, 'keys', `${keyId}.json`);
  const errors = [];
  if (!existsSync(file)) {
    return { errors: [{ file, pointer: '', message: `no registered key "${keyId}"`, hint: `expected keys/${keyId}.json — register the public key first` }] };
  }
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    return { errors: [{ file, pointer: '', message: `not valid JSON: ${e.message}` }] };
  }
  for (const k of Object.keys(doc)) {
    if (!['keyId', 'publicJwk', 'claims'].includes(k)) {
      errors.push({ file, pointer: `/${k}`, message: `unknown registry key "${k}"`, hint: 'allowed: keyId, publicJwk, claims' });
    }
  }
  if (doc.keyId !== basename(file, '.json') || !KEY_ID_RE.test(doc.keyId ?? '')) {
    errors.push({ file, pointer: '/keyId', message: `"keyId" must match the filename and ${KEY_ID_RE}` });
  }
  const jwk = doc.publicJwk;
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    errors.push({ file, pointer: '/publicJwk', message: 'publicJwk must be an Ed25519 OKP JWK: {kty, crv, x}' });
  }
  if (jwk && (jwk.d !== undefined)) {
    errors.push({ file, pointer: '/publicJwk/d', message: 'registry keys must not contain private material ("d")', hint: 'the registry is public keys only — keep private keys out of keys/' });
  }
  for (const k of Object.keys(jwk ?? {})) {
    if (!['kty', 'crv', 'x'].includes(k)) {
      errors.push({ file, pointer: `/publicJwk/${k}`, message: `unknown publicJwk member "${k}"`, hint: 'registry JWKs are closed: kty, crv, x only' });
    }
  }
  if (!Array.isArray(doc.claims) || doc.claims.length === 0 || !doc.claims.every((c) => typeof c === 'string' && CLAIM_RE.test(c))) {
    errors.push({ file, pointer: '/claims', message: `"claims" must be a non-empty array of names matching ${CLAIM_RE}` });
  }
  if (errors.length) return { errors };
  return { key: doc, errors: [] };
}

export function loadPrivateKeyFile(path) {
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    return { errors: [{ file: path, pointer: '', message: `cannot read private key file: ${e.message}` }] };
  }
  if (!KEY_ID_RE.test(doc.keyId ?? '') || !doc.privateJwk || doc.privateJwk.crv !== 'Ed25519') {
    return { errors: [{ file: path, pointer: '', message: 'private key file must be {keyId, privateJwk(Ed25519)}' }] };
  }
  return { key: doc, errors: [] };
}
