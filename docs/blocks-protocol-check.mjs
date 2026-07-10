// Draft 04 consistency harness: PROTOCOL.md, implementation, vectors, and
// curated examples must agree. Run from the repository root.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { canon } from '../cli/src/canon.js';
import { approvalPayload, jsonDigest } from '../cli/src/evidence.js';
import { hashBlock } from '../cli/src/run.js';
import { loadBlock, loadLibrary } from '../cli/src/loader.js';
import { parseWorkflowFile, validateWorkflow } from '../cli/src/validate.js';

const file = process.argv[2] ?? 'PROTOCOL.md';
const doc = readFileSync(file, 'utf8');
const src = (path) => readFileSync(path, 'utf8');
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// Surface and constants.
const bin = src('cli/bin/blocks');
const helpText = bin.slice(bin.indexOf('usage: blocks'), bin.indexOf('vocabulary:'));
const verbs = [...helpText.matchAll(/^  ([a-z-]+)/gm)].map((match) => match[1]);
check('CLI HELP verbs appear in Appendix A', verbs.length >= 12 && verbs.every((verb) => doc.includes(`blocks ${verb}`)), verbs.join(', '));
check('outcome classes 0/1/2/3 match', bin.includes('0 ok · 1 validation/contract failure · 2 usage error · 3 permission refusal') && /exit codes follow \[RNR-13\]/i.test(doc));
check('reference implementation speaks protocol 4', src('cli/src/validate.js').includes('IMPLEMENTED_PROTOCOL = 4') && doc.includes('Draft-04 runner stamps'));
check('detached approval domain tag is pinned', src('cli/src/evidence.js').includes("APPROVAL_PREFIX = 'blocks-approval-v2'") && doc.includes('blocks-approval-v2'));
check('secret digest domain tag is pinned', src('cli/src/evidence.js').includes("SECRET_PREFIX = 'blocks-secret-v1'") && doc.includes('blocks-secret-v1'));
check('attempt budget is three', /MAX_ATTEMPTS = 3/.test(src('cli/src/run.js')) && /three counted submissions/i.test(doc));

const schemaSource = src('cli/src/schema.js');
const schemaKeys = /KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(schemaSource)[1].match(/'([^']+)'/g).map((value) => value.slice(1, -1));
const schemaTypes = /TYPES = new Set\(\[([^\]]+)\]/.exec(schemaSource)[1].match(/'([^']+)'/g).map((value) => value.slice(1, -1));
check(`all ${schemaKeys.length} schema keys named`, schemaKeys.every((key) => doc.includes(`\`${key}\``)), schemaKeys.join(', '));
check(`all ${schemaTypes.length} schema types named`, schemaTypes.every((type) => doc.includes(`\`${type}\``)), schemaTypes.join(', '));
check('Draft 04 contextual enum implemented and specified', schemaKeys.includes('enumFromInput') && doc.includes('[SCH-9]'));
check('Draft 04 mixed joins implemented and specified', src('cli/src/when.js').includes('rejectMixed') && doc.includes('[GAT-11]'));
check('atomic replacement implemented and single-writer rule specified', src('cli/src/run.js').includes('renameSync(temporary, target)') && doc.includes('[RUN-10]'));

for (const field of ['workflow', 'workflowFile', 'workflowHash', 'runId', 'startedAt', 'secretSalt', 'inputs', 'nodes']) {
  check(`run field ${field} specified`, doc.includes(`\`${field}\``));
}
for (const status of ['pending', 'done', 'skipped', 'failed', 'paused', 'complete']) {
  check(`status ${status} specified`, doc.includes(`\`${status}\``));
}

// Language-neutral vectors.
const canonVectors = JSON.parse(src('conformance/vectors/canon.json'));
for (const vector of canonVectors.vectors) check(`canon vector ${vector.id}`, canon(JSON.parse(vector.inputJson)) === vector.canonical);
for (const vector of canonVectors.invalid) {
  let refused = false;
  try { canon(JSON.parse(vector.inputJson)); } catch { refused = true; }
  check(`canon invalid ${vector.id} refused`, refused);
}
const approvalVector = JSON.parse(src('conformance/vectors/approval.json'));
const historical = JSON.parse(src(approvalVector.sourceRun));
const historicalRecord = historical.nodes[approvalVector.nodeId];
const historicalPayload = approvalPayload({
  workflowHash: historical.workflowHash,
  blockHash: historicalRecord.blockHash,
  runId: historical.runId,
  nodeId: approvalVector.nodeId,
  input: historicalRecord.input,
  answer: historicalRecord.output,
});
check('historical Draft 03 input digest is byte-identical', jsonDigest(historicalRecord.input) === approvalVector.inputDigest);
check('historical Draft 03 answer digest is byte-identical', jsonDigest(historicalRecord.output) === approvalVector.answerDigest);
check('historical Draft 03 payload is byte-identical', historicalPayload === approvalVector.payload);
check('historical Draft 03 signature still verifies', verify(null, Buffer.from(historicalPayload), createPublicKey({ key: approvalVector.publicJwk, format: 'jwk' }), Buffer.from(approvalVector.signature, 'base64url')));

const hashVectors = JSON.parse(src('conformance/vectors/blockhash.json'));
for (const vector of hashVectors.vectors) {
  const { block, errors } = loadBlock(vector.blockDir);
  check(`blockHash vector ${vector.id}`, errors.length === 0 && hashBlock(block) === vector.hash);
}

// Root workflows and current curated runs.
const { library, errors: libraryErrors } = loadLibrary(process.cwd());
check('block library loads', libraryErrors.length === 0, libraryErrors[0]?.message ?? '');
for (const name of readdirSync('workflows').filter((entry) => entry.endsWith('.workflow.json'))) {
  const path = join('workflows', name);
  const { workflow, errors } = parseWorkflowFile(path);
  const validation = errors.length ? errors : validateWorkflow(workflow, library, path, { root: process.cwd() }).errors;
  check(`workflow ${name} validates`, validation.length === 0, validation[0]?.message ?? '');
}
const currentRuns = readdirSync('examples/runs/current').filter((entry) => entry.endsWith('.run.json'));
check('current examples include deterministic and detached/salted ledgers', currentRuns.includes('deterministic-audit-smoke.run.json') && currentRuns.includes('draft04-ledger-smoke.run.json'));
for (const name of currentRuns) {
  let ok = true;
  let detail = '';
  try { execFileSync(process.execPath, ['cli/bin/blocks', 'audit', join('examples/runs/current', name)], { encoding: 'utf8' }); }
  catch (error) { ok = false; detail = String(error.stdout || error.stderr || error.message).slice(0, 200); }
  check(`current run ${name} audits`, ok, detail);
}
const draft4Example = JSON.parse(src('examples/runs/current/draft04-ledger-smoke.run.json'));
check('Draft 04 example carries protocol and salt', draft4Example.protocol === 4 && /^[A-Za-z0-9_-]{22}$/.test(draft4Example.secretSalt));
check('Draft 04 example persists no raw example secret', !src('examples/runs/current/draft04-ledger-smoke.run.json').includes('example-secret-not-persisted'));
check('Draft 04 example carries detached approval', typeof draft4Example.nodes.approve.approval?.signature === 'string');

if (existsSync('keys')) {
  const bad = readdirSync('keys').filter((name) => name.endsWith('.json')).filter((name) => {
    try { const key = JSON.parse(src(join('keys', name))); return key.privateJwk || key.publicJwk?.d; }
    catch { return true; }
  });
  check('keys registry contains no private material', bad.length === 0, bad.join(', '));
}

// Requirement IDs and checklist.
const ids = [...doc.matchAll(/\[([A-Z]{3}-\d+)\]/g)].map((match) => match[1]);
const unique = new Set(ids);
check('requirement IDs present', unique.size >= 115, `${unique.size} unique`);
const byPrefix = new Map();
for (const id of unique) {
  const [prefix, raw] = id.split('-');
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
  byPrefix.get(prefix).add(Number(raw));
}
const gaps = [...byPrefix].filter(([, values]) => Math.max(...values) !== values.size).map(([prefix, values]) => `${prefix}:${values.size}/${Math.max(...values)}`);
check('requirement IDs gapless per prefix', gaps.length === 0, gaps.join(', '));
const appendixC = doc.indexOf('## Appendix C');
const appendixD = doc.indexOf('## Appendix D');
check('Appendix C and D exist in order', appendixC !== -1 && appendixD > appendixC);
if (appendixC !== -1 && appendixD > appendixC) {
  const bodyIds = new Set([...doc.slice(0, appendixC).matchAll(/^\s*\[([A-Z]{3}-\d+)\]\s/gm)].map((match) => match[1]));
  const listIds = new Set([...doc.slice(appendixC, appendixD).matchAll(/\[([A-Z]{3}-\d+)\]/g)].map((match) => match[1]));
  const missing = [...bodyIds].filter((id) => !listIds.has(id));
  const phantom = [...listIds].filter((id) => !bodyIds.has(id));
  check(`checklist covers ${bodyIds.size} body requirements`, missing.length === 0, missing.join(', '));
  check('checklist has no phantom IDs', phantom.length === 0, phantom.join(', '));
}

// Normative prose and links.
check('RFC 2119/8174 boilerplate present', /RFC\s*2119/.test(doc) && /RFC\s*8174/.test(doc));
check('RFC 8785 is normative', /RFC 8785/.test(doc) && /UTF-16 code units/.test(doc));
const sections = doc.split(/^## /m).slice(1);
const lowercase = [];
for (const section of sections) {
  const title = section.split('\n')[0];
  if (!/\(normative\)/i.test(title)) continue;
  const prose = section.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/\[[A-Z]{3}-\d+\]/g, '');
  for (const match of prose.matchAll(/\b(must not|must|shall)\b/g)) lowercase.push(`${title}: ${match[1]}`);
}
check('no lowercase must/shall in normative prose', lowercase.length === 0, lowercase.slice(0, 5).join(' | '));
const slug = (text) => text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/ /g, '-');
const headers = new Set([...doc.matchAll(/^#{1,3} (.+)$/gm)].map((match) => slug(match[1])));
const broken = [...doc.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]).filter((anchor) => !headers.has(anchor));
check('internal anchors resolve', broken.length === 0, broken.slice(0, 8).join(', '));
check('Draft 04 banner and historical changelogs present', /Draft 04/.test(doc) && /2026-07-10/.test(doc) && ['## 18.', '## 19.', '## 20.'].every((heading) => doc.includes(heading)));
check('no local absolute paths or common secret patterns', !doc.includes('/Users/') && !/sk-[a-zA-Z0-9]{8,}|AKIA[A-Z0-9]{8,}|ghp_[a-zA-Z0-9]{8,}/.test(doc));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
