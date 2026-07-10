// Byte-exact evidence preimages shared by record, audit, and conformance tests.

import { createHash } from 'node:crypto';
import { canon } from './canon.js';

// Detached signing changes custody, not the signed fields, so Draft 04 keeps
// the Draft-2 domain tag. RFC 8785 is byte-identical to the prior canonicalizer
// for valid committed approval inputs; vectors pin that claim.
export const APPROVAL_PREFIX = 'blocks-approval-v2';
export const SECRET_PREFIX = 'blocks-secret-v1';

export function sha256(...bufs) {
  const hash = createHash('sha256');
  for (const buf of bufs) hash.update(buf);
  return `sha256:${hash.digest('hex')}`;
}

export function jsonDigest(value) {
  return sha256(Buffer.from(canon(value), 'utf8'));
}

export function approvalPayload({ workflowHash, blockHash, runId, nodeId, input, answer }) {
  return [
    APPROVAL_PREFIX,
    workflowHash,
    blockHash,
    runId,
    nodeId,
    jsonDigest(input),
    jsonDigest(answer),
  ].join('\n');
}

export function secretDigest(secretSalt, value) {
  if (typeof secretSalt !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(secretSalt)) {
    throw new TypeError('secretSalt must be 128 random bits encoded as 22 base64url characters');
  }
  return sha256(Buffer.from(`${SECRET_PREFIX}\n${secretSalt}\n${canon(value)}`, 'utf8'));
}
